/* =============================================================
   epub.js · EPUB 2/3 → 章节段（sections）
   container.xml → OPF（manifest/spine/metadata）→ 目录（EPUB3 nav 优先，EPUB2 NCX）→ 逐 spine 项取正文
   输出 { format:'epub', title, author, language, sections:[{ href, title, blocks, chars }], toc, warnings }
   sections 是「结构切出来的段」，还不是章；合并/拆分/兜底在 chapters.js。

   XML 不写通用解析器：container/OPF/NCX 结构极固定，正则 + 属性提取够用；
   命名空间前缀不固定（dc:title / opf:title / 无前缀），匹配时一律忽略前缀。
   DRM：META-INF/encryption.xml 里 EncryptedData 引用到 spine 正文 → 抛 {code:'DRM'}；
        只引用字体（字体混淆）→ 忽略，正常解析。
   UMD：Node 走 module.exports；其他环境挂 globalThis.MPEpub。
   ============================================================= */
(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const Z = isNode ? require('./zip.js') : root.MPZip;
  const H = isNode ? require('./html2text.js') : root.MPHtml2Text;
  const D = isNode ? require('./deps.js') : root.MPFmtDeps;
  const mod = factory(Z, H, D);
  if (isNode) module.exports = mod;
  root.MPEpub = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Zip, H2T, Deps) {
  'use strict';

  function err(code, msg, hint) { const e = new Error('epub: ' + msg); e.code = code; if (hint) e.hint = hint; return e; }

  /* ---------- 迷你 XML 工具 ---------- */
  function esc(local) { return local.replace(/[-.]/g, '\\$&'); }
  /** 所有 <prefix:local ...> 开标签（含自闭合），返回 [{inner, index}] */
  function openTags(xml, local) {
    const re = new RegExp('<(?:[\\w.-]+:)?' + esc(local) + '(?=[\\s/>])([^>]*)>', 'g');
    const out = [];
    let m;
    while ((m = re.exec(xml))) out.push({ inner: m[1], index: m.index, end: re.lastIndex });
    return out;
  }
  /** 所有 <local ...>内容</local>，返回 [{inner(属性串), body}] */
  function elements(xml, local) {
    const re = new RegExp('<(?:[\\w.-]+:)?' + esc(local) + '(?=[\\s/>])([^>]*?)(/?)>', 'g');
    const closeRe = new RegExp('</(?:[\\w.-]+:)?' + esc(local) + '\\s*>', 'g');
    const out = [];
    let m;
    while ((m = re.exec(xml))) {
      if (m[2] === '/') { out.push({ inner: m[1], body: '', index: m.index }); continue; }
      closeRe.lastIndex = re.lastIndex;
      const c = closeRe.exec(xml);
      const body = c ? xml.slice(re.lastIndex, c.index) : '';
      out.push({ inner: m[1], body: body, index: m.index });
      if (c) re.lastIndex = closeRe.lastIndex;
    }
    return out;
  }
  function textOf(body) { return H2T.decodeEntities(body.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim(); }
  const attr = H2T.attr;

  /* ---------- 路径 ---------- */
  function dirOf(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); }
  function splitHref(href) {
    const q = href.indexOf('?'); if (q >= 0) href = href.slice(0, q);
    const h = href.indexOf('#');
    return h < 0 ? { path: href, frag: null } : { path: href.slice(0, h), frag: href.slice(h + 1) };
  }
  function resolvePath(base, rel) {
    let p;
    try { p = decodeURIComponent(rel); } catch (e) { p = rel; }
    if (p[0] === '/') p = p.slice(1); else p = base + p;
    const parts = [];
    p.split('/').forEach(function (seg) {
      if (seg === '' || seg === '.') return;
      if (seg === '..') parts.pop(); else parts.push(seg);
    });
    return parts.join('/');
  }

  /* ---------- 主流程 ---------- */
  /** 前半段：zip / OPF / 目录 / spine。不读正文。 */
  function prepare(buf, opts) {
    const o = opts || {};
    const warnings = [];
    const zip = Zip.open(buf);

    // 1. mimetype（宽松：有的包缺这一项，不因此拒绝）
    const mt = Zip.readText(zip, 'mimetype', 'utf-8');
    if (mt != null && mt.indexOf('application/epub+zip') < 0) warnings.push('mimetype 不是 application/epub+zip: ' + mt.trim());

    // 2. container.xml → OPF 路径
    const containerName = Zip.resolveName(zip, 'META-INF/container.xml');
    const container = containerName ? Zip.readText(zip, containerName, 'utf-8') : null;
    let opfPath = null;
    if (container) {
      const rf = openTags(container, 'rootfile');
      for (let i = 0; i < rf.length && !opfPath; i++) {
        const fp = attr(rf[i].inner, 'full-path');
        const mtype = attr(rf[i].inner, 'media-type');
        if (fp && (!mtype || /oebps-package/i.test(mtype))) opfPath = fp;
      }
    }
    if (!opfPath) {
      // 兜底：直接在包里找 .opf
      for (let i = 0; i < zip.names.length; i++) if (/\.opf$/i.test(zip.names[i])) { opfPath = zip.names[i]; warnings.push('container.xml 缺失或无效，直接用了 ' + opfPath); break; }
    }
    if (!opfPath) throw err('CORRUPT', '找不到 OPF（不是 EPUB 或包已损坏）');
    const opfName = Zip.resolveName(zip, opfPath);
    if (!opfName) throw err('CORRUPT', 'container.xml 指向的 OPF 不存在: ' + opfPath);
    const opf = Zip.readText(zip, opfName, 'utf-8');
    const base = dirOf(opfName);

    // 3. metadata
    const meta = {};
    ['title', 'creator', 'language', 'identifier', 'publisher'].forEach(function (k) {
      const els = elements(opf, k);
      if (els.length) meta[k] = textOf(els[0].body);
    });

    // 4. manifest / spine
    const manifest = Object.create(null);
    openTags(opf, 'item').forEach(function (t) {
      const id = attr(t.inner, 'id'), href = attr(t.inner, 'href');
      if (!id || !href) return;
      manifest[id] = { id: id, href: href, path: resolvePath(base, splitHref(href).path), type: attr(t.inner, 'media-type') || '', props: attr(t.inner, 'properties') || '' };
    });
    const spineEls = elements(opf, 'spine');
    const spineInner = spineEls.length ? spineEls[0].inner : '';
    const spineBody = spineEls.length ? spineEls[0].body : opf;
    const spine = [];
    openTags(spineBody, 'itemref').forEach(function (t) {
      const idref = attr(t.inner, 'idref');
      const linear = attr(t.inner, 'linear');
      const item = idref && manifest[idref];
      if (!item) { warnings.push('spine 引用了不存在的 manifest 项: ' + idref); return; }
      if (linear && linear.toLowerCase() === 'no') return;   // 封面/版权页之类
      spine.push(item);
    });
    if (!spine.length) throw err('CORRUPT', 'spine 为空');

    // 5. DRM 判定
    const encName = Zip.resolveName(zip, 'META-INF/encryption.xml');
    if (encName) {
      const enc = Zip.readText(zip, encName, 'utf-8') || '';
      const uris = [];
      openTags(enc, 'CipherReference').forEach(function (t) { const u = attr(t.inner, 'URI'); if (u) uris.push(resolvePath('', u)); });
      const spinePaths = new Set(spine.map(function (s) { return s.path; }));
      const hit = uris.filter(function (u) { return spinePaths.has(u); });
      if (hit.length) throw err('DRM', '正文被加密（' + hit.length + ' 个文件）', '这本书受版权保护，暂不支持导入');
      if (uris.length) warnings.push('encryption.xml 只加密了 ' + uris.length + ' 个非正文文件（通常是字体），已忽略');
    }

    // 6. 目录：EPUB3 nav 优先，其次 NCX
    let toc = [];
    let navItem = null;
    for (const id in manifest) if (/\bnav\b/.test(manifest[id].props)) { navItem = manifest[id]; break; }
    if (navItem) {
      const navName = Zip.resolveName(zip, navItem.path);
      const nav = navName ? Zip.readText(zip, navName) : null;
      if (nav) toc = parseNav(nav, dirOf(navItem.path));
      if (!toc.length) warnings.push('nav 文档没有解析出目录项');
    }
    if (!toc.length) {
      let ncxItem = null;
      const tocId = attr(spineInner, 'toc');
      if (tocId && manifest[tocId]) ncxItem = manifest[tocId];
      if (!ncxItem) for (const id in manifest) if (/dtbncx/i.test(manifest[id].type) || /\.ncx$/i.test(manifest[id].path)) { ncxItem = manifest[id]; break; }
      if (ncxItem) {
        const ncxName = Zip.resolveName(zip, ncxItem.path);
        const ncx = ncxName ? Zip.readText(zip, ncxName) : null;
        if (ncx) toc = parseNcx(ncx, dirOf(ncxItem.path));
      }
    }
    if (!toc.length) warnings.push('没有可用目录（nav/NCX），章标题将由正文标题或正则推断');

    // 7. 目录按文件分组
    const tocByPath = Object.create(null);
    toc.forEach(function (t) { (tocByPath[t.path] || (tocByPath[t.path] = [])).push(t); });

    /* 8. 前半到此为止。
       ★ 「逐 spine 项取正文」是整个导入里最慢的一段：实测 19 MB / 1356 章的书
         要 5.3 秒，比后面扫 20 章（0.44 秒）长一个量级。它原本写死成一个
         同步 forEach，占着主线程 —— 就算回调了进度，DOM 也不会重绘。
         所以拆成 prepare / readSection / finish 三段，让调用方自己决定怎么驱动：
         同步一把梭（parse），还是分批让出主线程（parseAsync）。
       ★ 循环体只有 readSection 这一份，两条路共用，不会漂。 */
    return {
      zip: zip, meta: meta, spine: spine, toc: toc, tocByPath: tocByPath,
      warnings: warnings, sections: [], missing: 0,
    };
  }

  /** 读一个 spine 项 → 若干 section。就地改 ctx。 */
  function readSection(ctx, si) {
    const item = ctx.spine[si];
    const name = Zip.resolveName(ctx.zip, item.path);
    if (!name) { ctx.missing++; ctx.warnings.push('正文文件不存在: ' + item.path); return; }
    const html = Zip.readText(ctx.zip, name);
    const parsed = H2T.toBlocks(html);
    const entries = ctx.tocByPath[item.path] || [];
    const pieces = splitByAnchors(parsed.blocks, entries);
    pieces.forEach(function (pc) {
      ctx.sections.push({
        href: item.path + (pc.frag ? '#' + pc.frag : ''),
        spineIndex: si,
        title: pc.title,                 // 来自目录；null 表示目录没给
        docTitle: parsed.docTitle,       // <title>，仅作兜底线索
        blocks: pc.blocks,
        chars: pc.blocks.reduce(function (a, b) { return a + b.text.length; }, 0),
      });
    });
  }

  /** 组装返回值。 */
  function finish(ctx) {
    if (!ctx.sections.length) throw err('CORRUPT', 'spine 里没有一个正文文件能读出来');
    if (ctx.missing) ctx.warnings.push('共 ' + ctx.missing + ' 个正文文件缺失');
    return {
      format: 'epub',
      title: ctx.meta.title || null,
      author: ctx.meta.creator || null,
      language: ctx.meta.language || null,
      identifier: ctx.meta.identifier || null,
      sections: ctx.sections,
      toc: ctx.toc,
      spineCount: ctx.spine.length,
      warnings: ctx.warnings,
    };
  }

  /** 同步解析。行为和拆分前逐字一致 —— smoke 第 21 节盯着这一条。 */
  function parse(buf, opts) {
    const ctx = prepare(buf, opts);
    for (let i = 0; i < ctx.spine.length; i++) readSection(ctx, i);
    return finish(ctx);
  }

  /**
   * 异步解析：分批读，每批之间让出主线程，好让进度画得出来、界面不冻。
   * @param {Object} opts 额外支持 {onProgress(done,total), step}
   * @returns {Promise}
   */
  function parseAsync(buf, opts) {
    const o = opts || {};
    /* ★ 每批至少读一项。step 传了 0 或负数的话，「读了 0 项然后继续排下一批」
       就是个静默死循环 —— 页面不报错、不白屏，只是永远停在「正在解压」。 */
    const step = Math.max(1, o.step || 20);   // 一批 20 项 ≈ 80ms，够细也不至于被 setTimeout 拖垮
    return new Promise(function (resolve, reject) {
      let ctx;
      try { ctx = prepare(buf, o); } catch (e) { reject(e); return; }
      let i = 0;
      const total = ctx.spine.length;
      if (o.onProgress) { try { o.onProgress(0, total); } catch (e) { /* 画进度炸了不该连累解析 */ } }
      function batch() {
        try {
          const end = Math.min(total, i + step);
          if (end <= i) { reject(new Error('epub 分批解析没有推进（step=' + step + '）')); return; }
          for (; i < end; i++) readSection(ctx, i);
          if (o.onProgress) { try { o.onProgress(i, total); } catch (e) { /* 同上 */ } }
          if (i >= total) { resolve(finish(ctx)); return; }
          Deps.nextTick(batch);       // ★ 不是 setTimeout —— 后台标签页里它被钳到 1 秒一次
        } catch (e) { reject(e); }
      }
      batch();
    });
  }

  /** 目录若有多条指向同一文件的不同锚点，就在对应 id 的块处切开 */
  function splitByAnchors(blocks, entries) {
    if (!entries.length) return [{ frag: null, title: null, blocks: blocks }];
    if (entries.length === 1) return [{ frag: entries[0].frag, title: entries[0].title, blocks: blocks }];
    // 找每个锚点所在块下标
    const idAt = Object.create(null);
    blocks.forEach(function (b, i) { if (b.ids) b.ids.forEach(function (id) { if (!(id in idAt)) idAt[id] = i; }); });
    const cuts = [];
    entries.forEach(function (e) {
      const at = e.frag == null ? 0 : (e.frag in idAt ? idAt[e.frag] : -1);
      if (at >= 0) cuts.push({ at: at, title: e.title, frag: e.frag });
    });
    if (!cuts.length) return [{ frag: null, title: entries[0].title, blocks: blocks }];
    cuts.sort(function (a, b) { return a.at - b.at; });
    // 去重（两个目录项指向同一块）
    const uniq = [];
    cuts.forEach(function (c) { if (!uniq.length || uniq[uniq.length - 1].at !== c.at) uniq.push(c); });
    if (uniq[0].at > 0) uniq[0].at = 0;    // 第一个锚点前的内容并入第一段（通常是本章标题之前的装饰）
    return uniq.map(function (c, i) {
      const end = i + 1 < uniq.length ? uniq[i + 1].at : blocks.length;
      return { frag: c.frag, title: c.title, blocks: blocks.slice(c.at, end) };
    });
  }

  /** EPUB3 nav：<nav epub:type="toc"> 里的所有 <a href> */
  function parseNav(nav, base) {
    let scope = nav;
    const navs = elements(nav, 'nav');
    for (let i = 0; i < navs.length; i++) {
      const t = attr(navs[i].inner, 'epub:type') || attr(navs[i].inner, 'type') || '';
      if (/\btoc\b/.test(t)) { scope = navs[i].body; break; }
    }
    if (scope === nav && navs.length) scope = navs[0].body;
    const out = [];
    elements(scope, 'a').forEach(function (a) {
      const href = attr(a.inner, 'href');
      if (!href) return;
      const sp = splitHref(href);
      out.push({ path: resolvePath(base, sp.path), frag: sp.frag, title: textOf(a.body) || null });
    });
    return out;
  }

  /** EPUB2 NCX：navPoint → navLabel/text + content/src，按文档顺序（嵌套一并拉平） */
  function parseNcx(ncx, base) {
    const out = [];
    const re = /<(?:[\w.-]+:)?navPoint(?=[\s>])[^>]*>/g;
    let m;
    while ((m = re.exec(ncx))) {
      const from = re.lastIndex;
      // 这个 navPoint 的 label 与 content 出现在它自己的子 navPoint 之前
      const nextNp = ncx.indexOf('<navPoint', from);
      const nextNpNs = ncx.search(/<[\w.-]+:navPoint/g);
      const limit = nextNp < 0 ? ncx.length : nextNp;
      const seg = ncx.slice(from, limit);
      const lab = elements(seg, 'text');
      const con = openTags(seg, 'content');
      if (!con.length) continue;
      const src = attr(con[0].inner, 'src');
      if (!src) continue;
      const sp = splitHref(src);
      out.push({ path: resolvePath(base, sp.path), frag: sp.frag, title: lab.length ? textOf(lab[0].body) || null : null });
      void nextNpNs;
    }
    return out;
  }

  return { parse: parse, parseAsync: parseAsync, prepare: prepare, readSection: readSection, finish: finish, parseNav: parseNav, parseNcx: parseNcx, splitByAnchors: splitByAnchors, resolvePath: resolvePath, _xml: { openTags: openTags, elements: elements, textOf: textOf } };
});

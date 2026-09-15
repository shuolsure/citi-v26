/* =============================================================
   index.js · 门面：字节 → { title, author, chapters:[{title,text}] }
   页面层只认这一个文件：
       const r = Fmt.parseBook(bytes)                     // 只解析，不预扫描
       const r = Fmt.importAny(bytes, { bridge, title })  // 解析 + 直接交给主引擎（页面用这个）

   路由（sniff.js 看文件头，不看扩展名）：
       txt          → 主引擎 detectEncoding → normalize → splitChapters(auto)   ← 一行没改
       epub         → epub.js  → sections → chapters.js
       mobi/azw/azw3→ mobi.js  → html2text → pagebreak 切段 → chapters.js
       其他         → 抛 { code:'UNSUPPORTED', hint }

   错误一律是 Error 且带 code：
       DRM         正文被加密，不解密，也不给去 DRM 的办法（方案 Q4）
       UNSUPPORTED 格式认得出但我们不做（PDF/KFX/docx…），或压根认不出
       CORRUPT     格式对但文件坏了（多半是没传完）
   每个错误都带 hint，是可以直接弹给读者看的一句话。
   UMD：Node 走 module.exports；其他环境挂 globalThis.MPFormats。
   ============================================================= */
(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const parts = isNode
    ? { D: require('./deps.js'), S: require('./sniff.js'), E: require('./epub.js'), M: require('./mobi.js'), H: require('./html2text.js'), C: require('./chapters.js') }
    : { D: root.MPFmtDeps, S: root.MPSniff, E: root.MPEpub, M: root.MPMobi, H: root.MPHtml2Text, C: root.MPChapters };
  const mod = factory(parts.D, parts.S, parts.E, parts.M, parts.H, parts.C);
  if (isNode) module.exports = mod;
  root.MPFormats = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Deps, Sniff, Epub, Mobi, H2T, Chapters) {
  'use strict';

  /* hint 是**直接弹给读者看的一句话**，不能是 'zip: 找不到 ZIP 目录结尾（EOCD）' 这种。
     message 留给日志。底层模块只在有话可说时才自己带 hint，没带就用这里的默认。 */
  const DEFAULT_HINT = {
    DRM: '这本书受版权保护，暂不支持导入。',
    UNSUPPORTED: '暂不支持这种文件。目前支持 TXT / EPUB / MOBI / AZW / AZW3。',
    CORRUPT: '这个文件读不出来，可能没传完或已损坏。重新发一次，或换个来源再试。',
  };
  function err(code, msg, hint) {
    const e = new Error(msg);
    e.code = code;
    e.hint = hint || DEFAULT_HINT[code] || msg;
    return e;
  }

  /** 底下几个模块抛出来的东西可能没有 code（比如越界的 TypeError）—— 一律收敛成 CORRUPT */
  function normalizeError(e, format) {
    if (e && e.code) { if (!e.hint) e.hint = DEFAULT_HINT[e.code] || e.message; return e; }
    const m = e && e.message ? e.message : String(e);
    return err('CORRUPT', (format || '') + ' 解析失败: ' + m);
  }

  const SUPPORTED_HINT = '目前支持 TXT / EPUB / MOBI / AZW / AZW3。';

  /**
   * 只解析，不做预扫描。
   * @param {ArrayBuffer|Uint8Array} buf
   * @param {Object} [opts] { chapters?:传给 chapters.build 的参数, preferKf7? }
   * @returns {{format, sniff, title, author, language, encoding, chapters:[{n,title,text,chars}],
   *            splitMode, warnings, stats, text?}}
   *   text 只有 TXT 路径有（页面想用主引擎的 guessTitle 时要它）
   */
  function parseBook(buf, opts) {
    const o = opts || {};
    const bytes = Deps.toBytes(buf);
    const s = Sniff.sniff(bytes);
    if (s.format === 'unsupported') throw err('UNSUPPORTED', '不支持的文件类型: ' + s.kind, (s.hint || '认不出这个文件的格式。') + (s.kind === 'binary' ? '' : ' ' + SUPPORTED_HINT));

    if (s.format === 'txt') return parseTxt(bytes, s, o);
    if (s.format === 'epub') return parseEpub(bytes, s, o);
    if (s.format === 'mobi') return parseMobi(bytes, s, o);
    throw err('UNSUPPORTED', '未知路由 ' + s.format, SUPPORTED_HINT);
  }

  /**
   * 异步解析。目前只有 epub 真的分批（它是最慢的：19 MB / 1356 章 实测 5.3 秒），
   * txt / mobi 照旧同步，只是包了一层 Promise，好让调用方一视同仁。
   * @param {Object} opts 额外支持 {onProgress(done,total,phase)}
   */
  function parseBookAsync(buf, opts) {
    const o = opts || {};
    let bytes, s;
    try {
      bytes = Deps.toBytes(buf);
      s = Sniff.sniff(bytes);
      if (s.format === 'unsupported') {
        throw err('UNSUPPORTED', '不支持的文件类型: ' + s.kind,
          (s.hint || '认不出这个文件的格式。') + (s.kind === 'binary' ? '' : ' ' + SUPPORTED_HINT));
      }
    } catch (e) { return Promise.reject(e); }

    if (s.format !== 'epub') {
      /* ★ 同步那条路原样跑，包成 Promise。不许在这里另写一份分支逻辑 —— 
         两份实现迟早会漂，而「解析结果差一点」在界面上看都像正常的书。 */
      try { return Promise.resolve(parseBook(buf, o)); } catch (e) { return Promise.reject(e); }
    }
    return parseEpubAsync(bytes, s, o);
  }

  function parseEpubAsync(bytes, s, o) {
    return Epub.parseAsync(bytes, o)
      .catch(function (e) { throw normalizeError(e, 'epub'); })
      .then(function (p) { return buildEpub(p, s, o); });
  }

  /* ---------- TXT：完全走主引擎，这里一行逻辑都不加 ---------- */
  function parseTxt(bytes, s, o) {
    const detect = Deps.detectEncoding(bytes);
    const text = Deps.normalize(detect.text);
    if (!text) throw err('CORRUPT', 'txt 解出来是空的', '这个文件里没有文字。');
    const sp = Deps.splitChapters(text, { mode: o.split || 'auto', size: o.size });
    const warnings = [];
    if (!detect.ok) warnings.push('编码识别不确定（' + detect.encoding + '，乱码率 ' + (detect.badRate * 100).toFixed(2) + '%）');
    return {
      format: 'txt', sniff: s, title: null, author: null, language: null,
      encoding: detect.encoding, chapters: sp.chapters, splitMode: sp.mode,
      warnings: warnings, stats: { sections: 1, resplit: 0 }, text: text, detect: detect,
    };
  }

  /* ---------- EPUB ---------- */
  function parseEpub(bytes, s, o) {
    let p;
    try { p = Epub.parse(bytes, o); } catch (e) { throw normalizeError(e, 'epub'); }
    return buildEpub(p, s, o);
  }

  /** Epub.parse 之后的组装。★ 同步和异步两条路共用，不许各写一份。 */
  function buildEpub(p, s, o) {
    const built = Chapters.build(p.sections, Object.assign({ hasToc: p.toc.length > 0 }, o.chapters || {}));
    if (!built.chapters.length) throw err('CORRUPT', 'epub 没解出任何章节', '这本书的正文是空的，可能只有图片。');
    return {
      format: 'epub', sniff: s, title: p.title, author: p.author, language: p.language,
      encoding: 'utf-8', chapters: built.chapters, splitMode: built.mode,
      warnings: p.warnings.concat(built.warnings), stats: built.stats, source: p,
    };
  }

  /* ---------- MOBI / AZW / AZW3 ---------- */
  function parseMobi(bytes, s, o) {
    let p;
    try { p = Mobi.parse(bytes, o); } catch (e) { throw normalizeError(e, 'mobi'); }
    const warnings = p.warnings.slice();
    let sections;
    if (p.textIsPlain) {
      // TEXtREAd：正文本来就是纯文本，没有标签也没有 pagebreak
      sections = [{ title: null, text: p.html }];
    } else {
      const parsed = H2T.toBlocks(p.html);
      if (!p.title && parsed.docTitle) p.title = parsed.docTitle;
      sections = Chapters.sectionsFromBlocks(parsed.blocks, o.sections || {});
      if (sections.length === 1 && sections[0].by === 'whole') warnings.push('正文里没有分页标记也没有标题块，只能靠正文标题正则分章');
    }
    const built = Chapters.build(sections, Object.assign({ hasToc: false }, o.chapters || {}));
    if (!built.chapters.length) throw err('CORRUPT', p.format + ' 没解出任何章节', '这本书的正文是空的。');
    return {
      format: p.format, sniff: s, title: p.title, author: p.author, language: p.language,
      encoding: p.encoding, chapters: built.chapters, splitMode: built.mode,
      warnings: warnings.concat(built.warnings), stats: built.stats, source: p,
    };
  }

  /**
   * 解析 + 交给主引擎（页面层用这个）。
   * TXT 走 importBook（书名由主引擎的 guessTitle 猜），其余走 importChapters（结构已经有了，别再猜一遍）。
   * @param {ArrayBuffer|Uint8Array} buf
   * @param {Object} [opts] importBook/importChapters 的参数（bridge, title, id, today, vocab, names…）
   * @returns {{meta, chapters, index, names_guess, …, parsed}}  parsed 里有真实字符编码与 warnings
   */
  function importAny(buf, opts) {
    const o = opts || {};
    const parsed = parseBook(buf, o);
    if (parsed.format === 'txt') {
      const r = Deps.engine.importBook(parsed.text, o);
      r.meta.encoding = parsed.encoding;          // importBook 收到的是字符串，编码得由这里补回去
      r.parsed = parsed;
      return r;
    }
    const r = Deps.engine.importChapters(parsed.chapters, Object.assign({}, o, {
      title: o.title || parsed.title || '未命名',
      encoding: parsed.format,                    // 方案 §四：meta.encoding 记来源格式
    }));
    r.parsed = parsed;
    return r;
  }

  /** importAny 的异步版：解析走分批，后面的 importBook/importChapters 照旧。 */
  function importAnyAsync(buf, opts) {
    const o = opts || {};
    return parseBookAsync(buf, o).then(function (parsed) {
      if (parsed.format === 'txt') {
        const r = Deps.engine.importBook(parsed.text, o);
        r.meta.encoding = parsed.encoding;
        r.parsed = parsed;
        return r;
      }
      const r = Deps.engine.importChapters(parsed.chapters, Object.assign({}, o, {
        title: o.title || parsed.title || '未命名',
        encoding: parsed.format,
      }));
      r.parsed = parsed;
      return r;
    });
  }

  return {
    parseBook: parseBook, importAny: importAny,
    parseBookAsync: parseBookAsync, importAnyAsync: importAnyAsync,
    sniff: Sniff.sniff,
    deps: Deps, epub: Epub, mobi: Mobi, html2text: H2T, chapters: Chapters,
  };
});

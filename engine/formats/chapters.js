/* =============================================================
   chapters.js · 分章仲裁：结构优先、正则兜底、结果要仲裁（方案 §六）
   输入是「结构切出来的段」（EPUB 的 spine 项 / MOBI 的 pagebreak 段），
   输出是 importChapters() 要的 [{title, text}]。

   四条规则（方案 §六，顺序不能换）：
     (b) 段长 > 2 万字且段内 findHeadings ≥ 3  → 用主引擎的标题正则对这一段二次切分
     (a) 段长 < 200 字                          → 并入前一段；第一段这么短就当书名页丢掉
     (d) 段的标题：目录给的 > 段内前 3 块的 h 块 > 段首行匹配标题正则 > 「第 N 章」
     (c) 仲裁完只剩 ≤ 2 章且全书 > 2 万字        → 全文拼起来交给 splitChapters(auto)

   ★ C3：标题不进 text。这条和 TXT 路径的 byHeadings 一致，
     「同源等价」（TXT / EPUB / MOBI 三条路径逐章相似度 ≥ 99.5%）就靠两边同口径。

   ★ 二次切分为什么用**没剥标题的 raw**：
     Gutenberg 那种「按 7.4 万字一个文件」切出来的 EPUB，每个文件的第一行就是「第一回：…」。
     先按 (d) 把它剥成段标题、再去找标题，第一回的标题就没了。
     所以先看这一段要不要二次切，要切就整段原样交给正则，标题概念作废。

   ★ 二次切分产生的「首个标题之前那一截」（上一回的尾巴，因为文件是按大小切的）
     **接回上一章**，不像主引擎 byHeadings 那样丢掉或另起一个「序」——
     丢掉会让同源等价掉几百字，另起「序」会凭空多出十来个空壳章。

   标题正则、分章、normalize 一律走 deps.js → import.js，这里不再写一份。
   UMD：Node 走 module.exports；其他环境挂 globalThis.MPChapters。
   ============================================================= */
(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const D = isNode ? require('./deps.js') : root.MPFmtDeps;
  const mod = factory(D);
  if (isNode) module.exports = mod;
  root.MPChapters = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Deps) {
  'use strict';

  const BIG_SECTION = 20000;          // 方案 §六：段长 > 2 万字才考虑二次切
  const MIN_HEADS_IN_SECTION = 3;     // 且段内至少 3 个标题（少于这个数多半是误命中）
  const SHORT = Deps.PRE_AS_CHAPTER;  // 200，与 TXT 路径同一个常数

  /** 一行是不是标题行 —— 判据只有主引擎的 HEAD_RE 一份（findHeadings 对单行串就是它） */
  function isHeadingLine(line) {
    if (!line || line.indexOf('\n') >= 0) return false;
    return Deps.findHeadings(line).length === 1;
  }

  /** 目录标题和正文首行是不是同一个标题（差别只在标点/空白） */
  function sameTitle(a, b) {
    const key = function (s) { return String(s == null ? '' : s).replace(/[\s　·・:：.。、,，;；—\-_*"'“”「」【】\[\]()（）]/g, ''); };
    const ka = key(a);
    return !!ka && ka === key(b);
  }

  function blocksText(blocks) {
    const lines = new Array(blocks.length);
    for (let i = 0; i < blocks.length; i++) lines[i] = blocks[i].text;
    return Deps.normalize(lines.join('\n'));
  }

  /* -------------------------------------------------------------
     一、块流 → 结构段（MOBI 用；EPUB 的段由 spine/目录锚点给）
     ------------------------------------------------------------- */
  /**
   * KF7 用 <mbp:pagebreak/> 分页；KF8 没有 pagebreak，退而用 h1–h3 块切。
   * 两个都没有就整本一段 —— 交给 build() 的规则 (c) 兜底。
   * @param {Array} blocks html2text.toBlocks().blocks
   * @param {Object} [opts] { headingLevel=3, minHeadingBlocks=3 }
   */
  function sectionsFromBlocks(blocks, opts) {
    const o = opts || {};
    const bs = blocks || [];
    let cuts = [], by = 'pagebreak';
    for (let i = 0; i < bs.length; i++) if (bs[i].pagebreak) cuts.push(i);
    if (!cuts.length) {
      const lv = o.headingLevel == null ? 3 : o.headingLevel;
      const hs = [];
      for (let i = 0; i < bs.length; i++) if (bs[i].kind === 'h' && bs[i].level <= lv) hs.push(i);
      if (hs.length >= (o.minHeadingBlocks == null ? MIN_HEADS_IN_SECTION : o.minHeadingBlocks)) { cuts = hs; by = 'heading-block'; }
    }
    if (!cuts.length) return bs.length ? [{ title: null, blocks: bs, by: 'whole' }] : [];
    const out = [];
    let start = 0;
    for (let k = 0; k < cuts.length; k++) {
      const c = cuts[k];
      if (c <= start) continue;                 // 切点在开头，或两个切点挨着
      out.push({ title: null, blocks: bs.slice(start, c), by: by });
      start = c;
    }
    out.push({ title: null, blocks: bs.slice(start), by: by });
    return out.filter(function (s) { return s.blocks.length; });
  }

  /* -------------------------------------------------------------
     二、单段：定标题 + 从正文里剥掉标题（C3）
     ------------------------------------------------------------- */
  /**
   * @returns {{title:string|null, from:'toc'|'h'|'line'|null, text:string}}
   */
  function sectionTitle(section) {
    const blocks = (section.blocks || []).slice();
    const toc = section.title || null;
    let idx = -1, from = null;
    for (let i = 0; i < blocks.length && i < 3; i++) {
      if (blocks[i].kind === 'h') { idx = i; from = 'h'; break; }
    }
    if (idx < 0 && blocks.length) {
      const t0 = blocks[0].text;
      if (isHeadingLine(t0) || (toc && sameTitle(t0, toc))) { idx = 0; from = 'line'; }
    }
    let title = toc;
    if (idx >= 0) {
      if (!title) title = blocks[idx].text;
      blocks.splice(idx, 1);                    // C3：标题不进 text
    }
    if (toc) from = 'toc';
    return { title: title, from: title ? from : null, text: blocksText(blocks) };
  }

  /* -------------------------------------------------------------
     三、仲裁
     ------------------------------------------------------------- */
  /**
   * @param {Array} sections [{ title?, blocks?, text? }]
   * @param {Object} [opts] {
   *     hasToc      本书有目录 —— 只有这时候「这一段不在目录里」才是「它是上一章的续」的证据
   *     bigChars    默认 20000
   *     minHeads    默认 3
   *     shortChars  默认 200
   *   }
   * @returns {{chapters:[{n,title,text,chars}], mode, warnings, stats}}
   */
  function build(sections, opts) {
    const o = opts || {};
    const big = o.bigChars == null ? BIG_SECTION : o.bigChars;
    const minHeads = o.minHeads == null ? MIN_HEADS_IN_SECTION : o.minHeads;
    const shortLimit = o.shortChars == null ? SHORT : o.shortChars;
    const warnings = [];
    const stats = { sections: 0, resplit: 0, mergedShort: 0, mergedUntitled: 0, droppedFront: 0, tailBack: 0 };

    // 统一成 { toc, blocks }：允许调用方直接给 text（TXT 段或测试用）
    const secs = (sections || []).map(function (s) {
      if (s.blocks) return { title: s.title || null, blocks: s.blocks };
      const lines = Deps.normalize(s.text || '').split('\n');
      return { title: s.title || null, blocks: lines.map(function (l) { return { text: l, kind: 'p', level: 0 }; }).filter(function (b) { return b.text; }) };
    }).filter(function (s) { return s.blocks.length; });
    stats.sections = secs.length;
    if (!secs.length) return { chapters: [], mode: 'empty', warnings: ['没有可用的正文段'], stats: stats };

    const raws = secs.map(function (s) { return blocksText(s.blocks); });
    const totalChars = raws.reduce(function (a, t) { return a + t.length; }, 0);

    const out = [];        // [{title, text}]，标题可能是 null（最后统一补「第 N 章」）
    secs.forEach(function (s, i) {
      const raw = raws[i];
      if (!raw) return;
      const heads = Deps.findHeadings(raw);

      // 规则 (b)：大段二次切分。用没剥标题的 raw，段自己的标题概念作废。
      if (raw.length > big && heads.length >= minHeads) {
        stats.resplit++;
        const pre = raw.slice(0, heads[0].start).replace(/^\n+|\n+$/g, '');
        if (pre) {
          if (out.length) { out[out.length - 1].text = out[out.length - 1].text ? out[out.length - 1].text + '\n' + pre : pre; stats.tailBack++; }
          else if (pre.length >= shortLimit) out.push({ title: s.title || '序', text: pre });
          else stats.droppedFront++;
        }
        for (let k = 0; k < heads.length; k++) {
          const from = heads[k].start + heads[k].len;
          const to = (k + 1 < heads.length) ? heads[k + 1].start : raw.length;
          out.push({ title: heads[k].title, text: raw.slice(from, to).replace(/^\n+|\n+$/g, '') });   // C3
        }
        return;
      }

      // 规则 (d)：定标题
      const t = sectionTitle(s);
      if (t.title == null && o.hasToc && out.length) {
        // 有目录、这一段却不在目录里，也没有自己的标题 —— 它是上一段那一章被按大小拆开的后半截
        out[out.length - 1].text = out[out.length - 1].text ? out[out.length - 1].text + '\n' + t.text : t.text;
        stats.mergedUntitled++;
        return;
      }
      out.push({ title: t.title, text: t.text });
    });

    // 规则 (a)：短段并入前一段；第一段太短当书名页丢掉
    const merged = [];
    for (let i = 0; i < out.length; i++) {
      const c = out[i];
      if (c.text.length < shortLimit) {
        if (merged.length) {
          if (c.text) merged[merged.length - 1].text += '\n' + c.text;
          stats.mergedShort++;
          continue;
        }
        // 第一段：后面还有别的段才丢，否则整本书就没了
        if (out.length > 1) { stats.droppedFront++; continue; }
      }
      merged.push({ title: c.title, text: c.text });
    }

    // 规则 (c)：整体兜底 —— 结构没给出有效边界（整本一个 XHTML 之类）。
    // 方案原话是「≤ 2 段且全书 > 2 万字」。只按字数拦会漏掉短书：
    // 一本三千字、整本一个文件、没有目录也没有 h 标签的书，结构给的就是一整段，
    // 而全文正则明明能切出 5 章 —— 卡在 2 万字上等于说「短书就不许有章」。
    // 所以判据改成两条**任一**成立：正则真的切出了比结构更多的章（这时候它一定比结构好），
    // 或者全书超过 2 万字（这时候哪怕只能按字数硬切，也好过让读者面对一个几十万字的「章」）。
    if (merged.length <= 2) {
      const joined = Deps.normalize(raws.join('\n'));
      const sp = Deps.splitChapters(joined, { mode: 'auto', size: o.size });
      const better = sp.mode === 'heading' && sp.chapters.length > merged.length;
      if (better || totalChars > big) {
        warnings.push('结构只切出 ' + merged.length + ' 段，已改用全文' + (sp.mode === 'heading' ? '标题' : '固定') + '分章');
        return {
          chapters: sp.chapters.map(function (c, i) { return { n: i + 1, title: c.title, text: c.text, chars: c.text.length }; }),
          mode: 'global-' + sp.mode, warnings: warnings, stats: stats,
        };
      }
    }

    if (stats.mergedShort) warnings.push(stats.mergedShort + ' 个不足 ' + shortLimit + ' 字的段已并入前一章');
    if (stats.mergedUntitled) warnings.push(stats.mergedUntitled + ' 个没有目录标题的段已并入前一章（同一章被拆成多个文件）');
    if (stats.droppedFront) warnings.push('丢弃了 ' + stats.droppedFront + ' 段书名页/版权页级别的碎片');

    // 第一段没标题、后面那段有 —— 和主引擎 byHeadings 一样叫它「序」。
    // 不这么做的话同一本书的 EPUB（第一段是二次切分的 pre，叫「序」）和 MOBI（第一段是独立的
    // pagebreak 段，叫「第 1 章」）会给出两个名字，跨格式对不齐。
    if (merged.length > 1 && !merged[0].title && merged[1].title) merged[0].title = '序';

    const chapters = merged.map(function (c, i) {
      const text = c.text;
      return { n: i + 1, title: c.title || ('第 ' + (i + 1) + ' 章'), text: text, chars: text.length };
    });
    const untitled = chapters.filter(function (c, i) { return !merged[i].title; }).length;
    if (untitled) warnings.push(untitled + ' 章没有标题，已按顺序编号');
    return { chapters: chapters, mode: stats.resplit ? 'structure+heading' : 'structure', warnings: warnings, stats: stats };
  }

  return {
    build: build,
    sectionsFromBlocks: sectionsFromBlocks,
    sectionTitle: sectionTitle,
    isHeadingLine: isHeadingLine,
    sameTitle: sameTitle,
    blocksText: blocksText,
    BIG_SECTION: BIG_SECTION, MIN_HEADS_IN_SECTION: MIN_HEADS_IN_SECTION, SHORT: SHORT,
  };
});

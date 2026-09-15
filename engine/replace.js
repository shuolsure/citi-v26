/* =============================================================
   replace.js · 替换引擎（真实现，纯函数）
   输入 章节 + 词位 + 词单 + 密度 + 用户词状态 → 输出 HTML + 本章实际替换词表
   零依赖（除 NRParse / NRAc）。UMD。M0 原样搬进 app/server/，端与云同一份（不变式 I2）。

   硬规则（项目说明 §五、不变式 I5/I6），六条全部在这里落地：
     R1 每千字替换 ≤ 密度上限          → quota = floor(字数/1000 × density)
     R2 一行 ≤ 1 处（行 = 分句）        → perClause
     R3 自然度 < 3 不替                 → naturalness()，公式与扫词台 scan.js 同一份
     R4 专名不替                        → 专名表建第二台 AC，位置重叠即丢
     R5 首现带中文                      → 该用户该书首次替换该词时加（中文）
     R6 词形永远原形                    → 只输出 words[].word，不做任何形态变化
   附加三条（demo 与 M0 一致，写在这里而不是散在页面里）：
     R7 同一段落 ≤ 2 处（产品文档 §4.1）
     R8 同一个词每章 ≤ 2 处（不然一个高频词能把配额吃光，曝光就摊不开）
     R9 邻字否决 —— 命中的左右邻字落在否决表里就丢（说明这个命中切穿了词边界）
        「冒险家」不该替成「adventure（冒险）家」，「我意识到」不该替成「我 consciousness（意识）到」。
        AC 是纯串匹配，不知道词边界；分词器又太大（jieba 词典 3.4MB，放不进小程序分包）。
        折中是**只在命中处看左右 1–2 个字**：数据 200KB 上下，运行时 4 次 Set 查询。
        表由 `data-src/corpus/` 离线从语料训练（方案见小程序版 doc/05-邻字否决表方案.md），
        引擎只认格式 `{表达: {L:[禁止的左邻串], R:[禁止的右邻串]}}`，不传就整条规则不生效。
        ★ 只否决不发现：候选永远来自 AC + 桥表，表错了最多少替一处，不会替错一处。
   ============================================================= */
(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const P = isNode ? require('./parse.js') : root.NRParse;
  const A = isNode ? require('./ac.js') : root.NRAc;
  const mod = factory(P, A);
  if (isNode) module.exports = mod;
  root.NRReplace = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (NRParse, NRAc) {
  'use strict';

  const CONTENT_POS = new Set(['n', 'v', 'adj']);
  const FUNCTION_POS = new Set(['adv', 'conj', 'prep', 'aux', 'part', 'pron', 'num', 'int']);
  const MAX_PER_PARA = 2;
  const MAX_PER_WORD = 2;

  /* ---------- 自然度：与扫词台 scan.js 同一公式（基线 3，clamp 1-5） ----------
     +1 实词 n/v/adj ； -2 副词/连词/虚词
     +1 句尾        ； -1 句首且形容词
     +1 精确/直命中 ； -1 情境
     -1 所在分句 > 14 字
     小说的「行」是分句（约 8-16 字），与歌词一行长度同量级，阈值不用改。 */
  function naturalness(o) {
    const pos_hint = o.pos_hint, precision = o.precision, pos = o.pos, lineLen = o.lineLen;
    let s = 3;
    if (CONTENT_POS.has(pos_hint)) s += 1;
    else if (FUNCTION_POS.has(pos_hint)) s -= 2;
    if (pos === '句尾') s += 1;
    else if (pos === '句首' && pos_hint === 'adj') s -= 1;
    if (precision === '精确' || precision === '直命中') s += 1;
    else if (precision === '情境') s -= 1;
    if (lineLen > 14) s -= 1;
    return Math.max(1, Math.min(5, s));
  }

  function posOf(offset, len, clause) {
    if (!clause) return '句中';
    if (offset <= clause.start) return '句首';
    if (offset + len >= clause.start + clause.len - 1) return '句尾';
    return '句中';
  }

  /* ---------- 专名护栏（R4） ---------- */
  let _pnCache = { key: '', ac: null };
  function properRanges(text, properNouns) {
    const list = (properNouns || []).filter(Boolean);
    if (!list.length) return [];
    const key = list.join('|');
    if (_pnCache.key !== key) _pnCache = { key: key, ac: NRAc.build(list.map(function (p) { return { pat: p }; })) };
    return _pnCache.ac.search(text).map(function (h) { return { start: h.start, end: h.start + h.len }; });
  }
  function inProper(ranges, start, len) {
    return ranges.some(function (r) { return start < r.end && r.start < start + len; });
  }

  /* ---------- 邻字否决（R9） ----------
     表是只读快照，缓存键用**对象引用**（同 findCandidates 的理由：算内容指纹比建表还贵）。 */
  let _vetoCache = { table: null, idx: null };
  function vetoIndex(veto) {
    if (!veto) return null;
    if (_vetoCache.table !== veto) {
      const m = new Map();
      for (const k in veto) {
        const v = veto[k] || {};
        m.set(k, { L: new Set(v.L || []), R: new Set(v.R || []) });
      }
      _vetoCache = { table: veto, idx: m };
    }
    return _vetoCache.idx;
  }
  /** chars 是**码点**数组（NRParse 的 parsed.chars），与候选位的 offset 同一把尺子 */
  function vetoedAt(idx, chars, start, len, expr) {
    if (!idx) return false;
    const v = idx.get(expr);
    if (!v) return false;
    const e = start + len;
    const l1 = start >= 1 ? chars[start - 1] : '';
    const l2 = start >= 2 ? chars[start - 2] + chars[start - 1] : '';
    const r1 = e < chars.length ? chars[e] : '';
    const r2 = e + 1 < chars.length ? chars[e] + chars[e + 1] : '';
    return (!!l1 && v.L.has(l1)) || (!!l2 && v.L.has(l2)) || (!!r1 && v.R.has(r1)) || (!!r2 && v.R.has(r2));
  }

  /* ---------- 桥：word_id + 表达 → {precision, pos_hint} ---------- */
  function bridgeIndex(bridge) {
    const m = new Map();
    for (const b of bridge || []) {
      for (const e of b.exprs || []) m.set(b.word_id + ' ' + e.zh, e);
    }
    return m;
  }

  /** 桥里精度最高的表达（生成模式的写作管线也用它；不变式 I6 同书同词同表达） */
  const RANK = { 直命中: 4, 精确: 3, 近似: 2, 情境: 1 };
  function bestExpr(bridge, word_id) {
    const b = (bridge || []).find(function (x) { return x.word_id === word_id; });
    if (!b || !b.exprs || !b.exprs.length) return null;
    return b.exprs.slice().sort(function (x, y) { return (RANK[y.precision] || 0) - (RANK[x.precision] || 0); })[0];
  }

  /* ---------- 导入模式：桥 + AC 现找可替位 ---------- */
  /* 缓存键用**桥对象的引用**，不是内容指纹。
     原先每次调用都重建 pats 再算 NRAc.version(pats)（map + sort + join 全部模式串）——
     算缓存键比它缓存的东西还贵：5500 词的桥有 16000+ 个模式串，单次 version 约 9ms，
     一本 900 章的书导入时要跑 900 次，光算键就 8 秒，而 AC 本身建一次只要 21ms。
     桥是只读快照（不变式 I11），同一个数组对象就是同一份桥，引用比较足够且是 O(1)。
     桥换了（换快照版本）引用必然变，会正常重建。 */
  let _brCache = { bridge: null, ver: '', ac: null };
  function findCandidates(text, bridge) {
    if (_brCache.bridge !== bridge) {
      const pats = [];
      for (const b of bridge || []) {
        for (const e of b.exprs || []) {
          if (!e.zh) continue;
          pats.push({ pat: e.zh, word_id: b.word_id, precision: e.precision || '近似', pos_hint: e.pos_hint || '' });
        }
      }
      _brCache = { bridge: bridge, ver: NRAc.version(pats), ac: NRAc.build(pats) };
    }
    // 重叠裁决：同扫词台，按 (起点, 精度, 长度) 贪心取不重叠的一组
    const hits = _brCache.ac.search(text);
    hits.sort(function (a, b) {
      return a.start - b.start
        || (RANK[b.ref.precision] || 0) - (RANK[a.ref.precision] || 0)
        || b.len - a.len;
    });
    const acc = [];
    for (const h of hits) {
      const clash = acc.some(function (a) { return h.start < a.offset + a.len && a.offset < h.start + h.len; });
      if (clash) continue;
      acc.push({ word_id: h.ref.word_id, expr: h.pat, offset: h.start, len: h.len });
    }
    return acc;
  }

  /* =============================================================
     主流程
     ============================================================= */
  /**
   * @param {Object} p
   * @param {Object} p.chapter     {n, title, text, word_slots}
   * @param {string} p.book        书 id（首现按「该用户该书」判定）
   * @param {Object} p.plan        scheduler 的输出 {review, reinforce, fresh}（可空）
   * @param {number} p.density     每千字上限 5/8/11/14
   * @param {Object} p.userWords   word_id → 词状态
   * @param {Object} p.profile     {first_hint, ...}
   * @param {Map}    p.words       word_id → 词条
   * @param {Array}  p.bridge      词义桥
   * @param {Array}  p.properNouns 专名表
   * @param {Object} p.veto        邻字否决表 {表达: {L:[], R:[]}}（可空，不传则 R9 不生效）
   * @returns {{html, replaced, quota, parsed, dropped, candidates}}
   */
  function replace(p) {
    const chapter = p.chapter, book = p.book, density = p.density;
    const userWords = p.userWords || {}, profile = p.profile || {};
    const words = p.words, bridge = p.bridge, properNouns = p.properNouns;
    const plan = p.plan || { review: [], reinforce: [], fresh: [] };
    const parsed = NRParse.parseChapter(chapter.text);
    const bIdx = bridgeIndex(bridge);
    const pnRanges = properRanges(chapter.text, properNouns);
    const wordOf = function (id) { return (words instanceof Map) ? words.get(id) : (words || {})[id]; };

    // 词单优先级：复习 > 强化 > 新词 > 其余已见词
    const rank = new Map();
    (plan.review || []).forEach(function (x) { rank.set(x.word_id || x, 0); });
    (plan.reinforce || []).forEach(function (x) { const id = x.word_id || x; if (!rank.has(id)) rank.set(id, 1); });
    (plan.fresh || []).forEach(function (x) { const id = x.word_id || x; if (!rank.has(id)) rank.set(id, 2); });

    // 1) 候选位：生成模式用预置 word_slots；导入模式现找（I1：导入正文只在端上）
    const raw = (chapter.word_slots && chapter.word_slots.length)
      ? chapter.word_slots.slice()
      : findCandidates(chapter.text, bridge);

    const vIdx = vetoIndex(p.veto);
    const dropped = { proper: 0, natural: 0, skip: 0, noword: 0, perClause: 0, perPara: 0, perWord: 0, quota: 0, veto: 0 };
    const cands = [];
    for (const s of raw) {
      const w = wordOf(s.word_id);
      if (!w) { dropped.noword++; continue; }
      const uw = userWords[s.word_id];
      if (uw && uw.state === '跳过') { dropped.skip++; continue; }              // 「不学这个词」
      if (inProper(pnRanges, s.offset, s.len)) { dropped.proper++; continue; }  // R4
      if (vetoedAt(vIdx, parsed.chars, s.offset, s.len, s.expr)) { dropped.veto++; continue; }  // R9
      const clause = NRParse.locate(parsed.clauses, s.offset);
      const e = bIdx.get(s.word_id + ' ' + s.expr) || {};
      const pos = posOf(s.offset, s.len, clause);
      const nat = naturalness({
        pos_hint: e.pos_hint || w.pos,
        precision: e.precision || '近似',
        pos: pos,
        lineLen: clause ? clause.len : 20,
      });
      if (nat < 3) { dropped.natural++; continue; }                             // R3
      cands.push({
        word_id: s.word_id, word: w.word, expr: s.expr, offset: s.offset, len: s.len,
        clause: clause ? clause.i : -1, para: clause ? clause.para : -1,
        pos: pos, precision: e.precision || '近似', pos_hint: e.pos_hint || w.pos,
        naturalness: nat,
        planRank: rank.has(s.word_id) ? rank.get(s.word_id) : 3,
        exposures: uw ? uw.exposures : 0,
      });
    }

    // 2) 配额（R1）
    const quota = Math.max(0, Math.floor(parsed.wordCount / 1000 * density));

    // 3) 挑位：词单优先级 → 自然度 → 曝光少的优先 → 位置靠前
    const order = cands.slice().sort(function (a, b) {
      return a.planRank - b.planRank
        || b.naturalness - a.naturalness
        || a.exposures - b.exposures
        || a.offset - b.offset;
    });

    const usedClause = new Set(), perPara = new Map(), perWord = new Map();
    const picked = [];
    for (const c of order) {
      if (picked.length >= quota) { dropped.quota++; continue; }                              // R1
      if (usedClause.has(c.clause)) { dropped.perClause++; continue; }                        // R2
      if ((perPara.get(c.para) || 0) >= MAX_PER_PARA) { dropped.perPara++; continue; }        // R7
      if ((perWord.get(c.word_id) || 0) >= MAX_PER_WORD) { dropped.perWord++; continue; }     // R8
      usedClause.add(c.clause);
      perPara.set(c.para, (perPara.get(c.para) || 0) + 1);
      perWord.set(c.word_id, (perWord.get(c.word_id) || 0) + 1);
      picked.push(c);
    }
    picked.sort(function (a, b) { return a.offset - b.offset; });

    // 4) 首现（R5）：该用户该书首次出现该词 → 带（中文）；同章第二次不带
    const shownFirst = new Set();
    for (const c of picked) {
      const uw = userWords[c.word_id];
      const seenInBook = !!(uw && uw.first_seen && uw.first_seen.book === book);
      c.first = (profile.first_hint !== false) && !seenInBook && !shownFirst.has(c.word_id);
      if (c.first) shownFirst.add(c.word_id);
    }

    // 5) 渲染（R6：只输出原形 w.word）
    const html = render(parsed, picked, userWords);
    return { html: html, replaced: picked, quota: quota, parsed: parsed, dropped: dropped, candidates: cands.length };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function render(parsed, picked, userWords) {
    const cs = parsed.chars;
    const out = [];
    let pi = 0;
    for (const para of parsed.paras) {
      const end = para.start + para.len;
      let cur = para.start;
      let inner = '';
      while (pi < picked.length && picked[pi].offset < para.start) pi++;
      while (pi < picked.length && picked[pi].offset < end) {
        const c = picked[pi];
        inner += esc(cs.slice(cur, c.offset).join(''));
        const st = (userWords[c.word_id] || {}).state || '未见';
        inner += '<w class="w" data-id="' + esc(c.word_id) + '" data-off="' + c.offset + '"'
          + ' data-state="' + esc(st) + '"' + (c.first ? ' data-first="1"' : '') + '>'
          + esc(c.word)
          + (c.first ? '<span class="w-zh">（' + esc(c.expr) + '）</span>' : '')
          + '</w>';
        cur = c.offset + c.len;
        pi++;
      }
      inner += esc(cs.slice(cur, end).join(''));
      out.push('<p class="para" data-p="' + para.i + '">' + inner + '</p>');
    }
    return out.join('\n');
  }

  return {
    replace: replace, naturalness: naturalness, findCandidates: findCandidates,
    bestExpr: bestExpr, bridgeIndex: bridgeIndex, properRanges: properRanges,
    vetoIndex: vetoIndex, vetoedAt: vetoedAt,
    MAX_PER_PARA: MAX_PER_PARA, MAX_PER_WORD: MAX_PER_WORD,
  };
});

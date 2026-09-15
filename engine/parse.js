/* =============================================================
   parse.js · 章节解析（真实现）
   章节正文 → 段落 / 分句 / 句子，全部带「码点」偏移，与 word_slots 的 offset 同坐标系。
   零依赖。UMD：浏览器挂 globalThis.NRParse，Node 可 require。
   M0 原样搬进 app/server/（端与云同一份，不变式 I2）。

   口径（产品文档 §4.1「一行 ≤ 1 处」的落地解释）：
     · 段 = 空行分隔的自然段
     · 行 = 分句：以 。！？；…—— ，、：与换行切开的小句
       （中文小说里「一行」随字号浮动，不能用渲染行；分句是稳定且更保阅读的代理）
     · 句 = 整句：只以 。！？…… 与引号收束切开，给章末小测挖空用（不变式 I7）
   ============================================================= */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.NRParse = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CLAUSE_END = new Set(['。', '！', '？', '；', '，', '、', '：', '…', '—', '\n']);
  const SENT_END = new Set(['。', '！', '？', '…']);
  const CLOSERS = new Set(['"', '"', '」', '』', '）', ')', '》']);

  /** 码点数组 —— 中文与 emoji 安全，与 ac.js 的 start/len 同单位 */
  function chars(text) { return Array.from(String(text ?? '')); }

  /**
   * 切段。段之间以一个或多个空行分隔。
   * @returns {Array<{i:number,start:number,len:number,text:string}>}
   */
  function paragraphs(text) {
    const cs = chars(text);
    const out = [];
    let i = 0;
    while (i < cs.length) {
      while (i < cs.length && (cs[i] === '\n' || cs[i] === '\r')) i++;
      if (i >= cs.length) break;
      const start = i;
      while (i < cs.length && cs[i] !== '\n') i++;
      const len = i - start;
      if (len > 0) out.push({ i: out.length, start, len, text: cs.slice(start, start + len).join('') });
    }
    return out;
  }

  /** 通用切分：给一组终止符，切出带偏移的片段（终止符归前一片） */
  function splitBy(text, base, enders) {
    const cs = chars(text);
    const out = [];
    let start = 0;
    for (let i = 0; i < cs.length; i++) {
      if (!enders.has(cs[i])) continue;
      let end = i + 1;
      while (end < cs.length && (enders.has(cs[end]) || CLOSERS.has(cs[end]))) end++;
      const seg = cs.slice(start, end).join('');
      if (seg.trim()) out.push({ start: base + start, len: end - start, text: seg });
      start = end;
      i = end - 1;
    }
    if (start < cs.length) {
      const seg = cs.slice(start).join('');
      if (seg.trim()) out.push({ start: base + start, len: cs.length - start, text: seg });
    }
    return out;
  }

  /** 分句（「一行」）—— 替换引擎的「一行 ≤ 1 处」用它 */
  function clauses(text, base) { return splitBy(text, base || 0, CLAUSE_END); }

  /** 整句 —— 章末小测挖空用它（I7：题目只出自本章句子） */
  function sentences(text, base) { return splitBy(text, base || 0, SENT_END); }

  /**
   * 一次解析出全章结构。
   * @returns {{text, chars, paras, clauses, sents, wordCount}}
   */
  function parseChapter(text) {
    const t = String(text ?? '');
    const paras = paragraphs(t);
    const cls = [];
    const sts = [];
    for (const p of paras) {
      for (const c of clauses(p.text, p.start)) cls.push({ ...c, para: p.i, i: cls.length });
      for (const s of sentences(p.text, p.start)) sts.push({ ...s, para: p.i, i: sts.length });
    }
    // 字数：去掉空白与标点后的汉字/字母数，密度配额按它算
    const wordCount = Array.from(t.replace(/[\s　]/g, '')).length;
    return { text: t, chars: chars(t), paras, clauses: cls, sents: sts, wordCount };
  }

  /** 找出包含 [offset, offset+len) 的那一片（分句或整句） */
  function locate(list, offset) {
    for (const s of list) if (offset >= s.start && offset < s.start + s.len) return s;
    return null;
  }

  return { parseChapter, paragraphs, clauses, sentences, locate, chars };
});

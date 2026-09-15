/* =============================================================
   ac.js · Aho–Corasick 多模式匹配（真实现，与扫词台同一份）
   桥表达是多字词，直接串匹配，不需要分词器：结果确定、可复现、零依赖。
   UMD：浏览器挂 globalThis.NRAc，Node 走 module.exports。
   ============================================================= */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.NRAc = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * 构建自动机。
   * @param {Array<{pat:string}&Object>} patterns 每项必须有 pat，其余字段原样带回
   * @returns {{search:(text:string)=>Array, size:number, count:number, version:string}}
   */
  function build(patterns) {
    const pats = (patterns || []).filter((p) => p && p.pat);
    // 节点：next(Map) / fail / out(索引数组)
    const next = [new Map()];
    const fail = [0];
    const out = [null];

    function newNode() { next.push(new Map()); fail.push(0); out.push(null); return next.length - 1; }

    pats.forEach((p, idx) => {
      let node = 0;
      for (const ch of p.pat) {
        let nx = next[node].get(ch);
        if (nx === undefined) { nx = newNode(); next[node].set(ch, nx); }
        node = nx;
      }
      (out[node] || (out[node] = [])).push(idx);
    });

    // BFS 建 fail 指针 + 合并输出
    const queue = [];
    for (const [, nx] of next[0]) { fail[nx] = 0; queue.push(nx); }
    for (let qi = 0; qi < queue.length; qi++) {
      const node = queue[qi];
      const f = fail[node];
      if (out[f]) out[node] = (out[node] || []).concat(out[f]);
      for (const [ch, nx] of next[node]) {
        let s = f;
        while (s !== 0 && !next[s].has(ch)) s = fail[s];
        fail[nx] = next[s].has(ch) ? next[s].get(ch) : 0;
        if (fail[nx] === nx) fail[nx] = 0;
        queue.push(nx);
      }
    }

    /**
     * 在 text 上跑一遍，返回全部命中（含重叠，交给上层裁决）。
     * start/len 以「码点」为单位与 Array.from(text) 一致（中文安全）。
     */
    function search(text) {
      const chars = Array.from(String(text ?? ''));
      const hits = [];
      let node = 0;
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        while (node !== 0 && !next[node].has(ch)) node = fail[node];
        node = next[node].has(ch) ? next[node].get(ch) : 0;
        const o = out[node];
        if (o) for (const idx of o) {
          const len = Array.from(pats[idx].pat).length;
          hits.push({ start: i - len + 1, len, pat: pats[idx].pat, ref: pats[idx] });
        }
      }
      hits.sort((a, b) => a.start - b.start || b.len - a.len);
      return hits;
    }

    return { search, size: next.length, count: pats.length, version: version(pats) };
  }

  /** FNV-1a 32bit → 5 位十六进制短串，用作 bridge_version（同桥同版本，可复现） */
  function version(patterns) {
    const key = (patterns || []).map((p) => `${p.pat}|${p.word_id || ''}|${p.precision || ''}`).sort().join('\n');
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0').slice(0, 5);
  }

  return { build, version };
});

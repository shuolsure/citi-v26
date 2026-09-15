/* =============================================================
   inflate.js · 原始 DEFLATE（RFC 1951）解压，零依赖
   小程序没有 DecompressionStream / zlib，EPUB 的 ZIP 条目要靠它。
   为什么自己写而不引 fflate/pako：只要 inflateRaw 一个函数；自己写 ~200 行，
   可以在 Node 里拿 zlib.deflateRawSync 做随机对拍（tests/smoke.mjs 第 1 节）。

   实现：查表解码（表长 2^maxLen，maxLen ≤ 15），比逐位规范解码快一个量级，
   一个块建两张表最多 32K 次写入，可忽略。
   UMD：Node 走 module.exports；其他环境挂 globalThis.MPInflate。
   ============================================================= */
(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const mod = factory();
  if (isNode) module.exports = mod;
  root.MPInflate = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function err(msg) { const e = new Error('inflate: ' + msg); e.code = 'CORRUPT'; return e; }

  /** 码长数组 → 查表 {table:Int32Array, bits}。表项 = (len << 16) | symbol，0 表示非法码 */
  function buildTable(lengths, n) {
    let maxLen = 0;
    for (let i = 0; i < n; i++) if (lengths[i] > maxLen) maxLen = lengths[i];
    if (maxLen === 0) return { table: new Int32Array(1), bits: 0, empty: true };
    const count = new Uint16Array(16);
    for (let i = 0; i < n; i++) count[lengths[i]]++;
    count[0] = 0;
    const next = new Uint16Array(16);
    let code = 0;
    for (let len = 1; len < 16; len++) { code = (code + count[len - 1]) << 1; next[len] = code; }
    const size = 1 << maxLen;
    const table = new Int32Array(size);
    for (let sym = 0; sym < n; sym++) {
      const len = lengths[sym];
      if (!len) continue;
      let c = next[len]++;
      // deflate 的码是 MSB-first 写、但比特流 LSB-first 读 → 反转 len 位
      let rev = 0;
      for (let k = 0; k < len; k++) { rev = (rev << 1) | (c & 1); c >>= 1; }
      const step = 1 << len;
      for (let j = rev; j < size; j += step) table[j] = (len << 16) | sym;
    }
    return { table: table, bits: maxLen };
  }

  let FIXED_LIT = null, FIXED_DIST = null;
  function fixedTables() {
    if (FIXED_LIT) return;
    const l = new Uint8Array(288);
    for (let i = 0; i < 144; i++) l[i] = 8;
    for (let i = 144; i < 256; i++) l[i] = 9;
    for (let i = 256; i < 280; i++) l[i] = 7;
    for (let i = 280; i < 288; i++) l[i] = 8;
    FIXED_LIT = buildTable(l, 288);
    const d = new Uint8Array(30);
    for (let i = 0; i < 30; i++) d[i] = 5;
    FIXED_DIST = buildTable(d, 30);
  }

  /**
   * @param {Uint8Array} src 原始 deflate 流（不含 zlib/gzip 头）
   * @param {number} [expected] 已知的解压后长度（ZIP 目录里有），省去扩容
   * @returns {Uint8Array}
   */
  function inflateRaw(src, expected) {
    let pos = 0, bitbuf = 0, bitcnt = 0;
    let out = new Uint8Array(expected > 0 ? expected : Math.max(4096, src.length * 4));
    let olen = 0;

    function grow(n) {
      if (olen + n <= out.length) return;
      const no = new Uint8Array(Math.max(out.length * 2, olen + n));
      no.set(out.subarray(0, olen));
      out = no;
    }
    function fill(n) {   // 保证 bitcnt ≥ n（流尾用 0 补，非法码由查表发现）
      while (bitcnt < n) {
        bitbuf |= (pos < src.length ? src[pos] : 0) << bitcnt;
        pos++;
        bitcnt += 8;
      }
    }
    function bits(n) {
      if (n === 0) return 0;
      fill(n);
      const v = bitbuf & ((1 << n) - 1);
      bitbuf >>>= n; bitcnt -= n;
      return v;
    }
    function decode(h) {
      if (h.empty) throw err('用了空表');
      fill(h.bits);
      const e = h.table[bitbuf & ((1 << h.bits) - 1)];
      if (!e) throw err('非法哈夫曼码');
      const len = e >>> 16;
      bitbuf >>>= len; bitcnt -= len;
      return e & 0xFFFF;
    }
    function checkEnd() {
      // 读位置减去还没消费的整字节数，不能越过输入尾巴太多（流尾补零允许 ≤ 4 字节）
      if (pos - (bitcnt >> 3) > src.length + 4) throw err('输入提前结束');
    }

    let final = 0;
    do {
      final = bits(1);
      const type = bits(2);
      if (type === 0) {
        // 存储块：对齐到字节。fill 可能已经把后面整字节读进 bitbuf，先把它们退回去
        pos -= bitcnt >> 3;
        bitbuf = 0; bitcnt = 0;
        if (pos + 4 > src.length) throw err('存储块头越界');
        const len = src[pos] | (src[pos + 1] << 8);
        const nlen = src[pos + 2] | (src[pos + 3] << 8);
        if ((len ^ 0xFFFF) !== nlen) throw err('存储块长度校验失败');
        pos += 4;
        if (pos + len > src.length) throw err('存储块越界');
        grow(len);
        out.set(src.subarray(pos, pos + len), olen);
        olen += len; pos += len;
        continue;
      }
      let lit, dist;
      if (type === 1) { fixedTables(); lit = FIXED_LIT; dist = FIXED_DIST; }
      else if (type === 2) {
        const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
        const clTable = buildTable(cl, 19);
        const lengths = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const sym = decode(clTable);
          if (sym < 16) lengths[i++] = sym;
          else if (sym === 16) {
            if (i === 0) throw err('重复码长无前驱');
            const prev = lengths[i - 1], r = 3 + bits(2);
            if (i + r > hlit + hdist) throw err('码长溢出');
            for (let k = 0; k < r; k++) lengths[i++] = prev;
          } else {
            const r = sym === 17 ? 3 + bits(3) : 11 + bits(7);
            if (i + r > hlit + hdist) throw err('码长溢出');
            i += r;   // Uint8Array 默认 0
          }
        }
        lit = buildTable(lengths.subarray(0, hlit), hlit);
        dist = buildTable(lengths.subarray(hlit), hdist);
      } else throw err('非法块类型 3');

      for (;;) {
        const sym = decode(lit);
        if (sym < 256) { if (olen >= out.length) grow(1); out[olen++] = sym; continue; }
        if (sym === 256) break;
        const li = sym - 257;
        if (li >= 29) throw err('非法长度码');
        const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
        const di = decode(dist);
        if (di >= 30) throw err('非法距离码');
        const d = DIST_BASE[di] + bits(DIST_EXTRA[di]);
        if (d > olen) throw err('回溯距离超出已输出');
        grow(len);
        // 允许重叠拷贝（d < len 时是重复模式）
        let s = olen - d;
        for (let k = 0; k < len; k++) out[olen++] = out[s++];
        if ((olen & 0xFFFF) === 0) checkEnd();
      }
    } while (!final);
    checkEnd();
    return olen === out.length ? out : out.subarray(0, olen);
  }

  return { inflateRaw: inflateRaw };
});

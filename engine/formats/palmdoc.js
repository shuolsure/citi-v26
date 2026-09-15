/* =============================================================
   palmdoc.js · PalmDB 容器 + PalmDOC LZ77 + HUFF/CDIC 解码 + 记录尾部剥离
   MOBI / AZW / AZW3 / PRC 共用这一层。规格来源：MobileRead Wiki（PDB / MOBI / PalmDOC）。
   ★ 不抄 KindleUnpack 代码（GPLv3），只按公开格式描述实现。

   PalmDOC LZ77（type 2）40 行；HUFF/CDIC（type 17480）是 kindlegen 的可选压缩，
   Calibre 从不生成它 —— 本目录夹具里若没有 HUFF 文件，那部分代码就是「按规格写、未经真书验证」，README 里要如实标注。
   UMD：Node 走 module.exports；其他环境挂 globalThis.MPPalm。
   ============================================================= */
(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const D = isNode ? require('./deps.js') : root.MPFmtDeps;
  const mod = factory(D);
  if (isNode) module.exports = mod;
  root.MPPalm = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Deps) {
  'use strict';

  function err(code, msg, hint) { const e = new Error('palm: ' + msg); e.code = code; if (hint) e.hint = hint; return e; }
  function u16(b, p) { return (b[p] << 8) | b[p + 1]; }                                   // PDB 全是大端
  function u32(b, p) { return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; }

  /**
   * 读 PDB 头与记录表。
   * @returns {{ name, type, creator, records:[{start,end,id}], bytes }}
   */
  function readPdb(buf) {
    const b = Deps.toBytes(buf);
    if (b.length < 78) throw err('CORRUPT', '文件太短，不是 PalmDB');
    const type = Deps.ascii(b, 60, 64), creator = Deps.ascii(b, 64, 68);
    const num = u16(b, 76);
    if (78 + num * 8 > b.length) throw err('CORRUPT', '记录表越界');
    const offs = [];
    for (let i = 0; i < num; i++) offs.push(u32(b, 78 + i * 8));
    const records = [];
    for (let i = 0; i < num; i++) {
      const start = offs[i], end = i + 1 < num ? offs[i + 1] : b.length;
      if (start > end || end > b.length) throw err('CORRUPT', '记录 ' + i + ' 偏移非法');
      records.push({ start: start, end: end });
    }
    // 名字：32 字节 NUL 结尾
    let nameEnd = 0; while (nameEnd < 32 && b[nameEnd]) nameEnd++;
    return { name: Deps.ascii(b, 0, nameEnd), type: type, creator: creator, records: records, bytes: b };
  }
  function record(pdb, i) {
    const r = pdb.records[i];
    if (!r) throw err('CORRUPT', '记录 ' + i + ' 不存在');
    return pdb.bytes.subarray(r.start, r.end);
  }

  /* ---------- PalmDOC LZ77 ---------- */
  function lz77(src) {
    const out = new Uint8Array(src.length * 8 + 4096);   // 单记录 ≤ 4096 解压后，×8 足够
    let o = 0;
    for (let i = 0; i < src.length;) {
      const c = src[i++];
      if (c === 0) out[o++] = 0;
      else if (c <= 8) { for (let k = 0; k < c && i < src.length; k++) out[o++] = src[i++]; }
      else if (c <= 0x7F) out[o++] = c;
      else if (c <= 0xBF) {
        if (i >= src.length) break;
        const pair = ((c << 8) | src[i++]) & 0x3FFF;
        const dist = pair >> 3, len = (pair & 7) + 3;
        if (dist === 0 || dist > o) throw err('CORRUPT', 'LZ77 回溯越界');
        for (let k = 0; k < len; k++) { out[o] = out[o - dist]; o++; }
      } else { out[o++] = 0x20; out[o++] = c ^ 0x80; }
    }
    return out.subarray(0, o);
  }

  /* ---------- 记录尾部：多字节补齐 + TBS 索引 ---------- */
  /** 尾部一条「反向变长整数」标明的长度 */
  function trailingEntrySize(rec, size) {
    let bitpos = 0, result = 0;
    for (;;) {
      const v = rec[size - 1];
      result |= (v & 0x7F) << bitpos;
      bitpos += 7; size--;
      if ((v & 0x80) || bitpos >= 28 || size === 0) return result;
    }
  }
  /** 按 extraFlags 算出要从记录尾剥掉多少字节 */
  function trailingSize(rec, extraFlags) {
    let size = rec.length, num = 0;
    let flags = extraFlags >>> 1;
    while (flags) {
      if (flags & 1) num += trailingEntrySize(rec, size - num);
      flags >>>= 1;
    }
    if (extraFlags & 1) num += (rec[size - num - 1] & 3) + 1;   // 多字节补齐：低 2 位 + 1
    return Math.min(num, size);
  }

  /* ---------- HUFF / CDIC ---------- */
  /**
   * 构造 HUFF/CDIC 解码器。
   * @param {Uint8Array} huff 'HUFF' 记录
   * @param {Uint8Array[]} cdics 'CDIC' 记录数组
   * @returns {function(Uint8Array):Uint8Array}
   */
  function huffcdic(huff, cdics) {
    if (Deps.ascii(huff, 0, 4) !== 'HUFF') throw err('CORRUPT', 'HUFF 记录签名错误');
    const cacheOff = u32(huff, 8), baseOff = u32(huff, 12);
    // dict1：256 项，索引 = 码的高 8 位
    const d1len = new Uint8Array(256), d1term = new Uint8Array(256), d1max = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      const v = u32(huff, cacheOff + i * 4);
      const codelen = v & 0x1F, term = v & 0x80, maxcode = v >>> 8;
      if (codelen === 0) throw err('CORRUPT', 'HUFF 码长为 0');
      if (codelen <= 8 && !term) throw err('CORRUPT', 'HUFF 短码非终结');
      d1len[i] = codelen; d1term[i] = term ? 1 : 0;
      d1max[i] = (((maxcode + 1) * Math.pow(2, 32 - codelen)) - 1) >>> 0;
    }
    const mincode = new Array(33), maxcode = new Array(33);
    for (let i = 1; i <= 32; i++) {
      const lo = u32(huff, baseOff + (i - 1) * 8), hi = u32(huff, baseOff + (i - 1) * 8 + 4);
      mincode[i] = (lo * Math.pow(2, 32 - i)) % 4294967296;
      maxcode[i] = (((hi + 1) * Math.pow(2, 32 - i)) - 1) % 4294967296;
    }
    // 词典：所有 CDIC 的条目顺序拼接
    const dict = [];
    for (let c = 0; c < cdics.length; c++) {
      const cd = cdics[c];
      if (Deps.ascii(cd, 0, 4) !== 'CDIC') throw err('CORRUPT', 'CDIC 记录签名错误');
      const phrases = u32(cd, 8), bits = u32(cd, 12);
      const n = Math.min(1 << bits, phrases - dict.length);
      for (let k = 0; k < n; k++) {
        const off = u16(cd, 16 + k * 2);
        const blen = u16(cd, 16 + off);
        const slice = cd.subarray(18 + off, 18 + off + (blen & 0x7FFF));
        dict.push({ bytes: slice, done: !!(blen & 0x8000) });
      }
    }

    /** 从 bitpos 起读 32 位（越界补 0） */
    function peek32(data, bitpos) {
      const bp = bitpos >>> 3, sh = bitpos & 7;
      const b0 = data[bp] || 0, b1 = data[bp + 1] || 0, b2 = data[bp + 2] || 0, b3 = data[bp + 3] || 0, b4 = data[bp + 4] || 0;
      const hi = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
      if (sh === 0) return hi;
      return (((hi * Math.pow(2, sh)) % 4294967296) + (b4 >>> (8 - sh))) >>> 0;
    }

    function unpack(data, depth) {
      if (depth > 32) throw err('CORRUPT', 'HUFF 递归过深');
      const chunks = [];
      let total = 0;
      const bitsTotal = data.length * 8;
      let bitpos = 0;
      for (;;) {
        const code = peek32(data, bitpos);
        const hi8 = code >>> 24;
        let codelen = d1len[hi8];
        let max = d1max[hi8];
        if (!d1term[hi8]) {
          while (code < mincode[codelen]) { codelen++; if (codelen > 32) throw err('CORRUPT', 'HUFF 码长溢出'); }
          max = maxcode[codelen];
        }
        bitpos += codelen;
        if (bitpos > bitsTotal) break;
        const r = Math.floor((max - code) / Math.pow(2, 32 - codelen));
        const entry = dict[r];
        if (!entry) throw err('CORRUPT', 'HUFF 词典索引越界 ' + r);
        let bytes;
        if (entry.done) bytes = entry.bytes;
        else {
          dict[r] = null;                       // 防环
          bytes = unpack(entry.bytes, depth + 1);
          dict[r] = { bytes: bytes, done: true };
        }
        chunks.push(bytes); total += bytes.length;
      }
      const out = new Uint8Array(total);
      let o = 0;
      for (let i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
      return out;
    }
    return function (rec) { return unpack(rec, 0); };
  }

  function concat(parts) {
    let total = 0;
    for (let i = 0; i < parts.length; i++) total += parts[i].length;
    const out = new Uint8Array(total);
    let o = 0;
    for (let i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
    return out;
  }

  return { readPdb: readPdb, record: record, lz77: lz77, trailingSize: trailingSize, huffcdic: huffcdic, concat: concat, u16: u16, u32: u32 };
});

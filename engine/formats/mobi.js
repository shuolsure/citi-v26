/* =============================================================
   mobi.js · MOBI / AZW（KF7）/ AZW3（KF8）→ 正文 HTML
   记录 0 = PalmDOC 头(16) + MOBI 头 + EXTH；文本记录用 palmdoc.js 解压；KF8 多一层 FDST 流切分。
   输出 { format:'mobi'|'azw3', kf8, title, author, language, encoding, compression, html, textIsPlain, warnings }
   html 交给 html2text.js；KF7 的 <mbp:pagebreak/> 由 html2text 标成块的 pagebreak。

   DRM：PalmDOC 头 encryption ≠ 0 → 抛 {code:'DRM'}，**不做任何解密尝试**。
   KF8 规范做法要用 SKEL/FRAG 索引把片段插回骨架 —— 我们只要正文流 0 的原始顺序，直接剥标签。
   MOBI 头偏移（相对记录 0 起点）：16 'MOBI' · 20 头长 · 24 类型 · 28 编码 · 36 版本 · 80 首个非文本记录 ·
     84/88 全名偏移/长度 · 108 首图 · 112/116 HUFF 记录号/数 · 128 EXTH 标志 · 192/196 FDST 记录/数(KF8) ·
     0xF2 尾部数据标志(u16, 头长 ≥ 0xE4 且版本 ≥ 5) · 0xF8 FRAG · 0xFC SKEL
   UMD：Node 走 module.exports；其他环境挂 globalThis.MPMobi。
   ============================================================= */
(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const P = isNode ? require('./palmdoc.js') : root.MPPalm;
  const D = isNode ? require('./deps.js') : root.MPFmtDeps;
  const mod = factory(P, D);
  if (isNode) module.exports = mod;
  root.MPMobi = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Palm, Deps) {
  'use strict';

  const u16 = Palm.u16, u32 = Palm.u32;
  function err(code, msg, hint) { const e = new Error('mobi: ' + msg); e.code = code; if (hint) e.hint = hint; return e; }

  const EXTH_NAMES = { 100: 'author', 101: 'publisher', 103: 'description', 104: 'isbn', 105: 'subject', 106: 'date', 121: 'kf8Boundary', 125: 'resourceCount', 503: 'title', 524: 'language' };

  /** 解析一条头记录（记录 0，或 KF8 的边界后那条） */
  function parseHeader(rec) {
    if (rec.length < 16) throw err('CORRUPT', '头记录太短');
    const h = {
      compression: u16(rec, 0), textLength: u32(rec, 4), textRecords: u16(rec, 8), recordSize: u16(rec, 10), encryption: u16(rec, 12),
      mobi: false, version: 0, encoding: 1252, headerLength: 0, extraFlags: 0, exth: {},
    };
    if (Deps.ascii(rec, 16, 20) !== 'MOBI') return h;             // 纯 PalmDOC（TEXtREAd）
    h.mobi = true;
    h.headerLength = u32(rec, 20);
    h.mobiType = u32(rec, 24);
    h.encoding = u32(rec, 28);
    h.version = u32(rec, 36);
    h.firstNonText = u32(rec, 80);
    const nameOff = u32(rec, 84), nameLen = u32(rec, 88);
    if (nameOff + nameLen <= rec.length) h.fullName = Deps.bytesToText(rec.subarray(nameOff, nameOff + nameLen), h.encoding === 65001 ? 'utf-8' : 'cp1252').text;
    h.locale = u32(rec, 92);
    h.minVersion = u32(rec, 104);
    h.firstImage = u32(rec, 108);
    h.huffRecord = u32(rec, 112);
    h.huffCount = u32(rec, 116);
    h.exthFlags = u32(rec, 128);
    if (h.headerLength >= 0xE4 && h.version >= 5 && rec.length >= 0xF4) h.extraFlags = u16(rec, 0xF2);
    if (h.version >= 8 && rec.length >= 0x100) {
      h.fdstRecord = u32(rec, 192); h.fdstCount = u32(rec, 196);
      h.fragRecord = u32(rec, 0xF8); h.skelRecord = u32(rec, 0xFC);
    } else if (rec.length >= 196) {
      h.firstContent = u16(rec, 192); h.lastContent = u16(rec, 194);
    }
    // EXTH
    if (h.exthFlags & 0x40) {
      const p = 16 + h.headerLength;
      if (Deps.ascii(rec, p, p + 4) === 'EXTH') {
        const count = u32(rec, p + 8);
        let q = p + 12;
        for (let i = 0; i < count && q + 8 <= rec.length; i++) {
          const type = u32(rec, q), len = u32(rec, q + 4);
          if (len < 8 || q + len > rec.length) break;
          const data = rec.subarray(q + 8, q + len);
          const name = EXTH_NAMES[type];
          if (name) {
            if (type === 121 || type === 125) h.exth[name] = u32(data, 0);
            else h.exth[name] = Deps.bytesToText(data, h.encoding === 65001 ? 'utf-8' : 'cp1252').text;
          }
          q += len;
        }
      }
    }
    return h;
  }

  /** 把 base 起的 count 条文本记录解压拼接成字节 */
  function extractText(pdb, base, h, warnings) {
    let decode;
    if (h.compression === 1) decode = function (r) { return r; };
    else if (h.compression === 2) decode = Palm.lz77;
    else if (h.compression === 17480) {
      const huffBase = base + h.huffRecord;
      const huff = Palm.record(pdb, huffBase);
      const cdics = [];
      for (let i = 1; i < h.huffCount; i++) cdics.push(Palm.record(pdb, huffBase + i));
      decode = Palm.huffcdic(huff, cdics);
      warnings.push('HUFF/CDIC 压缩：解码器按规格实现，样本覆盖有限');
    } else throw err('UNSUPPORTED', '未知压缩类型 ' + h.compression);

    const parts = [];
    let produced = 0;
    for (let i = 1; i <= h.textRecords; i++) {
      const idx = base + i;
      if (idx >= pdb.records.length) { warnings.push('文本记录数超出文件，实际只有 ' + (i - 1) + ' 条'); break; }
      let rec = Palm.record(pdb, idx);
      const trail = Palm.trailingSize(rec, h.extraFlags);
      if (trail) rec = rec.subarray(0, rec.length - trail);
      const out = decode(rec);
      parts.push(out);
      produced += out.length;
    }
    let bytes = Palm.concat(parts);
    if (h.textLength && produced > h.textLength) bytes = bytes.subarray(0, h.textLength);
    else if (h.textLength && produced < h.textLength * 0.98) warnings.push('解出的正文比头部声明短（' + produced + ' / ' + h.textLength + '）');
    return bytes;
  }

  /** KF8：FDST 记录 → 各流 [start,end)；取流 0 */
  function flow0(pdb, base, h, bytes, warnings) {
    if (h.fdstRecord == null || h.fdstRecord === 0xFFFFFFFF) return bytes;
    const idx = base + h.fdstRecord;
    if (idx >= pdb.records.length) { warnings.push('FDST 记录号越界，按整段处理'); return bytes; }
    const fd = Palm.record(pdb, idx);
    if (Deps.ascii(fd, 0, 4) !== 'FDST') { warnings.push('FDST 签名不符，按整段处理'); return bytes; }
    const count = u32(fd, 8);
    if (count < 1) return bytes;
    const start = u32(fd, 12), end = u32(fd, 16);
    if (end > bytes.length || start >= end) { warnings.push('FDST 流 0 边界非法，按整段处理'); return bytes; }
    return bytes.subarray(start, end);
  }

  /**
   * @param {ArrayBuffer|Uint8Array} buf
   * @param {Object} [opts] { preferKf7?: boolean }  合体文件默认取 KF8 段
   */
  function parse(buf, opts) {
    const o = opts || {};
    const warnings = [];
    const pdb = Palm.readPdb(buf);
    const sig = pdb.type + pdb.creator;
    if (sig !== 'BOOKMOBI' && sig !== 'TEXtREAd') throw err('UNSUPPORTED', '不是 MOBI/PalmDOC（type/creator=' + sig + '）');

    let base = 0;
    let h = parseHeader(Palm.record(pdb, 0));
    let kf8 = h.mobi && h.version >= 8;
    // 合体文件：EXTH 121 指向 KF8 头记录
    const boundary = h.exth.kf8Boundary;
    if (!kf8 && !o.preferKf7 && boundary && boundary < pdb.records.length && boundary !== 0xFFFFFFFF) {
      try {
        const h8 = parseHeader(Palm.record(pdb, boundary));
        if (h8.mobi && h8.version >= 8) { base = boundary; h = h8; kf8 = true; }
      } catch (e) { warnings.push('KF8 段头解析失败，退回 KF7: ' + e.message); }
    }
    if (h.encryption !== 0) throw err('DRM', '正文已加密（encryption=' + h.encryption + '）', '这本书受版权保护，暂不支持导入');

    const bytes = extractText(pdb, base, h, warnings);
    const body = kf8 ? flow0(pdb, base, h, bytes, warnings) : bytes;
    const enc = h.encoding === 65001 ? 'utf-8' : h.encoding === 1252 ? 'cp1252' : null;
    if (enc == null) warnings.push('未知 textEncoding ' + h.encoding + '，按自动识别');
    const dec = Deps.bytesToText(body, enc);
    if (dec.badRate > 0.005) warnings.push('正文乱码率 ' + (dec.badRate * 100).toFixed(2) + '%');

    return {
      format: kf8 ? 'azw3' : 'mobi',
      kf8: kf8,
      version: h.version,
      title: h.exth.title || h.fullName || pdb.name || null,
      author: h.exth.author || null,
      language: h.exth.language || null,
      encoding: dec.encoding,
      compression: h.compression,
      textIsPlain: !h.mobi,             // TEXtREAd：不是 HTML，是纯文本
      html: dec.text,
      exth: h.exth,
      warnings: warnings,
    };
  }

  return { parse: parse, parseHeader: parseHeader };
});

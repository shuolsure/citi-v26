/* =============================================================
   zip.js · 只读 ZIP：中央目录 → 按名取条目 → inflate + CRC32
   面向 EPUB：只解析目录，**按需**解压单个条目（图片一张都不碰）。
   不支持 ZIP64（EPUB 不会超 4GB）、不支持加密条目（EPUB 的 DRM 走 encryption.xml，不是 ZIP 加密）。
   CRC32 必须校验：raw deflate 本身没有校验，损坏包会静默解出错字（inflate 对拍里 1/50 不抛）。
   UMD：Node 走 module.exports；其他环境挂 globalThis.MPZip。
   ============================================================= */
(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const F = isNode ? require('./inflate.js') : root.MPInflate;
  const D = isNode ? require('./deps.js') : root.MPFmtDeps;
  const mod = factory(F, D);
  if (isNode) module.exports = mod;
  root.MPZip = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Inflate, Deps) {
  'use strict';

  function err(code, msg) { const e = new Error('zip: ' + msg); e.code = code; return e; }
  function u16(b, p) { return b[p] | (b[p + 1] << 8); }
  function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }

  let CRC_TABLE = null;
  function crc32(bytes, from, to) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        CRC_TABLE[n] = c;
      }
    }
    let crc = -1;
    for (let i = from || 0, end = to == null ? bytes.length : to; i < end; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ -1) >>> 0;
  }

  /**
   * 解析中央目录。
   * @returns {{entries: Object<string,{name,method,flags,csize,usize,crc,offset}>, names: string[], bytes}}
   */
  function open(buf) {
    const bytes = Deps.toBytes(buf);
    // EOCD：从尾部向前找签名 50 4B 05 06（注释最长 65535）
    const minEocd = 22;
    if (bytes.length < minEocd) throw err('CORRUPT', '文件太短，不是 ZIP');
    let eocd = -1;
    for (let p = bytes.length - minEocd, lo = Math.max(0, bytes.length - 65557); p >= lo; p--) {
      if (bytes[p] === 0x50 && bytes[p + 1] === 0x4B && bytes[p + 2] === 0x05 && bytes[p + 3] === 0x06) { eocd = p; break; }
    }
    if (eocd < 0) throw err('CORRUPT', '找不到 ZIP 目录结尾（EOCD）');
    const total = u16(bytes, eocd + 10);
    const cdSize = u32(bytes, eocd + 12);
    const cdOff = u32(bytes, eocd + 16);
    if (cdOff === 0xFFFFFFFF || total === 0xFFFF) throw err('UNSUPPORTED', 'ZIP64 不支持');
    if (cdOff + cdSize > bytes.length) throw err('CORRUPT', '中央目录越界');

    const entries = Object.create(null);
    const names = [];
    let p = cdOff;
    for (let i = 0; i < total; i++) {
      if (u32(bytes, p) !== 0x02014B50) throw err('CORRUPT', '中央目录项签名错误');
      const flags = u16(bytes, p + 8);
      const method = u16(bytes, p + 10);
      const crc = u32(bytes, p + 16);
      const csize = u32(bytes, p + 20);
      const usize = u32(bytes, p + 24);
      const nameLen = u16(bytes, p + 28), extraLen = u16(bytes, p + 30), commentLen = u16(bytes, p + 32);
      const offset = u32(bytes, p + 42);
      const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
      // bit 11 = 名字是 UTF-8；否则理论上是 cp437，但 EPUB 里都是 ASCII，按 UTF-8 宽松解即可
      const name = Deps.bytesToText(nameBytes, 'utf-8').text;
      entries[name] = { name: name, method: method, flags: flags, csize: csize, usize: usize, crc: crc, offset: offset };
      names.push(name);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries: entries, names: names, bytes: bytes };
  }

  /** 取一个条目的解压字节。找不到返回 null；损坏/加密/未知压缩法抛错 */
  function read(zip, name) {
    const e = zip.entries[name];
    if (!e) return null;
    const b = zip.bytes;
    const p = e.offset;
    if (p + 30 > b.length || u32(b, p) !== 0x04034B50) throw err('CORRUPT', '本地文件头签名错误: ' + name);
    if (e.flags & 0x1) throw err('UNSUPPORTED', 'ZIP 加密条目: ' + name);
    const nameLen = u16(b, p + 26), extraLen = u16(b, p + 28);   // 本地头的 extra 长度可能与目录不同，以本地为准
    const start = p + 30 + nameLen + extraLen;
    if (start + e.csize > b.length) throw err('CORRUPT', '条目数据越界: ' + name);
    const raw = b.subarray(start, start + e.csize);
    let out;
    if (e.method === 0) out = raw;
    else if (e.method === 8) out = Inflate.inflateRaw(raw, e.usize);
    else throw err('UNSUPPORTED', '未知压缩方法 ' + e.method + ': ' + name);
    if (out.length !== e.usize) throw err('CORRUPT', '解压长度不符: ' + name);
    if (crc32(out) !== e.crc) throw err('CORRUPT', 'CRC 校验失败: ' + name);
    return out;
  }

  /** 取条目并按文本解码（严格 UTF-8，退 GBK）。找不到返回 null */
  function readText(zip, name, hint) {
    const bytes = read(zip, name);
    return bytes == null ? null : Deps.bytesToText(bytes, hint).text;
  }

  /** ZIP 里名字的匹配：有的打包器把路径写成 ./OEBPS/x 或大小写不一致，做一次宽松查找 */
  function resolveName(zip, name) {
    if (zip.entries[name]) return name;
    const norm = name.replace(/^\.?\//, '');
    if (zip.entries[norm]) return norm;
    const lower = norm.toLowerCase();
    for (let i = 0; i < zip.names.length; i++) {
      if (zip.names[i].toLowerCase() === lower) return zip.names[i];
    }
    return null;
  }

  return { open: open, read: read, readText: readText, resolveName: resolveName, crc32: crc32 };
});

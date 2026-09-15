/* =============================================================
   sniff.js · 看文件头认格式，不看扩展名（方案 §四）
   微信聊天转发的文件经常被改名或丢扩展名，扩展名不能当判据。

   判据（按顺序）：
     偏移 60–67 == 'BOOKMOBI' / 'TEXtREAd'                 → mobi（含 azw/azw3/prc）
     'PK\x03\x04' 且首条目名为 mimetype 且内容含 epub+zip  → epub
     'PK\x03\x04' 且首条目名为 [Content_Types].xml         → docx/xlsx/pptx，拒绝
     'PK\x03\x04' 其他 → 包里找得到 META-INF/container.xml → epub（mimetype 不规范的包）
                          否则                              → 拒绝
     其他已知二进制魔数（PDF/KFX/gzip/rar/7z/RTF/doc/图片） → 拒绝，各给各的话术
     有 BOM                                                 → txt（编码已确定，不再猜）
     剩下且不像二进制                                        → txt（交给主引擎 detectEncoding）

   本模块**不抛异常**：认不出来就返回 { format:'unsupported', … }，
   由 index.js 统一包成 { code:'UNSUPPORTED', hint }。这样冒烟里能对着返回值断言。
   UMD：Node 走 module.exports；其他环境挂 globalThis.MPSniff。
   ============================================================= */
(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const D = isNode ? require('./deps.js') : root.MPFmtDeps;
  const mod = factory(D);
  if (isNode) module.exports = mod;
  root.MPSniff = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Deps) {
  'use strict';

  function u16(b, p) { return b[p] | (b[p + 1] << 8); }
  function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }

  /** 字节序列在 [from,to) 里是不是等于 ASCII 串 sig */
  function at(b, p, sig) {
    if (p + sig.length > b.length) return false;
    for (let i = 0; i < sig.length; i++) if (b[p + i] !== sig.charCodeAt(i)) return false;
    return true;
  }
  /** 在 [from,to) 里找 ASCII 串（ZIP 的文件名在包里是未压缩存放的，所以能这么找） */
  function findAscii(b, sig, from, to) {
    const n = Math.min(to == null ? b.length : to, b.length) - sig.length;
    const c0 = sig.charCodeAt(0);
    for (let i = Math.max(0, from || 0); i <= n; i++) {
      if (b[i] !== c0) continue;
      let ok = true;
      for (let k = 1; k < sig.length; k++) if (b[i + k] !== sig.charCodeAt(k)) { ok = false; break; }
      if (ok) return i;
    }
    return -1;
  }

  /* ---------- 已知二进制魔数：认出来就给一句人话 ---------- */
  const MAGICS = [
    { at: 0, sig: '%PDF-', kind: 'pdf', hint: 'PDF 的版面无法可靠还原成段落，替换后句子会断行。请用 TXT / EPUB / MOBI。' },
    { at: 0, sig: 'CONT', kind: 'kfx', hint: '这是 Kindle 的 KFX 格式，暂不支持。请换 EPUB / MOBI / TXT。' },
    { at: 0, sig: 'SQLite format 3', kind: 'sqlite', hint: '这是数据库文件，不是电子书。' },
    { at: 0, sig: '{\\rtf', kind: 'rtf', hint: 'RTF 暂不支持，请另存为 TXT 再导入。' },
    { at: 0, sig: 'Rar!', kind: 'archive', hint: '这是压缩包，请先解压出电子书再导入。' },
    { at: 0, sig: '7z\xBC\xAF\x27\x1C', kind: 'archive', hint: '这是压缩包，请先解压出电子书再导入。' },
    { at: 0, sig: '\x1F\x8B', kind: 'archive', hint: '这是压缩包，请先解压出电子书再导入。' },
    { at: 0, sig: 'BZh', kind: 'archive', hint: '这是压缩包，请先解压出电子书再导入。' },
    { at: 0, sig: '\xD0\xCF\x11\xE0', kind: 'msoffice', hint: '这是旧版 Word/Excel 文档，暂不支持。请另存为 TXT。' },
    { at: 0, sig: '\x89PNG', kind: 'image', hint: '这是图片，不是电子书。' },
    { at: 0, sig: '\xFF\xD8\xFF', kind: 'image', hint: '这是图片，不是电子书。' },
    { at: 0, sig: 'GIF8', kind: 'image', hint: '这是图片，不是电子书。' },
    { at: 0, sig: '\xEADRMION\xEE', kind: 'kfx', hint: '这是加了 DRM 的 Kindle 文件，暂不支持。' },
  ];

  /**
   * 首块字节像什么 —— 只在**没有 BOM、也没认出任何魔数**、准备当 TXT 处理之前问一次。
   * @returns {'text'|'utf16-nobom'|'binary'}
   *
   * ★ 这里踩过一次：第一版把「控制字符占比 > 5%」当二进制判据，
   *   结果 UTF-16 的中文正文被判成二进制 —— UTF-16LE 里「安」是 89 5B，
   *   低字节 0x89 没问题，可「上」是 0A 4E、「乘」是 58 4E，CJK 的两个字节
   *   落进 0x00–0x1F 的概率相当高，一屏中文轻松超过 5%。
   *   带 BOM 的那三个 txt 夹具全被拒了，还振振有词地说「认不出格式」。
   *   所以：先认 BOM（认出来就直接是文本），剩下的再区分「像无 BOM 的 UTF-16」和「真二进制」。
   */
  function looksLike(b) {
    const n = Math.min(b.length, 4096);
    if (!n) return 'text';
    let nul = 0, ctrl = 0, even = 0, odd = 0;
    for (let i = 0; i < n; i++) {
      const c = b[i];
      if (c === 0) { nul++; if (i & 1) odd++; else even++; }
      else if (c < 0x09 || (c > 0x0D && c < 0x20)) ctrl++;
    }
    // UTF-8 / GBK 的正文里 NUL 一个都不该有，控制字符也几乎为零
    if (nul === 0) return ctrl / n > 0.05 ? 'binary' : 'text';
    // 有 NUL：无 BOM 的 UTF-16 会把 NUL 全塞在同一个奇偶位上（ASCII 字符的高字节恒为 0）
    const parity = Math.max(even, odd) / nul;
    if (parity >= 0.9) return 'utf16-nobom';
    return 'binary';
  }
  /** 兼容旧名（冒烟里按 true/false 断言） */
  function looksBinary(b) { return looksLike(b) !== 'text'; }

  /** ZIP 首条目：局部文件头 30 字节定长 + 文件名 + 扩展字段 */
  function firstEntry(b) {
    if (b.length < 30) return null;
    const flags = u16(b, 6), method = u16(b, 8);
    const nameLen = u16(b, 26), extraLen = u16(b, 28);
    if (nameLen === 0 || 30 + nameLen > b.length) return null;
    const name = Deps.ascii(b, 30, 30 + nameLen);
    const dataAt = 30 + nameLen + extraLen;
    let size = u32(b, 18);
    if (flags & 0x08) size = 0;              // 用了数据描述符，头里的长度是 0，只能猜着读
    return { name: name, method: method, dataAt: dataAt, size: size };
  }

  const OK_EPUB_MIME = 'application/epub+zip';

  /**
   * @param {ArrayBuffer|Uint8Array} buf
   * @returns {{format:'epub'|'mobi'|'txt'|'unsupported', kind, detail?, hint?}}
   */
  function sniff(buf) {
    const b = Deps.toBytes(buf);
    if (!b.length) return { format: 'unsupported', kind: 'empty', hint: '这个文件是空的。' };

    // 1. PalmDB（MOBI / AZW / AZW3 / PRC / 纯 PalmDOC）
    if (b.length >= 68) {
      const sig = Deps.ascii(b, 60, 68);
      if (sig === 'BOOKMOBI') return { format: 'mobi', kind: 'BOOKMOBI', detail: 'PalmDB type/creator=BOOKMOBI' };
      if (sig === 'TEXtREAd') return { format: 'mobi', kind: 'TEXtREAd', detail: 'PalmDB type/creator=TEXtREAd（纯 PalmDOC，正文是纯文本）' };
    }

    // 2. ZIP 家族
    if (b[0] === 0x50 && b[1] === 0x4B) {
      if (b[2] === 0x05 && b[3] === 0x06) return { format: 'unsupported', kind: 'zip-empty', hint: '这是一个空的压缩包。' };
      if (b[2] !== 0x03 || b[3] !== 0x04) return { format: 'unsupported', kind: 'zip-odd', hint: '这个压缩包不完整，可能没传完。' };
      const e = firstEntry(b);
      if (e && e.name === 'mimetype') {
        const end = e.size ? e.dataAt + e.size : e.dataAt + OK_EPUB_MIME.length;
        const mime = Deps.ascii(b, e.dataAt, Math.min(end, e.dataAt + 64)).trim();
        if (mime.indexOf(OK_EPUB_MIME) === 0) {
          return { format: 'epub', kind: 'epub', detail: 'mimetype 是首条目且为 ' + OK_EPUB_MIME };
        }
        return { format: 'unsupported', kind: 'ocf-other', detail: 'mimetype=' + mime, hint: '这是一个 OCF 包但不是 EPUB（mimetype: ' + mime + '）。' };
      }
      if (e && e.name === '[Content_Types].xml') {
        return { format: 'unsupported', kind: 'office', hint: '这是 Word/Excel/PPT 文档，暂不支持。请另存为 TXT 再导入。' };
      }
      // mimetype 不在首位（打包工具不规范）：包里找得到 container.xml 就仍按 EPUB 处理。
      // 只搜首尾两段：局部文件头在前面，中央目录在末尾，中间全是压缩数据，搜也是白搜。
      const HEAD = 65536, TAIL = 524288;
      let pos = findAscii(b, 'META-INF/container.xml', 0, HEAD);
      if (pos < 0 && b.length > TAIL) pos = findAscii(b, 'META-INF/container.xml', b.length - TAIL, b.length);
      else if (pos < 0) pos = findAscii(b, 'META-INF/container.xml', HEAD, b.length);
      if (pos >= 0) return { format: 'epub', kind: 'epub-loose', detail: '首条目是 ' + (e ? e.name : '?') + '，但包里有 META-INF/container.xml' };
      return { format: 'unsupported', kind: 'zip-other', detail: '首条目 ' + (e ? e.name : '?'), hint: '这是一个压缩包，不是电子书。请先解压。' };
    }

    // 3. 其他二进制魔数
    for (let i = 0; i < MAGICS.length; i++) {
      const m = MAGICS[i];
      if (at(b, m.at, m.sig)) return { format: 'unsupported', kind: m.kind, hint: m.hint };
    }

    // 4. 有 BOM 就是文本，编码已经确定，别再拿字节分布猜
    const bom = Deps.engine.sniffBom(b);
    if (bom) return { format: 'txt', kind: 'txt', detail: 'BOM: ' + bom.enc };

    // 5. 没有 BOM：看字节分布。无 BOM 的 UTF-16 主引擎解不了，要说清楚是哪儿不对，
    //    不能笼统说「认不出格式」让用户无从下手。
    const like = looksLike(b);
    if (like === 'utf16-nobom') return { format: 'unsupported', kind: 'utf16-nobom', hint: '这个文件像是没有 BOM 的 UTF-16 文本，请用记事本另存为 UTF-8 或 ANSI 再导入。' };
    if (like === 'binary') return { format: 'unsupported', kind: 'binary', hint: '认不出这个文件的格式。支持 TXT / EPUB / MOBI / AZW / AZW3。' };
    return { format: 'txt', kind: 'txt', detail: '无 BOM' };
  }

  return { sniff: sniff, looksLike: looksLike, looksBinary: looksBinary, firstEntry: firstEntry, findAscii: findAscii, MAGICS: MAGICS };
});

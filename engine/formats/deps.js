/* =============================================================
   deps.js · 格式层对主引擎的唯一依赖入口
   解码（UTF-8/GBK）、规范化、标题正则、分章 全部复用 miniprogram/engine/import.js，
   这里**不许再写一份**（项目口径：别在别处再写一份）。

   ★ 已合并进 miniprogram/engine/formats/，ENGINE 指向 '../import.js'。
     （独立开发期在 EPUB/formats/ 时那一行是 '../../miniprogram/engine/import.js'）
   UMD：Node 走 module.exports；小程序/浏览器挂 globalThis.MPFmtDeps（要求先加载 MPImport）。
   ============================================================= */
(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const ENGINE = '../import.js';                         // ★ 唯一依赖主引擎的地方
  const I = isNode ? require(ENGINE) : root.MPImport;
  if (!I) throw new Error('deps.js: 找不到主引擎 import.js（MPImport）');
  const mod = factory(I);
  if (isNode) module.exports = mod;
  root.MPFmtDeps = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (I) {
  'use strict';

  /** 字节 → 字符串：严格 UTF-8，坏得多就退 GBK（EPUB/MOBI 规范上都是 UTF-8，退路只为野文件） */
  function bytesToText(bytes, hint) {
    if (hint === 'cp1252' || hint === 'latin1') return { text: cp1252(bytes), encoding: 'cp1252', badRate: 0 };
    const u8 = I.decodeUtf8(bytes, 0);
    const rate = u8.total ? u8.bad / u8.total : 0;
    if (hint === 'utf-8' || rate <= I.BAD_LIMIT) return { text: u8.text, encoding: 'utf-8', badRate: rate };
    const gb = I.decodeGbk(bytes, 0);
    const gbRate = gb.total ? gb.bad / gb.total : 0;
    return gbRate < rate ? { text: gb.text, encoding: 'gbk', badRate: gbRate }
                         : { text: u8.text, encoding: 'utf-8', badRate: rate };
  }

  // Windows-1252 与 Latin-1 只差 0x80–0x9F 这 32 个码位（MOBI textEncoding=1252 的英文书会用到）
  const CP1252_HI = [0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
    0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178];
  function cp1252(bytes) {
    const CHUNK = 8192, parts = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const units = new Array(Math.min(CHUNK, bytes.length - i));
      for (let k = 0; k < units.length; k++) {
        const b = bytes[i + k];
        units[k] = (b >= 0x80 && b <= 0x9F) ? CP1252_HI[b - 0x80] : b;
      }
      parts.push(String.fromCharCode.apply(null, units));
    }
    return parts.join('');
  }

  /** ASCII 字节段 → 字符串（签名、标签名之类，不经解码器） */
  function ascii(bytes, from, to) {
    let s = '';
    for (let i = from; i < to && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  /**
   * 让出主线程，让浏览器有机会把界面画出来，然后继续。
   *
   * ★ 不要用 setTimeout(fn, 0)。**后台标签页里它会被钳到 1 秒一次** ——
   *   实测：19 MB 的 epub 分批解析，前台 5 秒的活儿在后台标签页里要跑 90 秒，
   *   进度条一秒动一格，看着像卡死。用户导入时切出去看一眼微信就会中招。
   *   MessageChannel 的回调也是宏任务（同样能让出渲染），但不吃那个节流。
   */
  function nextTick(fn) {
    if (typeof MessageChannel !== 'undefined') {
      const ch = new MessageChannel();
      ch.port1.onmessage = function () { ch.port1.close(); fn(); };
      ch.port2.postMessage(0);
      return;
    }
    setTimeout(fn, 0);
  }

  return {
    nextTick: nextTick,
    engine: I,
    toBytes: I.toBytes,
    bytesToText: bytesToText,
    cp1252: cp1252,
    ascii: ascii,
    normalize: I.normalize,
    findHeadings: I.findHeadings,
    splitChapters: I.splitChapters,
    detectEncoding: I.detectEncoding,
    PRE_AS_CHAPTER: I.PRE_AS_CHAPTER,
  };
});

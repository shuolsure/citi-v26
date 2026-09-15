/* =============================================================
   html2text.js · 无 DOMParser 的 HTML/XHTML → 段落块
   小程序没有 DOMParser；而且我们只要正文段落和标题，不要通用渲染器。

   输出 { blocks:[{ text, kind:'p'|'h', level, ids:[], pagebreak }], docTitle }
     · 块级标签（p/div/h1-6/li/tr/blockquote/section/article/aside/br/hr/…）开闭都是块边界
     · <h1>–<h6> 的文字进 kind:'h'（章标题候选；C3：标题不进正文）
     · <rt>/<rp>（注音）、<script>/<style>/<head>/<svg>/<math> 连内容一起丢
       —— 不丢 <rt> 的话「战(zhàn)斗」永远匹配不上「战斗」
     · 任何带 id 的标签，其 id 挂到**下一个非空块**上（EPUB 目录用 file.xhtml#id 指向章首）
     · <mbp:pagebreak>（MOBI 分页）→ 块边界 + 下一块标 pagebreak:true
     · 实体：命名只做常用二十来个，数字实体全做
   不用「.*」跨标签匹配整本书 —— 几 MB 的字符串会灾难性回溯；这里按 '<' 逐个扫。
   UMD：Node 走 module.exports；其他环境挂 globalThis.MPHtml2Text。
   ============================================================= */
(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const mod = factory();
  if (isNode) module.exports = mod;
  root.MPHtml2Text = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'td', 'th', 'blockquote', 'section', 'article',
    'aside', 'header', 'footer', 'nav', 'main', 'figure', 'figcaption', 'pre', 'ul', 'ol', 'dl', 'dt', 'dd', 'table', 'body', 'html',
    'address', 'center', 'title']);
  const VOID_BREAK = new Set(['br', 'hr', 'mbp:pagebreak']);
  const SKIP = new Set(['script', 'style', 'head', 'rt', 'rp', 'svg', 'math', 'noscript', 'template', 'video', 'audio', 'object', 'iframe']);
  // 严格 XHTML 里 <head> 内的 <title> 要留作 docTitle，所以 head 的跳过在 title 处例外

  const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009',
    hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', ldquo: '\u201C', rdquo: '\u201D', lsquo: '\u2018', rsquo: '\u2019',
    middot: '\u00B7', times: '\u00D7', copy: '\u00A9', reg: '\u00AE', laquo: '\u00AB', raquo: '\u00BB', shy: '', zwj: '', zwnj: '',
    iexcl: '\u00A1', iquest: '\u00BF', deg: '\u00B0', bull: '\u2022', trade: '\u2122', euro: '\u20AC', pound: '\u00A3', yen: '\u00A5',
  };
  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,10});/g, function (m, body) {
      if (body[0] === '#') {
        const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!(cp >= 0) || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
        return String.fromCodePoint(cp);
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m;
    });
  }

  /** 从标签内部字符串取属性（只在需要时调用；属性值可单/双引号/裸） */
  function attr(tagInner, name) {
    const re = new RegExp('(?:^|\\s)' + name.replace(/[:.]/g, '\\$&') + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i');
    const m = re.exec(tagInner);
    if (!m) return null;
    return decodeEntities(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
  }

  /**
   * @param {string} html
   * @param {Object} [opts] { keepTitleTag?: boolean }
   */
  function toBlocks(html, opts) {
    const o = opts || {};
    const blocks = [];
    let buf = '';               // 当前块累积文本
    let kind = 'p', level = 0;
    let pendingIds = [];
    let pendingBreak = false;
    let docTitle = null;
    let inTitle = false, titleBuf = '';
    const skipStack = [];       // 正在跳过的元素名栈（处理嵌套同名）

    function flush() {
      // HTML 空白语义：ASCII 空白折叠成一个空格；块首尾去掉 ASCII 空白与 nbsp
      let t = buf.replace(/\u00A0/g, ' ').replace(/[ \t\r\n\f]+/g, ' ').replace(/^[ \u00A0]+|[ \u00A0]+$/g, '');
      buf = '';
      if (!t) return;
      const b = { text: t, kind: kind, level: level };
      if (pendingIds.length) { b.ids = pendingIds; pendingIds = []; }
      if (pendingBreak) { b.pagebreak = true; pendingBreak = false; }
      blocks.push(b);
    }

    const n = html.length;
    let i = 0;
    while (i < n) {
      const lt = html.indexOf('<', i);
      if (lt < 0) { if (!skipStack.length) buf += decodeEntities(html.slice(i)); else if (inTitle) titleBuf += html.slice(i); break; }
      if (lt > i) {
        const seg = html.slice(i, lt);
        if (inTitle) titleBuf += seg;
        else if (!skipStack.length) buf += decodeEntities(seg);
      }
      // 注释 / CDATA / doctype / 处理指令
      if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
      if (html.startsWith('<![CDATA[', lt)) {
        const e = html.indexOf(']]>', lt + 9);
        const body = html.slice(lt + 9, e < 0 ? n : e);
        if (!skipStack.length) buf += body;
        i = e < 0 ? n : e + 3; continue;
      }
      if (html[lt + 1] === '!' || html[lt + 1] === '?') { const e = html.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }

      const gt = findTagEnd(html, lt);
      if (gt < 0) { i = n; break; }
      const inner = html.slice(lt + 1, gt);
      i = gt + 1;
      const closing = inner[0] === '/';
      const m = /^\/?\s*([a-zA-Z][\w:.-]*)/.exec(inner);
      if (!m) { if (!skipStack.length) buf += '<' + inner + '>'; continue; }   // 孤立的 '<'，当文本
      const name = m[1].toLowerCase();
      const selfClose = inner[inner.length - 1] === '/' || (name === 'br' || name === 'hr' || name === 'img' || name === 'mbp:pagebreak');

      // ---- 跳过区处理 ----
      if (skipStack.length) {
        if (closing && name === skipStack[skipStack.length - 1]) {
          skipStack.pop();
          if (name === 'head') inTitle = false;
        } else if (!closing && !selfClose && SKIP.has(name)) skipStack.push(name);
        else if (name === 'title' && skipStack[skipStack.length - 1] === 'head') {
          if (!closing) { inTitle = true; titleBuf = ''; }
          else { inTitle = false; if (docTitle == null) docTitle = decodeEntities(titleBuf).replace(/\s+/g, ' ').trim() || null; }
        }
        continue;
      }
      if (!closing && SKIP.has(name)) {
        if (!selfClose) skipStack.push(name);
        continue;
      }

      // ---- 正常区 ----
      if (!closing) {
        const id = inner.indexOf('id') >= 0 ? attr(inner, 'id') : null;
        if (id) pendingIds.push(id);
      }
      if (name === 'title' && !o.keepTitleTag) {   // 不在 head 里的 title（有的书 head 写得不规范）
        if (!closing) { inTitle = true; titleBuf = ''; } else { inTitle = false; if (docTitle == null) docTitle = decodeEntities(titleBuf).replace(/\s+/g, ' ').trim() || null; }
        continue;
      }
      if (VOID_BREAK.has(name)) {
        flush();
        if (name === 'mbp:pagebreak') pendingBreak = true;
        continue;
      }
      if (name === 'img' || name === 'image') continue;   // 图不进正文
      if (BLOCK.has(name)) {
        flush();
        const h = /^h([1-6])$/.exec(name);
        if (h) {
          if (!closing) { kind = 'h'; level = +h[1]; }
          else { kind = 'p'; level = 0; }
        }
        continue;
      }
      // 行内标签：忽略；但相邻两个行内元素之间没有空白时保持原样（中文不需要补空格）
    }
    flush();
    return { blocks: blocks, docTitle: docTitle };
  }

  /** 找标签的 '>'，跳过属性值里的 '>' */
  function findTagEnd(html, lt) {
    let q = null;
    for (let p = lt + 1; p < html.length; p++) {
      const c = html[p];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '>') return p;
      if (c === '<') return -1 - p;   // 嵌套 '<'：格式坏了，让调用方把它当文本
    }
    return -1;
  }

  /** 块数组 → 纯文本（段落用 \n 连），标题块单独取出 */
  function blocksToText(blocks) {
    const lines = [];
    for (let i = 0; i < blocks.length; i++) lines.push(blocks[i].text);
    return lines.join('\n');
  }

  return { toBlocks: toBlocks, blocksToText: blocksToText, decodeEntities: decodeEntities, attr: attr };
});

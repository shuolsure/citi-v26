// 词典加载 + 导入解析 + 词位匹配。引擎全部来自 legacy/engine（UMD，挂在 globalThis 上），这里只做编排。
// 词位匹配口径（docs/03 §3.2 · docs/04 §二）：AC 候选（全量桥）→ R9 邻字否决 → R4 专名遮罩 → R3 自然度 < 3 不替。
// offset 是**码点**，相对 normalize 之后的章节正文。
/* global NRParse, NRReplace, MPImport, MPFormats */

const yieldNow = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

export async function loadDict(base = 'dict/') {
  const get = async f => { const r = await fetch(base + f); if (!r.ok) throw new Error('词典文件读不到：' + f); return r.json(); };
  const [words, bridge, veto, decks] = await Promise.all([get('words.json'), get('bridge.json'), get('veto.json'), get('decks.json')]);
  const map = new Map(words.map(w => [w.w, w]));
  const bridgeArr = Object.keys(bridge).map(w => ({ word_id: w, exprs: bridge[w] }));
  const exprInfo = new Map();
  for (const b of bridgeArr) for (const e of b.exprs) exprInfo.set(b.word_id + ' ' + e.zh, e);
  return {
    words: map, bridgeArr, exprInfo, veto, vetoIdx: NRReplace.vetoIndex(veto),
    decks: decks.map(d => ({ id: d.id, name: d.name, short: d.short, wpm: d.wpm, custom: false, words: new Set(d.words), total: d.words.length })),
  };
}

export async function sha16(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 单章词位：[{o, l, w}]，按 offset 升序 */
export function matchChapter(text, dict, guards) {
  if (!text) return [];
  const cands = NRReplace.findCandidates(text, dict.bridgeArr);
  if (!cands.length) return [];
  const parsed = NRParse.parseChapter(text);
  const chars = parsed.chars;
  const proper = NRReplace.properRanges(text, guards);
  const out = [];
  let ci = 0;
  for (const c of cands) {
    if (NRReplace.vetoedAt(dict.vetoIdx, chars, c.offset, c.len, c.expr)) continue;
    if (proper.some(r => c.offset < r.end && r.start < c.offset + c.len)) continue;
    while (ci < parsed.clauses.length && parsed.clauses[ci].start + parsed.clauses[ci].len <= c.offset) ci++;
    const cl = parsed.clauses[ci];
    const e = dict.exprInfo.get(c.word_id + ' ' + c.expr) || {};
    let pos = '句中';
    if (cl) { if (c.offset <= cl.start) pos = '句首'; else if (c.offset + c.len >= cl.start + cl.len - 1) pos = '句尾'; }
    const nat = NRReplace.naturalness({ pos_hint: e.pos_hint, precision: e.precision, pos, lineLen: cl ? cl.len : 0 });
    if (nat < 3) continue;
    out.push({ o: c.offset, l: c.len, w: c.word_id, c: cl ? cl.i : -1 });
  }
  return out;
}

export class ImportError extends Error {
  constructor(code, hint, partial) { super(hint); this.code = code; this.hint = hint; this.partial = partial; }
}

/**
 * 字节或文本 → 分章 → 词位。onProgress(pct 0–100, phase)
 * 返回 {title, chapters:[{title,text,slots}], guards, hash, stats}
 */
export async function parseAndMatch(input, dict, { title, names = [], onProgress = () => {}, maxBytes = 20 * 1024 * 1024 } = {}) {
  onProgress(2, '读取文件');
  let chapters, gotTitle = title;
  if (input && Array.isArray(input.chapters)) {          // 已经分好章（示例书）：不过标题识别
    chapters = input.chapters.map((c, i) => ({ title: c.title || `第 ${i + 1} 章`, text: MPImport.normalize(c.text || '') }));
  } else if (typeof input === 'string') {
    const text = MPImport.normalize(input);
    const sp = MPImport.splitChapters(text, { mode: 'auto' });
    chapters = sp.chapters.map(c => ({ title: c.title, text: c.text }));
    if (!gotTitle) gotTitle = (text.split('\n')[0] || '').trim().slice(0, 30) || '未命名';
  } else {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length > maxBytes) throw new ImportError('TOO_BIG', '文件超过 20 MB。');
    let r;
    try {
      r = await MPFormats.parseBookAsync(bytes, { onProgress: (d, t) => onProgress(2 + Math.round(30 * d / Math.max(1, t)), '读取文件') });
    } catch (e) {
      throw new ImportError(e.code === 'DRM' || e.code === 'UNSUPPORTED' ? 'FORMAT' : 'BROKEN', e.hint || '这个文件读不出来。');
    }
    chapters = (r.chapters || []).map(c => ({ title: c.title, text: MPImport.normalize(c.text || '') }));
    if (!gotTitle) gotTitle = r.title || '未命名';
  }
  if (!chapters.length || chapters.every(c => !c.text.trim())) throw new ImportError('EMPTY', '没有读到正文。');
  onProgress(34, '按标题分章');
  await yieldNow();
  // 专名启发：用前 60 章的原始命中（口径 C4：扫得少只会遮得少，命中偏多不偏少）
  const scanTo = Math.min(chapters.length, 60);
  const imp = MPImport.importChapters(chapters.slice(0, scanTo), { bridge: dict.bridgeArr, names, scanTo });
  const guards = [...new Set(names.concat(imp.meta.guards || []))];
  onProgress(40, '匹配可替换词位');
  const out = [];
  const freq = {};
  let slots = 0;
  const t0 = performance.now();
  for (let i = 0; i < chapters.length; i++) {
    let s;
    try { s = matchChapter(chapters[i].text, dict, guards); }
    catch (e) { throw new ImportError('BROKEN', `第 ${i + 1} 章解析失败。`, { chapters: out, at: i }); }
    for (const x of s) freq[x.w] = (freq[x.w] || 0) + 1;
    slots += s.length;
    out.push({ title: chapters[i].title || `第 ${i + 1} 章`, text: chapters[i].text, slots: s });
    if (performance.now() - t0 > 30 * (i + 1) || i % 5 === 4) { onProgress(40 + Math.round(58 * (i + 1) / chapters.length), '匹配可替换词位'); await yieldNow(); }
  }
  const hash = await sha16(out.map(c => c.text).join('\n'));
  onProgress(100, '匹配可替换词位');
  return { title: gotTitle, chapters: out, guards, hash, stats: { slots, words: Object.keys(freq).length, freq } };
}

// 词典加载 + 导入解析 + 词位匹配。引擎全部来自 legacy/engine（UMD，挂在 globalThis 上），这里只做编排。
// 词位匹配口径（docs/03 §3.2 · docs/04 §二）：AC 候选（全量桥）→ R9 邻字否决 → R4 专名遮罩 → R3 自然度 < 3 不替。
// offset 是**码点**，相对 normalize 之后的章节正文。
/* global NRParse, NRReplace, MPImport, MPFormats */

export const yieldNow = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });

export async function loadDict(base = 'dict/') {
  const get = async f => { const r = await fetch(base + f); if (!r.ok) throw new Error('词典文件读不到：' + f); return r.json(); };
  const [words, bridge, veto, decks, ver] = await Promise.all([get('words.json'), get('bridge.json'), get('veto.json'), get('decks.json'), get('version.json')]);
  const map = new Map(words.map(w => [w.w, w]));
  const bridgeArr = Object.keys(bridge).map(w => ({ word_id: w, exprs: bridge[w] }));
  const exprInfo = new Map();
  for (const b of bridgeArr) for (const e of b.exprs) exprInfo.set(b.word_id + ' ' + e.zh, e);
  return {
    words: map, bridgeArr, exprInfo, veto, vetoIdx: NRReplace.vetoIndex(veto), version: ver.v,   // 匹配版本：桥 + 否决表 + 匹配代码的内容 hash（构建时算，R2 · C6）
    pack: ver.pack || null,   // 整包版本（R4 · 01 C4）：生产线产出的那一版词典的编号，只用来报出去，不参与重对齐判定
    decks: decks.map(d => ({ id: d.id, name: d.name, short: d.short, wpm: d.wpm, custom: false, words: new Set(d.words), total: d.words.length })),
  };
}

/** 词位对应的那条桥的 sense_id（R3 · 01 C1）：靠（词，中文表达）查，词典里没有就是 null */
export function senseIdIn(dict, w, expr) {
  if (!dict || !w || !expr) return null;
  const e = dict.exprInfo.get(w + ' ' + expr);
  return (e && e.id) || null;
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

/**
 * 词位命中的中文表达（R2 · 01 D2 D10）：{w: {中文: 次数}}，累加进 into。
 * 数据来自正文与词位坐标本身（o / l 是码点），不再跑一遍匹配；只在导入与重对齐时算一次，存进 bookidx。
 * 用处：点柱浮层要回答「这个英文词在这本书里替掉的是哪几个中文词、各几次」——最高的柱往往是错桥，这是发现它的入口。
 */
export function addExprCounts(text, slots, into = {}) {
  if (!slots.length || !text) return into;
  const cp = Array.from(text);
  for (const s of slots) {
    const zh = cp.slice(s.o, s.o + s.l).join('');
    if (!zh) continue;
    const m = into[s.w] || (into[s.w] = {});
    m[zh] = (m[zh] || 0) + 1;
  }
  return into;
}
/** 浮层用：中文表达按次数降序 → 字母序，[[中文, 次数]] */
export function exprRows(exprFreq, w) {
  return Object.entries((exprFreq && exprFreq[w]) || {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

// ---------- 词典版本变化后老书重新对齐（R2 · 01 C6） ----------
export const REALIGN_BATCH = 50;
/** 书的词位是用哪个匹配版本算的；缺省（一期导入的书）视为过期 */
export function needsRealign(idx, version) { return !!idx && idx.dictVersion !== version; }

/**
 * 逐章重匹配一本书。依赖全部注入（阅读器传 IndexedDB 与 MessageChannel，冒烟传内存假对象）：
 *   n 章数 · getChapter(i) → {title,text,slots}|null · putChapters([{i, rec}]) 一个事务 · putIdx(idx) · match(text) → slots · yieldFn()
 * 性质：每 REALIGN_BATCH 章落一次盘（一本 1835 章的书不在内存里攒 28 万个词位）；
 *      idx（freq / chWords / dictVersion）只在全部章节写完后才写 —— 中途失败或被杀，下次启动整本重来（幂等），不会出现「版本号新、词位旧」
 */
export async function realignBook({ n, getChapter, putChapters, putIdx, match, yieldFn, version }) {
  const freq = {}, chWords = [], exprFreq = {};
  let batch = [], changed = 0;
  for (let i = 0; i < n; i++) {
    const rec = await getChapter(i);
    if (!rec) { chWords.push([]); continue; }
    const slots = match(rec.text || '');
    if (JSON.stringify(slots) !== JSON.stringify(rec.slots || [])) changed++;
    for (const s of slots) freq[s.w] = (freq[s.w] || 0) + 1;
    addExprCounts(rec.text || '', slots, exprFreq);
    chWords.push([...new Set(slots.map(s => s.w))]);
    batch.push({ i, rec: { title: rec.title, text: rec.text, slots } });
    if (batch.length >= REALIGN_BATCH) { await putChapters(batch); batch = []; }
    await yieldFn();
  }
  if (batch.length) await putChapters(batch);
  const idx = { freq, chWords, exprFreq, dictVersion: version };
  await putIdx(idx);
  return { idx, changed };
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
  const freq = {}, exprFreq = {};
  let slots = 0;
  const t0 = performance.now();
  for (let i = 0; i < chapters.length; i++) {
    let s;
    try { s = matchChapter(chapters[i].text, dict, guards); }
    catch (e) { throw new ImportError('BROKEN', `第 ${i + 1} 章解析失败。`, { chapters: out, at: i }); }
    for (const x of s) freq[x.w] = (freq[x.w] || 0) + 1;
    addExprCounts(chapters[i].text, s, exprFreq);
    slots += s.length;
    out.push({ title: chapters[i].title || `第 ${i + 1} 章`, text: chapters[i].text, slots: s });
    if (performance.now() - t0 > 30 * (i + 1) || i % 5 === 4) { onProgress(40 + Math.round(58 * (i + 1) / chapters.length), '匹配可替换词位'); await yieldNow(); }
  }
  const hash = await sha16(out.map(c => c.text).join('\n'));
  onProgress(100, '匹配可替换词位');
  return { title: gotTitle, chapters: out, guards, hash, stats: { slots, words: Object.keys(freq).length, freq, exprFreq } };
}

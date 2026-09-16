// 词替 · 客户端主程序。绑定名与交互原型 renderVals() 一致（模板不改），数全部来自本地事实 + shared 记忆模型。
/* global NRParse */
import * as M from '../shared/memory-model.mjs';
import TEMPLATE from '../gen/template.js';
import { APP_VERSION, MODEL_VERSION } from '../gen/version.js';                    // 构建注入的内容 hash（R3 事件信封）
import { mount } from './runtime.js';
import { openStore } from './store.js';
import { loadDict, parseAndMatch, matchChapter, ImportError, needsRealign, realignBook, yieldNow, exprRows, senseIdIn } from './library.js';
import * as F from './facts.js';
import { exportBackup, validateBackup, applyBackup, claimPending, summarize } from './backup.js';
import { makeEvent, EVENT_NAMES } from '../shared/events.mjs';

// ---------- 设计常量（来自原型，纯展示） ----------
const DEN_NAMES = ['极轻', '轻', '偏轻', '适中', '偏密', '密'];
const GOALS = [30, 60, 90, 120];
const QUIZ = ['patience', 'whisper', 'alley', 'threshold', 'reluctant', 'silhouette', 'flicker', 'dusk'];
const ONB_DECKS = ['cet4', 'cet6', 'kaoyan'];
const SORTS = ['默认', '最快到期', '留存低', '最近新增'];
const LIME = '#BFE699';
const SAMPLE_DECK = 'sample';                                              // 14 个词的示例词表：只在示例书里出现（D8）
const FONTS = [
  { k: 'sys', name: '系统', family: "'Readex Pro','PingFang SC','Noto Sans SC',sans-serif" },
  { k: 'song', name: '宋体', family: "'Songti SC','Noto Serif SC','SimSun',serif" },
  { k: 'kai', name: '楷体', family: "'Kaiti SC','STKaiti','KaiTi',serif" }
];
const RV_MODES = [
  { k: 'recall', name: '回想中文', hint: '看英文词，在心里回想中文，再看答案。最快，默认。' },
  { k: 'spell', name: '拼写单词', hint: '给中文与音标，手动拼出英文。最费力，对拼写最有用。' },
  { k: 'choice', name: '四选一', hint: '给英文词与四个中文释义，选一个。适合排队、坐车时。' },
  { k: 'context', name: '回到原文', hint: '把你记下它的那一句挖空，回想当时的语境。' }
];
const FB_REASONS = [
  { k: 'context', name: '选词不合语境', hint: '英文词本身没错，但放在这句里不对' },
  { k: 'definition', name: '释义不对', hint: '释义与这个中文词对不上' },
  { k: 'example', name: '例句或音标有误', hint: '词本身没问题，附属信息有错' },
  { k: 'should_not_replace', name: '这个词不该被替换', hint: '人名、地名或固定说法' }
];
// 「这台设备上做不到」的说明框文案（2026-09-16）。每日提醒本来就有一条；看板同步原来什么都不说，
// 却在「我的」里显示「随账号」—— 而网页版没有账号，prefs.sync 全局没有第二处读它，拨了不会有任何变化。
const ASK_COPY = {
  sub: { title: '开启每日提醒', body: '每日提醒要用微信小程序的订阅消息推送，一次授权对应一次推送。当前是网页版，收不到推送；在小程序里打开这个开关才会生效。' },
  sync: { title: '看板同步', body: '看板布局要有账号才能跟着人走。当前是网页版（游客），布局只存在这台设备上，这个开关拨到哪一档都一样；换设备请用「备份与恢复」。在小程序里登录后它才会生效。' }
};
const ND_SRC = ['粘贴词单', '从现有词库挑', '从书里的生词'];
const WIDGETS = {
  heat: { name: '阅读日历', icon: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4', bg: '#FFFFFF', tinted: false },
  progress: { name: '学习进度', icon: 'M4 19V5M4 19h16M8 15l3.5 -4l3 2.5L20 8', bg: '#D6EEDC', tinted: true },
  time: { name: '阅读时长', icon: 'M12 4a8 8 0 1 0 0 16a8 8 0 0 0 0 -16M12 8v4l3 2', bg: '#CFE4F2', tinted: true },
  wordTop: { name: '单词学习榜', icon: 'M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1 -2 -2zM9 8h6', bg: '#FFFFFF', tinted: false },
  bookTop: { name: '书籍排行榜', icon: 'M4 5h5v14H4zM11 5h4v14h-4zM17.5 5.5l3.5 13l-3 .8l-3.5 -13z', bg: '#FFFFFF', tinted: false },
  review: { name: '今日复习', icon: 'M4 8h13l-3 -3M20 16H7l3 3', bg: '#E4D7F5', tinted: true },
  retention: { name: '留存构成', icon: 'M12 4a8 8 0 1 0 0 16a8 8 0 0 0 0 -16M12 12l5 -3', bg: '#FFFFFF', tinted: false },
  ebb: { name: '记忆曲线', icon: 'M4 6v12h16M7 9c2 6 4 7 5 3s2 -5 3 -1s2 4 3 2', bg: '#FFFFFF', tinted: false },
  decks: { name: '词库对比', icon: 'M4 6h7v12H4zM13 6h7v8h-7z', bg: '#FFFFFF', tinted: false },
  hours: { name: '阅读时段', icon: 'M12 4a8 8 0 1 0 0 16a8 8 0 0 0 0 -16M12 8v4l3 2', bg: '#FFFFFF', tinted: false },
  source: { name: '生词来源', icon: 'M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1 -2 -2zM9 12h6', bg: '#FFFFFF', tinted: false },
  year: { name: '年度目标', icon: 'M12 3l2.5 5.5l6 .8l-4.4 4.2l1.1 5.9l-5.2 -2.9l-5.2 2.9l1.1 -5.9l-4.4 -4.2l6 -.8z', bg: '#FFFFFF', tinted: false },
  badges: { name: '学习勋章', icon: 'M12 3l2.5 5.5l6 .8l-4.4 4.2l1.1 5.9l-5.2 -2.9l-5.2 2.9l1.1 -5.9l-4.4 -4.2l6 -.8z', bg: '#FFFFFF', tinted: false }
};
const WIDGET_KEYS = ['heat', 'progress', 'time', 'review', 'ebb', 'wordTop', 'bookTop', 'retention', 'decks', 'hours', 'source', 'year', 'badges'];
const PRESETS = { '重进度': ['progress', 'ebb', 'review', 'retention', 'decks'], '重阅读': ['heat', 'time', 'hours', 'bookTop', 'year'], '极简': ['progress', 'heat'] };
const HEAT_COLORS = ['#EDECEA', '#E4F0CF', '#CFE8A8', '#B6DE86', '#8FBF6A'];
const BADGES = [
  { key: 'streak7', name: '七日连续', icon: 'M12 3c3 4 5 6 5 9a5 5 0 0 1 -10 0c0 -1.5 .8 -2.8 2 -4c.4 1.4 1.2 2 2 2c-1 -3 0 -5.5 1 -7z', cond: '连续打卡 7 天' },
  { key: 'words100', name: '百词入库', icon: 'M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1 -2 -2zM9 8h6', cond: '词库累计记下 100 词' },
  { key: 'night10', name: '夜读人', icon: 'M18 14a7 7 0 0 1 -9 -9a7.5 7.5 0 1 0 9 9z', cond: '22 点到凌晨 4 点阅读满 10 天' },
  { key: 'book1', name: '读完一本', icon: 'M5 12.5l4.5 4.5L19 7', cond: '完整读完一本书' },
  { key: 'words1000', name: '千词屋', icon: 'M12 3l2.5 5.5l6 .8l-4.4 4.2l1.1 5.9l-5.2 -2.9l-5.2 2.9l1.1 -5.9l-4.4 -4.2l6 -.8z', cond: '词库累计记下 1000 词' },
  { key: 'month', name: '全勤一月', icon: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4', cond: '一个自然月天天打卡' }
];
const TONES = ['#3C4A3E', '#4C4438', '#3F4E5C', '#5C6B45', '#4E4458', '#5A4A3C', '#3D5358'];
const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

const hashStr = s => { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0; return h; };
const clip200 = s => { const a = Array.from(s || ''); return a.length > 200 ? a.slice(0, 200).join('') : (s || ''); };

class App {
  constructor(root) {
    this.root = root;
    this.s = {
      tab: 'read', sheet: null, settings: false, chapters: false, log: null, peek: false, editing: false, rv: null, onb: null,
      imp: 0, impSrc: '', impPct: 0, impPhase: '读取文件', impErr: null, impErrMsg: '', impResult: null, q: '', chQ: '', sortIdx: 0, filter: 0,
      page: null, badge: null, share: false, sheetBook: null, fb: null, fbReason: 0, bar: null, bkMenu: null, renaming: null, renameVal: '', ask: null,
      quiz: [], spellVal: '', choicePick: null, ndName: '', ndSrc: 0, ndPaste: '', ndSel: [], chVis: 1, chSc: 0, chBarDrag: false, fsDrag: false,
      toast: null, loading: true, netFail: false, rpage: 0, pageCount: 1, vocabLimit: 40, chPct: 0, reader: null, sessionLearned: 0, forced: [], bkPending: null, bkErr: ''
    };
    this.data = null; this.dict = null; this.idx = new Map(); this.memo = {};
  }

  setState(patch) { Object.assign(this.s, patch); this.view.schedule(); }
  flash(msg) { clearTimeout(this._t); this.setState({ toast: msg }); this._t = setTimeout(() => this.setState({ toast: null }), 2200); }
  touch() { this.rev = (this.rev || 0) + 1; this.memo = {}; }

  // ============ 事件（R3 · 01 E4 · 登记表 app/shared/events.mjs）============
  /**
   * 采一条事件。名字必须在登记表里（N2），字段必须合登记的类型——不合就**不写**，只记账并报到控制台。
   * 这里不抛：一次埋点写错不该让用户点不动按钮。真正的防线在测试——client-smoke 把 app.js 里
   * 每一处 emit 的名字都比对登记表，突变删掉任一处 emit 必须红。
   */
  emit(name, p) {
    try {
      const e = makeEvent(name, p, {
        app_version: APP_VERSION, dict_version: this.dict ? this.dict.version : null,
        model_version: MODEL_VERSION, exp: null
      });
      this._evq = (this._evq || []).concat([e]);
      this.flushEventsSoon();
      return e;
    } catch (err) {
      // 丢弃必须留痕（2026-09-16）：原来只自增 _evBad，而那个变量**从来没有被读过** ——
      // slot.reported 的枚举漂了三个月没人发现，就是因为丢事件在手机上完全静默（没人看控制台）。
      // 现在：① 计数进 state → 跟着备份导出，R6 一眼能看出这份数据有缺口；② 本次会话提示一次，不打扰。
      this._evBad = (this._evBad || 0) + 1;
      if (this.data) this.data.evDropped = (this.data.evDropped || 0) + 1;
      if (this._evBad === 1) this.flash('有事件没能记录，统计可能不全');
      console.error('[events] 丢弃一条不合登记表的事件：', name, err.message);
      return null;
    }
  }
  /**
   * 改一条设置并采事件（R3 · 01 E4）。**只走这一个入口**：散在十几个 toggle 里各写一行，
   * 迟早有人加了开关忘了采，而且没人发现（事件少一类不会报错）。
   * from / to 一律转成短字符串（枚举 / 数字 / 布尔），不带对象。
   */
  setPref(obj, key, value, name) {
    const from = obj[key];
    if (from === value) return false;
    obj[key] = value;
    this.emit('setting.changed', { key: String(name || key).slice(0, 40), from: from == null ? null : String(from).slice(0, 40), to: value == null ? null : String(value).slice(0, 40) });
    this.save();
    return true;
  }
  flushEventsSoon() { clearTimeout(this._evt); this._evt = setTimeout(() => this.flushEvents(), 250); }
  async flushEvents() {
    clearTimeout(this._evt);
    const q = this._evq || [];
    if (!q.length || !this.store) return 0;
    this._evq = [];
    try { return await this.store.appendEvents(q); }
    catch (e) { this._evq = q.concat(this._evq || []); console.error('[events] 写盘失败，留在队列里：', e.message || e); return 0; }
  }
  save() {
    this.touch();
    clearTimeout(this._sv);
    this._sv = setTimeout(() => this.flush(), 250);
    this.view.schedule();
  }
  async flush() {
    clearTimeout(this._sv);
    await this.flushEvents();
    try { await this.store.saveState(this.data); }
    catch (e) { this.flash('存储失败：' + (e.message || e.name)); }
  }

  async boot() {
    this.view = mount(this.root, TEMPLATE, () => this.vals());
    this.view.render();
    try {
      this.store = await openStore();
      this.data = await this.store.loadState();
    } catch (e) { this.setState({ loading: false, netFail: true, bootErr: '本机存储打不开：' + (e.message || e.name) }); return; }
    try { this.dict = await loadDict('dict/'); }
    catch (e) { this.setState({ loading: false, netFail: true }); return; }
    for (const b of this.data.books) { const ix = await this.store.getBookIdx(b.id); if (ix) this.idx.set(b.id, ix); }
    this.store.persist();
    this.touch();
    const onb = this.data.auth && !this.data.onboarded ? 0 : null;
    this.setState({ loading: false, onb });
    this.awardBadges();
    this.backfillSenseIds();                                               // 老词条按 srcExpr 补 senseId（R3 · C1）
    this.realignBooks();                                                   // 词典 / 匹配代码变了：后台逐本重对齐（R2 · C6），不阻塞启动
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.tickTimer(true); this.flushChapter(); this.flush(); } });
    window.addEventListener('pagehide', () => { this.tickTimer(true); this.flushChapter(); this.flush(); });
    this.root.addEventListener('scroll', e => this.onAnyScroll(e), true);
    this.bindGestures();
    for (const t of ['pointerdown', 'keydown', 'scroll']) this.root.addEventListener(t, () => { this.lastAct = Date.now(); }, { capture: true, passive: true });
  }

  // ============ 时间 ============
  now() { return Date.now(); }
  today() { return F.ymd(new Date()); }

  // ============ 词表 ============
  allDecks() {
    const custom = this.data.customDecks.map(d => ({ id: d.id, name: d.name, short: d.name, wpm: 0.1, custom: true, words: new Set(d.words), total: d.words.length }));
    return this.dict.decks.concat(custom);
  }
  deckById(id) { return this.allDecks().find(d => d.id === id) || this.dict.decks.find(d => d.id === 'cet4'); }
  curDeck() { return this.deckById(this.data.prefs.deckId); }
  bookDeck(b) { return this.deckById((b && this.data.prefs.bookDecks[b.hash]) || this.data.prefs.deckId); }
  learnedIn(deck) { let n = 0; for (const w in this.data.entries) if (F.activeEntry(this.data.entries[w]) && deck.words.has(w)) n++; return n; }

  // ============ 词条事实 ============
  entry(w) { const e = this.data.entries[w]; return F.activeEntry(e) ? e : null; }
  entryState(w) { const e = this.entry(w); if (!e) return null; return F.isDemoted(e) ? 'demoted' : 'learned'; }
  modelOf(w) { const e = this.entry(w); return e ? F.modelEntry(w, e, F.userMuted(this.data.muted, w), this.now()) : null; }
  activeModels() {
    if (this.memo.models) return this.memo.models;
    const now = this.now();
    return (this.memo.models = Object.keys(this.data.entries).filter(w => this.entry(w)).map(w => F.modelEntry(w, this.data.entries[w], F.userMuted(this.data.muted, w), now)));
  }
  /** 模型参数：远程配置缓存 → 本地默认（R1 · 01 A8）。所有 M.* 调用都必须带它 */
  cfg() { return this.memo.cfg || (this.memo.cfg = F.modelConfigOf(this.data.remote && this.data.remote.modelConfig)); }
  queue() { return this.memo.queue || (this.memo.queue = M.buildQueue(this.activeModels(), 0, this.cfg())); }
  retNow(w) { const m = this.modelOf(w); return m ? M.retentionNow(m, 0, this.cfg()) : 0; }
  tier(w) {                                                                // 书封柱 / 面板图例对同一个词问很多次（D14）
    const t = this.memo.tier || (this.memo.tier = new Map());
    if (!t.has(w)) { const m = this.modelOf(w); t.set(w, m ? F.tierOf(m, this.cfg()) : null); }
    return t.get(w);
  }

  learnWord(w, ctx) {
    const today = this.today();
    const d = this.data;
    const prev = d.entries[w];
    const kind = F.learnKind(prev, this.now());
    if (kind === 'active') return false;
    const senseId = this.senseIdOf(w, ctx.expr);
    const ev = { w, sense_id: senseId, book_hash: ctx.bookHash || null, src_expr: ctx.expr ? String(ctx.expr).slice(0, 40) : null };
    if (kind === 'undo') {                                                         // 24 小时内：撤销取消，原 firstAt / 复习史 / 出处都不动，新词数不加
      prev.deletedAt = null;
      this.emit('word.learned', { ...ev, sense_id: prev.senseId || senseId, kind: 'undo' });
      this.save();
      return true;
    }
    d.entries[w] = { firstAt: new Date().toISOString(), srcBook: ctx.bookHash || null, srcTitle: ctx.title || null, senseId,
      srcSentence: clip200(ctx.sentence), srcExpr: ctx.expr || null, reviews: prev ? prev.reviews : [], deletedAt: null };
    d.dailies[today] = d.dailies[today] || { mins: 0, newWords: 0 };
    d.dailies[today].newWords++;
    this.emit('word.learned', { ...ev, kind: ctx.bookHash ? 'new' : 'deck' });
    this.save();
    this.awardBadges();
    return true;
  }

  awardBadges() {
    const got = F.judgeBadges(F.badgeFacts(this.data, this.today()));
    let changed = false;
    for (const k of got) if (!this.data.badges[k]) { this.data.badges[k] = new Date().toISOString(); changed = true; const b = BADGES.find(x => x.key === k); if (b) this.flash('获得勋章 · ' + b.name); }
    if (changed) this.save();
  }

  // ============ 阅读计时（停表：离开阅读器 / 切后台（除非 bgCount）/ 无操作超过 idle 分钟） ============
  startTimer() {
    this.lastAct = Date.now(); this.lastTick = Date.now();
    clearInterval(this._timer);
    this._timer = setInterval(() => this.tickTimer(false), 1000);
  }
  stopTimer() { this.tickTimer(true); clearInterval(this._timer); this._timer = null; }
  tickTimer(final) {
    if (!this._timer || !this.s.reader) return;
    const now = Date.now();
    let dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    const p = this.data.prefs;
    if (dt > 5) dt = 0;                                            // 休眠/冻结后的间隔不算
    if (document.hidden && !p.bgCount) dt = 0;
    if (now - this.lastAct > p.idle * 60000) dt = 0;
    if (dt <= 0) return;
    const today = this.today(), hour = new Date().getHours();
    const d = this.data;
    d.dailies[today] = d.dailies[today] || { mins: 0, newWords: 0 };
    d.dailies[today].mins += dt / 60;
    d.hours[today] = d.hours[today] || new Array(24).fill(0);
    d.hours[today][hour] += dt;
    const bk = this.book(this.s.reader.bookId);
    if (bk) d.bookSecs[bk.hash] = (d.bookSecs[bk.hash] || 0) + dt;        // v2 起按内容 hash（E5：本机 bookId 换台机器就是孤儿）
    if (this._sess) this._sess.secs += dt;
    this._pageSecs = (this._pageSecs || 0) + dt;
    this._dirtySecs = (this._dirtySecs || 0) + dt;
    if (this._dirtySecs >= 10 || final) { this._dirtySecs = 0; this.save(); this.awardBadges(); }
    else if (Math.floor(d.dailies[today].mins) !== this._lastMinShown) { this._lastMinShown = Math.floor(d.dailies[today].mins); this.touch(); this.view.schedule(); }
  }
  /**
   * 结算一屏（outlier）：连续每屏 < 4 秒，这几屏的秒数不计。
   * 翻页模式由 turnPage / nextChapter 调；**滚动模式由 onReaderScroll 累计滚过一屏时调**
   * （2026-09-16 修：以前只有翻页模式调得到，滚动模式下设置里那个开关完全无效，
   *   而滚动才是默认模式 —— 快速划过的时间照常进打卡、热力、预测、勋章）。
   * 判定本身在 F.judgeQuickPage，两条路径共用同一把尺子，Node 里可断言。
   */
  onPageTurn() {
    const secs = this._pageSecs || 0;
    this._pageSecs = 0;
    const j = F.judgeQuickPage(secs, this._quick || 0, !!this.data.prefs.outlier);
    this._quick = j.quickRun;
    if (!j.drop) return;
    const today = this.today(), d = this.data;
    if (d.dailies[today]) d.dailies[today].mins = Math.max(0, d.dailies[today].mins - secs / 60);
    const bk = this.s.reader && this.book(this.s.reader.bookId);
    if (bk && d.bookSecs[bk.hash]) d.bookSecs[bk.hash] = Math.max(0, d.bookSecs[bk.hash] - secs);
    if (this._sess) this._sess.secs = Math.max(0, this._sess.secs - secs);   // 会话秒数与缓存扣同一份，事件与缓存才对得上
    const h = d.hours[today]; if (h) h[new Date().getHours()] = Math.max(0, h[new Date().getHours()] - secs);
  }

  // ============ 书 ============
  book(id) { return this.data.books.find(b => b.id === id) || null; }
  shelf() { return this.data.books.slice().sort((a, b) => (b.openedAt || b.createdAt || '').localeCompare(a.openedAt || a.createdAt || '')); }
  bookPct(b) { const n = b.chapters.length || 1; return Math.min(100, Math.round(((b.pos ? b.pos.chapter : 0) + (b.pos ? b.pos.pct : 0)) / n * 100)); }
  /**
   * 一本书 × 一个词表的统计（R2 · 01 D4 D7 D8 D14）。书封柱、书籍面板柱与图例、覆盖数、词表推荐全部走这里，口径只有一份。
   *  rows  这本书里「算数」的词 [w, 次数]，按次数降序 → 字母序（书内固定事实，每次打开一样）
   *        = 词表内的新词（newWordOf，已排除已会线）∪ 已记下的词（D9：别的词表记下的也画）
   *        剔掉全局「不再替换」与本书纠错暂停的词（D7：不替换的词不该画在图上，也不该算进覆盖数）
   *  hit   这本书里出现过的词表词个数（含已记下的）——书封绝对数与词表推荐排序都用它（D8）
   * 缓存在 memo 里，按（书，词表）一份；记词 / 复习 / 纠错 / 切词表都会 touch()，memo 整体作废（D14）
   */
  bookStats(b, deck) {
    const key = b.id + '|' + deck.id;
    const m = this.memo.bookStats || (this.memo.bookStats = new Map());
    if (m.has(key)) return m.get(key);
    const ix = this.idx.get(b.id) || { freq: {} };
    const paused = F.pausedSet(this.data.feedback, b.hash);
    const r = F.bookStats(ix.freq, {
      isDeckWord: w => this.newWordOf(deck, w), hasEntry: w => !!this.entry(w),
      hidden: w => F.userMuted(this.data.muted, w) || paused.has(w), tier: w => this.tier(w)
    });
    m.set(key, r);
    return r;
  }
  coverage(b, deck) { return this.bookStats(b, deck).hit; }

  async openBook(id, chapter) {
    const b = this.book(id);
    if (!b) { this.flash('先导入一本书'); this.setState({ imp: 1 }); return; }
    const ch = chapter != null ? chapter : (b.pos ? b.pos.chapter : 0);
    let data = await this.store.getChapter(b.id, ch);
    if (!data) data = { title: b.chapters[ch] ? b.chapters[ch].t : '', text: '', slots: [] };
    b.openedAt = new Date().toISOString();
    this.data.lastBookId = b.id;
    const pct = b.pos && b.pos.chapter === ch ? b.pos.pct : 0;
    this.parsedCache = null;
    this.resetScrollBase();
    this.setState({ tab: 'reader', reader: { bookId: b.id, chapter: ch, data }, chPct: Math.round(pct * 100), rpage: 0, sheet: null, settings: false, chapters: false, sheetBook: null });
    this.save();
    this.startTimer();
    requestAnimationFrame(() => {
      const el = this.findReaderEl();
      if (el) { el.scrollTop = pct * Math.max(0, el.scrollHeight - el.clientHeight); this.measurePages(); }
    });
  }

  findReaderEl() { return (this.readerEl = this.root.querySelector('div[style*="padding:22px 26px 96px"]')); }
  resetScrollBase() { this._lastTop = null; this._scrollAcc = 0; this._quick = 0; }
  leaveReader(tab = 'read') { this.resetScrollBase(); this.stopTimer(); this.flushChapter(); this.setState({ tab, reader: null, sheet: null, settings: false, chapters: false, peek: false }); this.flush(); }

  measurePages() {
    const el = this.readerEl;
    if (!el) return;
    const step = this.pageStep();
    const n = Math.max(1, Math.ceil((el.scrollHeight - el.clientHeight) / step) + 1);
    if (n !== this.s.pageCount) this.setState({ pageCount: n });
  }
  pageStep() {
    const el = this.readerEl, L = this.data.local;
    const line = L.fs * (L.fs >= 20 ? 2.15 : 2.05);
    return Math.max(line, Math.floor((el.clientHeight - 118) / line) * line);
  }

  // ============ 导入 ============
  pickFile() {
    const inp = document.createElement('input');
    inp.type = 'file';                                   // 不写 accept：iOS/macOS 会把 txt 置灰（旧项目踩过）
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      if (!/\.(txt|epub|mobi|azw3?|prc)$/i.test(f.name)) { this.setState({ imp: 4, impErr: 'format', impSrc: f.name, impPct: 0 }); return; }
      this.lastInput = { kind: 'file', file: f, name: f.name.replace(/\.[^.]+$/, '') };
      this.runImport();
    };
    inp.click();
  }
  async pickText() {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { /* 用户拒绝剪贴板权限，走输入框 */ }
    if (!text || text.trim().length < 20) text = window.prompt('把正文粘贴到这里（至少一段）') || '';
    if (!text.trim()) return;
    this.lastInput = { kind: 'text', text, name: '粘贴文本' };
    this.runImport();
  }
  async runImport(opts = {}) {
    const inp = this.lastInput;
    if (!inp) return;
    this.setState({ imp: 2, impPct: 0, impErr: null, impSrc: (inp.kind === 'file' ? '本地文件 · ' : inp.kind === 'text' ? '粘贴文本 · ' : '') + (inp.label || inp.name) });
    const t0 = Date.now();
    this._impT0 = t0;                                                     // saveImported 成功时也要用它算耗时
    try {
      const input = inp.kind === 'file' ? new Uint8Array(await inp.file.arrayBuffer()) : inp.kind === 'text' ? inp.text : { chapters: inp.chapters };
      const r = await parseAndMatch(input, this.dict, {
        title: inp.title || (inp.kind === 'file' ? inp.name : undefined), names: inp.names || [],
        onProgress: (pct, phase) => this.setState({ impPct: pct, impPhase: phase })
      });
      await this.saveImported(r, inp, opts);
    } catch (e) {
      const err = e instanceof ImportError ? e : new ImportError('BROKEN', e.message || '解析失败');
      // 失败也要记：解析引擎的健康度靠它（reason 只带错误码，不带文件名与正文）
      this.emit('import.finished', { book_hash: null, kind: inp.kind, ok: false, reason: err.code, chapters: 0, slots: 0, fresh: 0, ms: Date.now() - t0 });
      this.setState({ imp: 4, impErr: err.code === 'FORMAT' ? 'format' : 'broken', impErrMsg: err.hint, impPct: this.s.impPct });
    }
  }
  async saveImported(r, inp, { reparseId } = {}) {
    const existing = this.data.books.find(b => b.hash === r.hash) || (reparseId && this.book(reparseId));
    const id = existing ? existing.id : 'b' + Date.now().toString(36);
    const meta = {
      id, hash: r.hash, title: existing ? existing.title : r.title, sample: !!inp.sample,
      chapters: r.chapters.map(c => ({ t: c.title, n: c.slots.length, empty: !c.text.trim() })),
      guards: r.guards.slice(0, 500), createdAt: existing ? existing.createdAt : new Date().toISOString(),
      pos: existing ? existing.pos : { chapter: 0, pct: 0 }, read: existing ? existing.read : [], den: existing ? existing.den : this.data.local.den,
      finishedAt: existing ? existing.finishedAt : null, openedAt: new Date().toISOString(), tone: TONES[hashStr(r.hash) % TONES.length]
    };
    const idx = { freq: r.stats.freq, chWords: r.chapters.map(c => [...new Set(c.slots.map(s => s.w))]), exprFreq: r.stats.exprFreq, dictVersion: this.dict.version };
    // 从备份恢复过、但当时本机没有正文的书：同 hash 重新导入时接上进度（与书架写入同一事务）
    const claimed = existing ? null : claimPending(this.data, meta);
    if (claimed) {
      Object.assign(meta, claimed.meta);
      this.data = { ...this.data, pendingBooks: claimed.pendingBooks, bookSecs: { ...this.data.bookSecs, [meta.hash]: (this.data.bookSecs[meta.hash] || 0) + claimed.secs } };
    }
    this.data = await this.store.putBook(this.data, meta, r.chapters, idx);
    this.idx.set(id, idx);
    const deck = this.bookDeck(meta);
    let slots = 0; const fresh = new Set();
    for (const c of r.chapters) for (const s of c.slots) if (this.newWordOf(deck, s.w) || this.entry(s.w)) { slots++; if (!this.entry(s.w)) fresh.add(s.w); }
    this.emit('import.finished', { book_hash: meta.hash, kind: inp.kind, ok: true, reason: null,
      chapters: r.chapters.length, slots, fresh: fresh.size, ms: Date.now() - (this._impT0 || Date.now()) });
    this.touch();
    this.setState({ imp: reparseId ? 0 : 3, impResult: { id, chapters: r.chapters.length, slots, fresh: fresh.size, chapter: meta.pos.chapter } });
    if (claimed) this.flash('已接上备份里的进度 · 第 ' + (meta.pos.chapter + 1) + ' 章');
    if (reparseId) this.flash('已重新解析《' + meta.title + '》');
  }
  /**
   * 给 v2 之前记下的词条补 senseId（R3 · 01 C1）。迁移函数拿不到词典，只能在这里补：
   * 词条里存了记下时读到的中文表达（srcExpr），配上词典就能查回那条桥。查不到的（自建词表、
   * 换源后没了的表达）保持 null —— 宁可空着，也不要猜一个 id 进历史数据。
   */
  backfillSenseIds() {
    let n = 0;
    for (const [w, e] of Object.entries(this.data.entries)) {
      if (e.senseId || !e.srcExpr) continue;
      const id = this.senseIdOf(w, e.srcExpr);
      if (id) { e.senseId = id; n++; }
    }
    if (n) this.save();
    return n;
  }
  /** 某个词在这本书里第一次出现的位置（D2 纠错要坐标）：按 chWords 找到章，再翻那一章拿 offset 与中文表达 */
  async firstSlotOf(b, w) {
    const ix = this.idx.get(b.id) || {};
    const chw = ix.chWords || [];
    for (let i = 0; i < chw.length; i++) {
      if (!chw[i] || !chw[i].includes(w)) continue;
      const rec = await this.store.getChapter(b.id, i);
      const s = ((rec && rec.slots) || []).find(x => x.w === w);
      if (s) return { chapter: i, o: s.o, expr: Array.from(rec.text || '').slice(s.o, s.o + s.l).join('') };
    }
    return null;
  }
  /**
   * 词典更新后，这本书里「报过错、而且已经修好」的词自动恢复替换（07 纠错闭环的最后一步，2026-09-16 补）。
   * 判据：报错时记下的那个位置（章 + 码点偏移），重对齐之后**已经不再替成同一个词** ——
   *      桥被删掉、被判给别的英文词、或被新的否决规则挡掉，三种情况都算「这条反馈已解决」。
   * 位置对不上的（从书籍面板点柱报的错没有章 / 偏移）保持手工恢复，不猜。
   * 之前只有设置页的 restore 按钮会写 resumedAt —— 服务端 release 删的是它自己的 muted_words 表，
   * 跟本机这条队列不是一回事，所以桥修好之后那本书里的词仍然永久暂停着。
   */
  async resumeFixedFeedback(b) {
    const list = (this.data.feedback || []).filter(f => f.bookHash === b.hash && !f.resumedAt && f.chapter != null && f.offset != null);
    if (!list.length) return 0;
    const byCh = new Map();
    for (const f of list) { if (!byCh.has(f.chapter)) byCh.set(f.chapter, []); byCh.get(f.chapter).push(f); }
    let n = 0;
    const at = new Date().toISOString();
    for (const [ch, items] of byCh) {
      const rec = await this.store.getChapter(b.id, ch);
      if (!rec) continue;
      const slots = rec.slots || [];
      for (const f of items) if (F.feedbackFixed(f, slots)) { f.resumedAt = at; n++; }
    }
    if (n) this.save();
    return n;
  }
  /** 词典版本变化后老书重新对齐：逐本、逐章，完成前阅读器用旧词位；正在读的那一章不中途换，下次翻章生效 */
  async realignBooks() {
    if (this._realigning) return;
    this._realigning = true;
    let done = 0, resumed = 0;
    try {
      for (const b of this.data.books.slice()) {
        const ix = this.idx.get(b.id);
        if (!needsRealign(ix, this.dict.version)) continue;
        const r = await realignBook({
          n: b.chapters.length, version: this.dict.version, yieldFn: yieldNow,
          getChapter: i => this.store.getChapter(b.id, i),
          putChapters: items => this.store.putChapters(b.id, items),
          putIdx: idx => this.store.putBookIdx(b.id, idx),
          match: text => matchChapter(text, this.dict, b.guards || [])
        });
        this.idx.set(b.id, r.idx);
        resumed += await this.resumeFixedFeedback(b);                    // 报过错、已修好的词恢复替换
        done++;
      }
    } catch (e) { this.flash('重新对齐没做完，下次打开再试：' + (e.message || e.name)); }
    finally { this._realigning = false; }
    if (done) { this.touch(); this.flash('词典已更新，' + done + ' 本书重新对齐' + (resumed ? '，' + resumed + ' 个报过错的词恢复替换' : '')); }
  }

  async addSample() {
    const sb = globalThis.MPData && globalThis.MPData.sampleBook;
    const existing = this.data.books.find(b => b.sample);
    if (existing) { this.flash('示例书已在书架上'); return existing.id; }
    this.lastInput = { kind: 'chapters', chapters: sb.chapters.map(c => ({ title: '第 ' + c.n + ' 章 · ' + c.title, text: c.text })), title: '暗巷', names: sb.names, sample: true, label: '示例书《暗巷》' };
    await this.runImport();
    return this.s.impResult && this.s.impResult.id;
  }

  // ============ 全局滚动：词库列表分批渲染 ============
  onAnyScroll(e) {
    const el = e.target;
    if (!(el instanceof HTMLElement) || this.s.tab !== 'vocab') return;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 600) this.setState({ vocabLimit: this.s.vocabLimit + 40 });
  }

  // ============ 渲染值 ============
  theme() {
    const L = this.data ? this.data.local : { theme: 'light', autoDark: false };
    const h = new Date().getHours();
    return L.autoDark && (h >= 22 || h < 6) ? 'dark' : L.theme;
  }
  vars(t) {
    if (t === 'dark') return { ground: '#0E1014', card: '#191D24', panel: '#1C2027', ink: '#E8E9EC', sub: '#9BA0AA', sub2: '#787E89', mute: '#262B33', line: '#252A32', btn: '#2E3642', btnFg: '#F2F3F5', bar: '#BFE699', cardSh: '0 0 0 1px rgba(255,255,255,.07)', heat0: '#20242B' };
    if (t === 'sepia') return { ground: '#EDE5D3', card: '#FBF7EC', panel: '#FBF7EC', ink: '#1E1B12', sub: '#7A7160', sub2: '#A2987F', mute: '#F1EADA', line: '#E7DFCC', btn: '#1E1B12', btnFg: '#FBF7EC', bar: '#1E1B12', cardSh: '0 1px 2px rgba(30,27,18,.05),0 14px 30px -24px rgba(30,27,18,.45)', heat0: '#E5DCC7' };
    return { ground: '#F2F1F0', card: '#FFFFFF', panel: '#FFFFFF', ink: '#030315', sub: '#7A7A85', sub2: '#A8A8B0', mute: '#F2F1F0', line: '#F0EFED', btn: '#030315', btnFg: '#FFFFFF', bar: '#030315', cardSh: '0 1px 2px rgba(3,3,21,.04),0 14px 30px -24px rgba(3,3,21,.5)', heat0: '#EDECEA' };
  }
  paper(t) {
    if (t === 'dark') return { paper: '#030315', ink: '#E4E4EA', sub: '#8C8C99', chip: 'rgba(255,255,255,.1)' };
    if (t === 'sepia') return { paper: '#F6F1E4', ink: '#1E1B12', sub: '#7A7160', chip: 'rgba(3,3,21,.07)' };
    return { paper: '#FFFFFF', ink: '#030315', sub: '#7A7A85', chip: '#F2F1F0' };
  }

  vals() {
    const s = this.s;
    /**
     * 背景色三档（白 / 米黄 / 纯黑）**只染阅读页**（2026-09-16 · 用户验收）。
     * 以前 vars(t) 是整壳的 CSS 变量源：在书里选「纯黑」，退出来书架、词库、「我」全跟着黑了 ——
     * 那三颗色卡在阅读器的 Aa 面板里，用户的预期是「这本书的纸」，不是换整个 App 的皮肤。
     * 现在：阅读页内（含它自己的 Aa / 目录 / 释义浮层，都在 reader 这一层）跟着主题走，外面恒定浅色。
     * paper(t) 那三个值（ink / sub / chipBg）本来就只在阅读器模板里用，不用再关一道。
     */
    const inReader = s.tab === 'reader';
    const t = this.theme(), V = this.vars(inReader ? t : 'light'), T = this.paper(t);
    const base = {
      shellBg: inReader ? T.paper : V.ground, vCard: V.card, vPanel: V.panel, vInk: V.ink, vSub: V.sub, vSub2: V.sub2, vMute: V.mute,
      vLine: V.line, vBtn: V.btn, vBtnFg: V.btnFg, vBar: V.bar, vCardSh: V.cardSh, ink: inReader ? T.ink : '#030315', sub: T.sub, chipBg: T.chip,
      fadeFrom: 'rgba(255,255,255,0)', fadeTo: T.paper, noop: () => {}, toast: s.toast || '', toastOpacity: s.toast ? 1 : 0, toastY: s.toast ? '0px' : '8px'
    };
    if (!this.data || !this.dict) {
      return { ...base, isRead: true, loading: s.loading, skeleton: s.loading ? [{}, {}, {}] : [], netFail: s.netFail, ready: false, retryNet: () => location.reload(), openBook: () => location.reload(),
        deckShort: '', learnedN: 0, deckTotal: 0, tugPct: 0, chTitle: s.bootErr || '', curTitle: '', pct: 0, bookDash: '0 132', tabY: '0%', tabOpacity: 1,
        tabBg0: 'var(--btn)', tabFg0: 'var(--btnFg)', tabBg1: 'transparent', tabFg1: 'var(--sub)', tabBg2: 'transparent', tabFg2: 'var(--sub)', maskOpacity: 0, maskEvents: 'none',
        sheetY: '118%', setY: '118%', chapY: '118%', logY: '118%', impY: '118%', bkY: '118%', badgeY: '118%', fbY: '118%', bmY: '118%' };
    }
    return { ...base, ...this.valsReady(V, T, t) };
  }

  valsReady(V, T, themeKey) {
    const s = this.s, d = this.data, P = d.prefs, L = d.local;
    const now = this.now(), today = this.today();
    const deck = this.curDeck();
    const learnedN = this.learnedIn(deck);
    const tugPct = deck.total ? Math.round(learnedN / deck.total * 100) : 0;
    const pill = on => on ? 'var(--btn)' : 'var(--mute)';
    const pillFg = on => on ? 'var(--btnFg)' : 'var(--sub)';
    const sw = on => ({ bg: on ? 'var(--btn)' : 'rgba(122,122,133,.3)', x: on ? '20px' : '0px' });
    const models = this.activeModels();
    const due = this.queue();
    const reader = s.tab === 'reader';
    const overlay = !!(s.sheet || s.settings || s.chapters || s.log || s.imp > 0 || s.badge !== null || s.share || s.sheetBook !== null || s.fb || s.bar || s.bkMenu !== null || s.ask);

    // ---------- 今日 / 七日 ----------
    const mins = Math.floor((d.dailies[today] || { mins: 0 }).mins);
    const goal = P.goal;
    const goalPct = Math.min(100, Math.round(mins / goal * 100));
    const C = 2 * Math.PI * 31, RC = 2 * Math.PI * 15;
    const dow = (new Date().getDay() + 6) % 7;
    const weekDates = WEEK_LABELS.map((_, i) => F.addDays(today, i - dow));
    const minsList = weekDates.map(x => x > today ? 0 : Math.floor((d.dailies[x] || { mins: 0 }).mins));
    const week = WEEK_LABELS.map((label, i) => {
      const m = minsList[i], r = m / goal, done = r >= 1, blank = m <= 0;
      return { label, done, showPct: !blank && !done, pct: Math.round(r * 100), disc: done ? LIME : 'transparent',
        trackColor: blank ? 'rgba(3,3,21,.22)' : 'rgba(3,3,21,.11)', trackWidth: blank ? 1.5 : 3, trackDash: blank ? '2 3.5' : '94.3 0',
        dash: (RC * Math.min(1, r)).toFixed(1) + ' ' + RC.toFixed(1), labelColor: blank ? '#A8A8B0' : '#030315', labelWeight: i === dow ? 600 : 400,
        onClick: () => {} };                                              // Q7：补打卡不做
    });
    const streak = F.streakOf(d.dailies, today);

    // ---------- 预测（近 28 天日均记词） ----------
    const learnedAt = Object.keys(d.entries).filter(w => this.entry(w) && deck.words.has(w)).map(w => Date.parse(d.entries[w].firstAt));
    const rate = F.dailyRate(d.dailies, today);
    const tooNew = F.usedDaysOf(d.dailies, today) < F.FORECAST_MIN_DAYS;
    const f = F.forecast({ total: deck.total, learnedN, learnedAt, daily: rate, nowMs: now, tooNew });
    const daily = rate >= 1 ? Math.round(rate) : rate > 0 ? rate.toFixed(1) : 0;
    const last3 = [2, 1, 0].map(k => { const x = F.addDays(today, -k); return { label: k === 0 ? '今天' : k === 1 ? '昨天' : '前天', n: (d.dailies[x] || {}).newWords || 0 }; });
    const max3 = Math.max(1, ...last3.map(x => x.n));

    // ---------- 书架 ----------
    const shelf = this.shelf();
    const curBook = this.book(d.lastBookId) || shelf[0] || null;
    const books = shelf.map(b => {
      const bd = this.bookDeck(b);
      const st = this.bookStats(b, bd);
      const top = st.rows.slice(0, 15);
      const MIX = [16, 34, 54, 76, 100];
      const maxF = top.length ? top[0][1] : 1;
      const bars = top.map(([w, n]) => {
        const tr = this.tier(w);                                           // 与看板留存构成同一口径（R1 · 01 A4 D5）
        const lv = !tr ? 0 : tr === 'solid' ? 4 : tr === 'ok' ? 3 : 2;
        return { h: Math.max(4, Math.round(n / maxF * 74)) + 'px', c: 'color-mix(in oklab,' + b.tone + ' ' + MIX[lv] + '%,#FFFFFF)' };
      });
      const pctB = this.bookPct(b);
      return { key: b.id, title: b.title, bars, barsEmpty: !bars.length, emptyHint: '这本书里没有当前词表的词',   // D15 空状态
        hitLabel: st.hit + ' 个' + bd.short + '词',                        // D8：书封改绝对数，不再是「覆盖 4%」
        pctLabel: b.finishedAt ? '已读完' : pctB === 0 ? '还没开始' : '已读 ' + pctB + '%',
        onClick: () => { if (this._lp) { this._lp = false; return; } this.setState({ sheetBook: b.id }); },
        onDown: () => { clearTimeout(this._bp); this._lp = false; this._bp = setTimeout(() => { this._lp = true; this.setState({ bkMenu: b.id, renaming: null }); }, 450); },
        onUp: () => clearTimeout(this._bp) };
    });

    const out = {
      loading: false, skeleton: [], netFail: false, ready: true, isEmpty: shelf.length === 0, retryNet: () => location.reload(),
      isRead: s.tab === 'read', isVocab: s.tab === 'vocab', isMe: s.tab === 'me', isReader: reader,
      deckName: deck.name, deckShort: deck.short, deckTotal: deck.total, learnedN, unlearnedN: deck.total - learnedN, tugW: tugPct + '%', tugPct,
      cycleDeck: () => this.cycleDeck(),
      daily, dailyBasis: tooNew ? '用满 7 天后按近 28 天速度算' : '按近 28 天速度', weeksLeft: f.weeks, doneDate: f.doneDate, doneDateShort: f.doneDateShort,
      doneLineShort: f.daysLeft && f.daysLeft <= 365 ? '预计 ' + f.doneDate + ' 学完' : f.doneDate + ' 学完',
      pastPath: f.pastPath, futurePath: f.futurePath, areaPath: f.areaPath, nowX: f.nowX.toFixed(1), nowY: f.nowY.toFixed(1), endX: f.endX.toFixed(1), endY: f.endY.toFixed(1),
      nowLabelX: f.nowLabelX, yTop: f.yTop, yMid: f.yMid,
      last3: last3.map(x => ({ ...x, h: Math.max(3, Math.round(x.n / max3 * 26)) + 'px' })),
      mins, minsLeft: Math.max(0, goal - mins), goalLabel: '目标 ' + (goal % 60 === 0 ? goal / 60 + ' 小时' : goal + ' 分钟'), goalPct,
      ringDash: (C * goalPct / 100).toFixed(1) + ' ' + C.toFixed(1),
      cycleGoal: () => this.setPref(P, 'goal', GOALS[(GOALS.indexOf(P.goal) + 1) % GOALS.length]),
      streak, week, weekDone: week.filter(x => x.done).length,
      books, bookList: books, shelfEmpty: shelf.length === 0, bookCount: shelf.length, deckSwitchLabel: deck.short,
      importBook: () => this.setState({ imp: 1 }),
      curTitle: curBook ? curBook.title : '还没有在读的书',
      chTitle: curBook ? (curBook.chapters[curBook.pos.chapter] || { t: '' }).t : '导入一本书开始',
      pct: curBook ? this.bookPct(curBook) : 0,
      bookDash: (2 * Math.PI * 21 * (curBook ? this.bookPct(curBook) : 0) / 100).toFixed(1) + ' ' + (2 * Math.PI * 21).toFixed(1),
      openBook: () => curBook ? this.openBook(curBook.id) : this.setState({ imp: 1 }),
      dueCount: due.length, hasDue: due.length > 0,
      goRead: () => this.go('read'), goVocab: () => this.go('vocab'), goMe: () => this.go('me'),
      backToRead: () => this.leaveReader('read'),
      closeAll: () => this.setState({ sheet: null, settings: false, chapters: false, log: null, imp: s.imp === 2 ? 2 : 0, badge: null, share: false, sheetBook: null, fb: null, bar: null, bkMenu: null, renaming: null, ask: null }),
      maskOpacity: overlay ? 1 : 0, maskEvents: overlay ? 'auto' : 'none',
      sheetY: s.sheet ? '0%' : '118%', setY: s.settings ? '0%' : '118%', chapY: s.chapters ? '0%' : '118%', logY: s.log ? '0%' : '118%',
      tabY: (reader || overlay || s.tab === 'review' || s.onb !== null || !!s.page || s.badge !== null || s.share || this.authOn()) ? '150%' : '0%',
      tabOpacity: (reader || overlay || s.tab === 'review' || s.onb !== null || !!s.page || s.badge !== null || s.share || this.authOn()) ? 0 : 1,
      tabBg0: s.tab === 'read' ? 'var(--btn)' : 'transparent', tabBg1: s.tab === 'vocab' ? 'var(--btn)' : 'transparent', tabBg2: s.tab === 'me' ? 'var(--btn)' : 'transparent',
      tabFg0: pillFg(s.tab === 'read'), tabFg1: pillFg(s.tab === 'vocab'), tabFg2: pillFg(s.tab === 'me'),
      remindAt: P.remindAt
    };

    Object.assign(out, this.valsReader(T, L, deck), this.valsSheets(V, deck), this.valsVocab(deck, models), this.valsMe(V, deck, learnedN, tugPct, models, due, minsList, today, f, daily),
      this.valsReview(due), this.valsOnboarding(deck), this.valsImport(), this.valsPages(deck), this.valsDensity(L));
    return out;
  }

  authOn() { return this.data && !this.data.auth; }
  go(tab) { this.setState({ tab, sheet: null, settings: false, chapters: false, vocabLimit: 40 }); }
  cycleDeck() {
    const decks = this.allDecks();
    const i = decks.findIndex(x => x.id === this.data.prefs.deckId);
    // 走 setPref（2026-09-16 修）：这颗顶部循环按钮原来直接赋值 + save()，于是「换词表」这个
    // 登记表点名要看的设置（events.mjs setting.changed 的 q）只有设置页那条路径采得到
    this.setPref(this.data.prefs, 'deckId', decks[(i + 1) % decks.length].id, 'deckId');
    this.flash('当前词库 · ' + this.curDeck().short);
  }

  valsDensity(L) {
    const den = this.denFor();
    return {
      denStops: DEN_NAMES.map((n, i) => ({ name: n, h: (14 + i * 5) + 'px', c: i <= den ? LIME : 'var(--line)', onClick: () => this.setDen(i) })),
      denName: DEN_NAMES[den], densityName: DEN_NAMES[den]
    };
  }
  denFor() {
    const r = this.s.reader;
    const b = r ? this.book(r.bookId) : (this.s.imp === 3 && this.s.impResult ? this.book(this.s.impResult.id) : null);
    return b && b.den != null ? b.den : this.data.local.den;
  }
  setDen(i) {
    const r = this.s.reader;
    const b = r ? this.book(r.bookId) : (this.s.imp === 3 && this.s.impResult ? this.book(this.s.impResult.id) : null);
    if (b) this.setPref(b, 'den', i, 'den');                              // 密度档是产品决策最想知道的一个设置（B1 定值就靠它校准）
    else this.setPref(this.data.local, 'den', i, 'den');
  }

  // ---------- 阅读器 ----------
  chapterParsed() {
    const r = this.s.reader;
    if (!r) return null;
    if (this.parsedCache && this.parsedCache.data === r.data) return this.parsedCache;
    const text = r.data.text || '';
    const p = NRParse.parseChapter(text);
    return (this.parsedCache = { data: r.data, paras: p.paras, sents: p.sents, chars: p.chars, charN: F.charCount(text) });
  }
  valsReader(T, L, deck) {
    const s = this.s, r = s.reader;
    const fontDef = FONTS.find(x => x.k === L.font) || FONTS[0];
    const out = {
      fs: L.fs, lh: L.fs >= 20 ? 2.15 : 2.05, readerFont: fontDef.family, paged: L.pageMode === 'page', readerScroll: L.pageMode === 'page' ? 'hidden' : 'auto',
      toggleSettings: () => this.setState({ settings: !s.settings, sheet: null, chapters: false }),
      toggleChapters: () => this.setState({ chapters: !s.chapters, sheet: null, settings: false }),
      fsUp: () => this.setPref(L, 'fs', Math.min(22, L.fs + 1), 'fs'), fsDown: () => this.setPref(L, 'fs', Math.max(15, L.fs - 1), 'fs'),
      fsW: Math.round((L.fs - 15) / 7 * 100) + '%', fsTrans: s.fsDrag ? '0s' : '.22s cubic-bezier(.4,0,.2,1)',
      fsRef: el => { this.fsEl = el; },
      fsDragStart: e => { if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId); this._fsFrom = L.fs; this.setState({ fsDrag: true }); this.fsFromX(e.clientX); },
      fsDragMove: e => { if (this.s.fsDrag) this.fsFromX(e.clientX); }, fsDragEnd: () => { this.noteFsDrag(); this.setState({ fsDrag: false }); },
      setThemeLight: () => { L.theme = 'light'; this.save(); }, setThemeSepia: () => { L.theme = 'sepia'; this.save(); }, setThemeDark: () => { L.theme = 'dark'; this.save(); },
      ringLight: this.ring('light'), ringSepia: this.ring('sepia'), ringDark: this.ring('dark'),
      fontOpts: FONTS.map(x => ({ name: x.name, family: x.family, ring: L.font === x.k ? '0 0 0 2px var(--panel),0 0 0 5px #BFE699' : 'inset 0 0 0 1px rgba(122,122,133,.3)', onClick: () => { L.font = x.k; this.save(); } })),
      setScrollMode: () => this.setPref(L, 'pageMode', 'scroll'), setPageMode: () => { this.setPref(L, 'pageMode', 'page'); requestAnimationFrame(() => this.measurePages()); },
      scrollModeBg: L.pageMode === 'page' ? 'var(--mute)' : 'var(--btn)', scrollModeFg: L.pageMode === 'page' ? 'var(--sub)' : 'var(--btnFg)',
      pageModeBg: L.pageMode === 'page' ? 'var(--btn)' : 'var(--mute)', pageModeFg: L.pageMode === 'page' ? 'var(--btnFg)' : 'var(--sub)',
      peekOn: L.peekOn, peekBg: L.peekOn ? 'var(--btn)' : 'rgba(122,122,133,.3)', peekX: L.peekOn ? '20px' : '0px',
      togglePeek: () => { L.peekOn = !L.peekOn; this.s.peek = false; this.save(); },
      toggleShowEn: () => this.setPref(L, 'showEn', !L.showEn),
      switchBg: L.showEn ? 'var(--btn)' : 'rgba(122,122,133,.3)', switchX: L.showEn ? '20px' : '0px',
      peekStart: () => { if (!L.peekOn) return; clearTimeout(this._p); this._p = setTimeout(() => this.setState({ peek: true }), 320); },
      peekEnd: () => { clearTimeout(this._p); if (this.s.peek) this.setState({ peek: false }); },
      sessionLearned: s.sessionLearned
    };
    if (!r) return Object.assign(out, { paras: [], chMissing: false, chEndVisible: false, chapters: [], chCount: 0, pctW: '0%', readerFootRight: '', chNextLabel: '', onPage: 0 });
    const b = this.book(r.bookId);
    const n = b.chapters.length;
    const pc = this.chapterParsed();
    const bd = this.bookDeck(b);
    const ix = this.idx.get(b.id) || { freq: {}, chWords: [] };
    const slots = r.data.slots || [];
    const den = b.den != null ? b.den : L.den;
    const modes = F.slotModes(slots, { ...this.slotCtx(bd, ix.freq, den, L.showEn, b.hash), chars: pc.charN });
    this.enterChapter(b, r.chapter, slots, modes, pc.charN, den);         // 换了章才动（同一章反复重绘不重复计曝光）
    let onPage = 0, si = 0;
    const paras = pc.paras.map(pa => {
      const runs = [];
      let cur = pa.start;
      const end = pa.start + pa.len;
      while (si < slots.length && slots[si].o < pa.start) si++;
      for (; si < slots.length && slots[si].o < end; si++) {
        const sl = slots[si], mode = modes[si];
        if (!mode) continue;
        if (sl.o > cur) runs.push(this.textRun(pc.chars.slice(cur, sl.o).join('')));
        runs.push(this.slotRun(sl, mode, pc, r, T));
        if (mode !== 'zh') onPage++;
        cur = sl.o + sl.l;
      }
      if (cur < end) runs.push(this.textRun(pc.chars.slice(cur, end).join('')));
      return { runs };
    });
    const bookPct = this.bookPct(b);
    const paged = L.pageMode === 'page';
    const last = r.chapter >= n - 1;
    const qq = s.chQ.trim();
    const chList = b.chapters.map((c, i) => ({ c, i })).filter(({ c, i }) => !qq || c.t.includes(qq) || String(i + 1) === qq);
    const window0 = qq ? chList : chList.filter(({ i }) => Math.abs(i - r.chapter) <= 150);
    return Object.assign(out, {
      paras, onPage, chMissing: !pc.paras.length, chTitle: b.chapters[r.chapter] ? b.chapters[r.chapter].t : '',
      chEndVisible: pc.paras.length > 0 && (!paged || s.rpage >= s.pageCount - 1),
      chNextLabel: last ? (b.finishedAt ? '全书读完' : '读完全书') : '下一章 · ' + b.chapters[r.chapter + 1].t, chIsLast: last,
      nextChapter: () => this.nextChapter(),
      readerFootRight: paged ? (Math.min(s.rpage, s.pageCount - 1) + 1) + ' / ' + s.pageCount : bookPct + '%',
      pctW: bookPct + '%',
      prevPage: () => this.tapPage(-1), nextPage: () => this.tapPage(1),
      onScroll: e => this.onReaderScroll(e.currentTarget),
      reparse: () => this.reparse(b.id),
      chQ: s.chQ, onChQ: e => this.setState({ chQ: e.target.value }), hasChQ: !!s.chQ, clearChQ: () => this.setState({ chQ: '' }),
      chCount: n, chNoResult: !!qq && !chList.length,
      chapters: window0.map(({ c, i }) => {
        const ws = ix.chWords[i] || [];
        const inDeck = ws.filter(w => bd.words.has(w) || this.entry(w));
        const nw = inDeck.filter(w => !this.entry(w)).length;
        const done = b.read.includes(i);
        const C2 = 2 * Math.PI * 10;
        const p = done ? 1 : i === r.chapter ? s.chPct / 100 : 0;
        return { key: i, title: c.t, words: inDeck.length, nw, known: inDeck.length - nw, w: i === r.chapter ? 600 : 400, color: c.empty ? 'var(--sub2)' : 'var(--ink2)',
          goto: () => this.gotoChapter(i), cur: i === r.chapter, done, ringDash: (C2 * p).toFixed(1) + ' ' + C2.toFixed(1) };
      }),
      chRef: el => { this.chEl = el; if (el) requestAnimationFrame(() => this.chMeasure()); },
      chTrackRef: el => { this.chTrack = el; }, chOnScroll: () => this.chMeasure(),
      chThumbH: Math.max(16, Math.round(s.chVis * 100)) + '%', chThumbTop: (s.chSc * (100 - Math.max(16, Math.round(s.chVis * 100)))).toFixed(2) + '%',
      chBarTrans: s.chBarDrag ? '0s' : '.12s linear',
      chBarDown: e => { if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId); this.setState({ chBarDrag: true }); this.chDragTo(e.clientY); },
      chBarMove: e => { if (this.s.chBarDrag) this.chDragTo(e.clientY); }, chBarUp: () => this.setState({ chBarDrag: false })
    });
  }
  /** 已会线（R2 · B3）：没记下、词频名次在线内的词当作已会 */
  basic(w) { if (this.entry(w)) return false; const x = this.dict.words.get(w); return !!x && F.isBasic(x.rank, F.knownLine(this.data.quizEst)); }
  /** 词表里、词典里、且不在已会线内的「新词」候选（正文替换 / 未学列表 / 书封柱 / 覆盖数同一口径） */
  /** 词位对应的那条桥的 sense_id（R3 · 01 C1）。词典里没有这条桥（自建词表、旧数据）时是 null */
  senseIdOf(w, expr) { return senseIdIn(this.dict, w, expr); }
  newWordOf(deck, w) { return deck.words.has(w) && this.dict.words.has(w) && !this.basic(w); }
  slotCtx(deck, freq, den, showEn, bookHash = null) {
    const paused = F.pausedSet(this.data.feedback, bookHash);            // 本书纠错暂停的词（A11：只在这本书里不替）
    return { inDeck: w => this.newWordOf(deck, w), entryState: w => this.entryState(w), muted: w => F.userMuted(this.data.muted, w) || paused.has(w),
      lvOf: w => (this.dict.words.get(w) || { lv: 3 }).lv, freq, den, DEN_CAP: F.DEN_CAP, showEn };
  }
  textRun(text) { return { aText: text, aStyle: '', bText: '', bStyle: 'display:none', style: '', onClick: null }; }
  /**
   * 曝光（R3 · 01 E4）：**一次章次访问每词一条**（不是每个词位一条——1800 章的书逐词位记会把事件仓撑爆，
   * 也不是每次重绘记一次——vals() 每次滚动都跑）。
   *
   * 「见过」只算**真的翻到的那一段**：按本次访问到达过的最大进度截断（this._expoMax）。
   * 小说台 doc/06 用「段落 35% 进视口 + 停留 1.5 秒」区分「滑过去」和「读了」；CiTi 一次只渲染一章，
   * 用「到达过的进度」是同一个意思的便宜版——整章照记会把没翻到的后半章也算成见过，那是系统性高估。
   * 真正的「读了多久」由 reading.session 回答，两者互相印证。
   */
  enterChapter(b, chapter, slots, modes, charN, den) {
    const key = b.hash + '#' + chapter;
    if (this._expoKey === key) return;
    this.flushChapter();
    this._expoKey = key;
    this._expoAt = { hash: b.hash, chapter, slots, modes };
    this._expoMax = 0;
    this._sess = { hash: b.hash, chapter, secs: 0, charN, den, from: (b.pos && b.pos.chapter === chapter ? b.pos.pct : 0) || 0 };
  }
  /**
   * 离开这一章（换章 / 退出阅读器 / 切后台）时把曝光与阅读会话一起结算。
   * **进度只读一次再传下去**：曝光与会话都要用它，而 flushExposure 会把它清零——
   * 原来的写法（各自去读 this._expoMax）让 chars_read 恒为 0，浏览器实测才发现，断言里看不出来。
   */
  flushChapter() { const max = Math.min(1, this._expoMax || 0); this.flushExposure(max); this.flushSession(max); }
  /**
   * 阅读会话（R3 · 01 E5 N1）：dailies / hours / bookSecs 从今往后是**能从事件重建的缓存**，
   * 事实是这一条。秒数与缓存同一把尺子（含 outlier 扣除），chars_read 按这一次新读到的进度算。
   */
  flushSession(max = Math.min(1, this._expoMax || 0)) {
    const x = this._sess;
    this._sess = null;
    if (!x || x.secs < 1) return 0;                                       // 不足 1 秒的（翻一下就走）不记
    const gained = Math.max(0, max - x.from);
    this.emit('reading.session', {
      book_hash: x.hash, chapter: x.chapter, seconds: Math.round(x.secs * 10) / 10,
      chars_read: Math.round((x.charN || 0) * gained), den: x.den, page_mode: this.data.local.pageMode === 'page' ? 'page' : 'scroll'
    });
    return 1;
  }
  noteReadRatio(ratio) { if (this._expoAt && ratio > (this._expoMax || 0)) this._expoMax = Math.min(1, ratio); }
  /** 结算这一章：按「词 × 形态」合并成一条一条事件。返回事件条数 */
  flushExposure(max = Math.min(1, this._expoMax || 0)) {
    const at = this._expoAt;
    this._expoKey = null; this._expoAt = null;
    this._expoMax = 0;
    if (!at || !at.slots.length || max <= 0) return 0;
    const last = at.slots[at.slots.length - 1].o;
    const cut = last * max;
    const m = new Map();
    at.slots.forEach((sl, i) => {
      const form = at.modes[i];
      if (!form || sl.o > cut) return;
      const k = sl.w + ' ' + form;
      m.set(k, (m.get(k) || 0) + 1);
    });
    for (const [k, count] of m) {
      const i = k.lastIndexOf(' ');
      this.emit('word.exposed', { w: k.slice(0, i), book_hash: at.hash, chapter: at.chapter, form: k.slice(i + 1), count });
    }
    return m.size;
  }
  slotRun(sl, mode, pc, r, T) {
    const w = this.dict.words.get(sl.w) || { zh: '' };
    const surface = pc.chars.slice(sl.o, sl.o + sl.l).join('');
    const swaps = mode === 'en';
    let shown = mode;
    if (swaps && this.s.peek) shown = 'zh';
    const active = this.s.sheet && this.s.sheet.o === sl.o && this.s.sheet.w === sl.w;
    let box = 'color:' + T.ink + ';cursor:pointer;margin:0 3px;padding:0 1px 2px;';
    if (swaps) box += 'display:inline-block;position:relative;text-align:center;text-indent:0;';
    box += active ? 'border-bottom:1.5px solid ' + T.ink : 'border-bottom:1px dashed ' + T.sub + ';transition:border-color .2s';
    const text = shown === 'en' ? sl.w : shown === 'both' ? surface + ' ' + sl.w : surface;
    return {
      style: box, aText: swaps ? sl.w : text, aStyle: swaps && shown !== 'en' ? 'visibility:hidden' : '',
      bText: swaps ? surface : '', bStyle: swaps && shown !== 'en' ? 'position:absolute;left:0;right:0;top:0' : 'display:none',
      onClick: () => {
        const sent = pc.sents.find(x => sl.o >= x.start && sl.o < x.start + x.len);
        const bk = this.book(r.bookId);
        this.emit('word.looked_up', { w: sl.w, sense_id: this.senseIdOf(sl.w, surface), book_hash: bk ? bk.hash : null, chapter: r.chapter, via: 'tap' });
        this.setState({ sheet: { w: sl.w, o: sl.o, expr: surface, sentence: sent ? sent.text.trim() : surface, chapter: r.chapter }, settings: false, chapters: false });
      }
    };
  }
  ring(t) { return this.data.local.theme === t ? '0 0 0 2px var(--panel),0 0 0 5px #BFE699' : 'inset 0 0 0 1px rgba(122,122,133,.3)'; }
  /** 拖动字号只在松手时采一条 setting.changed：拖的过程中每一帧都采会把事件仓灌满（fsFromX 每次 pointermove 都跑） */
  noteFsDrag() {
    const from = this._fsFrom;
    this._fsFrom = null;
    const to = this.data.local.fs;
    if (from == null || from === to) return;
    this.emit('setting.changed', { key: 'fs', from: String(from), to: String(to) });
  }
  fsFromX(x) {
    const el = this.fsEl; if (!el) return;
    const rc = el.getBoundingClientRect(); if (!rc.width) return;
    const fs = Math.round(15 + Math.min(1, Math.max(0, (x - rc.left) / rc.width)) * 7);
    if (fs !== this.data.local.fs) { this.data.local.fs = fs; this.save(); }
  }
  chMeasure() {
    const el = this.chEl; if (!el) return;
    const vis = Math.min(1, el.clientHeight / Math.max(1, el.scrollHeight));
    const max = el.scrollHeight - el.clientHeight;
    const p = max > 0 ? el.scrollTop / max : 0;
    if (Math.abs(vis - this.s.chVis) > 0.002 || Math.abs(p - this.s.chSc) > 0.002) this.setState({ chVis: vis, chSc: p });
  }
  chDragTo(y) {
    const tr = this.chTrack, el = this.chEl; if (!tr || !el) return;
    const rc = tr.getBoundingClientRect();
    const th = Math.max(36, rc.height * Math.min(1, el.clientHeight / Math.max(1, el.scrollHeight)));
    const t = Math.min(1, Math.max(0, (y - rc.top - th / 2) / Math.max(1, rc.height - th)));
    el.scrollTop = t * (el.scrollHeight - el.clientHeight);
    this.chMeasure();
  }
  onReaderScroll(el) {
    this.readerEl = el;
    const r = this.s.reader; if (!r) return;
    const max = el.scrollHeight - el.clientHeight;
    const ratio = max > 0 ? Math.min(1, el.scrollTop / max) : 0;
    this.noteScroll(el);

    const b = this.book(r.bookId);
    b.pos = { chapter: r.chapter, pct: ratio };
    this.noteReadRatio(ratio);
    const cp = Math.round(ratio * 100);
    if (cp !== this.s.chPct) { this.s.chPct = cp; this.save(); }
  }
  /**
   * 滚动模式下的「一屏」：累计滚动距离每满一个可视高度，就当作翻过一屏结算一次。
   * · 只在滚动模式累计 —— 翻页模式里 turnPage 已经显式结算，再累计就是双重计数（turnPage 设置
   *   scrollTop 也会触发 scroll 事件）。
   * · 单次位移超过两屏的按「定位跳转」处理（换章、恢复进度、拖进度条），不计入，也不结算。
   */
  noteScroll(el) {
    if (this.data.local.pageMode === 'page') { this._lastTop = el.scrollTop; return; }
    const top = el.scrollTop;
    const screen = Math.max(1, el.clientHeight);
    const prev = this._lastTop == null ? top : this._lastTop;
    this._lastTop = top;
    const dist = Math.abs(top - prev);
    if (dist > screen * 2) { this._scrollAcc = 0; return; }
    this._scrollAcc = (this._scrollAcc || 0) + dist;
    let guard = 0;
    while (this._scrollAcc >= screen && guard++ < 20) { this._scrollAcc -= screen; this.onPageTurn(); }
  }
  // ---------- 阅读手势（2026-09-16 · 用户验收：翻页不跟手） ----------
  /**
   * 手势只认「阅读器正文那一层」。设置 / 目录 / 释义 / 遮罩都挂在 reader 外面那一层，
   * 用 wrap.contains(target) 一次全排除掉，不用逐个列浮层开关（漏一个就会在浮层上误翻页）。
   */
  gestureEl(target) {
    if (this.s.tab !== 'reader' || !this.s.reader) return null;
    const el = this.findReaderEl();
    const wrap = el && el.parentNode;
    if (!wrap || !(target === wrap || wrap.contains(target))) return null;
    return el;
  }
  maxTop(el) { return Math.max(0, el.scrollHeight - el.clientHeight); }
  atChapterEnd(el) { return el.scrollTop >= this.maxTop(el) - 2; }
  /**
   * 用 touch 而不是 pointer：iOS 上滚动一启动就会发 pointercancel，
   * 「已经到底了还想往下推」那一下恰好全在滚动过程里，pointer 版收不到。
   */
  bindGestures() {
    const r = this.root;
    r.addEventListener('touchstart', e => this.gestureStart(e), { capture: true, passive: true });
    r.addEventListener('touchend', e => this.gestureEnd(e), { capture: true, passive: true });
    r.addEventListener('touchcancel', () => { this._g = null; }, { capture: true, passive: true });
    r.addEventListener('wheel', e => this.gestureWheel(e), { capture: true, passive: true });
  }
  /** 左右两块点击区：刚刚那一下已经被 swipe 翻过了就不再翻（iOS 轻滑之后还会补一个 click） */
  tapPage(dir) {
    if (this._swipeAt && this.now() - this._swipeAt < 400) return;
    this.turnPage(dir);
  }
  gestureStart(e) {
    const t = e.touches && e.touches[0];
    const el = t ? this.gestureEl(e.target) : null;
    this._g = el ? { x: t.clientX, y: t.clientY, atEnd: this.atChapterEnd(el) } : null;
  }
  gestureEnd(e) {
    const g = this._g; this._g = null;
    const t = e.changedTouches && e.changedTouches[0];
    const el = g && t ? this.gestureEl(e.target) : null;
    if (!el) return;
    const act = F.swipeAction({ paged: this.data.local.pageMode === 'page', dx: t.clientX - g.x, dy: t.clientY - g.y,
      atEnd: this.atChapterEnd(el), startedAtEnd: g.atEnd });
    if (!act) return;
    if (act === 'nextChapter') { this.autoNextChapter(); return; }
    this._swipeAt = this.now();                    // 紧跟着那一下 click 是这次滑动带出来的，别再翻一页
    this.turnPage(act === 'nextPage' ? 1 : -1);
  }
  /** 桌面端的同一件事：滚到章末还在继续往下滚，累计够一下就进下一章 */
  gestureWheel(e) {
    const el = this.gestureEl(e.target);
    if (!el || this.data.local.pageMode === 'page' || e.deltaY <= 0 || !this.atChapterEnd(el)) { this._wheelAcc = 0; return; }
    this._wheelAcc = (this._wheelAcc || 0) + e.deltaY;
    if (this._wheelAcc < F.SWIPE.wheelEnd) return;
    this._wheelAcc = 0;
    this.autoNextChapter();
  }
  /**
   * 翻到下一章。gotoChapter 是异步的（要从 IndexedDB 取正文），所以必须上闸：
   * 没有这道闸，连着滑两下会一次跨两章，而且第二次拿到的还是旧的 s.reader.chapter。
   * 最后一章读完之后再推不重复结算。
   */
  autoNextChapter() {
    const r = this.s.reader;
    if (!r || this._autoCh) return;
    const b = this.book(r.bookId);
    if (r.chapter >= b.chapters.length - 1 && b.finishedAt) return;
    this._autoCh = true;
    Promise.resolve(this.nextChapter()).finally(() => { this._autoCh = false; });
  }
  turnPage(dir) {
    const el = this.findReaderEl(); if (!el) return;
    this.measurePages();
    const step = this.pageStep();
    const pg = this.s.rpage + dir;
    // 两头都要能出去（2026-09-16 · 用户验收「左右翻页翻不动」）：以前第一页往回翻直接 return，
    // 章末往后翻又撞上 nextChapter 的异步竞态，连点两下会跳过一章。现在前后都走 goto/auto 这一条路。
    if (pg < 0) { this.prevChapter(); return; }
    if (pg >= this.s.pageCount) { this.autoNextChapter(); return; }
    el.scrollTop = pg * step;
    this.onPageTurn();
    this.onReaderScroll(el);
    this.setState({ rpage: pg });
  }
  /** toEnd：往回翻章时落在上一章的最后一页，而不是又从头开始（翻页模式才有意义） */
  async gotoChapter(i, toEnd = false) {
    const r = this.s.reader, b = this.book(r.bookId);
    b.pos = { chapter: i, pct: 0 };
    const data = (await this.store.getChapter(b.id, i)) || { title: b.chapters[i].t, text: '', slots: [] };
    this.parsedCache = null;
    this.resetScrollBase();
    this.setState({ reader: { ...r, chapter: i, data }, chapters: false, sheet: null, chPct: 0, rpage: 0 });
    this.save();
    requestAnimationFrame(() => {
      if (!this.findReaderEl()) return;
      this.readerEl.scrollTop = 0;
      this.measurePages();
      if (!toEnd) return;
      // 落到最后一页要量两次：翻页模式下「下一章」那一行只在最后一页才渲染，它一出现正文就长一截、页数 +1
      // （实测 9 → 10）。只量一次会停在倒数第二页，用户还得再滑一下才到真正的章末。
      const fit = () => { if (!this.findReaderEl()) return; this.measurePages(); const last = this.s.pageCount - 1; this.readerEl.scrollTop = last * this.pageStep(); this.setState({ rpage: last }); };
      fit();
      requestAnimationFrame(fit);
    });
  }
  /** 第一页再往回翻 = 上一章的最后一页；已经是第一章就不动 */
  async prevChapter() {
    const r = this.s.reader;
    if (!r || r.chapter <= 0) return;
    await this.gotoChapter(r.chapter - 1, true);
  }
  async nextChapter() {
    const r = this.s.reader, b = this.book(r.bookId);
    if (!b.read.includes(r.chapter)) b.read.push(r.chapter);
    this.onPageTurn();
    this.noteReadRatio(1);                                                // 翻到下一章 = 这一章翻完了
    if (r.chapter >= b.chapters.length - 1) {
      if (!b.finishedAt) { b.finishedAt = new Date().toISOString(); this.flash('读完了《' + b.title + '》'); }
      b.pos = { chapter: r.chapter, pct: 1 };
      this.save(); this.awardBadges();
      return;
    }
    await this.gotoChapter(r.chapter + 1);
  }
  async reparse(bookId) {
    const b = this.book(bookId);
    const chapters = [];
    for (let i = 0; i < b.chapters.length; i++) { const c = await this.store.getChapter(b.id, i); chapters.push({ title: b.chapters[i].t, text: c ? c.text : '' }); }
    this.lastInput = { kind: 'chapters', chapters, title: b.title, names: [], label: '重新解析 · ' + b.title };
    this.setState({ chapters: false, bkMenu: null });
    await this.runImport({ reparseId: b.id });
    if (this.s.reader && this.s.reader.bookId === b.id) this.gotoChapter(this.s.reader.chapter);
  }

  // ---------- 浮层：释义 / 纠错 / 书籍面板 / 书籍管理 / 确认 ----------
  valsSheets(V, deck) {
    const s = this.s, d = this.data;
    const sh = s.sheet;
    const w = sh ? (this.dict.words.get(sh.w) || {}) : {};
    const isLearned = !!(sh && this.entry(sh.w));
    const curBook = s.reader ? this.book(s.reader.bookId) : null;
    const out = {
      sheetWord: sh ? sh.w : '', sheetPh: w.ph || '', sheetPos: w.pos || '', sheetDef: w.def || '',
      sheetEx: w.ex || (sh ? '原文：' + sh.sentence : ''), sheetExZh: w.ex ? w.exZh : (sh ? '「' + sh.expr + '」在这一句里被替换' : ''),
      learnLabel: isLearned ? '已记下 · 取消' : '记下这个词', learnBg: isLearned ? 'var(--mute)' : 'var(--btn)', learnFg: isLearned ? 'var(--sub)' : 'var(--btnFg)', learnDot: isLearned ? '#E4E3E0' : LIME,
      learnWord: () => {
        if (!sh) return;
        if (isLearned) {
          d.entries[sh.w].deletedAt = new Date().toISOString();
          this.emit('word.unlearned', { w: sh.w, sense_id: d.entries[sh.w].senseId || null });
          this.save(); this.setState({ sheet: null }); this.flash('已取消记下 ' + sh.w); return;
        }
        this.learnWord(sh.w, { bookHash: curBook ? curBook.hash : null, title: curBook ? curBook.title : null, sentence: sh.sentence, expr: sh.expr });
        this.setState({ sheet: null, sessionLearned: s.sessionLearned + 1 });
        this.flash('已记下 ' + sh.w);
      },
      muteWord: () => { if (!sh) return; d.muted[sh.w] = { by: 'user', at: new Date().toISOString() }; this.emit('word.muted', { w: sh.w, on: true }); this.save(); this.setState({ sheet: null }); this.flash(sh.w + ' 不再替换'); },
      openFb: () => this.setState({ fb: { ...s.sheet, bookHash: (this.book(s.reader && s.reader.bookId) || curBook || {}).hash || null }, sheet: null, fbReason: 0 }),
      fbY: s.fb ? '0%' : '118%', fbWord: s.fb ? s.fb.expr : '', fbClose: () => this.setState({ fb: null }),
      fbReasons: FB_REASONS.map((r, i) => ({ name: r.name, hint: r.hint, ring: s.fbReason === i ? 'inset 0 0 0 1.5px var(--ink2)' : 'inset 0 0 0 1px rgba(122,122,133,.22)',
        dot: s.fbReason === i ? LIME : 'transparent', dotRing: s.fbReason === i ? 'none' : 'inset 0 0 0 1.5px rgba(122,122,133,.4)', onClick: () => this.setState({ fbReason: i }) })),
      fbSubmit: () => {
        const fb = s.fb; if (!fb) return;
        // 反馈只带词位坐标，不带正文（PRD §2）
        d.feedback.push({ w: fb.w, reason: FB_REASONS[s.fbReason].k, bookHash: fb.bookHash || null, chapter: fb.chapter, offset: fb.o, at: new Date().toISOString() });   // 作用域是「打开这个词的那本书」，不是「在读的书」（D2 从书籍面板也能报）
        this.emit('slot.reported', { w: fb.w, sense_id: this.senseIdOf(fb.w, fb.expr), book_hash: fb.bookHash || null,
          chapter: fb.chapter == null ? null : fb.chapter, offset: fb.o == null ? null : fb.o, reason: FB_REASONS[s.fbReason].k });
        this.save(); this.setState({ fb: null }); this.flash('已收到 · 本书里 ' + fb.w + ' 暂停替换');   // 不写全局 mute：别的书照常替换、复习照常（A11）
      },
      askOn: !!s.ask, askCancel: () => this.setState({ ask: null })
    };
    // 书籍面板
    const bk = s.sheetBook ? this.book(s.sheetBook) : null;
    if (bk) {
      const cur = this.bookDeck(bk);
      // D8：推荐按绝对命中词数（比例会让 14 个词的示例词表永远排第一）；示例词表只在示例书里参与推荐
      const decks = this.allDecks().filter(x => x.id === cur.id || x.id !== SAMPLE_DECK || bk.sample).map(x => ({ x, cov: this.coverage(bk, x) })).sort((a, b) => b.cov - a.cov);
      const shown = decks.slice(0, 3);
      if (!shown.some(y => y && y.x.id === cur.id)) shown[2] = decks.find(y => y.x.id === cur.id);
      const st = this.bookStats(bk, cur);
      const tones = ['#030315', '#8CC152', 'rgba(122,122,133,.34)'];
      const cnt = st.legend;                                               // D4：图例数全书，柱只画 top 22
      const top = st.rows.slice(0, 22);
      const maxF = top.length ? top[0][1] : 1;
      // D2：柱可点 → 浮层（这个词在书里替掉的是哪几个中文、各几次 + 「这个词不对」）。最高的柱往往是错桥，这是发现它的入口
      const bars = top.map(([w2, n]) => { const tr = this.tier(w2), g = !tr ? 2 : tr === 'solid' ? 0 : 1; return { key: w2, h: Math.max(5, Math.round(n / maxF * 100)) + '%', c: tones[g], onClick: () => this.setState({ bar: { w: w2, bookId: bk.id } }) }; });
      const pb = this.bookPct(bk);
      const hist = F.freqHistogram(st.rows, w2 => this.tier(w2));
      const maxBin = Math.max(1, ...hist.map(x => x.n));
      Object.assign(out, {
        bkTitle: bk.title, bkRead: pb === 0 ? '还没开始' : '已读 ' + pb + '%',
        bkDecks: shown.map(({ x, cov }) => {
          const on = x.id === cur.id, cp = x.total ? Math.round(cov / x.total * 100) : 0;
          return { key: x.id, name: x.short, full: x.name, pct: cp + '%', barW: cp + '%', sub: cov + ' / ' + x.total + ' 词', barC: on ? '#030315' : 'rgba(3,3,21,.22)',
            ring: on ? 'inset 0 0 0 1.5px var(--ink2)' : 'inset 0 0 0 1px rgba(122,122,133,.22)', weight: on ? 600 : 400,
            onClick: () => { d.prefs.bookDecks[bk.hash] = x.id; this.save(); } };
        }),
        bkBars: bars, bkLegend: ['牢固', '学习中', '未学'].map((nm, g) => ({ name: nm, n: cnt[g], c: tones[g] })),
        bkHist: hist.map(x => {                                            // D1 分桶直方图（拍板 Q10）：柱高 = 落在该桶的词数，按三档掌握堆叠
          const h = Math.round(x.n / maxBin * 56);
          return { key: x.label, label: x.label, n: x.n, h: Math.max(x.n ? 2 : 0, h) + 'px',
            segs: x.g.map((g2, i) => ({ key: i, h: (g2 ? Math.max(1, Math.round(h * g2 / x.n)) : 0) + 'px', c: tones[i] })) };
        })
      });
    } else Object.assign(out, { bkTitle: '', bkRead: '', bkDecks: [], bkBars: [], bkLegend: [], bkHist: [] });
    Object.assign(out, { bkY: bk ? '0%' : '118%', bkOpen: () => { const id = s.sheetBook; this.setState({ sheetBook: null }); this.openBook(id); }, bkClose: () => this.setState({ sheetBook: null }) });
    // D2 柱可点浮层：这个英文词在这本书里替掉了哪几个中文、各几次 + 「这个词不对」（最高的柱往往是错桥）
    const bar = s.bar ? this.book(s.bar.bookId) : null;
    const barW = bar ? s.bar.w : '';
    const barIx = bar ? (this.idx.get(bar.id) || {}) : {};
    const barExprs = bar ? exprRows(barIx.exprFreq, barW) : [];
    Object.assign(out, {
      barY: bar ? '0%' : '118%', barWord: barW, barDef: bar ? ((this.dict.words.get(barW) || {}).def || '') : '',
      barCaption: bar ? '在《' + bar.title + '》里出现 ' + ((barIx.freq || {})[barW] || 0) + ' 次'
        + (barExprs.length ? '，替掉这 ' + barExprs.length + ' 个中文说法：' : '。这本书的词位还没算出中文说法（重新解析一次即可）。') : '',
      barExprs: barExprs.map(([zh, n]) => ({ key: zh, zh, n })),
      barClose: () => this.setState({ bar: null }),
      barReport: async () => {
        if (!bar) return;
        const loc = await this.firstSlotOf(bar, barW);                       // 纠错要词位坐标；点柱时才去翻那一章，不预先加载
        this.setState({ bar: null, fbReason: 0, fb: { w: barW, expr: (loc && loc.expr) || (barExprs[0] && barExprs[0][0]) || barW, chapter: loc ? loc.chapter : null, o: loc ? loc.o : null, bookHash: bar.hash } });
      }
    });
    // 书籍管理
    const bm = s.bkMenu ? this.book(s.bkMenu) : null;
    Object.assign(out, {
      bmY: bm ? '0%' : '118%', bmTitle: s.renaming ? '重命名' : (bm ? bm.title : ''), bmMeta: bm ? (this.bookPct(bm) === 0 ? '还没开始' : '已读 ' + this.bookPct(bm) + '%') : '',
      bmMenu: !!bm && !s.renaming, bmRenaming: !!s.renaming, renameVal: s.renameVal, onRename: e => this.setState({ renameVal: e.target.value }),
      renameSave: () => { const v = s.renameVal.trim(); if (!v) { this.flash('书名不能为空'); return; } this.book(s.renaming).title = v.slice(0, 100); this.save(); this.setState({ renaming: null, bkMenu: null }); this.flash('已改名为《' + v + '》'); },
      renameCancel: () => this.setState({ renaming: null }), bmClose: () => this.setState({ bkMenu: null, renaming: null }),
      bmActions: bm ? [
        { name: '重命名', hint: '导入时的文件名往往不是书名', icon: 'M4 20h4l10 -10l-4 -4l-10 10zM14 6l4 4', color: 'var(--ink2)', onClick: () => this.setState({ renaming: bm.id, renameVal: bm.title }) },
        { name: '重新解析', hint: '换了词表或章节切错时用', icon: 'M20 11a8 8 0 1 0 -2.3 5.7M20 5v6h-6', color: 'var(--ink2)', onClick: () => this.reparse(bm.id) },
        { name: '导出这本书的生词', hint: '导出为纯文本，可粘到其他背词工具', icon: 'M12 4v11M8 11l4 4l4 -4M5 19h14', color: 'var(--ink2)', onClick: () => this.exportWords(bm) },
        { name: '删除这本书', hint: '书与阅读进度一起删，已记的词保留在词库', icon: 'M5 7h14M9 7V5h6v2M7 7l1 13h8l1 -13', color: '#B0503A', onClick: () => this.setState({ bkMenu: null, ask: { kind: 'del', id: bm.id } }) }
      ] : []
    });
    // 确认框三种：删书 / 开每日提醒 / 看板同步。后两种都是「这台设备上做不到」的说明框，
    // 确认键只是「知道了」，不改任何状态 —— 界面不该声称一件当前构建做不到的事（ASK_COPY）。
    const ask = s.ask;
    const delBook = ask && ask.kind === 'del' ? this.book(ask.id) : null;
    const askCopy = delBook ? null : ASK_COPY[(ask && ask.kind) || 'sub'] || ASK_COPY.sub;
    Object.assign(out, {
      askTitle: delBook ? '删除《' + delBook.title + '》' : askCopy.title,
      askBody: delBook ? '这本书的正文、章节与阅读进度会一起删掉。从它里记下的词仍留在词库，复习排程不受影响。' : askCopy.body,
      askYes: delBook ? '删 除' : '知道了', askNo: delBook ? '不删' : '暂不', askYesBg: delBook ? '#B0503A' : 'var(--btn)', askYesFg: delBook ? '#FFFFFF' : 'var(--btnFg)',
      askConfirm: async () => {
        if (delBook) {
          try { this.data = await this.store.deleteBook(this.data, delBook.id, delBook.chapters.length); this.idx.delete(delBook.id); if (this.data.lastBookId === delBook.id) this.data.lastBookId = null; this.touch(); this.setState({ ask: null }); this.flash('《' + delBook.title + '》已删除'); }
          catch (e) { this.flash('删除失败：' + e.message); }
        } else this.setState({ ask: null });
      }
    });
    return out;
  }
  /**
   * 「导出这本书的生词」（R2 · 01 D11）：一期导出的是**已记下**的词，与「新建词库 · 从书里的生词」方向相反。
   * 改成导出未记下的词（书籍面板里画出来的那一批：词表内、过了已会线、没被 mute / 纠错暂停），按出现次数降序；
   * 已记下的词附在文件末尾一节，不丢。文案不改（04 第 23 行）。
   */
  exportWordsText(b) {
    const deck = this.bookDeck(b);
    const rows = this.bookStats(b, deck).rows;
    const line = ([w, n]) => w + '\t' + ((this.dict.words.get(w) || {}).def || '') + '\t出现 ' + n + ' 次';
    const fresh = rows.filter(([w]) => !this.entry(w)), learned = rows.filter(([w]) => this.entry(w));
    const parts = ['《' + b.title + '》· 未记下的' + deck.short + '词 ' + fresh.length + ' 个', ...fresh.map(line)];
    if (learned.length) parts.push('', '已记下 ' + learned.length + ' 个', ...learned.map(line));
    return { text: parts.join('\n'), n: fresh.length };
  }
  async exportWords(b) {
    const { text, n } = this.exportWordsText(b);
    this.setState({ bkMenu: null });
    try { await navigator.clipboard.writeText(text); this.flash(n + ' 个生词已复制到剪贴板'); }
    catch { this.flash('剪贴板不可用，没能复制'); }
  }

  // ---------- 词库 Tab ----------
  valsVocab(deck, models) {
    const s = this.s, d = this.data;
    const qq = s.q.trim().toLowerCase();
    const now = this.now();
    const learnedWords = Object.keys(d.entries).filter(w => this.entry(w));
    // 已会线内的词不进未学列表；但搜索时要搜得到，否则没法手动记下解除（R2 · B3）
    const unlearned = w => qq ? !this.entry(w) : this.newWordOf(deck, w);
    let pool;
    if (s.filter === 1) pool = learnedWords;
    else if (s.filter === 2) pool = [...deck.words].filter(unlearned);
    else pool = learnedWords.concat([...deck.words].filter(unlearned));
    const retMemo = new Map(), dueMemo = new Map();
    const ret = w => { if (!retMemo.has(w)) retMemo.set(w, this.entry(w) ? this.retNow(w) : 1); return retMemo.get(w); };
    const nextOf = w => { if (!dueMemo.has(w)) { const m = this.modelOf(w); dueMemo.set(w, m ? M.nextDue(M.buildHistory(m, this.cfg()), 0, this.cfg()) : 9999); } return dueMemo.get(w); };
    let list = pool.filter(w => this.dict.words.has(w)).filter(w => !qq || w.toLowerCase().includes(qq) || (this.dict.words.get(w).def || '').includes(s.q.trim()));
    const firstAt = w => this.entry(w) ? Date.parse(d.entries[w].firstAt) : 0;
    if (s.sortIdx === 1) list.sort((a, b) => nextOf(a) - nextOf(b));
    else if (s.sortIdx === 2) list.sort((a, b) => ret(a) - ret(b));
    else if (s.sortIdx === 3) list.sort((a, b) => firstAt(b) - firstAt(a));
    const total = list.length;
    list = list.slice(0, s.vocabLimit);
    const vocabList = list.map(w => {
      const dw = this.dict.words.get(w), m = this.modelOf(w), has = !!m;
      const h = has ? M.buildHistory(m, this.cfg()) : null;
      const c = has ? F.ebbChart(h, 158, 54, 2, 4, 4, 3, this.cfg()) : null;
      return { key: w, w, def: dw.def, has, blank: !has, mini: has ? c.past : '', area: has ? c.area : '', future: has ? c.future : '', dots: has ? c.dots : [],
        nowX: has ? c.nowX : 0, nowY: has ? c.nowY : 0, thrY: has ? c.thrY : 40, baseY: has ? c.baseY : 50,
        pct: has ? Math.round(M.retentionNow(m, 0, this.cfg()) * 100) + '%' : '', caption: has ? F.dueCaption(c.nextAt) : this.basic(w) ? '默认已会 · 点开可记下' : '还没记下这个词',
        onClick: () => this.setState({ log: w }) };
    });
    const out = {
      q: s.q, onQ: e => this.setState({ q: e.target.value, vocabLimit: 40 }), clearQ: () => this.setState({ q: '' }), hasQ: !!s.q,
      sortPills: SORTS.map((nm, i) => ({ name: nm, bg: s.sortIdx === i ? 'var(--btn)' : 'var(--mute)', fg: s.sortIdx === i ? 'var(--btnFg)' : 'var(--sub)', onClick: () => this.setState({ sortIdx: i, vocabLimit: 40 }) })),
      vocabList, vocabEmpty: !total, hasVocab: !!total,
      vocabEmptyText: qq ? '没有匹配「' + s.q + '」的词' : (s.filter === 1 && !learnedWords.length) ? '词库还是空的，去阅读里记下第一个词' : '这个筛选下没有词',
      fBg0: s.filter === 0 ? 'var(--btn)' : 'var(--mute)', fFg0: s.filter === 0 ? 'var(--btnFg)' : 'var(--sub)',
      fBg1: s.filter === 1 ? 'var(--btn)' : 'var(--mute)', fFg1: s.filter === 1 ? 'var(--btnFg)' : 'var(--sub)',
      fBg2: s.filter === 2 ? 'var(--btn)' : 'var(--mute)', fFg2: s.filter === 2 ? 'var(--btnFg)' : 'var(--sub)',
      setFilter0: () => this.setState({ filter: 0, vocabLimit: 40 }), setFilter1: () => this.setState({ filter: 1, vocabLimit: 40 }), setFilter2: () => this.setState({ filter: 2, vocabLimit: 40 }),
      closeLog: () => this.setState({ log: null }),
      reviewNow: () => {
        const w = s.log;
        if (w && !this.entry(w)) { this.learnWord(w, { title: '词库' }); this.setState({ log: null }); this.flash('已记下 ' + w); return; }   // 没记下的词：这颗按钮就是「记下」（已会线内的词靠它解除，R2 · B3）
        if (w && !s.forced.includes(w)) s.forced.push(w);
        this.setState({ log: null }); this.flash('已加入今日复习');
      },
      logActLabel: s.log && this.entry(s.log) ? '加入今日复习' : '记下这个词'
    };
    // 学习日志
    const lw = s.log;
    let lv = { logWord: '', logDef: '', logPh: '', logStrength: 0, logNext: '', logPast: '', logFuture: '', logArea: '', logDots: [], logs: [], logLine: 66, logNowX: 0, logNowY: 0 };
    if (lw) {
      const dw = this.dict.words.get(lw) || {}, m = this.modelOf(lw), has = !!m;
      const h = has ? M.buildHistory(m, this.cfg()) : null;
      const c = has ? F.ebbChart(h, 336, 112, 10, 12, 24, 99, this.cfg()) : null;
      const strength = has ? Math.round(M.retentionNow(m, 0, this.cfg()) * 100) : 0;
      const e = d.entries[lw];
      const revs = has ? F.reviewsOf(e) : [];
      const GR = { keep: '记得', fuzzy: '模糊', forget: '忘了' };
      lv = {
        logWord: lw, logDef: dw.def || '', logPh: dw.ph || '', logStrength: strength,
        logNext: has ? (c.nextAt <= 0 ? '建议今天' : F.fmtMD(new Date(now + c.nextAt * F.DAY))) : '尚未开始',
        logPast: has ? c.past : '', logFuture: has ? c.future : '', logArea: has ? c.area : '', logDots: has ? c.dots : [], logNowX: has ? c.nowX : 0, logNowY: has ? c.nowY : 0, logLine: has ? c.thrY : 66,
        logs: (has ? h.revs.map((t, i) => {
          const date = F.fmtMD(new Date(now + t * F.DAY));
          const before = i === 0 ? null : Math.round(M.retentionAt({ revs: h.revs.slice(0, i), P: h.P.slice(0, i), S: h.S.slice(0, i), n: i }, t) * 100);
          return { key: i, date, action: i === 0 ? '阅读中记下 · 初始留存 85%' : '复习' + GR[revs[i - 1].grade] + ' · 间隔 ' + Math.max(0, Math.round(t - h.revs[i - 1])) + ' 天 · 复习前 ' + before + '%',
            val: Math.round(h.P[i] * 100) + '%', valColor: 'var(--ink2)' };
        }) : []).concat([{ key: 'now', date: '今天', action: has ? '当前留存' : '还没记下这个词', val: has ? strength + '%' : '—', valColor: 'var(--sub)' }])
      };
    }
    return Object.assign(out, lv);
  }

  // ---------- 我的 Tab ----------
  valsMe(V, deck, learnedN, tugPct, models, due, minsList, today, f, daily) {
    const s = this.s, d = this.data, P = d.prefs;
    const now = this.now();
    // 阅读日历：近 18 周
    const heatCols = [];
    const dow = (new Date().getDay() + 6) % 7;
    const start = F.addDays(today, -(17 * 7 + dow));
    let heatDays = 0;
    for (let c = 0; c < 18; c++) {
      const cells = [];
      for (let r = 0; r < 7; r++) {
        const x = F.addDays(start, c * 7 + r);
        const mm = x > today ? 0 : ((d.dailies[x] || {}).mins || 0);
        const lvl = mm <= 0 ? 0 : mm < 15 ? 1 : mm < 30 ? 2 : mm < 60 ? 3 : 4;
        if (lvl) heatDays++;
        cells.push({ c: lvl === 0 ? V.heat0 : HEAT_COLORS[lvl] });
      }
      heatCols.push({ cells });
    }
    const heatBest = F.bestRun(d.dailies, start, today);
    const peakMin = Math.max(60, ...minsList);
    const timeBars = minsList.map((m, i) => ({ h: Math.max(4, Math.round(m / peakMin * 56)) + 'px', c: i === dow ? 'var(--bar)' : m > 0 ? '#8FBF6A' : 'var(--line)', label: WEEK_LABELS[i], w: i === dow ? 600 : 400 }));
    const weekMins = minsList.reduce((a, b) => a + b, 0);
    // 单词学习榜
    const rOf = new Map(models.map(m => [m.w, M.retentionNow(m, 0, this.cfg())]));
    const wordTop = models.map(m => ({ w: m.w, n: m.reviews.length + 1, r: rOf.get(m.w) })).sort((a, b) => b.n - a.n || b.r - a.r).slice(0, 5)
      .map((v, i) => ({ rank: i + 1, w: v.w, rankColor: i === 0 ? 'var(--ink2)' : 'var(--sub2)', barW: Math.round(v.r * 100) + '%', pct: Math.round(v.r * 100) + '%' }));
    // 书籍排行榜
    const bookRows = d.books.map(b => ({ title: b.title, secs: d.bookSecs[b.hash] || 0, tone: b.tone })).filter(b => b.secs > 0).sort((a, b) => b.secs - a.secs).slice(0, 4);
    const bookTop = bookRows.map((b, i, arr) => ({ rank: i + 1, title: b.title, cover: 'linear-gradient(162deg,' + b.tone + ',color-mix(in oklab,' + b.tone + ' 44%,#14161A))',
      rankColor: i === 0 ? 'var(--ink2)' : 'var(--sub2)', barW: Math.round(b.secs / arr[0].secs * 100) + '%', hours: (b.secs / 3600).toFixed(1) + ' h' }));
    // 留存构成
    const br = M.retentionBreakdown(models, 0, this.cfg());
    const totalR = Math.max(1, br.solid + br.ok + br.due);
    const RC2 = 2 * Math.PI * 26;
    const seg = n => (RC2 * n / totalR).toFixed(1) + ' ' + RC2.toFixed(1);
    const off = n => (-RC2 * n / totalR).toFixed(1);
    // 阅读时段：近 30 天，两小时一格
    const hrs = new Array(24).fill(0);
    for (let i = 0; i < 30; i++) { const h = d.hours[F.addDays(today, -i)]; if (h) h.forEach((v, k) => { hrs[k] += v; }); }
    const buckets = new Array(12).fill(0).map((_, i) => hrs[i * 2] + hrs[i * 2 + 1]);
    const hourMax = Math.max(...buckets);
    const HOUR_LABELS = ['0', '', '4', '', '8', '', '12', '', '16', '', '20', ''];
    const hourBars = buckets.map((h, i) => ({ h: Math.max(3, Math.round(h / (hourMax || 1) * 46)) + 'px', c: hourMax && h === hourMax ? 'var(--bar)' : h > 0 ? '#C7DEA6' : 'var(--line)', label: HOUR_LABELS[i] }));
    const hrTotal = hrs.reduce((a, b) => a + b, 0);
    const peakB = buckets.indexOf(hourMax);
    const nightShare = hrTotal ? Math.round((hrs[22] + hrs[23] + hrs[0] + hrs[1] + hrs[2] + hrs[3]) / hrTotal * 100) : 0;
    const hoursCaption = hrTotal ? `最常在 ${peakB * 2}–${peakB * 2 + 2} 点读，夜读占 ${nightShare}%` : '近 30 天还没有阅读记录';
    // 生词来源：本月
    const monthKey = today.slice(0, 7);
    // 按内容 hash 聚合（F.sourceRows）：改书名不再把同一本书裂成两条，口径与下面分享卡的 shareN 一致
    const srcRows = F.sourceRows(d.entries, d.books, monthKey, w => !!this.entry(w));
    const srcMax = srcRows.length ? srcRows[0].n : 1;
    const source = srcRows.map(r => ({ title: r.title, n: r.n + ' 词', barW: Math.round(r.n / srcMax * 100) + '%',
      c: 'color-mix(in oklab,' + (r.tone || '#5C6B45') + ' 62%,#FFFFFF)' }));
    // 词库对比
    const deckRows = this.allDecks().map(x => { const ln = this.learnedIn(x), p = x.total ? Math.round(ln / x.total * 100) : 0; const cur = x.id === P.deckId;
      return { key: x.id, name: x.short, pct: p + '%', barW: p + '%', sub: ln + ' / ' + x.total, weight: cur ? 600 : 400, c: cur ? 'var(--bar)' : '#C7DEA6', onClick: () => this.setPref(P, 'deckId', x.id) }; });
    // 年度目标
    const year = today.slice(0, 4);
    const yearDone = d.books.filter(b => b.finishedAt && F.ymd(new Date(b.finishedAt)).startsWith(year)).length;
    const dayOfYear = Math.floor((now - new Date(+year, 0, 1).getTime()) / F.DAY) + 1;
    const yearCaption = yearDone ? `按当前速度，今年能读完 ${Math.round(yearDone / dayOfYear * 365)} 本` : '今年还没有读完的书';
    const yearSlots = [];
    for (let i = 0; i < P.yearGoal; i++) yearSlots.push({ c: i < yearDone ? 'var(--bar)' : 'var(--line)' });
    // 记忆曲线：该词库的理想排程示意（模型理想节奏，不是用户数据）
    const ideal = M.idealSchedule(5, this.cfg());
    const shift = ideal.revs[4] + 6;
    const ebbM = { revs: ideal.revs.map(x => x - shift), P: ideal.P, S: ideal.S, n: ideal.n };
    const ebbC = F.ebbChart(ebbM, 302, 96, 6, 10, 14, 99, this.cfg());
    const ebbPeaks = ebbM.revs.map((r, i) => ({ cx: ebbC.dots[i].cx, cy: ebbC.dots[i].cy, label: i === 0 ? '初记' : '+' + Math.round(r - ebbM.revs[i - 1]) + '天', pct: Math.round(ebbM.P[i] * 100) + '%' }));
    const avgRet = models.length ? Math.round(models.reduce((a, m) => a + rOf.get(m.w), 0) / models.length * 100) : 0;
    // 勋章
    const bf = F.badgeFacts(d, today);
    const badges = BADGES.map((b, i) => { const got = !!d.badges[b.key];
      return { name: b.name, icon: b.icon, got, onClick: () => this.setState({ badge: i }), bg: got ? LIME : 'var(--mute)', fg: got ? '#030315' : 'var(--sub2)', ring: got ? 'none' : 'inset 0 0 0 1px rgba(3,3,21,.07)', labelColor: got ? 'var(--ink2)' : 'var(--sub2)' }; });
    const PROG = { streak7: `连续 ${bf.streak} / 7 天`, words100: `${bf.words} / 100 词`, night10: `${bf.nightDays} / 10 天`, book1: `${bf.finishedBooks} / 1 本`, words1000: `${bf.words} / 1000 词`, month: `本月已打卡 ${bf.monthDays} 天` };
    const bi = s.badge;
    const TINT = { card: '#FFFFFF', mute: '#F2F1F0', sub: '#41513F', sub2: '#6E7583', line: 'rgba(3,3,21,.08)', btn: '#030315', btnFg: '#FFFFFF', bar: '#030315', ink: '#030315' };
    // 不能写 var(--card)：卡片上 --card:var(--card) 是自引用循环，整张卡里的变量全部失效（原型数据就有这个坑）
    const NEUT = { card: V.card, mute: V.mute, sub: V.sub, sub2: V.sub2, line: V.line, btn: V.btn, btnFg: V.btnFg, bar: V.bar, ink: V.ink };
    const boardMeta = { heat: '近 18 周 · ' + heatDays + ' 天', progress: '', time: '', wordTop: '按复习次数', bookTop: '按阅读时长', review: '', retention: models.length + ' 词', ebb: '理想排程示意', decks: '点行切换', hours: '近 30 日', source: '本月新增', year: yearDone + ' / ' + P.yearGoal, badges: Object.keys(d.badges).length + ' / ' + BADGES.length };
    const board = P.board.filter(k => WIDGETS[k]).map((k, i) => {
      const wd = WIDGETS[k], Pp = wd.tinted ? TINT : NEUT;
      const move = j => { const bb = P.board.slice(); if (j < 0 || j >= bb.length) return; [bb[i], bb[j]] = [bb[j], bb[i]]; P.board = bb; this.save(); };
      return { key: k, name: wd.name, icon: wd.icon, bg: wd.tinted ? wd.bg : 'var(--card)', ...Pp, iconBg: wd.tinted ? '#FFFFFF' : 'var(--mute)',
        shadow: s.editing ? 'inset 0 0 0 1.5px rgba(3,3,21,.16)' : wd.tinted ? 'none' : 'var(--cardSh)', editing: s.editing, plain: !s.editing && !!boardMeta[k], meta: boardMeta[k], metaColor: wd.tinted ? '#41513F' : 'var(--sub2)',
        isHeat: k === 'heat', isProgress: k === 'progress', isTime: k === 'time', isWordTop: k === 'wordTop', isBookTop: k === 'bookTop', isBadges: k === 'badges',
        isReview: k === 'review', isRetention: k === 'retention', isDecks: k === 'decks', isHours: k === 'hours', isSource: k === 'source', isYear: k === 'year', isEbb: k === 'ebb',
        up: () => move(i - 1), down: () => move(i + 1), remove: () => { P.board = P.board.filter(x => x !== k); this.save(); this.flash('已移除 ' + wd.name); } };
    });
    const pool = WIDGET_KEYS.filter(k => !P.board.includes(k)).map(k => ({ key: k, name: WIDGETS[k].name, icon: WIDGETS[k].icon, add: () => { P.board = P.board.concat([k]); this.save(); this.flash('已添加 ' + WIDGETS[k].name); } }));
    const mutedN = Object.keys(d.muted).filter(w => F.userMuted(d.muted, w)).length + F.pausedList(d.feedback).length;
    const finished = d.books.filter(b => b.finishedAt).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0];
    const shareBook = finished || this.book(d.lastBookId);
    const shareN = shareBook ? Object.values(d.entries).filter(e => F.activeEntry(e) && (e.srcBook ? e.srcBook === shareBook.hash : e.srcTitle === shareBook.title)).length : Object.values(d.entries).filter(F.activeEntry).length;
    return {
      board, pool, heatCols, heatBest, heatLegend: HEAT_COLORS.map((c, i) => ({ c: i === 0 ? V.heat0 : c })),
      timeBars, wordTop, bookTop, badges, dueChips: due.slice(0, 4).map(w => ({ w, pct: Math.round(this.retNow(w) * 100) + '%' })),
      retSolid: br.solid, retOkay: br.ok, retDue: br.due, retDash1: seg(br.solid), retOff1: 0, retDash2: seg(br.ok), retOff2: off(br.solid), retDash3: seg(br.due), retOff3: off(br.solid + br.ok),
      hourBars, hoursCaption, source, deckRows, yearSlots, yearDone, yearGoal: P.yearGoal, yearCaption,
      ebbPast: ebbC.past, ebbFuture: ebbC.future, ebbArea: ebbC.area, ebbThr: ebbC.thrY, ebbPeaks, avgRet,
      weekHours: (weekMins / 60).toFixed(1), avgMins: Math.round(weekMins / 7), weekDone7: minsList.filter(m => m > 0).length,
      editing: s.editing, editLabel: s.editing ? '完 成' : '编辑', editIcon: s.editing ? 'M5 12.5l4.5 4.5L19 7' : 'M4 20h4l10 -10l-4 -4l-10 10zM14 6l4 4',
      editBg: s.editing ? 'var(--btn)' : 'var(--card)', editFg: s.editing ? 'var(--btnFg)' : 'var(--ink2)', toggleEdit: () => this.setState({ editing: !s.editing }),
      poolHint: pool.length ? '点一下加到看板' : '全部组件已在看板上',
      isGuest: true, isSignedIn: false, meName: '未登录', meSub: '词库与进度只存在这台手机上',
      askLogin: () => { d.auth = null; this.save(); },
      meRows: [
        { icon: 'M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1 -2 -2zM9 8h6', label: '我的词库', value: this.allDecks().length + ' 个', onClick: () => this.setState({ page: 'decks' }) },
        { icon: 'M4 8h13l-3 -3M20 16H7l3 3', label: '复习方式', value: (RV_MODES.find(m => m.k === P.rvMode) || RV_MODES[0]).name, onClick: () => this.setState({ page: 'rvmode' }) },
        { icon: 'M4 4l16 16M10 5a7 7 0 0 1 9 7M5 12a7 7 0 0 0 9 7', label: '不再替换的词', value: mutedN + ' 个', onClick: () => this.setState({ page: 'muted' }) },
        { icon: 'M18 9a6 6 0 1 0 -12 0c0 4 -1.5 5 -2 6h16c-.5 -1 -2 -2 -2 -6M10 20a2.2 2.2 0 0 0 4 0', label: '每日提醒', value: P.remind ? P.remindAt : '已关闭', onClick: () => this.setState({ page: 'remind' }) },
        { icon: 'M12 4a8 8 0 1 0 0 16a8 8 0 0 0 0 -16M12 8v4l3 2', label: '时长统计口径', value: '无操作 ' + P.idle + ' 分钟', onClick: () => this.setState({ page: 'stat' }) },
        { icon: 'M4 8h13l-3 -3M20 16H7l3 3', label: '看板同步', value: '仅本机', onClick: () => this.setState({ page: 'sync' }) },   // 网页版没有账号，无论 prefs.sync 在哪一档都只存本机
        { icon: 'M12 4v11M7.5 10.5L12 15l4.5 -4.5M5 19h14', label: '备份与恢复', value: d.backupAt ? '上次 ' + F.ymd(new Date(d.backupAt)).slice(5) : '未备份', onClick: () => this.setState({ page: 'backup', bkPending: null, bkErr: '' }) }
      ],
      startReview: () => this.openReview(),
      badgeY: bi !== null ? '0%' : '118%', badgeName: bi !== null ? BADGES[bi].name : '', badgeIcon: bi !== null ? BADGES[bi].icon : '',
      badgeGot: bi !== null && !!d.badges[BADGES[bi].key], badgeCond: bi !== null ? BADGES[bi].cond : '',
      badgeState: bi !== null ? (d.badges[BADGES[bi].key] ? d.badges[BADGES[bi].key].slice(0, 10) + ' 获得' : '尚未达成') : '',
      badgeBg: bi !== null && d.badges[BADGES[bi].key] ? LIME : 'var(--mute)', badgeFg: bi !== null && d.badges[BADGES[bi].key] ? '#030315' : 'var(--sub2)',
      badgeProgress: bi !== null ? (d.badges[BADGES[bi].key] ? '已达成' : '进度 ' + PROG[BADGES[bi].key]) : '',
      closeBadge: () => this.setState({ badge: null }), shareOn: s.share, shareY: s.share ? '0%' : '118%', closeShare: () => this.setState({ share: false }), openShare: () => this.setState({ badge: null, share: true }),
      shareHead1: shareBook ? (shareBook.finishedAt ? '读完了《' + shareBook.title + '》' : '在读《' + shareBook.title + '》') : '在小说里背单词',
      shareHead2: '顺手记下 ' + shareN + ' 个词',
      shareRows: [{ k: '连续打卡', v: F.streakOf(d.dailies, today) + ' 天' }, { k: '词库进度', v: learnedN + ' / ' + deck.total + ' 词' }, { k: '本周阅读', v: (weekMins / 60).toFixed(1) + ' 小时' }]
    };
  }

  // ---------- 复习 ----------
  openReview(queue) {
    const all = queue || [...new Set(this.queue().concat(this.s.forced.filter(w => this.entry(w))))];
    if (!all.length) { this.flash('今天没有到期的词'); return; }
    const q = all.slice(0, F.ROUND_MAX);                                   // 每轮最多 30 词（R1 · 01 A7）
    this.setState({ tab: 'review', rv: { queue: q, i: 0, revealed: false, res: [], shownAt: Date.now() }, sheet: null, settings: false, chapters: false, log: null, forced: [], spellVal: '', choicePick: null });
  }
  valsReview() {
    const s = this.s, d = this.data, P = d.prefs, rv = s.rv;
    const rvTotal = rv ? rv.queue.length : 0;
    const rvSummary = !!(rv && rv.i >= rvTotal);
    const curW = rv && !rvSummary ? rv.queue[rv.i] : null;
    const cur = curW ? this.entry(curW) : null;
    const dw = curW ? (this.dict.words.get(curW) || {}) : {};
    const m = curW && cur ? this.modelOf(curW) : null;
    const gr = g => m ? M.previewGrade(m, g, 0, this.cfg()) : { days: 0, peak: 0 };
    const hasCtx = !!(cur && cur.srcSentence && cur.srcExpr && cur.srcSentence.includes(cur.srcExpr));
    const mode = P.rvMode === 'context' && !hasCtx ? 'recall' : P.rvMode;          // 缺原文降级为回想中文（PRD §7）
    const asking = !!(rv && !rvSummary && !rv.revealed);
    const applyGrade = g => {
      if (!cur) return;
      if (g === 'keep' && !keepOk) return;                                   // 答错「记得」不可选（R1 · 01 A6 · 拍板 Q4）
      const before = M.retentionNow(m, 0, this.cfg());
      const pv = M.previewGrade(m, g, 0, this.cfg());
      const nReviews = (cur.reviews || []).length;
      cur.reviews = (cur.reviews || []).concat([{ at: new Date().toISOString(), grade: g, mode }]);
      // R3 · 01 E4：correct 是客观对错（拼写 / 四选一才有），grade 是用户自评，两者分开存；
      // overdue_days = 逾期多久才来复习（> 0 逾期、< 0 提前），R6 校准要靠它把「按时」和「刷分」分开
      this.emit('review.answered', {
        w: curW, sense_id: cur.senseId || null, mode, grade: g,
        correct: mode === 'spell' ? spellOk : mode === 'choice' ? choiceOk : null,
        latency_ms: rv.shownAt ? Math.min(600000, Date.now() - rv.shownAt) : null,
        answer: mode === 'spell' ? s.spellVal.trim().slice(0, 64) : mode === 'choice' && s.choicePick !== null ? String(s.choicePick) : null,
        retention: Math.round(before * 1e4) / 1e4, overdue_days: Math.round(-M.nextDue(M.buildHistory(m, this.cfg()), 0, this.cfg()) * 1e3) / 1e3,
        reviews_before: nReviews
      });
      this.save();
      this.setState({ rv: { ...rv, i: rv.i + 1, revealed: false, res: rv.res.concat([{ w: curW, g, days: pv.days, p: pv.peak, before }]), shownAt: Date.now() }, spellVal: '', choicePick: null });
    };
    const spellOk = !!(curW && s.spellVal.trim().toLowerCase() === curW.toLowerCase());
    // 四选一：干扰项取同词表其他词的真实释义，按词确定性挑选（刷新不变）
    const deck = this.curDeck();
    const choiceDefs = [];
    if (curW) {
      const pool = [...deck.words].filter(w => w !== curW && this.dict.words.has(w));
      const h = hashStr(curW);
      const picks = [];
      const senses = F.defSenses(dw.def);                                  // 干扰项不能与正确释义共享义项（F.distractorOk）
      for (let k = 0; picks.length < 3 && k < 120 && pool.length; k++) { const def = this.dict.words.get(pool[(h + k * 7919) % pool.length]).def; if (F.distractorOk(dw.def, def, senses) && !picks.includes(def)) picks.push(def); }
      picks.splice(h % 4, 0, dw.def || '');
      choiceDefs.push(...picks);
    }
    const choiceOk = s.choicePick !== null && choiceDefs[s.choicePick] === dw.def;
    const keepOk = F.keepAllowed(mode, spellOk, choiceOk);
    const ctxRuns = [];
    if (hasCtx) {
      const parts = cur.srcSentence.split(cur.srcExpr);
      parts.forEach((p, k) => { if (k > 0) ctxRuns.push({ text: '　', style: 'color:var(--sub2);border-bottom:1.5px solid var(--sub2);padding:0 16px;margin:0 5px' }); ctxRuns.push({ text: p, style: '' }); });
    }
    const cnt = g => rv ? rv.res.filter(r => r.g === g).length : 0;
    const res = rv ? rv.res : [];
    const rvSoon = res.length ? Math.min(...res.map(r => r.days)) : 0;
    const srcFull = cur && cur.srcSentence ? cur.srcSentence : '';
    // 提问阶段不能露答案：没有英文例句时用原文，但把被替换的中文词挖空
    const srcBlank = srcFull && cur.srcExpr ? srcFull.split(cur.srcExpr).join('____') : srcFull;
    const exLine = dw.ex || (asking ? srcBlank : srcFull);
    return {
      rvOn: s.tab === 'review', rvSummary, rvIdx: rv ? Math.min(rv.i + 1, rvTotal) : 0, rvTotal, rvProgW: rvTotal ? Math.round(rv.i / rvTotal * 100) + '%' : '0%',
      rvWord: curW || '', rvPh: dw.ph || '', rvDef: dw.def || '', rvPos: dw.pos || '', rvEx: exLine, rvExZh: dw.ex ? dw.exZh : (cur && cur.srcSentence ? '记下时的原文' + (cur.srcTitle ? ' · ' + cur.srcTitle : '') : ''),
      rvRet: m ? Math.round(M.retentionNow(m, 0, this.cfg()) * 100) + '%' : '', rvRevealed: !!(rv && !rvSummary && rv.revealed), rvHidden: asking,
      rvReveal: () => this.setState({ rv: { ...rv, revealed: true } }),
      rvKeepDays: gr('keep').days, rvFuzzyDays: gr('fuzzy').days, rvForgetDays: gr('forget').days,
      rvKeepLabel: keepOk ? F.keepLabel(gr('keep').days) : '这次不能选', rvFuzzyLabel: F.keepLabel(gr('fuzzy').days), rvForgetLabel: F.keepLabel(gr('forget').days),
      // 置灰：同色系淡化，仍看得出是「记得」那颗按钮（rvKeepCursor 原被这行注释吞掉，R3 验收时补回）
      rvKeepBg: keepOk ? '#BFE699' : 'rgba(191,230,153,.32)', rvKeepFg: keepOk ? '#030315' : 'var(--sub2)', rvKeepCursor: keepOk ? 'pointer' : 'default',
      rvAgainLabel: rvSummary && this.queue().length ? '还有 ' + this.queue().length + ' 个到期词，再练一轮' : '再练一轮',
      gradeKeep: () => applyGrade('keep'), gradeFuzzy: () => applyGrade('fuzzy'), gradeForget: () => applyGrade('forget'),
      rvExit: () => this.setState({ tab: 'me', rv: null }),
      rvDots: rv ? rv.queue.map((w, i) => ({ key: i, c: i < rv.i ? LIME : i === rv.i ? 'var(--ink2)' : 'rgba(122,122,133,.28)', wd: i === rv.i ? '18px' : '6px' })) : [],
      rvCntKeep: cnt('keep'), rvCntFuzzy: cnt('fuzzy'), rvCntForget: cnt('forget'),
      rvBefore: res.length ? Math.round(res.reduce((a, r) => a + r.before, 0) / res.length * 100) : 0,
      rvAfter: res.length ? Math.round(res.reduce((a, r) => a + r.p, 0) / res.length * 100) : 0,
      rvSoonDays: rvSoon, rvSoonDate: res.length ? F.fmtMD(new Date(this.now() + rvSoon * F.DAY)) : '—',
      rvAgain: () => { const q = this.queue(); if (!q.length) { this.flash('没有到期的词了'); return; } this.openReview(q); },
      rvBack: () => { this.setState({ tab: 'read', rv: null }); this.flash('复习已计入今日'); },
      openReview: () => this.openReview(),
      rvModes: RV_MODES.map(x => ({ name: x.name, hint: x.hint, dot: P.rvMode === x.k ? LIME : 'transparent', dotRing: P.rvMode === x.k ? 'none' : 'inset 0 0 0 1.5px rgba(122,122,133,.4)', onClick: () => { this.setPref(P, 'rvMode', x.k); this.flash('复习方式 · ' + x.name); } })),
      rvAskRecall: asking && mode === 'recall', rvAskSpell: asking && mode === 'spell', rvAskChoice: asking && mode === 'choice', rvAskContext: asking && mode === 'context',
      // rvZh 只出现在拼写题：给读到的那个中文表达，没有才用词典释义（R1 · 01 A14）
      rvZh: (cur && cur.srcExpr) || dw.zh || '', rvSrc: cur && cur.srcTitle ? cur.srcTitle : '', rvHintLen: curW ? curW.length + ' 个字母' : '',
      rvExBlank: dw.ex ? dw.ex.split(curW).join('______') : (srcFull ? srcFull : '（这个词还没有例句）'),
      rvCtx: ctxRuns, spellVal: s.spellVal, onSpell: e => this.setState({ spellVal: e.target.value }),
      rvChoices: choiceDefs.map((def, i) => { const on = s.choicePick === i; return { key: i, def, tag: 'ABCD'[i], bg: on ? '#BFE699' : 'var(--card)', ring: on ? 'none' : 'var(--cardSh)', tagBg: on ? 'rgba(3,3,21,.12)' : 'var(--mute)', tagFg: on ? '#030315' : 'var(--sub)', onClick: () => this.setState({ choicePick: i, rv: { ...rv, revealed: true } }) }; }),
      rvHasJudge: mode === 'spell' || mode === 'choice',
      rvJudge: mode === 'spell' ? (spellOk ? '拼对了' : (s.spellVal.trim() ? '你拼的是 ' + s.spellVal.trim() + '，正确是 ' + (curW || '') : '没拼，直接看答案')) : (choiceOk ? '选对了' : '选错了 · 正确释义是' + (dw.def || '')),
      rvJudgeBg: (mode === 'spell' ? spellOk : choiceOk) ? '#BFE699' : '#F6E2DC',
      rvJudgeIcon: (mode === 'spell' ? spellOk : choiceOk) ? 'M5 12.5l4.5 4.5L19 7' : 'M6 6l12 12M18 6l-12 12'
    };
  }

  // ---------- 授权与引导 ----------
  valsOnboarding(deck) {
    const s = this.s, d = this.data;
    const quizW = QUIZ.filter(w => this.dict.words.has(w));
    const qi = Math.min(s.quiz.length, quizW.length - 1);
    const qw = this.dict.words.get(quizW[qi]) || {};
    const est = d.quizEst;
    const recId = est ? (est < 1800 ? 'cet4' : est < 2800 ? 'cet6' : 'kaoyan') : null;
    const quizAnswer = yes => {
      const q = s.quiz.concat([yes]);
      // 逐题记（E8）：一期只留了一个估计值 quizEst，R6 想重新标定那把尺子就没有原始数据
      this.emit('quiz.answered', { w: quizW[qi], lv: (this.dict.words.get(quizW[qi]) || { lv: 0 }).lv, step: q.length, known: !!yes });
      if (q.length < quizW.length) { this.setState({ quiz: q }); return; }
      let score = 0, known = 0;
      q.forEach((v, i) => { if (v) { score += this.dict.words.get(quizW[i]).lv; known++; } });
      d.quizEst = Math.round(600 + score * 180);
      d.prefs.deckId = d.quizEst < 1800 ? 'cet4' : d.quizEst < 2800 ? 'cet6' : 'kaoyan';
      d.local.den = known <= 2 ? 1 : known <= 5 ? 3 : 4;
      this.save();
      this.setState({ quiz: q, onb: 2 });
    };
    // 引导第 3 步的「真实正文」：示例书第 1 章前两段，按当前强度实时抽样
    const sb = globalThis.MPData && globalThis.MPData.sampleBook;
    let onbSample = [], onPage = 0;
    if (s.onb === 3 && sb) {
      if (!this.sampleCache) {
        // 每千字上限要有足够字数才分得出档（两段 107 字时前四档名额都是 0）：取开头若干段凑满 600 字，名额按这段字数算，与阅读器同一口径
        const lines = sb.chapters[0].text.split('\n').filter(x => x.trim());
        const pick = [];
        for (const ln of lines) { pick.push(ln); if (F.charCount(pick.join('')) >= F.PREVIEW_CHARS) break; }
        const text = pick.join('\n\n');
        // freq 必须给：slotModes 的第一排序键是「本书出现次数」，传空对象会让排序退化成
        // 「lv 升序 → 字母序」—— 预览里替的是最简单的词，真实阅读里替的是高频词，
        // 名额数量对、选词口径错，而这一屏正是用来告诉用户「替出来长什么样」的（2026-09-16 修）
        const sfreq = {};
        const sslots = matchChapter(text, this.dict, sb.names);
        for (const s2 of sslots) sfreq[s2.w] = (sfreq[s2.w] || 0) + 1;
        this.sampleCache = { chars: Array.from(text), charN: F.charCount(text), slots: sslots, freq: sfreq };
      }
      const sc = this.sampleCache;
      const modes = F.slotModes(sc.slots, { ...this.slotCtx(deck, sc.freq, d.local.den, true), entryState: () => null, chars: sc.charN });
      let cur = 0;
      sc.slots.forEach((sl, i) => {
        if (!modes[i]) return;
        if (sl.o > cur) onbSample.push({ text: sc.chars.slice(cur, sl.o).join(''), style: '' });
        const surface = sc.chars.slice(sl.o, sl.o + sl.l).join('');
        onbSample.push({ text: modes[i] === 'zh' ? surface : surface + ' ' + sl.w, style: modes[i] === 'zh' ? '' : 'border-bottom:1px dashed var(--sub);padding:0 1px 2px;margin:0 3px' });
        if (modes[i] !== 'zh') onPage++;
        cur = sl.o + sl.l;
      });
      if (cur < sc.chars.length) onbSample.push({ text: sc.chars.slice(cur).join(''), style: '' });
    }
    const finishOnb = how => { d.onboarded = true; this.emit('onboard.step', { step: s.onb == null ? 4 : s.onb, action: how }); this.save(); };
    const sampleSlots = sb ? sb.chapters.length : 0;
    return {
      authOn: this.authOn(),
      doLogin: () => { d.auth = 'guest'; if (!d.onboarded) this.emit('onboard.step', { step: 0, action: 'enter' }); this.save(); this.setState({ onb: d.onboarded ? null : 0 }); this.flash('网页版不能微信登录，已进入游客模式'); },
      doGuest: () => { d.auth = 'guest'; if (!d.onboarded) this.emit('onboard.step', { step: 0, action: 'enter' }); this.save(); this.setState({ onb: d.onboarded ? null : 0 }); },
      onbOn: s.onb !== null && !this.authOn(), isOnb0: s.onb === 0, isOnbQuiz: s.onb === 1, isOnbDeck: s.onb === 2, isOnbDen: s.onb === 3, isOnbBook: s.onb === 4,
      onbNext: () => { this.emit('onboard.step', { step: s.onb, action: 'next' }); this.setState({ onb: s.onb + 1 }); },
      quizIdx: Math.min(s.quiz.length + 1, quizW.length), quizWord: quizW[qi] || '', quizPh: qw.ph || '',
      quizDots: quizW.map((_, i) => ({ c: i < s.quiz.length ? LIME : i === s.quiz.length ? 'var(--ink2)' : 'var(--line)' })),
      quizYes: () => quizAnswer(true), quizNo: () => quizAnswer(false), quizSkip: () => { d.quizEst = 0; this.emit('onboard.step', { step: 1, action: 'skip' }); this.save(); this.setState({ onb: 2, quiz: [] }); },
      quizAdvice: est ? '自测估算你认识约 ' + est + ' 词，已经默选下面这一个，替换强度也跟着调了。不同意就改。' : '决定哪些词会出现在正文里。之后可以随时切换。',
      onbDeckCards: ONB_DECKS.map(id => { const x = this.deckById(id); const on = d.prefs.deckId === id;
        return { key: id, name: x.name, short: x.short, total: x.total + ' 词', rate: '约 ' + Math.round(x.wpm * 60) + ' 词 / 小时',
          ring: on ? 'inset 0 0 0 2px var(--ink2)' : 'inset 0 0 0 1px rgba(122,122,133,.25)', dot: on ? LIME : 'transparent', dotRing: on ? 'none' : 'inset 0 0 0 1.5px rgba(122,122,133,.4)',
          rec: recId === id, onClick: () => { d.prefs.deckId = id; this.save(); } }; }),
      onbSample, onPage,
      sampleMeta: sampleSlots + ' 章 · 自有版权短篇，立刻能看到效果',
      onbStartSample: async () => { finishOnb('done'); this.setState({ onb: null }); const id = await this.addSample(); if (id) { this.setState({ imp: 0 }); this.openBook(id, 0); } },
      onbImport: () => { finishOnb('done'); this.setState({ onb: null, imp: 1 }); },
      onbSkip: () => { finishOnb('skip'); this.setState({ onb: null }); }
    };
  }

  // ---------- 导入 ----------
  valsImport() {
    const s = this.s, r = s.impResult;
    return {
      impY: s.imp ? '0%' : '118%', impStep1: s.imp === 1, impStep2: s.imp === 2, impStep3: s.imp === 3, impStep4: s.imp === 4,
      impSrcName: s.impSrc, impPct: s.impPct, impPctW: s.impPct + '%', impPhase: s.impPhase,
      pickWx: () => this.pickFile(), pickLocal: () => this.pickFile(), pickText: () => this.pickText(),
      impChapters: r ? r.chapters : 0, impSlots: r ? r.slots : 0, impNew: r ? r.fresh : 0,
      impStartLabel: r && r.chapter > 0 ? '继续读第 ' + (r.chapter + 1) + ' 章' : '开始读第 1 章',
      impStart: () => { const id = r && r.id; this.setState({ imp: 0 }); if (id) this.openBook(id); },
      impClose: () => this.setState({ imp: s.imp === 2 ? 2 : 0 }),
      impErrTitle: s.impErr === 'format' ? '这个格式读不了' : '解析停在了中途',
      impErrBody: s.impErr === 'format' ? '只支持 TXT 与 EPUB（也能读 MOBI / AZW3）。PDF 与扫描件抽不出连续正文，切章与词位对齐都会错位。' + (s.impErrMsg ? '（' + s.impErrMsg + '）' : '')
        : '文件在 ' + s.impPct + '% 处中断，没有写入书架。' + (s.impErrMsg || '常见原因是编码混用或文件本身不完整。'),
      impErrAction: s.impErr === 'format' ? '换一个文件' : '从中断处重试',
      impErrNote: s.impErr === 'format' ? '如果手边只有 PDF，可以先用其他工具转成 TXT 再导入。' : '重试会重新处理这个文件，已读进度与已记的词都保留。',
      impRetry: () => { if (s.impErr === 'format') this.setState({ imp: 1, impErr: null }); else this.runImport(); }
    };
  }

  // ---------- 设置二级页 ----------
  // ============ 备份与恢复（R0 · 01 E2）============
  valsBackup() {
    const s = this.s, d = this.data, pd = s.bkPending;
    const sm = pd ? summarize(pd, d.books) : null;
    return {
      isPageBackup: s.page === 'backup',
      backupExport: () => this.exportBackupFile(), backupPick: () => this.pickBackupFile(),
      backupExportSub: d.backupAt ? '上次导出 ' + F.ymd(new Date(d.backupAt)) : '还没导出过',   // 本地日期：ISO 是 UTC，凌晨导出会显示成前一天
      backupHasPending: !!pd, backupHasErr: !!s.bkErr, backupErr: s.bkErr || '',
      backupSummary: sm ? F.ymd(new Date(sm.exportedAt)) + ' 导出 · ' + sm.words + ' 个词 · ' + sm.books + ' 本书' + (sm.pending ? '（' + sm.pending + ' 本要重新导入正文，进度会自动接上）' : '') + '。恢复会覆盖这台手机上现有的词库、复习记录与设置。' : '',
      backupCancel: () => this.setState({ bkPending: null }),
      backupConfirm: () => this.restoreBackup()
    };
  }
  async exportBackupFile() {
    await this.flushEvents();                            // 队列里还没落盘的事件也要进备份
    const bk = exportBackup(this.data, new Date().toISOString(), await this.store.readEvents(0));
    const blob = new Blob([JSON.stringify(bk)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'citi-backup-' + this.today() + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    this.data.backupAt = bk.exportedAt;
    this.save();
    this.flash('备份已导出 · ' + Object.keys(bk.state.entries).length + ' 个词 · ' + bk.events.length + ' 条事件');
  }
  pickBackupFile() {
    const inp = document.createElement('input');
    inp.type = 'file';                                   // 不写 accept：iOS/macOS 会把文件置灰（一期坑）
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      let json;
      try { json = JSON.parse(await f.text()); } catch { this.setState({ bkPending: null, bkErr: '这个文件不是备份：读不出 JSON' }); return; }
      const r = validateBackup(json);
      if (!r.ok) { this.setState({ bkPending: null, bkErr: '备份文件不对，没有恢复任何内容：' + r.reason }); return; }
      this.setState({ bkPending: r.backup, bkErr: '' });
    };
    inp.click();
  }
  async restoreBackup() {
    const bk = this.s.bkPending;
    if (!bk) return;
    const next = applyBackup(this.data, bk);
    clearTimeout(this._sv);                              // 防抖里还没落盘的旧 state 不许在恢复之后写回来
    clearTimeout(this._evt); this._evq = [];             // 同理：恢复时丢掉队列里属于「恢复前」的事件
    try { await this.store.saveState(next); await this.store.replaceEvents(bk.events || []); }
    catch (e) { this.save(); this.setState({ bkErr: '写入失败，数据没变：' + (e.message || e.name) }); return; }
    this.data = next;
    this.touch();
    const sm = summarize(bk, next.books);
    this.setState({ bkPending: null, bkErr: '', page: null, tab: 'me' });
    this.flash('已恢复 · ' + sm.words + ' 个词 · ' + (bk.events || []).length + ' 条事件' + (sm.pending ? ' · ' + sm.pending + ' 本书待重新导入' : ''));
  }

  valsPages(deck) {
    const s = this.s, d = this.data, P = d.prefs;
    const sw = on => ({ bg: on ? 'var(--btn)' : 'rgba(122,122,133,.3)', x: on ? '20px' : '0px' });
    const out = {
      pageOn: !!s.page, pageTitle: { muted: '不再替换的词', remind: '每日提醒', stat: '时长统计口径', sync: '看板同步', decks: '我的词库', newdeck: '新建词库', rvmode: '复习方式', backup: '备份与恢复' }[s.page] || '',
      isPageMuted: s.page === 'muted', isPageRemind: s.page === 'remind', isPageStat: s.page === 'stat', isPageSync: s.page === 'sync',
      isPageDecks: s.page === 'decks', isPageNewDeck: s.page === 'newdeck', isPageRvMode: s.page === 'rvmode',
      ...this.valsBackup(),
      closePage: () => this.setState({ page: s.page === 'newdeck' ? 'decks' : null }),
      // 两组（04 第 24 行）：我设置的（全局）在前，纠错后暂停的（只在那本书）在后，副标题写明书名
      mutedRows: Object.keys(d.muted).filter(w => F.userMuted(d.muted, w)).map(w => ({ key: 'u:' + w, w, def: '我设置的 · ' + ((this.dict.words.get(w) || {}).def || '—'), restore: () => { delete d.muted[w]; this.save(); this.flash(w + ' 已恢复替换'); } }))
        .concat(F.pausedList(d.feedback).map(p => { const bk = d.books.find(b => b.hash === p.bookHash); return { key: 'f:' + p.bookHash + ':' + p.w, w: p.w, def: '纠错后暂停 · 只在《' + (bk ? bk.title : '已删除的书') + '》',
          restore: () => { const at = new Date().toISOString(); for (const f of d.feedback) if (f.w === p.w && f.bookHash === p.bookHash && !f.resumedAt) f.resumedAt = at; this.save(); this.flash(p.w + ' 在这本书里恢复替换'); } }; })),
      mutedCountAll: Object.keys(d.muted).filter(w => F.userMuted(d.muted, w)).length + F.pausedList(d.feedback).length,
      remindOn: P.remind, remindBg: sw(P.remind).bg, remindX: sw(P.remind).x,
      toggleRemind: () => { if (P.remind) { P.remind = false; this.save(); this.flash('每日提醒已关闭'); } else this.setState({ ask: { kind: 'sub' } }); },
      idleMin: P.idle, cycleIdle: () => this.setPref(P, 'idle', P.idle === 3 ? 5 : P.idle === 5 ? 10 : 3, 'idle'),
      bgOn: P.bgCount, bgBg: sw(P.bgCount).bg, bgX: sw(P.bgCount).x, toggleBg: () => { P.bgCount = !P.bgCount; this.save(); },
      outOn: P.outlier, outBg: sw(P.outlier).bg, outX: sw(P.outlier).x, toggleOut: () => { P.outlier = !P.outlier; this.save(); },
      // 与 toggleRemind 同一处理：说明当前构建做不到，并且**不改值**（改了也没有任何效果，只会让人以为生效了）
      syncOn: P.sync, syncBg: sw(P.sync).bg, syncX: sw(P.sync).x, toggleSync: () => this.setState({ ask: { kind: 'sync' } }),
      presets: Object.keys(PRESETS).map(k => ({ name: k, count: PRESETS[k].length + ' 个组件', apply: () => { P.board = PRESETS[k].slice(); this.save(); this.setState({ page: null, tab: 'me' }); this.flash('已套用「' + k + '」'); } })),
      deckPageRows: this.allDecks().map(x => { const ln = this.learnedIn(x), p = x.total ? Math.round(ln / x.total * 100) : 0, cur = x.id === P.deckId;
        return { key: x.id, name: x.name + (x.custom ? ' · 自建' : ''), sub: ln + ' / ' + x.total + ' 词', barW: p + '%', barC: cur ? 'var(--bar)' : 'rgba(122,122,133,.3)', weight: cur ? 600 : 400,
          dot: cur ? LIME : 'transparent', dotRing: cur ? 'none' : 'inset 0 0 0 1.5px rgba(122,122,133,.4)', onClick: () => { this.setPref(P, 'deckId', x.id); this.flash('当前词库 · ' + x.short); } }; }),
      openNewDeck: () => this.setState({ page: 'newdeck', ndName: '', ndPaste: '', ndSel: [], ndSrc: 0 }),
      ndName: s.ndName, onNdName: e => this.setState({ ndName: e.target.value }), ndPaste: s.ndPaste, onNdPaste: e => this.setState({ ndPaste: e.target.value }),
      ndSrcPills: ND_SRC.map((nm, i) => ({ name: nm, bg: s.ndSrc === i ? 'var(--btn)' : 'var(--mute)', fg: s.ndSrc === i ? 'var(--btnFg)' : 'var(--sub)', onClick: () => this.setState({ ndSrc: i, ndSel: [] }) })),
      ndIsPaste: s.ndSrc === 0, ndIsDeck: s.ndSrc === 1, ndIsBook: s.ndSrc === 2
    };
    if (s.page !== 'newdeck') return Object.assign(out, { ndDeckRows: [], ndBookRows: [], ndCount: 0, ndCov: [], ndBtnLabel: '先选几个词', ndBtnBg: 'var(--mute)', ndBtnFg: 'var(--sub)', ndBtnDot: 'var(--line)', ndCreate: () => {} });
    const toggle = k => this.setState({ ndSel: s.ndSel.includes(k) ? s.ndSel.filter(x => x !== k) : s.ndSel.concat([k]) });
    const box = on => ({ boxBg: on ? LIME : 'transparent', boxRing: on ? 'none' : 'inset 0 0 0 1.5px rgba(122,122,133,.4)' });
    const decks = this.dict.decks.filter(x => x.id !== 'sample');
    const bookFresh = b => Object.keys((this.idx.get(b.id) || { freq: {} }).freq).filter(w => !this.entry(w));
    let words = [];
    if (s.ndSrc === 0) {
      const { words: ws } = F.normalizeTokens(s.ndPaste.split(/[\s,，、;；]+/));
      words = ws.map(k => this.dict.words.has(k) ? k : [...this.dict.words.keys()].find(w => w.toLowerCase() === k)).filter(Boolean);
    } else if (s.ndSrc === 1) { for (const x of decks) if (s.ndSel.includes('d' + x.id)) words.push(...[...x.words].filter(w => !this.entry(w))); }
    else for (const b of d.books) if (s.ndSel.includes('b' + b.id)) words.push(...bookFresh(b));
    words = [...new Set(words)];
    const ndCount = words.length;
    return Object.assign(out, {
      ndDeckRows: decks.map(x => { const on = s.ndSel.includes('d' + x.id); return { key: x.id, name: x.short, n: x.total - this.learnedIn(x), on, ...box(on), onClick: () => toggle('d' + x.id) }; }),
      ndBookRows: d.books.map(b => { const on = s.ndSel.includes('b' + b.id); return { key: b.id, name: b.title, n: bookFresh(b).length, on, ...box(on), onClick: () => toggle('b' + b.id) }; }),
      ndCount,
      ndCov: d.books.slice(0, 6).map(b => { const ix = this.idx.get(b.id) || { freq: {} }; const hit = ndCount ? words.filter(w => ix.freq[w]).length : 0; const p = ndCount ? Math.round(hit / ndCount * 100) : 0;
        return { key: b.id, title: b.title, pct: p + '%', barW: p + '%', barC: 'color-mix(in oklab,' + b.tone + ' 62%,#FFFFFF)' }; }),
      ndBtnLabel: ndCount ? (ndCount > 5000 ? '最多 5000 词' : '创建词库 · ' + ndCount + ' 词') : '先选几个词',
      ndBtnBg: ndCount && ndCount <= 5000 ? 'var(--btn)' : 'var(--mute)', ndBtnFg: ndCount && ndCount <= 5000 ? 'var(--btnFg)' : 'var(--sub)', ndBtnDot: ndCount && ndCount <= 5000 ? LIME : 'var(--line)',
      ndCreate: () => {
        if (!ndCount) { this.flash('先选几个词（词典里没有的词会略过）'); return; }
        if (ndCount > 5000) { this.flash('自建词库最多 5000 词'); return; }
        const nm = s.ndName.trim().slice(0, 40) || '未命名词库';
        d.customDecks.push({ id: 'c_' + Date.now().toString(36), name: nm, words, createdAt: new Date().toISOString() });
        this.save(); this.setState({ page: 'decks' }); this.flash('已创建「' + nm + '」');
      }
    });
  }
}

export async function start(root, lib) {
  const app = new App(root);
  app.lib = lib;
  globalThis.__citi = app;             // 调试与浏览器实测用
  await app.boot();
  return app;
}

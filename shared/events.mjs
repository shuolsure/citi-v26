// 事件登记表（R3 · 01 E4 E9 · 拍板 Q11）。客户端、服务端、冒烟、数据字典生成器共用这一份。
//
// 三条规矩（违反会被冒烟拦下，不是靠自觉）：
//   N1 事件是唯一事实源：dailies / hours / bookSecs 这类累加值是「能从事件重建的缓存」，永不上传。
//   N2 登记后才能采：没写进 EVENTS 的名字，客户端 emit 抛、服务端直接丢。新采一个信号先改这张表。
//   L0 正文永不出本地：任何事件都不许带正文、句子、章节标题、书名。带 book_hash（内容 hash），不带 title。
//
// 字段类型：str(max 码点) · int · num · bool · hash16(16 位小写十六进制) · enum(...) · id8(8 位小写十六进制)
// 「码点」不是 UTF-16 长度：一个 emoji 算 1（与服务端 MAX_STR 闸同一把尺子）。

export const SCHEMA_V = 1;

/** 数据分级（01 E9）。决定「丢了要不要紧」与「能不能抽样」，不是决定「敏不敏感」——敏感的那一类根本不采。 */
export const LEVELS = {
  L0: '正文层：书的正文、句子、书名。永不出本地，任何事件都不许带。',
  L1: '账号层：learner_id、设备、应用版本。R5 上云才有。',
  L2: '学习事实：记下 / 取消 / 复习作答 / 阅读会话 / 纠错。丢了就重建不出学习状态，一条都不能少。',
  L3: '行为信号：曝光 / 点开 / 逐题自测 / 导入 / 引导 / 设置。量大、可抽样、丢一部分不影响学习本身。'
};

const str = max => ({ t: 'str', max });
const int = { t: 'int' };
const num = { t: 'num' };
const bool = { t: 'bool' };
const hash16 = { t: 'hash16' };
const id8 = { t: 'id8' };
const one = (...vals) => ({ t: 'enum', vals });
const opt = f => ({ ...f, opt: true });

/**
 * 每条事件：level 分级 · q「它回答什么问题」（想不出来就不该采）· fields 字段表。
 * 字段默认必填；opt(...) 表示可以缺省或为 null。
 */
export const EVENTS = {
  // ---------- L2 学习事实 ----------
  'word.learned': {
    level: 'L2', q: '这个词是在哪本书、哪个义项上记下的？「撤销取消」和「真的新记」要分得开（R1 A10）。',
    fields: { w: str(64), sense_id: opt(id8), book_hash: opt(hash16), src_expr: opt(str(40)), kind: one('new', 'undo', 'deck') }
  },
  'word.unlearned': {
    level: 'L2', q: '取消了哪些词？配合 word.learned 能算出「记了又取消」的比例。',
    fields: { w: str(64), sense_id: opt(id8) }
  },
  'word.muted': {
    level: 'L2', q: '用户主动关掉替换的词有哪些？（纠错导致的暂停走 slot.reported，两者别混）',
    fields: { w: str(64), on: bool }
  },
  'review.answered': {
    level: 'L2', q: '模型准不准：预测的留存与实际答对率对不对得上（R6 校准的唯一输入）。correct 是客观对错，grade 是用户自评，两者必须分开存。',
    fields: {
      w: str(64), sense_id: opt(id8), mode: one('recall', 'choice', 'spell', 'context'), grade: one('keep', 'fuzzy', 'forget'),
      correct: opt(bool), latency_ms: opt(int), answer: opt(str(64)), retention: num, overdue_days: num, reviews_before: int
    }
  },
  'reading.session': {
    level: 'L2', q: '读了多久、读了多少字：dailies / hours / bookSecs 全部从这里重建（N1）。',
    fields: { book_hash: opt(hash16), chapter: int, seconds: num, chars_read: int, den: int, page_mode: one('scroll', 'page') }
  },
  'slot.reported': {
    level: 'L2', q: '哪条桥被读者判为错的：R4 生产线剪枝的输入，也是唯一能修到桥的信号。',
    fields: { w: str(64), sense_id: opt(id8), book_hash: opt(hash16), chapter: opt(int), offset: opt(int), reason: one('context', 'sense', 'example', 'proper') }
  },

  // ---------- L3 行为信号 ----------
  'word.exposed': {
    level: 'L3', q: '这个词你见过几次、以什么形态见的：替换密度与「见过几次才记得住」的根基。按一次阅读会话每词一条，不是每个词位一条。',
    fields: { w: str(64), book_hash: opt(hash16), chapter: int, form: one('en', 'both', 'zh'), count: int }
  },
  'word.looked_up': {
    level: 'L3', q: '点开释义却没记下的词有多少：「看一眼就够」与「真的要学」的分界。',
    fields: { w: str(64), sense_id: opt(id8), book_hash: opt(hash16), chapter: int, via: one('tap', 'peek', 'vocab') }
  },
  'quiz.answered': {
    level: 'L3', q: '引导自测逐题对错：现在只存一个估计值，逐题存下来才能在 R6 重新标定那把尺子（E8）。',
    fields: { w: str(64), lv: int, step: int, known: bool }
  },
  'import.finished': {
    level: 'L3', q: '导入成功率、失败原因、耗时与词位数：解析引擎的健康度。',
    fields: { book_hash: opt(hash16), kind: one('file', 'text', 'chapters'), ok: bool, reason: opt(str(40)), chapters: int, slots: int, fresh: int, ms: int }
  },
  'onboard.step': {
    level: 'L3', q: '引导四步在哪一步流失。',
    fields: { step: int, action: one('enter', 'next', 'back', 'skip', 'done') }
  },
  'setting.changed': {
    level: 'L3', q: '哪些设置真的有人改：密度档、词表、复习形态、目标这几个是产品决策的输入。',
    fields: { key: str(40), from: opt(str(40)), to: opt(str(40)) }
  }
};

export const EVENT_NAMES = Object.keys(EVENTS);

/** 信封：每条事件都带。schema_v 变了才需要迁移；dict_version / model_version 让「换了词典 / 改了模型之后的数据」能分开看。 */
export const ENVELOPE = {
  event_id: str(40), at: str(30), tz: int, app_version: str(40), schema_v: int,
  dict_version: opt(str(40)), model_version: opt(str(40)), exp: opt(str(40))
};

const HEX16 = /^[0-9a-f]{16}$/;
const HEX8 = /^[0-9a-f]{8}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function checkField(path, spec, v, bad) {
  if (v == null) { if (!spec.opt) bad.push(path + ' 缺失'); return; }
  switch (spec.t) {
    case 'str':
      if (typeof v !== 'string') { bad.push(path + ' 不是字符串'); return; }
      if ([...v].length > spec.max) bad.push(path + ' 超过 ' + spec.max + ' 码点');
      return;
    case 'int':
      if (!Number.isInteger(v)) bad.push(path + ' 不是整数');
      return;
    case 'num':
      if (typeof v !== 'number' || !Number.isFinite(v)) bad.push(path + ' 不是有限数');
      return;
    case 'bool':
      if (typeof v !== 'boolean') bad.push(path + ' 不是布尔');
      return;
    case 'hash16':
      if (typeof v !== 'string' || !HEX16.test(v)) bad.push(path + ' 不是 16 位内容 hash');
      return;
    case 'id8':
      if (typeof v !== 'string' || !HEX8.test(v)) bad.push(path + ' 不是 8 位 sense_id');
      return;
    case 'enum':
      if (!spec.vals.includes(v)) bad.push(path + ' 不在 ' + spec.vals.join(' / ') + ' 里');
      return;
    default:
      bad.push(path + ' 类型 ' + spec.t + ' 没定义');
  }
}

/**
 * 整条事件校验。返回 { ok, reason }。
 * 严格到「多一个没登记的字段也算错」——否则「顺手多带一个」会绕过登记制（N2），
 * 而多带的那个字段往往就是正文（L0）。
 */
export function validateEvent(e) {
  const bad = [];
  if (!e || typeof e !== 'object') return { ok: false, reason: '不是对象' };
  if (!EVENT_NAMES.includes(e.name)) return { ok: false, reason: '事件名 ' + JSON.stringify(e.name) + ' 没有登记' };
  for (const [k, spec] of Object.entries(ENVELOPE)) checkField(k, spec, e[k], bad);
  if (e.at != null && typeof e.at === 'string' && !ISO.test(e.at)) bad.push('at 不是 ISO 时间');
  const spec = EVENTS[e.name].fields;
  const p = e.p;
  if (!p || typeof p !== 'object') bad.push('p 缺失');
  else {
    for (const [k, s] of Object.entries(spec)) checkField('p.' + k, s, p[k], bad);
    for (const k of Object.keys(p)) if (!(k in spec)) bad.push('p.' + k + ' 没有登记');
  }
  for (const k of Object.keys(e)) if (k !== 'name' && k !== 'p' && !(k in ENVELOPE)) bad.push(k + ' 没有登记');
  return bad.length ? { ok: false, reason: bad.join('；') } : { ok: true };
}

/** 事件 id：优先 randomUUID；没有（老 Safari、Node 冒烟）时退到时间 + 随机，够本机去重用 */
export function newEventId(rnd = Math.random, now = Date.now) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return now().toString(36) + '-' + Math.floor(rnd() * 0x100000000).toString(36) + Math.floor(rnd() * 0x100000000).toString(36);
}

/**
 * 造一条事件。env 由调用方一次性备好（app_version / dict_version / model_version / exp）。
 * 校验不过直接抛：宁可在开发时崩，也不要往事件仓里写脏数据——R6 分析时没人查得出来。
 */
export function makeEvent(name, p, env = {}, clock = {}) {
  const at = clock.at || new Date().toISOString();
  const e = {
    name, p: p || {},
    event_id: env.event_id || newEventId(clock.rnd, clock.now),
    at, tz: env.tz != null ? env.tz : -new Date(at).getTimezoneOffset(),
    app_version: env.app_version || 'dev', schema_v: SCHEMA_V,
    dict_version: env.dict_version != null ? env.dict_version : null,
    model_version: env.model_version != null ? env.model_version : null,
    exp: env.exp != null ? env.exp : null
  };
  const r = validateEvent(e);
  if (!r.ok) throw new Error('事件 ' + name + ' 不合登记表：' + r.reason);
  return e;
}

/* =============================================================
   scheduler.js · 调度器（真实现，纯函数）
   schedule({profile, userWords, capacity, candidates?, words, curChapter}) → {review, reinforce, fresh}
   零依赖。UMD。M0 原样搬进 app/server/scheduler.js，端与云同一份（不变式 I2）。

   产品文档 §4.3：
     capacity = 配额（生成模式 = 密度 x 章长；导入模式 = 同样的配额，但只在 candidates 里选）
     review    = 到期词按逾期章数降序，取 <= 40%
     reinforce = 强化中 + 上章小测错，取 <= 20%
     fresh     = 未见词中 level 属于 [user_level, user_level+1]，按考纲优先级，取剩余
     user_level：最近 200 曝光的 lookup 率 < 10% → +0.2；> 35% → -0.2；考纲锁定时不越界

   不变式 I8：间隔按「章」计，天做上限 —— 到期判定 = 当前章 >= due_chapter 或 今天 >= due_date。
   ============================================================= */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.NRSched = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REVIEW_SHARE = 0.4;
  const REINFORCE_SHARE = 0.2;
  const EXAM_WEIGHT = { 考研: 1.0, 雅思: 0.95, 六级: 0.9, 四级: 0.8, 高考: 0.7, 中考: 0.55 };

  /** 考纲 → 词的难度层级。**全项目唯一一份**：词库快照的 words[].level 也按它换算。
   *  两处各写一份会让「用户水平」和「词难度」不在同一把尺子上，调度器就永远挑不出新词。 */
  const EXAM_LEVEL = { 中考: 2.2, 高考: 3.0, 四级: 3.6, 六级: 4.2, 考研: 4.6, 雅思: 4.8 };

  /** 起步水平（分级测跳过时冷启动，产品文档 §3.1）。
   *  注意不等于考纲难度：备考的人此刻的水平在目标之下 —— 这正是他要背词的原因。
   *  差 1.2 档，于是「考研」起步 3.4（与项目说明 §8.5 的示例一致），
   *  新词落在 [3.4, 4.4]，也就是先补四六级、再随 adjustLevel 往考研爬。 */
  function levelFromExam(exam) {
    const target = EXAM_LEVEL[exam];
    if (!target) return 3.0;
    return Math.max(2.0, Math.round((target - 1.2) * 10) / 10);
  }

  /** 词的难度层级：没标 level 就按词频推（rank 越大越难） */
  function levelOf(w) {
    if (!w) return 3;
    if (typeof w.level === 'number') return w.level;
    const r = w.freq_rank || 3000;
    return Math.max(1, Math.min(6, 1 + r / 900));
  }

  /** 考纲优先级：本人考纲命中权重最高，其次按词频（常用先学） */
  function priority(w, exam) {
    if (!w) return 0.3;
    const tags = w.exam_tags || [];
    const hit = exam && tags.indexOf(exam) >= 0 ? 1.25 : 1;
    const base = Math.max(0.4, ...tags.map(function (t) { return EXAM_WEIGHT[t] || 0.5; }));
    const freq = 1 - Math.min(1, (w.freq_rank || 3000) / 6000);
    return hit * base * (0.55 + 0.45 * freq);
  }

  /**
   * 依据最近曝光的查词率微调水平（产品文档 §4.3）。
   * 返回 {level, lookupRate, samples}；考纲锁定时夹在考纲水平 +-0.8 内。
   */
  function adjustLevel(profile, userWords) {
    const base = (typeof profile.level_score === 'number') ? profile.level_score : levelFromExam(profile.exam);
    let exp = 0, look = 0;
    for (const id in userWords) {
      const u = userWords[id];
      exp += u.exposures || 0;
      look += u.lookups || 0;
    }
    if (exp < 20) return { level: base, lookupRate: exp ? look / exp : 0, samples: exp };
    const rate = look / exp;
    let lv = base;
    if (rate < 0.10) lv = base + 0.2;
    else if (rate > 0.35) lv = base - 0.2;
    if (profile.exam) {
      const anchor = levelFromExam(profile.exam);
      lv = Math.max(anchor - 0.8, Math.min(anchor + 0.8, lv));
    }
    return { level: Math.max(1, Math.min(6, lv)), lookupRate: rate, samples: exp };
  }

  /** 到期判定（I8：章优先，天兜底） */
  function isDue(u, curChapter, todayYmd) {
    if (!u) return false;
    if (u.state !== '复习' && u.state !== '阶段掌握' && u.state !== '熟练') return false;
    if (typeof u.due_chapter === 'number' && curChapter >= u.due_chapter) return true;
    if (u.due_date && todayYmd && todayYmd >= u.due_date) return true;
    return false;
  }

  /**
   * @param {Object} p
   * @param {Object} p.profile
   * @param {Object} p.userWords   word_id → 状态
   * @param {number} p.capacity    本章配额
   * @param {Map}    p.words       word_id → 词条
   * @param {number} p.curChapter  当前章序（全局阅读章数，间隔按章就靠它）
   * @param {string} [p.todayYmd]
   * @param {Array}  [p.candidates] 导入模式：AC 命中的可替位 [{word_id,...}]，只在其中选
   * @returns {{review, reinforce, fresh, level, capacity, due}}
   */
  function schedule(p) {
    const profile = p.profile || {};
    const userWords = p.userWords || {};
    const words = p.words;
    const capacity = Math.max(0, p.capacity || 0);
    const curChapter = p.curChapter || 1;
    const todayYmd = p.todayYmd;
    const wordOf = function (id) { return (words instanceof Map) ? words.get(id) : (words || {})[id]; };

    // 导入模式：只在 candidates 的词里选
    let allow = null;
    if (p.candidates) {
      allow = new Set();
      for (const c of p.candidates) allow.add(c.word_id || c);
    }
    const allowed = function (id) { return !allow || allow.has(id); };

    const lv = adjustLevel(profile, userWords);

    /* --- 1) 复习：到期词，按逾期章数降序 --- */
    const dueList = [];
    for (const id in userWords) {
      const u = userWords[id];
      if (u.state === '跳过') continue;
      if (!allowed(id)) continue;
      if (!isDue(u, curChapter, todayYmd)) continue;
      const overdue = (typeof u.due_chapter === 'number') ? (curChapter - u.due_chapter) : 0;
      dueList.push({ word_id: id, overdue: overdue, u: u });
    }
    dueList.sort(function (a, b) { return b.overdue - a.overdue; });
    const review = dueList.slice(0, Math.floor(capacity * REVIEW_SHARE))
      .map(function (x) { return pack(x.word_id, wordOf(x.word_id), '复习', x.overdue); });

    /* --- 2) 强化：强化中 + 上章小测错 --- */
    const reinList = [];
    for (const id in userWords) {
      const u = userWords[id];
      if (u.state === '跳过') continue;
      if (!allowed(id)) continue;
      if (review.some(function (r) { return r.word_id === id; })) continue;
      const wrongRecent = !!u.quiz_wrong_last;
      if (u.state === '强化中' || wrongRecent) {
        reinList.push({ word_id: id, score: (wrongRecent ? 100 : 0) + (u.lookups || 0) });
      }
    }
    reinList.sort(function (a, b) { return b.score - a.score; });
    const reinforce = reinList.slice(0, Math.floor(capacity * REINFORCE_SHARE))
      .map(function (x) { return pack(x.word_id, wordOf(x.word_id), '强化', 0); });

    /* --- 3) 新词：未见 + level 属于 [lv, lv+1]，按考纲优先级 --- */
    const taken = new Set(review.concat(reinforce).map(function (x) { return x.word_id; }));
    const rest = Math.max(0, capacity - review.length - reinforce.length);
    const pool = [];
    const iter = (words instanceof Map) ? Array.from(words.values()) : Object.keys(words || {}).map(function (k) { return words[k]; });
    for (const w of iter) {
      if (taken.has(w.id)) continue;
      if (!allowed(w.id)) continue;
      const u = userWords[w.id];
      if (u && u.state !== '未见') continue;      // 已见过的不算新词
      if (u && u.state === '跳过') continue;
      const L = levelOf(w);
      if (L < lv.level || L > lv.level + 1) continue;
      pool.push({ word_id: w.id, w: w, pr: priority(w, profile.exam) });
    }
    pool.sort(function (a, b) { return b.pr - a.pr || (a.w.freq_rank || 0) - (b.w.freq_rank || 0); });
    const fresh = pool.slice(0, rest).map(function (x) { return pack(x.word_id, x.w, '新词', 0); });

    return {
      review: review, reinforce: reinforce, fresh: fresh,
      level: lv.level, lookupRate: lv.lookupRate, capacity: capacity,
      due: dueList.length,
    };
  }

  /** 词单条目：生成模式把 expr 交给写作管线；导入模式只用 word_id */
  function pack(word_id, w, why, overdue) {
    return {
      word_id: word_id,
      word: w ? w.word : word_id,
      expr: (w && w.expr_pref) || '',   // 由调用方用 NRReplace.bestExpr 补全（桥里精度最高的表达）
      why: why, overdue: overdue || 0,
    };
  }

  return {
    schedule: schedule, adjustLevel: adjustLevel, isDue: isDue,
    levelOf: levelOf, levelFromExam: levelFromExam, priority: priority, EXAM_LEVEL: EXAM_LEVEL,
    REVIEW_SHARE: REVIEW_SHARE, REINFORCE_SHARE: REINFORCE_SHARE,
  };
});

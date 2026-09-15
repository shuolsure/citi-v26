/* =============================================================
   import.js · 导入管线（小程序新写，纯函数，Node 可测）
   ArrayBuffer/Uint8Array → 编码识别 → 解码 → 规范化 → 分章 → 全书预扫描 → 专名启发
   零依赖（除 MPGbk / NRAc / NRReplace）。UMD：浏览器/小程序挂 globalThis.MPImport，Node 走 module.exports。

   为什么这个文件必须存在（03 §3 已核实）：
     · 小程序没有 TextDecoder，FileSystemManager.readFile 的 encoding 没有 GBK
     · 国内 txt 小说一半以上是 GBK —— 这是导入成功率的第一道坎

   三条口径（定死，别在别处再写一份）：
     C1 预扫描用**全量桥**，不是用户选的词表。
        「换词表，能教你 N 个词实时变」（产品文档 §3.2 步骤 4）只有全量索引做得到；
        而且阅读时 replace.js 也是拿全量桥跑 findCandidates —— 两边同一把尺子，
        index.json 的章号才和读者真正会看到的替换位对得上。
     C2 词表过滤 = **过滤 words 映射，不过滤 bridge**。
        非词表的词在 replace.js 里会因为 wordOf() 取不到而进 dropped.noword，
        在 scheduler.js 里因为不在 words 池而选不进 fresh。改 bridge 会让 C1 崩掉。
     C3 章标题不进 chapter.text。
        标题里的词不该被替换，也不该被出成挖空题；标题单独存 meta。
     C4 **预扫描的结果可以缓存，替换结果绝不能缓存。**
        index 存的是「哪个词在哪一章出现几次」—— 纯文本属性，与读者无关，永不过期，
        所以可以只扫前几章、边读边补（prescan 的 from/to + mergeScan）。
        而「这一章实际替换哪些词、每个用哪种模式」是 replace() + scheduler() + modes() 每次进章现算的，
        随学习进度变 —— 一旦缓存下来，读者答对答错就不影响下一章了，整个学习模型空转。
        所以「提前只处理几章」只影响 index，不影响定制性。
   ============================================================= */
(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const G = isNode ? require('./gbk.js') : root.MPGbk;
  const A = isNode ? require('./ac.js') : root.NRAc;
  const R = isNode ? require('./replace.js') : root.NRReplace;
  const S = isNode ? require('./scheduler.js') : root.NRSched;
  const mod = factory(G, A, R, S);
  if (isNode) module.exports = mod;
  root.MPImport = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (MPGbk, NRAc, NRReplace, NRSched) {
  'use strict';

  const REPL = '�';

  /* =============================================================
     一、字节 → 文本
     ============================================================= */

  function toBytes(buf) {
    if (buf instanceof Uint8Array) return buf;
    if (typeof ArrayBuffer !== 'undefined' && buf instanceof ArrayBuffer) return new Uint8Array(buf);
    if (buf && buf.buffer) return new Uint8Array(buf.buffer, buf.byteOffset || 0, buf.byteLength);
    if (Array.isArray(buf)) return new Uint8Array(buf);
    throw new TypeError('toBytes: 需要 ArrayBuffer / Uint8Array');
  }

  /** 码元数组 → 字符串。分块 join，避免 fromCharCode.apply 的栈上限（几十万字必然超） */
  function unitsToString(units) {
    const CHUNK = 8192;
    const parts = [];
    for (let i = 0; i < units.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, units.slice(i, i + CHUNK)));
    }
    return parts.join('');
  }

  /** 码点 → UTF-16 码元，push 进 units */
  function pushCodePoint(units, cp) {
    if (cp <= 0xFFFF) { units.push(cp); return; }
    cp -= 0x10000;
    units.push(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
  }

  /**
   * 严格 UTF-8 解码。拒绝 overlong、代理区、> U+10FFFF、截断序列。
   * 坏字节替成 U+FFFD 并计数 —— badRate 就是编码识别的判据。
   * @returns {{text:string, bad:number, total:number}}
   */
  function decodeUtf8(bytes, from) {
    const units = [];
    let bad = 0, total = 0;
    for (let i = from || 0; i < bytes.length;) {
      const b = bytes[i];
      let cp, n;
      if (b < 0x80) { cp = b; n = 1; }
      else if (b >= 0xC2 && b <= 0xDF) { cp = b & 0x1F; n = 2; }
      else if (b >= 0xE0 && b <= 0xEF) { cp = b & 0x0F; n = 3; }
      else if (b >= 0xF0 && b <= 0xF4) { cp = b & 0x07; n = 4; }
      else { units.push(0xFFFD); bad++; total++; i++; continue; }

      if (i + n > bytes.length) { units.push(0xFFFD); bad++; total++; i++; continue; }
      let ok = true;
      for (let k = 1; k < n; k++) {
        const c = bytes[i + k];
        if (c < 0x80 || c > 0xBF) { ok = false; break; }
        cp = (cp << 6) | (c & 0x3F);
      }
      // overlong / 代理区 / 越界
      if (ok) {
        if (n === 3 && cp < 0x800) ok = false;
        else if (n === 4 && cp < 0x10000) ok = false;
        else if (cp >= 0xD800 && cp <= 0xDFFF) ok = false;
        else if (cp > 0x10FFFF) ok = false;
      }
      if (!ok) { units.push(0xFFFD); bad++; total++; i++; continue; }
      pushCodePoint(units, cp);
      total++;
      i += n;
    }
    return { text: unitsToString(units), bad: bad, total: total };
  }

  /**
   * GBK 解码（CP936 口径）：0x00–0x7F 单字节 ASCII，0x80 → €，其余走双字节表。
   * 未分配码位与孤立 lead 记 U+FFFD。
   */
  function decodeGbk(bytes, from) {
    const units = [];
    let bad = 0, total = 0;
    for (let i = from || 0; i < bytes.length;) {
      const b = bytes[i];
      if (b < 0x80) { units.push(b); total++; i++; continue; }
      if (b === 0x80) { units.push(0x20AC); total++; i++; continue; }   // CP936 的欧元符
      if (b === 0xFF || i + 1 >= bytes.length) { units.push(0xFFFD); bad++; total++; i++; continue; }
      const ch = MPGbk.pair(b, bytes[i + 1]);
      if (ch === REPL) { units.push(0xFFFD); bad++; total++; i += 1; continue; }  // 孤立 lead：只吞 1 字节再试
      units.push(ch.charCodeAt(0));
      total++;
      i += 2;
    }
    return { text: unitsToString(units), bad: bad, total: total };
  }

  /** UTF-16 解码（le/be），奇数长度末字节丢弃并计一次坏 */
  function decodeUtf16(bytes, from, little) {
    const units = [];
    let bad = 0, total = 0;
    let i = from || 0;
    for (; i + 1 < bytes.length; i += 2) {
      const u = little ? (bytes[i] | (bytes[i + 1] << 8)) : ((bytes[i] << 8) | bytes[i + 1]);
      units.push(u);
      total++;
    }
    if (i < bytes.length) { bad++; total++; }
    return { text: unitsToString(units), bad: bad, total: total };
  }

  const BOMS = [
    { enc: 'utf-8-bom', bytes: [0xEF, 0xBB, 0xBF] },
    { enc: 'utf-16le', bytes: [0xFF, 0xFE] },
    { enc: 'utf-16be', bytes: [0xFE, 0xFF] },
  ];

  function sniffBom(bytes) {
    for (const b of BOMS) {
      if (bytes.length < b.bytes.length) continue;
      let ok = true;
      for (let i = 0; i < b.bytes.length; i++) if (bytes[i] !== b.bytes[i]) { ok = false; break; }
      if (ok) return { enc: b.enc, skip: b.bytes.length };
    }
    return null;
  }

  /** 按指定编码解码（encoding 由 detect 或用户手选给出） */
  function decodeAs(buf, encoding) {
    const bytes = toBytes(buf);
    const bom = sniffBom(bytes);
    const skip = (bom && bom.enc === encoding) ? bom.skip
      : (bom && encoding === 'utf-8' && bom.enc === 'utf-8-bom') ? bom.skip : 0;
    let r;
    switch (encoding) {
      case 'gbk': r = decodeGbk(bytes, skip); break;
      case 'utf-16le': r = decodeUtf16(bytes, skip || (bom ? bom.skip : 0), true); break;
      case 'utf-16be': r = decodeUtf16(bytes, skip || (bom ? bom.skip : 0), false); break;
      case 'utf-8-bom':
      case 'utf-8':
      default: r = decodeUtf8(bytes, skip); break;
    }
    return { text: r.text, encoding: encoding, badRate: r.total ? r.bad / r.total : 0, bad: r.bad, total: r.total };
  }

  const BAD_LIMIT = 0.005;   // 乱码率上限：> 0.5% 就认为这个编码不对（产品文档 §4.1）

  /**
   * 自动识别编码。
   * BOM 优先；无 BOM 先试严格 UTF-8，失败率超阈值再试 GBK；两个都差 → ok:false，交给用户选。
   * @returns {{text, encoding, badRate, ok, bom, tried:Array}}
   */
  function detectEncoding(buf) {
    const bytes = toBytes(buf);
    const bom = sniffBom(bytes);
    if (bom) {
      const r = decodeAs(bytes, bom.enc);
      return { text: r.text, encoding: bom.enc, badRate: r.badRate, ok: r.badRate <= BAD_LIMIT, bom: true, tried: [r] };
    }
    const u8 = decodeAs(bytes, 'utf-8');
    if (u8.badRate <= BAD_LIMIT) {
      return { text: u8.text, encoding: 'utf-8', badRate: u8.badRate, ok: true, bom: false, tried: [u8] };
    }
    const gb = decodeAs(bytes, 'gbk');
    const best = gb.badRate <= u8.badRate ? gb : u8;
    return {
      text: best.text, encoding: best.encoding, badRate: best.badRate,
      ok: best.badRate <= BAD_LIMIT, bom: false,
      tried: [u8, gb],
    };
  }

  /* =============================================================
     二、规范化与分章
     ============================================================= */

  /** 统一换行、去每行首尾空白（含全角空格，缩进交给 CSS）、合并连续空行 */
  function normalize(text) {
    let t = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    t = t.split('\n').map(function (line) { return line.replace(/^[\s　]+|[\s　]+$/g, ''); }).join('\n');
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.replace(/^\n+|\n+$/g, '');
  }

  /* 「○」是 U+25CB WHITE CIRCLE，不是 U+3007 〇。中文排版里两个混用，
     Gutenberg 的《三國志演義》整本用的是前者 —— 少这一个字符，
     第一○○回 到 第一一○回 加第一二○回 共 12 个回目匹配不上，
     它们会被静默并进上一回（章数从 120 掉到 108，且不报错）。 */
  const CN_NUM = '0-9０-９零一二三四五六七八九十百千万两〇○';
  const HEAD_RE = new RegExp(
    '^(?:正文\\s*)?(?:第[' + CN_NUM + ']{1,8}[章节回卷部篇集话](?:[^\\n]{0,30})?'
    + '|[Cc]hapter\\s*[0-9]{1,4}(?:[^\\n]{0,30})?'
    + '|卷[' + CN_NUM + ']{1,4}(?:[^\\n]{0,30})?)$'
  );
  /* 标题行的真正判据是正则里那个 [^\n]{0,30} 的尾巴上限 + 行尾锚点：
     「第四章 第三章那封信到底是谁写的这个问题她在回去的路上想了整整一路也没有想明白」
     尾巴 38 字 > 30，匹配不到行尾，所以它是正文不是标题。
     原先另写了一条「整行 ≤ 40 字」的兜底 —— 那是不可达的死代码：
     前缀最多十来个字、尾巴最多 30 字，整行几乎不可能超过 40，它一次都不会触发。
     一条规则就够了，两条里有一条永远不生效只会让人以为有两层保护。 */
  const MIN_HEADS = 5;          // 命中少于这个数就不用标题分章（产品文档 §4.1）
  const AVG_LO = 500, AVG_HI = 20000;
  const FIXED_SIZE = 3000;

  function findHeadings(text) {
    const lines = text.split('\n');
    const heads = [];
    let off = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (HEAD_RE.test(line)) {
        heads.push({ line: i, title: line, start: off, len: line.length });
      }
      off += line.length + 1;
    }
    return heads;
  }

  /**
   * 分章。
   * @param {string} text 已 normalize
   * @param {Object} [opts] {mode:'heading'|'fixed'|'auto', size}
   * @returns {{mode, chapters:[{n,title,text,chars}], heads}}
   */
  function splitChapters(text, opts) {
    const o = opts || {};
    const want = o.mode || 'auto';
    const heads = findHeadings(text);
    const totalChars = text.length;
    const avg = heads.length ? totalChars / heads.length : Infinity;
    const headingOk = heads.length >= MIN_HEADS && avg >= AVG_LO && avg <= AVG_HI;

    if (want === 'heading' || (want === 'auto' && headingOk)) {
      if (heads.length) return { mode: 'heading', chapters: byHeadings(text, heads), heads: heads };
      // 用户点了标题分章但一个都没找到 —— 退化，并把真相带出去
      return { mode: 'fixed', chapters: byFixed(text, o.size || FIXED_SIZE), heads: heads, fellBack: true };
    }
    return { mode: 'fixed', chapters: byFixed(text, o.size || FIXED_SIZE), heads: heads };
  }

  /* 第一个标题之前的内容短于这个数，就当它是书名页/版权页，不单独成章。
     真实 txt 的第一行往往就是书名 —— 让它变成一个 3 个字的「序」，
     读者点「开始读」第一眼落到的就是一个空章，没有一处替换。
     超过这个数才可能是真的序言，那时候不能丢。 */
  const PRE_AS_CHAPTER = 200;

  function byHeadings(text, heads) {
    const out = [];
    const pre = heads[0].start > 0 ? text.slice(0, heads[0].start).trim() : '';
    if (pre.length >= PRE_AS_CHAPTER) {
      out.push({ n: out.length + 1, title: '序', text: pre, chars: pre.length });
    }
    for (let i = 0; i < heads.length; i++) {
      const bodyStart = heads[i].start + heads[i].len;
      const bodyEnd = (i + 1 < heads.length) ? heads[i + 1].start : text.length;
      const body = text.slice(bodyStart, bodyEnd).replace(/^\n+|\n+$/g, '');
      out.push({ n: out.length + 1, title: heads[i].title, text: body, chars: body.length });   // C3：标题不进 text
    }
    return out;
  }

  /** 固定切：目标 size 字，切点落在段落边界（不切断句子） */
  function byFixed(text, size) {
    const paras = text.split('\n');
    const out = [];
    let buf = [], n = 0;
    const flush = function () {
      if (!buf.length) return;
      const body = buf.join('\n').replace(/^\n+|\n+$/g, '');
      if (body) out.push({ n: out.length + 1, title: '第 ' + (out.length + 1) + ' 节', text: body, chars: body.length });
      buf = []; n = 0;
    };
    for (const p of paras) {
      buf.push(p);
      n += p.length + 1;
      if (n >= size) flush();
    }
    flush();
    return out;
  }

  /* =============================================================
     三、预扫描：词位索引 + 专名启发
     ============================================================= */

  /** 扩展 n-gram 时，「多出来的那些字」如果全是这些，就不算专名线索 —— 
      不加这条，「沉默了」出现 5 次就会把「沉默」整本书封杀。 */
  const STOP_EXTRA = new Set(Array.from(
    '了的着过地得是在和与就都也很不没有一个这那我你他她它们上下里外来去把被给对从向被之其所为以及但却还又再很太更最会能要想说道着呢吗吧啊哦嗯'
  ));
  /* 专名候选串里出现任何标点就不是专名。
     ⚠️ 原来这条正则漏了**中文弯引号**，于是「“聚会」「公司”」「‘观众」「协会’」全都成了 guard，
     把带引号那一侧的命中位白白遮掉。补齐后连同破折号、省略号、书名号一起挡。 */
  const PUNCT_RE = /[^\u4e00-\u9fa5\u3400-\u4dbfA-Za-z0-9]/;
  const NAME_PREFIX = new Set(['老', '小', '阿']);
  const NAME_SUFFIX = new Set(['哥', '姐', '叔', '婶', '总', '爷', '奶', '妈', '爸', '师', '君', '公', '氏']);
  const NAME_SUFFIX2 = ['老师', '先生', '女士', '同学', '师傅', '医生', '教授'];

  const NGRAM_MIN = 2, NGRAM_MAX = 4;
  const NAME_MIN_COUNT = 5;      // 全书重复 ≥ 5 次（项目说明 §8.5）
  const NAME_CAP = 300;          // meta.names 封顶，别让 meta.json 膨胀

  /* 包住率：这个 n-gram 吃掉了该命中串全书出现次数的多大比例。
     只看频次是不够的 —— 「林迟沉默了」重复 10 次会让「沉默」整本书被封杀，
     而「沉默」并不是专名。「光」几乎每次都在「光年」里（比例高）才是专名的样子。 */
  const NAME_MIN_RATIO = 0.6;


  /* 极大性：某一侧的邻字几乎恒定（且是汉字）→ 这个串不是一个完整单位，是从更长的词/名字里切下来的碎片。
     **这是 2026-09-09 那次「专名启发误伤 6.2%」的主修**，四本不同题材的书上一致有效。
     依据（同一份实测）：`恩王国` 左边永远是「鲁」（鲁恩王国）· `察部门` 左边永远是「警」·
     `保公司` 左边永远是「险」· `出口公` 右边永远是「司」· `赞美女` 右边永远是「神」。
     碎片当 guard 会遮掉一大批本来该替的位：「鲁恩 kingdom（王国）」「警察 department（部门）」是对的替换。
     ⚠️ 邻字是**标点或文首文尾**不算证据 —— 那正说明这个串在这里是完整的（`目光。` 不是碎片）。 */
  const NAME_MAX_NB_SHARE = 0.9;

  /* 一个命中串最多允许被几个**不同的**候选串吞掉。超过就说明它只是个「爱跟别的词搭伙的普通词」，
     不是某个专名的碎片 —— 专名是唯一的。
     依据：《诡秘之主》里「先生」几乎总跟在人名后面，于是 `斯先生 / 克先生 / 尔先生 / 奇先生 / 者先生 …`
     十几个串全都通过了吞没率，每一个都去遮「先生」；《解甲》里「突然」同样长出
     `突然出 / 突然开 / 突然停 / 突然发 …`。它们没有一个是专名，全是从别的词中间切开的碎片，
     而极大性判据抓不住它们（右邻是 现/手/声/来，不集中）。
     反过来，真专名「所罗门帝国」是唯一吞掉「帝国」的串。
     ⚠️ 代价是像「非凡者」这种**书内自造复合词**也会被丢掉（「非凡」在这本书里有 8 个以上的搭伙串）。
     四本书实测这是划算的：明确误伤 1.31%→0.08%，代价是少遮一批「本来也不算错」的位。 */
  const NAME_MAX_COVERERS = 3;

  /* 判「极大性」至少要有几次出现。样本太少时两次邻字相同是巧合不是证据，
     而称谓串（小梦）恰恰大多低频 —— 这一条是给它们留的口子。
     ⚠️ 别设成 NAME_MIN_COUNT(5)：`出口公`（出口公司）· `靠近公` · `教会总` 这些低频碎片会整批漏过去，
     实测《诡秘之主》上明确误伤会从 0.15% 涨回 0.40%。 */
  const NAME_MIN_JUDGE = 3;

  /* 称谓串的频次门槛。比普通 n-gram 的 5 低 —— 位置证据仍然更强，但不能只出现一两次就当专名。
     ⚠️ 原来是「完全不看频次」，在 192 词的桥上没问题；扩到 6000 词之后，
     「命中 + 一个称谓字」的组合遍地都是：`出口公`（出口公司）· `提高公` · `离开公` · `教会总`，
     它们大多只出现两三次，正好**低到躲开极大性判据的样本门槛**，只能靠频次挡。 */
  const TITLED_MIN_COUNT = 3;

  /* 导入时先扫多少章，以及读到离已扫边界还剩几章时补扫下一批。
     全书一次扫完在真机上是 4–11 秒（5500 词桥、50 万字），而读者只要能读第一章。
     数值可由调用方覆盖。 */
  const SCAN_INITIAL = 20, SCAN_BATCH = 20, SCAN_AHEAD = 5;

  /**
   * 预扫描。默认扫全书；给了 from/to 就只扫那一段（口径 C4：index 可增量补）。
   * @param {Array} chapters splitChapters 的输出
   * @param {Array} bridge   **全量桥**（口径 C1）
   * @param {Object} [opts]  {nameMinCount, nameMinRatio, from, to}   from/to 是 1 基闭区间
   * @returns {{index, names_guess, slots, words, perChapter, range}}
   *   index: { word_id: { 章序(1基, string): 命中数 } }
   *   perChapter: { 章序: 命中数 }（对象不是数组 —— 增量扫的时候数组会留一堆空洞）
   */
  function prescan(chapters, bridge, opts) {
    const o = opts || {};
    const minCount = o.nameMinCount || NAME_MIN_COUNT;
    const from = Math.max(1, o.from || 1);
    const to = Math.min(chapters.length, o.to == null ? chapters.length : o.to);
    const index = {};
    const perChapter = {};
    const hitsByCh = [];
    const scanned = [];
    let slots = 0;

    for (let ci = from - 1; ci <= to - 1; ci++) {
      const hits = NRReplace.findCandidates(chapters[ci].text, bridge);   // C1：全量桥
      hitsByCh.push(hits);
      scanned.push(chapters[ci]);
    }

    // 专名启发要拿**原始命中**去生成 n-gram，所以必须先算它，再拿它去过滤
    const names_guess = guessNames(scanned, hitsByCh, minCount, o.nameMinRatio, o.nameMaxNbShare, o.nameMaxGram, o.nameMaxCoverers, o.titledMinCount);

    /* ★ 索引要扣掉会被专名遮住的位。
       不扣的话，「光」在「光年便利店」里出现 18 次全都进了索引，
       于是详情页说「light 出现 18 次」、导入预览说「能教你 N 个词」——
       而阅读时 replace() 会把这些位全丢掉，一次都不替。数字比实际多，是在骗读者。
       口径 C1 说「index 要和阅读时替得出来的对得上」，指的就是这件事。

       ★★ 但这条和增量扫描（C4）本质上冲突：**专名启发靠全书频次（≥5 次），
       而增量扫描只看得到一部分**。前 2 章里「光年」只出现 2 次 → 不算专名 → 「光」进了索引；
       扫完全书才够 5 次，可前面的索引不会回溯。
       冲突不能消掉，但**方向是单向的、可陈述的**：
         扫得少 → 认出的专名少 → 遮得少 → **命中数只会偏高，不会偏低**。
       所以契约是：分批扫出来的索引 ⊇ 一次全扫的索引（词是超集、每格计数 ≥），
       一次扫完全书时两者相等。书库的书打包时一次全扫，数字是准的；
       读者导入的书边读边补，前期可能略偏高，随着扫得多而收敛。
       `mergeScan` 会报 `guardsChanged`，将来要收敛得更快就靠它触发重扫。 */
    const pn = (o.names || []).concat(o.knownGuards || []).concat(names_guess);
    const ranges = scanned.map(function (ch) { return NRReplace.properRanges(ch.text, pn); });
    const masked = function (ci, h) {
      const rs = ranges[ci];
      for (const r of rs) if (h.offset < r.end && r.start < h.offset + h.len) return true;
      return false;
    };

    for (let k = 0; k < hitsByCh.length; k++) {
      const key = String(from + k);
      let n = 0;
      for (const h of hitsByCh[k]) {
        if (masked(k, h)) continue;
        const m = index[h.word_id] || (index[h.word_id] = {});
        m[key] = (m[key] || 0) + 1;
        n++;
      }
      perChapter[key] = n;
      slots += n;
    }

    return {
      index: index, names_guess: names_guess, slots: slots,
      words: Object.keys(index).length, perChapter: perChapter,
      range: { from: from, to: to },
    };
  }

  /**
   * 把新扫出来的一段并进已有的书（不改入参）。
   * 同一章重复扫是**覆盖不是累加** —— 补扫必须幂等，否则重扫一次命中数就翻倍。
   * @param {Object} book {index, perChapter, scannedTo, meta:{guards}}
   * @param {Object} scan prescan 的输出
   */
  function mergeScan(book, scan) {
    const b = book || {};
    const index = {};
    for (const id in (b.index || {})) index[id] = Object.assign({}, b.index[id]);
    for (const id in scan.index) {
      const m = index[id] || (index[id] = {});
      for (const ch in scan.index[id]) m[ch] = scan.index[id][ch];
    }
    const guards = (b.meta && b.meta.guards ? b.meta.guards.slice() : []);
    let guardsChanged = false;
    for (const n of scan.names_guess) if (guards.indexOf(n) < 0) { guards.push(n); guardsChanged = true; }
    const perChapter = Object.assign({}, b.perChapter || {}, scan.perChapter);
    let slots = 0, words = 0;
    for (const k in perChapter) slots += perChapter[k];
    for (const id in index) words++;
    return {
      index: index, guards: guards.slice(0, NAME_CAP), perChapter: perChapter,
      scannedTo: Math.max(b.scannedTo || 0, scan.range.to),
      slots: slots, words: words,
      // 新认出了专名 → 之前扫的那些章的计数偏高（见 prescan 里的 ★★）。
      // M0 不做回溯重扫，只把这件事报出来，将来要收敛得更快就靠它。
      guardsChanged: guardsChanged,
    };
  }

  /**
   * 把一本书补扫到底（入库前必须做：书库的书要给所有人看，数字不能偏高）。
   * 一次全扫，所以专名判定看得到全书 —— 这也是「分批 ⊇ 全扫」那条不等式收敛的地方。
   * @returns {Object} mergeScan 的结果
   */
  function scanAll(book, bridge, opts) {
    const scan = prescan(book.chapters, bridge, Object.assign({}, opts, {
      from: 1, to: book.chapters.length, names: (book.meta && book.meta.names) || [],
    }));
    return mergeScan({ index: {}, perChapter: {}, scannedTo: 0, meta: { guards: [] } }, scan);
  }

  /** 读到第 cur 章时要不要补扫。返回 null 或 {from, to} */
  function nextScanRange(scannedTo, totalChapters, cur, opts) {
    const o = opts || {};
    const ahead = o.ahead == null ? SCAN_AHEAD : o.ahead;
    const batch = o.batch == null ? SCAN_BATCH : o.batch;
    if (scannedTo >= totalChapters) return null;
    if (cur + ahead <= scannedTo) return null;
    return { from: scannedTo + 1, to: Math.min(totalChapters, scannedTo + batch) };
  }

  /**
   * 专名启发（项目说明 §8.5 的落地）。
   * 只统计「真的包住了某个命中位」的 2–4 字串 —— 全书所有 n-gram 都统计的话，
   * 50 万字要几百万条，而且绝大多数与替换无关。
   */
  function guessNames(chapters, hitsByCh, minCount, minRatio, o_nbShare, o_gramMax, o_maxCov, o_titledMin) {
    const ratioMin = (typeof minRatio === 'number') ? minRatio : NAME_MIN_RATIO;
    const gramMax = (typeof o_gramMax === 'number') ? o_gramMax : NGRAM_MAX;
    const cand = new Set();
    const patTotal = new Map();   // 命中串 → 全书命中次数
    const titled = new Set();     // 称谓规则命中的串（产品文档 §4.2 第三条）
    const titledCovers = new Map();   // 称谓串 → 它包住的命中串集合

    /* --- 1) 收集「真的包住了某个命中位」的 2–4 字串 ---
       全书所有 n-gram 都统计的话，50 万字要几百万条，而且绝大多数与替换无关。 */
    for (let ci = 0; ci < chapters.length; ci++) {
      const cs = Array.from(chapters[ci].text);
      for (const h of hitsByCh[ci]) {
        patTotal.set(h.expr, (patTotal.get(h.expr) || 0) + 1);
        const t = titledSpan(cs, h.offset, h.len);
        if (t) {
          titled.add(t);
          let set = titledCovers.get(t);
          if (!set) { set = new Set(); titledCovers.set(t, set); }
          set.add(h.expr);
        }
        for (let L = Math.max(NGRAM_MIN, h.len + 1); L <= gramMax; L++) {
          const lo = Math.max(0, h.offset + h.len - L);
          const hi = Math.min(cs.length - L, h.offset);
          for (let st = lo; st <= hi; st++) {
            const g = cs.slice(st, st + L).join('');
            if (g.length !== L) continue;
            if (PUNCT_RE.test(g)) continue;
            // 多出来的字全是虚词/常用字 → 不是专名线索（不加这条，「沉默了」会封杀「沉默」）
            if (isAllStopExtra(g, cs, h, st)) continue;
            cand.add(g);
          }
        }
      }
    }
    /* ⚠️ 这里原来有两处「没候选就直接返回 titled」的快捷出口，2026-09-09 删掉了：
       它们绕过了称谓串的频次门槛和极大性判据，等于在边界情况下悄悄用回旧规则。
       正常流程在 cand/frequent 为空时本来就会走成空集，不需要特判。 */
    /* --- 2) 一遍 AC 数全书出现次数，留下够频繁的 ---
       称谓串也进这台 AC（只为拿到它们的全书次数，见第 4 条的门槛）；
       但 `frequent` 仍然只从 `cand` 里选 —— 让称谓串参与吞没率会改掉下面整段的语义。 */
    const patterns = Array.from(cand);
    titled.forEach(function (t) { if (!cand.has(t)) patterns.push(t); });
    const ac = NRAc.build(patterns.map(function (g) { return { pat: g }; }));
    const occByCh = [];
    const gCount = new Map();
    for (const ch of chapters) {
      const occ = ac.search(ch.text);
      occByCh.push(occ);
      for (const o of occ) gCount.set(o.pat, (gCount.get(o.pat) || 0) + 1);
    }
    const titledMin = (typeof o_titledMin === 'number') ? o_titledMin : TITLED_MIN_COUNT;
    const titledKept = new Set();
    titled.forEach(function (t) { if ((gCount.get(t) || 0) >= titledMin) titledKept.add(t); });
    const frequent = new Set();
    for (const [g, c] of gCount) if (c >= minCount && cand.has(g)) frequent.add(g);

    /* --- 3) 吞没率：按**命中串**算，不是按 n-gram 算 ---
       「光」可能同时被「小光」和「光年」吃掉，分开算的话两个都过不了阈值，
       但「光」确实几乎从不独立出现 —— 该保护。判据是「这个串有多少次是被吃掉的」。 */
    const covered = new Map();          // 命中串 → 被某个高频 n-gram 包住的次数
    const gCovers = new Map();          // n-gram → 它包住过的命中串集合
    const nbL = new Map(), nbR = new Map();   // 候选串 → 左/右邻字分布（只给极大性判据用）
    const bump = function (m, pat, ch) {
      let d = m.get(pat); if (!d) { d = new Map(); m.set(pat, d); }
      d.set(ch, (d.get(ch) || 0) + 1);
    };
    for (let ci = 0; ci < chapters.length; ci++) {
      const pool = occByCh[ci].filter(function (o) { return frequent.has(o.pat) || titledKept.has(o.pat); });
      const occ = pool.filter(function (o) { return frequent.has(o.pat); });
      const cs2 = Array.from(chapters[ci].text);
      for (const o of pool) {
        bump(nbL, o.pat, o.start >= 1 ? cs2[o.start - 1] : '');
        bump(nbR, o.pat, o.start + o.len < cs2.length ? cs2[o.start + o.len] : '');
      }
      for (const h of hitsByCh[ci]) {
        // 包住这个命中位的**每一个**高频串都要记账。
        // 只记第一个的话，「光」被「小光」记走之后「光年」就永远拿不到证据，
        // 该保护的专名会随 AC 的返回顺序随机掉一半。
        let any = false;
        for (const o of occ) {
          if (o.len <= h.len) continue;
          if (o.start > h.offset || h.offset + h.len > o.start + o.len) continue;
          any = true;
          let set = gCovers.get(o.pat);
          if (!set) { set = new Set(); gCovers.set(o.pat, set); }
          set.add(h.expr);
        }
        if (any) covered.set(h.expr, (covered.get(h.expr) || 0) + 1);   // 命中位只算一次，不按 n-gram 重复计
      }
    }
    const swallowed = function (pat) {
      const tot = patTotal.get(pat) || 0;
      return tot ? (covered.get(pat) || 0) / tot : 0;
    };

    /* --- 4) 一个 n-gram 只有在它包住的**每一个**命中串都「几乎总被吞掉」时才算专名 ---
       否则「迟沉默」重复 10 次就会把出现 100 次的「沉默」整本书封杀。 */
    /* 极大性：某一侧的汉字邻居占比 ≥ 阈值 → 碎片，不是完整单位 */
    const shareMax = (typeof o_nbShare === 'number') ? o_nbShare : NAME_MAX_NB_SHARE;
    const CJK1 = /^[\u4e00-\u9fa5\u3400-\u4dbf]$/;
    const domShare = function (d) {
      if (!d) return 0;
      let tot = 0, best = 0;
      d.forEach(function (n) { tot += n; });
      d.forEach(function (n, ch) { if (ch && CJK1.test(ch) && n > best) best = n; });
      return tot ? best / tot : 0;
    };
    const isFragment = function (g) {
      // 样本太少判不了「恒定」：只出现 2 次的串两次邻字相同是巧合，不是证据。
      // 称谓串大多是低频的（这正是它存在的理由），这一条让它们不受极大性约束。
      const d = nbR.get(g);
      let tot = 0;
      if (d) d.forEach(function (n) { tot += n; });
      if (tot < NAME_MIN_JUDGE) return false;
      return domShare(nbL.get(g)) >= shareMax || domShare(nbR.get(g)) >= shareMax;
    };

    /* 谁吞掉了这个命中串。**只数完整式**：`光年 / 光年便 / 光年便利 / 光年便利店` 是同一个东西的
       四个嵌套窗口，数成四个吞噬者会把「光年便利店」自己也误判成「爱搭伙的普通词」。 */
    const exprCoverers = new Map();
    for (let ci = 0; ci < chapters.length; ci++) {
      const pool2 = occByCh[ci].filter(function (o) {
        return (frequent.has(o.pat) || titledKept.has(o.pat)) && !isFragment(o.pat);
      });
      for (const h of hitsByCh[ci]) {
        for (const o of pool2) {
          if (o.len <= h.len) continue;
          if (o.start > h.offset || h.offset + h.len > o.start + o.len) continue;
          let set = exprCoverers.get(h.expr);
          if (!set) { set = new Set(); exprCoverers.set(h.expr, set); }
          set.add(o.pat);
        }
      }
    }
    const maxCov = (typeof o_maxCov === 'number') ? o_maxCov : NAME_MAX_COVERERS;
    /* 数吞噬者之前先按**包含关系**去重（同「最小集」那一步的逻辑）：
       `光年便利店` 与 `光年便利店的`、`小光` 与 `小光说` 是同一份证据的两个写法，
       算成两个吞噬者会把只被一个专名吞掉的命中串误判成「爱搭伙的普通词」。 */
    const nCoverers = function (expr) {
      const set = exprCoverers.get(expr);
      if (!set) return 0;
      const arr = Array.from(set).sort(function (a, b) { return a.length - b.length; });
      const keep = [];
      for (const x of arr) {
        let nested = false;
        for (const k of keep) if (x.indexOf(k) >= 0) { nested = true; break; }
        if (!nested) keep.push(x);
      }
      return keep.length;
    };
    const swallowedByMany = function (pats) {
      if (!pats || !pats.size) return true;
      for (const pat of pats) if (nCoverers(pat) <= maxCov) return false;
      return true;
    };
    const passed = [];
    for (const g of frequent) {
      const pats = gCovers.get(g);
      if (!pats || !pats.size) continue;
      let ok = true;
      for (const pat of pats) if (swallowed(pat) < ratioMin) { ok = false; break; }
      if (ok && !swallowedByMany(pats)) passed.push({ name: g, count: gCount.get(g) || 0, pats: pats });
    }

    /* --- 4.5) 碎片让位给完整式 ---
       「鲁恩王国」和它的碎片「恩王国」会同时通过上面全部判据，而最小集那一步按长度升序取，
       碎片更短、会**赢**，于是留下的是「恩王国」——它遮掉的是「鲁恩 kingdom（王国）」这种对的替换。
       所以在最小集之前先按极大性把碎片踢掉。
       ⚠️ **但只在「有完整式可让」的时候踢**：`光年便利店` 有 5 个字，超过 NGRAM_MAX=4，
       它的 2–4 字窗口（光年 / 光年便 / 光年便利）**全是碎片**，一刀切会让这个专名一个 guard 都不剩。
       判据因此是「这个命中串已经被某个完整式保护了吗」，不是「这个串是不是碎片」。 */
    const out = passed.filter(function (x) { return !isFragment(x.name); });
    out.sort(function (a, b) { return a.name.length - b.name.length || b.count - a.count; });

    // 最小集：若已收的某个串是它的子串，就丢掉它。
    // 「光年」已经在表里的话，「光年便」「光年便利」遮的是同一批命中位，留着只是让列表变长。
    const minimal = [];
    for (const x of out) {
      if (minimal.some(function (m) { return x.name.indexOf(m) >= 0; })) continue;
      minimal.push(x.name);
    }
    // 称谓命中排在前面：它是位置证据，比频次证据强，且不受吞没率约束（但要过 2.5 的频次门槛）
    // 称谓串也要过极大性：`斯先生 / 克先生 / 尔先生` 一样是从人名中间切开的碎片
    const titledFinal = Array.from(titledKept).filter(function (t) {
      return !swallowedByMany(titledCovers.get(t)) && !isFragment(t);
    });
    const merged = titledFinal.concat(minimal.filter(function (n) { return titledFinal.indexOf(n) < 0; }));
    return merged.slice(0, NAME_CAP);
  }

  /**
   * 命中位带称谓 → 返回连称谓在内的整串（进专名表），否则 null。
   * 「小光」「光哥」「林迟老师」这类：把整串当专名，replace.js 的 properRanges 就会遮住里面的命中位。
   */
  function titledSpan(cs, offset, len) {
    const prev = offset > 0 ? cs[offset - 1] : '';
    const hit = cs.slice(offset, offset + len).join('');
    const n1 = cs[offset + len] || '';
    const n2 = n1 + (cs[offset + len + 1] || '');
    if (NAME_PREFIX.has(prev)) return prev + hit;
    if (NAME_SUFFIX2.indexOf(n2) >= 0) return hit + n2;
    if (NAME_SUFFIX.has(n1)) return hit + n1;
    return null;
  }

  /** g 相对命中串多出来的字是否全在停用集里 */
  function isAllStopExtra(g, cs, hit, gStart) {
    const gs = Array.from(g);
    const hitStartInG = hit.offset - gStart;
    let extras = 0, stops = 0;
    for (let k = 0; k < gs.length; k++) {
      if (k >= hitStartInG && k < hitStartInG + hit.len) continue;
      extras++;
      if (STOP_EXTRA.has(gs[k])) stops++;
    }
    return extras > 0 && extras === stops;
  }

  /** 称谓规则（产品文档 §4.2 的第三条）：命中位前后带称谓字 → 当专名丢 */
  function titledName(text, offset, len) {
    const cs = Array.from(text);
    const prev = offset > 0 ? cs[offset - 1] : '';
    const next = cs[offset + len] || '';
    const next2 = (cs[offset + len] || '') + (cs[offset + len + 1] || '');
    if (NAME_PREFIX.has(prev)) return true;
    if (NAME_SUFFIX.has(next)) return true;
    if (NAME_SUFFIX2.indexOf(next2) >= 0) return true;
    return false;
  }

  /* =============================================================
     四、一次跑完
     ============================================================= */

  /**
   * @param {ArrayBuffer|Uint8Array|string} input
   * @param {Object} opts {bridge, encoding?, split?, size?, title?, nameMinCount?}
   * @returns {{meta, chapters, index, names_guess, detect}}
   */
  function importBook(input, opts) {
    const o = opts || {};
    let detect;
    if (typeof input === 'string') {
      detect = { text: input, encoding: 'text', badRate: 0, ok: true, bom: false, tried: [] };
    } else if (o.encoding) {
      const r = decodeAs(input, o.encoding);
      detect = { text: r.text, encoding: r.encoding, badRate: r.badRate, ok: r.badRate <= BAD_LIMIT, bom: !!sniffBom(toBytes(input)), tried: [r] };
    } else {
      detect = detectEncoding(input);
    }
    const text = normalize(detect.text);
    const sp = splitChapters(text, { mode: o.split || 'auto', size: o.size });
    // C4：只扫前几章，读者立刻能读；其余边读边补（nextScanRange + mergeScan）
    const scanTo = Math.min(sp.chapters.length, o.scanTo == null ? SCAN_INITIAL : o.scanTo);
    const scan = prescan(sp.chapters, o.bridge || [], { nameMinCount: o.nameMinCount, from: 1, to: scanTo });

    const meta = {
      id: o.id || ('b_' + Math.floor(Date.now() / 1000)),
      title: o.title || guessTitle(text),
      mode: 'import',
      encoding: detect.encoding,
      chars: text.length,
      chapters: sp.chapters.length,
      split: sp.mode,
      imported: o.today || null,
      vocab: o.vocab || null,
      coverage: { words: scan.words, slots: scan.slots },
      scannedTo: scan.range.to,          // 已扫到第几章（C4：index 是增量的）
      // names 只装**读者自己标的**专名（抽屉里点「这是人名」），导入时是空的；
      // guards 是启发出来的遮罩串，内部用。
      // 两者分开是因为启发难免出「封信」「小光说」这类不是人名但该遮的串 ——
      // 把它们摆进「本书人名」给读者看是错的，但拿它们遮住命中位是对的。
      names: [],
      guards: scan.names_guess.slice(),
      last_read: { ch: 1, para: 0 },
    };
    return {
      meta: meta, chapters: sp.chapters, index: scan.index,
      names_guess: scan.names_guess, detect: detect, perChapter: scan.perChapter,
      scannedTo: scan.range.to, fellBack: !!sp.fellBack,
    };
  }

  /** 传给 replace() 的 properNouns：读者标记 + 启发遮罩，去重。页面一律用它，别各拼各的。 */
  function properNounsOf(meta) {
    const m = meta || {};
    const out = [], seen = new Set();
    for (const n of (m.names || []).concat(m.guards || [])) {
      if (!n || seen.has(n)) continue;
      seen.add(n); out.push(n);
    }
    return out;
  }

  /**
   * 已经分好章的书（示例书、M2 的 epub）走这条，不要过标题识别。
   * 示例书《暗巷》的章名是「两点十四分」这种，不是「第X章」——
   * 硬塞进 splitChapters 会被退化成固定分章，把 3 章并成 2 段。
   * 分章是**txt 才需要猜**的事；已经有结构就别猜。
   * @param {Array} chapters [{title, text}]
   * @param {Object} opts {bridge, title, names?, id?, today?, vocab?}
   */
  function importChapters(chapters, opts) {
    const o = opts || {};
    const chs = (chapters || []).map(function (c, i) {
      const text = normalize(c.text || '');
      return { n: i + 1, title: c.title || ('第 ' + (i + 1) + ' 章'), text: text, chars: text.length };
    });
    const scanTo = Math.min(chs.length, o.scanTo == null ? SCAN_INITIAL : o.scanTo);
    const scan = prescan(chs, o.bridge || [], {
      nameMinCount: o.nameMinCount, from: 1, to: scanTo, names: o.names || [],
    });
    const meta = {
      id: o.id || ('b_' + Math.floor(Date.now() / 1000)),
      title: o.title || '未命名', mode: 'import', encoding: o.encoding || 'text',
      chars: chs.reduce(function (a, c) { return a + c.chars; }, 0),
      chapters: chs.length, split: 'given',
      imported: o.today || null, vocab: o.vocab || null,
      coverage: { words: scan.words, slots: scan.slots },
      scannedTo: scan.range.to,
      names: (o.names || []).slice(),      // 示例书自带的专名表（作者写的，比启发准）
      guards: scan.names_guess.slice(),
      last_read: { ch: 1, para: 0 },
    };
    return { meta: meta, chapters: chs, index: scan.index, names_guess: scan.names_guess,
      perChapter: scan.perChapter, scannedTo: scan.range.to };
  }

  function guessTitle(text) {
    const first = (text.split('\n')[0] || '').trim();
    if (first && first.length <= 30) return first;
    return '未命名';
  }

  /* =============================================================
     五、读取侧：词表过滤与「能教你 N 个词」
     ============================================================= */

  /**
   * 口径 C2：词表过滤 words 映射，不过滤 bridge。
   *
   * ★ 考纲是**难度上限**，不是标签相等 —— 这一条是踩出来的：
   *   项目说明（旧版 §一）写「words[].exam_tags 过滤」。按标签硬过滤的话，
   *   「考研」词表里每个词的 level 都是 4.6，而用户起步水平是 3.4（考纲 − 1.2），
   *   scheduler 的取词窗口是 [3.4, 4.4] —— 一个词都落不进去，
   *   fresh 恒空，读者一个新词都拿不到，而且**不报任何错**（小说台经验 10 的同款）。
   *   现实里考研大纲本来就包含四六级，所以词表 = level ≤ 考纲难度 的全部词，
   *   读者先补四六级、随水平上升再爬到考研词，正是 scheduler 设计的样子。
   *   难度尺子只有一把：scheduler.js 的 EXAM_LEVEL / levelOf，这里只引用不重写。
   *
   * ★ **雅思是例外，按标签筛**（TAG_PRESETS，2026-09-12）。上面那条讲的是
   *   高考 → 四级 → 六级 → 考研这条**难度递增链**：考研大纲本来就包含四六级，
   *   所以「难度上限」这把尺子筛出来的就是词表本身。雅思不在这条链上 ——
   *   它是另一套词表，不是「比考研更难的一档」。拿 level 筛它，EXAM_LEVEL.雅思=4.8
   *   高于库里最高的 4.6，于是筛出**整个词库**，选词页写「雅思 6,018 词」，
   *   和「考研 6,018 词」一模一样 —— 一个假数字，而且不报错。
   *
   *   为什么这次按标签**不会**撞上面那个 fresh 恒空：那个坑的成因是
   *   「词表里每个词的 level 都等于考纲难度」，窗口在考纲之下就一个都落不进。
   *   雅思标签是**打在已有词条上的**，词的 level 仍由它自己的考纲档决定（U4 取 min），
   *   2,094 个雅思词的 level 从 3.0 摊到 4.6；起步 3.6、窗口 [3.6,4.6] 内有 1,209 个。
   *   实测在 build.js 之后跑过，冒烟第 25 节钉着这条（判据是 fresh 非空，不是「跑得通」）。
   *
   * @param {Map|Object} words 全量词条
   * @param {Object} vocab {preset?:string, custom?:string[](word_id)}
   * @returns {Map} 过滤后的 word_id → 词条
   */
  /** 按 exam_tags 命中筛的预设（不在难度链上的词表）。其余预设一律按 level 上限。 */
  const TAG_PRESETS = { 雅思: true };

  function filterWords(words, vocab) {
    const v = vocab || {};
    const custom = new Set(v.custom || []);
    const byTag = !!(v.preset && TAG_PRESETS[v.preset]);
    const cap = (v.preset && !byTag) ? NRSched.EXAM_LEVEL[v.preset] : null;
    const iter = (words instanceof Map) ? Array.from(words.values())
      : Object.keys(words || {}).map(function (k) { return words[k]; });
    const out = new Map();
    for (const w of iter) {
      const byPreset = byTag
        ? (w.exam_tags || []).indexOf(v.preset) >= 0
        : (cap != null) && NRSched.levelOf(w) <= cap + 1e-9;
      if (byPreset || custom.has(w.id)) out.set(w.id, w);
    }
    return out;
  }

  /**
   * 「这本书能教你 N 个词 / 前 K 章约 M 个新词」（产品文档 §3.2 步骤 4）。
   * 全量 index 与词表求交，换词表时不用重扫。
   */
  function coverageOf(index, vocabWords, opts) {
    const o = opts || {};
    const has = (vocabWords instanceof Map)
      ? function (id) { return vocabWords.has(id); }
      : function (id) { return !!vocabWords[id]; };
    const firstK = o.firstChapters || 10;
    // C4：index 可能只覆盖前几章。这时候「这本书能教你 N 个词」是在说谎 ——
    // partial 让界面改口成「前 N 章能教你…」。数字本身不作假，措辞要跟着变。
    const partial = (o.scannedTo != null && o.total != null && o.scannedTo < o.total);
    let words = 0, slots = 0, headWords = 0, headSlots = 0;
    for (const id in index) {
      if (!has(id)) continue;
      words++;
      let inHead = false;
      for (const ch in index[id]) {
        const c = index[id][ch];
        slots += c;
        if (Number(ch) <= firstK) { headSlots += c; inHead = true; }
      }
      if (inHead) headWords++;
    }
    return { words: words, slots: slots, firstChapters: firstK, headWords: headWords, headSlots: headSlots,
      partial: partial, scannedTo: o.scannedTo == null ? null : o.scannedTo, total: o.total == null ? null : o.total };
  }

  /**
   * 到期顺延（产品文档 §4.3）：到期词若本章没有，推到它下一次出现的章。
   * 不改 due_date（天上限仍在，不变式 I8）。纯函数，返回补丁不改入参。
   *
   * ★ 增量索引下必须区分两种「找不到」（口径 C4）：
   *     gone      —— 全书都扫完了，后面确实没有了。词表里说「本书不再出现」，是真话。
   *     unscanned —— 只扫到第 N 章，后面还没看过。**不能说「不再出现」**，
   *                  那是拿「我还没查」当「它不存在」，词表会骗人。
   *   不传 scan 就当全书已扫完，行为与从前一致（向后兼容）。
   *
   * @param {Object} [scan] {to:已扫到第几章, total:总章数}
   * @returns {{patched:Object, gone:string[], unscanned:string[]}}
   */
  function deferDue(userWords, index, curChapter, isDue, todayYmd, scan) {
    const patched = {}, gone = [], unscanned = [];
    const complete = !scan || scan.to == null || scan.total == null || scan.to >= scan.total;
    for (const id in userWords) {
      const u = userWords[id];
      if (u.state === '跳过') continue;
      if (!isDue(u, curChapter, todayYmd)) continue;
      const occ = index[id];
      if (occ && occ[String(curChapter)]) continue;          // 本章就有，不用顺延
      let next = null;
      for (const ch in (occ || {})) {
        const n = Number(ch);
        if (n >= curChapter && (next === null || n < next)) next = n;
      }
      if (next !== null) { patched[id] = next; continue; }
      if (complete) gone.push(id);
      else unscanned.push(id);
    }
    return { patched: patched, gone: gone, unscanned: unscanned };
  }

  return {
    toBytes: toBytes, decodeUtf8: decodeUtf8, decodeGbk: decodeGbk, decodeUtf16: decodeUtf16,
    sniffBom: sniffBom, decodeAs: decodeAs, detectEncoding: detectEncoding,
    normalize: normalize, findHeadings: findHeadings, splitChapters: splitChapters,
    prescan: prescan, guessNames: guessNames, titledName: titledName, titledSpan: titledSpan,
    importBook: importBook, importChapters: importChapters, properNounsOf: properNounsOf,
    mergeScan: mergeScan, nextScanRange: nextScanRange, scanAll: scanAll, filterWords: filterWords, TAG_PRESETS: TAG_PRESETS, coverageOf: coverageOf, deferDue: deferDue,
    BAD_LIMIT: BAD_LIMIT, MIN_HEADS: MIN_HEADS, FIXED_SIZE: FIXED_SIZE, PRE_AS_CHAPTER: PRE_AS_CHAPTER,
    NAME_MIN_COUNT: NAME_MIN_COUNT, NAME_MIN_RATIO: NAME_MIN_RATIO,
    NAME_MAX_NB_SHARE: NAME_MAX_NB_SHARE, NAME_MAX_COVERERS: NAME_MAX_COVERERS, NAME_MIN_JUDGE: NAME_MIN_JUDGE, TITLED_MIN_COUNT: TITLED_MIN_COUNT,
    SCAN_INITIAL: SCAN_INITIAL, SCAN_BATCH: SCAN_BATCH, SCAN_AHEAD: SCAN_AHEAD,
  };
});

/* ============================================================================
 * js/game.js —— 阶段 1「状态机主循环」（无 DOM 依赖，可在 Node 里无头跑）
 * ----------------------------------------------------------------------------
 * 冻结约定：
 *   1. 所有状态切换集中在 Game.setState(next) 一个函数里（非法切换只告警不炸）。
 *   2. 金币 / 怀疑值 / 耐心 只由 applyEffect 改动；本文件不直接做加减。
 *   3. 界面渲染只读 Game.state；动画回调里不改数值（结算在动画之前/之后各一次，
 *      由 flags.revealLocked 保证「连续快速点击 50 次不重复开奖」）。
 *   4. 动画走 UI 的 Promise 接口；Node 无头时可注入 deps.ui / deps.setTimeout。
 * 对外：window.Game = { init, start, reset, action, setState, snapshot, subscribe,
 *                       hostPick, generateDoors, autoDemo }
 * ========================================================================== */
(function (root) {
  'use strict';

  var STATES = root.STATES;
  var CHOICES = root.CHOICES;
  var MODES = root.MODES;
  var RNG = root.RNG;
  var cloneState = root.cloneState;
  var clampInt = root.clampInt;
  var createInitialState = root.createInitialState;

  /** 合法状态迁移表（同状态允许，用于 DECIDE 内的加倍/质疑刷新）。 */
  var ALLOWED = {
    IDLE: ['ROUND_INTRO'],
    ROUND_INTRO: ['NARRATOR', 'PICK', 'GAME_OVER', 'CASHOUT'],
    NARRATOR: ['PICK', 'ROUND_INTRO'],
    PICK: ['HOST_OPEN', 'IDLE'],
    HOST_OPEN: ['DECIDE'],
    DECIDE: ['REVEAL', 'CASHOUT', 'GAME_OVER'],
    REVEAL: ['SETTLE_ROUND', 'GAME_OVER', 'CASHOUT'],
    SETTLE_ROUND: ['ROUND_INTRO', 'CASHOUT', 'GAME_OVER', 'IDLE'],
    CASHOUT: ['IDLE', 'ROUND_INTRO'],
    GAME_OVER: ['IDLE', 'ROUND_INTRO']
  };

  /**
   * 轮次风险提示兜底文案（若 GameData.config.roundHints 提供则以配置为准）。
   * 注意：横幅只报风险，不得预告旁白本轮的口径——真假留给你自己判断。
   * 这里必须与 data/config.json 的 roundHints 逐字一致（评审 P0-3）。
   */
  var ROUND_HINTS = {
    1: '第 1 轮：旁白还在热身，先看清台面。',
    2: '第 2 轮：灯光暗了一点，台下有人在看。',
    3: '第 3 轮：气氛不太对，收手也算赢。',
    4: '第 4 轮起：门后可能藏着炸弹，见好就收。'
  };

  /** 用户最后一次的静音选择（默认不静音）。
   *  跨「重置 / 切换模式 / 再来一局」保持：静音是本机偏好，不是本局状态；
   *  但不落盘（不写 CodexStore / localStorage），只在本进程内记忆。 */
  var mutedPref = false;

  /** 契约 v3 §5.1：演示提词器开关（?rehearsal=1 或 #rehearsal），本进程内记忆、跨重置保持。 */
  var rehearsalPref = false;

  /** 契约 v4 §6：?seed=xxx 指定的重放种子（本进程内记忆）。 */
  var seedPref = null;

  /** 契约 v5：?doors=N 强制本轮门数（仅普通模式；3–6，非法值回落 3）。 */
  var forceDoorCount = null;

  /** 读 URL 里的 ?doors=N（deps.location 可注入，测试用）。契约 §2.1：给了但非法 → 回落 3。 */
  function doorsFromUrl(opts, deps) {
    if (opts && opts.doors != null) {
      var n0 = parseInt(opts.doors, 10);
      return (n0 >= 3 && n0 <= 6) ? n0 : 3;
    }
    var loc = (deps && deps.location) || root.location || {};
    var m = /(?:[?&])doors=(\d+)(?:&|$)/.exec(String(loc.search || ''));
    if (!m) return null;
    var n = parseInt(m[1], 10);
    return (n >= 3 && n <= 6) ? n : 3;
  }

  /** 读 URL 里的提词器开关；deps.location 可注入（测试用）。 */
  function rehearsalFromUrl(opts, deps) {
    if (opts && opts.rehearsal === true) return true;
    var loc = (deps && deps.location) || root.location || {};
    var q = String(loc.search || '');
    var h = String(loc.hash || '');
    return /(?:[?&])rehearsal=1(?:&|$)/.test(q) || h === '#rehearsal';
  }

  var DEFAULT_TIMINGS = {
    introMs: 800, narratorMs: 2000, hostOpenMs: 600,
    revealMs: 900, revealDoubledExtraMs: 400, resetMs: 1000
  };

  var DEFAULT_RATINGS = [
    { min: 0, max: 99, title: '被旁白 PUA' },
    { min: 100, max: 199, title: '普通赌徒' },
    { min: 200, max: 299, title: '欧皇候选' },
    { min: 300, max: Infinity, title: '反杀旁白' }
  ];

  /* ---------------- 商店兜底表（data/shop.json 未就绪时也能跑；数值同设计契约 §2.2） */

  var DEFAULT_ECONOMY = { switchCost: 15, shopOpenStates: ['DECIDE', 'SETTLE_ROUND'], spentStat: true };

  var SHOP_FALLBACK = [
    { id: 'switch_ticket', name: '换门券', price: 25, cap: 3, kind: 'bag', icon: 'ticket', desc: '换门时自动消耗，省下 15 金币。' },
    { id: 'mute_card', name: '闭嘴卡', price: 20, cap: 2, kind: 'bag', icon: 'mute', desc: '用掉它，本轮旁白闭嘴——但它也听不见你质疑。' },
    { id: 'double_coins', name: '双倍金币', price: 40, cap: 2, kind: 'bag', icon: 'double', desc: '本轮收益与代价一起翻倍。' },
    { id: 'fuse', name: '保险丝', price: 35, cap: 2, kind: 'bag', icon: 'fuse', desc: '本轮第一次负面结算直接归零。' },
    { id: 'mystery_box', name: '神秘盒', price: 15, cap: 3, kind: 'instant', icon: 'box', desc: '当场开，开到什么全看这一局的手气。' },
    { id: 'patience_charm', name: '续命符', price: 60, cap: 2, kind: 'instant', icon: 'charm', desc: '立刻回 1 点耐心，最多攒到 5。' }
  ];

  /* ---------------- 契约 v6：难度 / 升级 / 剧情（data/*.json 未就绪时的兜底，数据层就绪后以数据为准） */

  var DIFFICULTY_IDS = ['normal', 'hard', 'hell'];

  var DIFFICULTY_NAMES = { normal: '普通', hard: '困难', hell: '地狱' };

  /** 契约 §2.4 难度表兜底：lieBase / 耐心 / 金币 / 怀疑值 / 奖励倍率。 */
  var DEFAULT_DIFFICULTY = {
    normal: { id: 'normal', name: '普通', lieBase: 0.35, patience: 3, coins: 100, suspicion: 2, reward: 1, desc: '旁白只是随口一说。' },
    hard: { id: 'hard', name: '困难', lieBase: 0.5, patience: 2, coins: 80, suspicion: 1, reward: 1.5, desc: '旁白开始认真骗你。' },
    hell: { id: 'hell', name: '地狱', lieBase: 0.65, patience: 1, coins: 60, suspicion: 0, reward: 2, desc: '一次错信，就是死。' }
  };

  /** 契约 §2.4 升级表兜底（data/upgrades.json 就绪后以数据为准）。 */
  var DEFAULT_UPGRADES = [
    { id: 'starting_coins', name: '私房钱', desc: '每级开局多 50 金币。', cost: 60, maxLevel: 5, effect: { type: 'starting_coins', value: 50 } },
    { id: 'starting_suspicion', name: '多疑症', desc: '每级开局多 1 点怀疑值。', cost: 80, maxLevel: 3, effect: { type: 'starting_suspicion', value: 1 } },
    { id: 'starting_patience', name: '硬命', desc: '每级开局多 1 点耐心。', cost: 100, maxLevel: 3, effect: { type: 'starting_patience', value: 1 } },
    { id: 'shop_discount', name: '熟客折扣', desc: '每级商店与换门费用 −10%。', cost: 120, maxLevel: 3, effect: { type: 'shop_discount', value: 0.1 } },
    { id: 'peek_plus', name: '第六感', desc: '每级每轮多 1 次免费窥视。', cost: 70, maxLevel: 3, effect: { type: 'peek_plus', value: 1 } },
    { id: 'death_insurance', name: '死亡保险', desc: '每局一次：耐心归零时改为金币清零并继续。', cost: 200, maxLevel: 1, effect: { type: 'death_insurance', value: 1 } }
  ];

  /** 契约 §2.5 首页剧情兜底（data/config.json.story 缺失时用）。 */
  var DEFAULT_STORY = [
    '你在急诊室醒来，账单压在枕头下面。有人俯身过来，声音很轻：三扇门，一门财富，两门空。选对了，你带着钱离开。',
    '可门边还站着一位旁白。它说的每一句话，都可能是谎——质疑它要付代价，信错它会要命。',
    '门已经开了。撑过去，或者死在这里。'
  ];

  /* ------------------------------------------------------------ 依赖与工具 */

  function fallbackTimeout(fn) { fn(); return 0; }

  function defaultDeps() {
    return {
      ui: root.UI || null,
      data: root.GameData || null,
      applyEffect: root.applyEffect || null,
      narrator: root.Narrator || null,
      store: root.CodexStore || null,
      setTimeout: (typeof root.setTimeout === 'function') ? root.setTimeout.bind(root) : fallbackTimeout,
      clearTimeout: (typeof root.clearTimeout === 'function') ? root.clearTimeout.bind(root) : function () {},
      now: function () { return Date.now(); }
    };
  }

  /** 无头（Node / 测试）用的空实现 UI：每个动画立刻 resolve。 */
  function noopUI() {
    var done = function () { return Promise.resolve(); };
    return {
      init: function () {}, render: function () {}, flash: function () {},
      toast: function () {}, banner: function () {}, openModal: function () {},
      closeModal: function () {}, skip: function () {}, setControls: function () {},
      playNarratorLine: done, playHostOpen: done, playReveal: done
    };
  }

  function config() { return (Game.deps && Game.deps.data && Game.deps.data.config) || {}; }
  function items() { return (Game.deps && Game.deps.data && Game.deps.data.items) || {}; }
  function timings() {
    var t = config().timings || {};
    var out = {};
    for (var k in DEFAULT_TIMINGS) if (Object.prototype.hasOwnProperty.call(DEFAULT_TIMINGS, k)) out[k] = t[k];
    return out;
  }
  function itemOf(id) { return items()[id] || null; }
  function kindOf(id) {
    var it = itemOf(id);
    if (it && it.kind) return it.kind;
    if (id === 'big_prize' || id === 'small_prize') return 'prize';
    if (id === 'empty') return 'no-prize';
    return 'hazard';
  }
  function isTopPrize(id) { return id === 'big_prize'; }
  function isNoPrize(id) { return kindOf(id) === 'no-prize'; }

  /** 契约 v5：门数夹在 3–6（非法值回落 3）。 */
  function clampDoorCount(n) {
    n = parseInt(n, 10);
    if (!isFinite(n)) return 3;
    return Math.max(3, Math.min(6, n));
  }

  /** 商店表：优先用 GameData.shop，缺数据时退化到兜底表（保证零构建下永不空窗）。 */
  function shopTable() {
    var list = Game.deps && Game.deps.data && Game.deps.data.shop;
    return (Array.isArray(list) && list.length) ? list : SHOP_FALLBACK;
  }
  function shopDef(id) {
    var list = shopTable();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }
  function economy() {
    var e = config().economy;
    return (e && typeof e === 'object') ? e : DEFAULT_ECONOMY;
  }
  /**
   * 单局限购数：数据层用 cap:null + unlimited:true 表示「不限购」（神秘盒）。
   * 返回 Infinity 表示不限购，非法值退化到 3（保险丝表兜底）。
   */
  function shopCap(def) {
    if (!def) return 3;
    if (def.unlimited === true || def.cap == null) return Infinity;
    var c = Number(def.cap);
    return isFinite(c) && c >= 0 ? c : 3;
  }
  /** 是否为「购买即结算」的即时商品（数据层 kind:'instant' 或派生 immediate:true）。 */
  function shopInstant(def) { return !!def && (def.kind === 'instant' || def.immediate === true); }
  /** 续命符的耐心天花板（与单局限购 cap 解耦）：数据层 patienceCap，缺省 5。 */
  function patienceCapOf(def) {
    var c = def && Number(def.patienceCap);
    return isFinite(c) && c > 0 ? c : 5;
  }

  /* ------------------------------------------- 契约 v4：人格 / 成就 / 统计 / 种子 */

  var PERSONA_IDS = ['sarcastic', 'gentle', 'crazy'];

  var DEFAULT_PERSONAS = [
    { id: 'sarcastic', name: '毒舌旁白', icon: '😏', desc: '阴阳怪气，句句带刺。', lieRateDelta: 0 },
    { id: 'gentle', name: '温柔旁白', icon: '🙂', desc: '轻声细语，但也不一定靠谱。', lieRateDelta: -0.05 },
    { id: 'crazy', name: '癫狂旁白', icon: '🤪', desc: '神经兮兮，语速都比别人快。', lieRateDelta: 0.05 }
  ];

  var DEFAULT_ACHIEVEMENTS = [
    { id: 'first_cashout', name: '见好就收', icon: '💰', desc: '第一次主动收手，把钱装进口袋就走。', check: { type: 'cashouts', threshold: 1 } },
    { id: 'rounds5', name: '五关斩将', icon: '🖐️', desc: '一局活到第 5 轮还没倒下。', check: { type: 'rounds', threshold: 5 } },
    { id: 'coins300', name: '三百门客', icon: '🪙', desc: '单局金币达到 300。', check: { type: 'coins', threshold: 300 } },
    { id: 'combo3', name: '三连问', icon: '🔥', desc: '连续 3 次质疑成功。', check: { type: 'challengeWins', threshold: 3 } },
    { id: 'codex24', name: '全知者', icon: '📖', desc: '解锁 24 句旁白语录。', check: { type: 'codexLines', threshold: 24 } },
    { id: 'endings4', name: '剧作人', icon: '🎭', desc: '解锁 4 个结局。', check: { type: 'endings', threshold: 4 } },
    { id: 'all_in', name: '梭哈', icon: '🎲', desc: '同一局里加倍 3 次。', check: { type: 'doubles', threshold: 3 } },
    { id: 'comeback', name: '绝地反击', icon: '📈', desc: '金币探到 20 以下后回到 200。', check: { type: 'comeback', threshold: 200 } },
    { id: 'clean_run', name: '火眼金睛', icon: '✅', desc: '闯到第 5 轮且从未质疑失败。', check: { type: 'clean', threshold: 1 } },
    { id: 'persona3', name: '千人千面', icon: '🎭', desc: '体验过三种旁白人格。', check: { type: 'personas', threshold: 3 } }
  ];

  /**
   * 成就判定器：既支持契约 v4 §3.2 的旧名（cashout/combo/all_in/...），
   * 也支持数据层实际使用的 type（cashouts/challengeWins/doubles/...），
   * 未知类型一律视为不满足（不抛错）。
   */
  var ACH_CHECK = {
    /* 收手类 */
    cashout: function (s) { return !!(s && s.ending); },
    cashouts: function (s, th) { return !!(s && s.ending) || ((Game.stats() || {}).games || 0) >= (th || 1); },
    /* 轮次 */
    rounds: function (s, th) { return (s.round || 0) >= (th || 1); },
    /* 金币 */
    coins: function (s, th) { return (s.coins || 0) >= (th || 1); },
    /* 质疑连击 */
    combo: function (s, th) { return (s.challengeStreak || 0) >= (th || 1); },
    challengeWins: function (s, th) { return (s.challengesWon || 0) >= (th || 1); },
    /* 图鉴 */
    codex: function (s, th) { return ((s.codex && s.codex.lines) || []).length >= (th || 1); },
    codexLines: function (s, th) { return ((s.codex && s.codex.lines) || []).length >= (th || 1); },
    endings: function (s, th) { return ((s.codex && s.codex.endings) || []).length >= (th || 1); },
    /* 加倍 */
    all_in: function (s) { return !!(s && s.allInWin); },
    doubles: function (s, th) { return (s.doublesUsed || 0) >= (th || 1); },
    /* 翻盘 */
    comeback: function (s, th) { return (s.minCoins != null) && s.minCoins <= 20 && (s.coins || 0) >= (th || 200); },
    /* 零失误 */
    clean_run: function (s) { return (s.round || 0) >= 5 && !(s.challengesLost > 0); },
    clean: function (s, th) { return (s.round || 0) >= 5 && !(s.challengesLost > 0); },
    /* 人格 */
    persona: function (s, th) { return (Game.personaSeen() || []).length >= (th || 1); },
    personas: function (s, th) { return (Game.personaSeen() || []).length >= (th || 1); }
  };

  /** 人格表：优先 GameData.personas（数组或按 id 映射），否则兜底。 */
  function personaTable() {
    var list = Game.deps && Game.deps.data && Game.deps.data.personas;
    if (Array.isArray(list) && list.length) return list;
    var byId = Game.deps && Game.deps.data && Game.deps.data.personasById;
    if (byId && typeof byId === 'object') {
      var out = [];
      for (var k in byId) if (Object.prototype.hasOwnProperty.call(byId, k)) out.push(byId[k]);
      if (out.length) return out;
    }
    return DEFAULT_PERSONAS;
  }
  function personaOf(id) {
    var list = personaTable();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }
  function achievementTable() {
    var list = Game.deps && Game.deps.data && Game.deps.data.achievements;
    return (Array.isArray(list) && list.length) ? list : DEFAULT_ACHIEVEMENTS;
  }
  function achievementById(id) {
    var list = achievementTable();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  /** 偏好设置（本机持久，静默降级）。 */
  var PREFS_DEFAULT = {
    onboarded: false, muted: false, persona: 'sarcastic',
    animationSpeed: 'full', bgm: true, sound: true,
    difficulty: 'normal'
  };
  function prefsOf() {
    var store = Game._store && Game._store();
    if (store && typeof store.loadPrefs === 'function') {
      try {
        var p = store.loadPrefs();
        if (p) return Object.assign({}, PREFS_DEFAULT, p);
      } catch (e) { /* 静默 */ }
    }
    return Object.assign({}, PREFS_DEFAULT);
  }
  /** 必选流程弹层是否开着（信息弹层不得覆盖它，否则关掉就卡住）。 */
  function blockingModalOpen() {
    var s = Game.state;
    if (!s) return false;
    return s.phase === STATES.SETTLE_ROUND || s.phase === STATES.CASHOUT || s.phase === STATES.GAME_OVER;
  }
  function writePrefs(p) {
    var store = Game._store && Game._store();
    if (store && typeof store.savePrefs === 'function') {
      try { store.savePrefs(p); return true; } catch (e) { return false; }
    }
    return false;
  }

  /** 契约 v4 §6：?seed=xxx（十六进制或十进制）优先于演示剧本与提词器。
   *  注意：只解析 URL，不把 opts.seed 缓存成重放种子——opts.seed 只对本次 init 生效，
   *  否则一次普通模式的可控种子测试会把后续所有演示开局都拽出剧本（G2.x 回归）。 */
  function seedFromUrl(opts, deps) {
    var loc = (deps && deps.location) || root.location || {};
    var q = String(loc.search || '');
    var h = String(loc.hash || '');
    var m = /[?&]seed=([0-9a-zA-Z]{1,12})/.exec(q) || /^#seed=([0-9a-zA-Z]{1,12})/.exec(h);
    if (!m) return null;
    var raw = m[1];
    var v = /^\d+$/.test(raw) ? parseInt(raw, 10) : parseInt(raw, 16);
    return isFinite(v) ? (v >>> 0) : null;
  }

  /** 种子标签（8 位十六进制，用于展示 / 分享 / 重放）。 */
  function seedTagOf(seed) {
    var n = (seed >>> 0).toString(16);
    while (n.length < 8) n = '0' + n;
    return n;
  }

  /** 当前页面的种子分享链接。 */
  function seedUrlOf(tag) {
    var loc = (Game.deps && Game.deps.location) || root.location || {};
    var base = String(loc.href || 'index.html');
    base = base.split('#')[0].split('?')[0];
    return base + '?seed=' + tag;
  }

  /* ---------------------------------------- 契约 v6：难度 / 升级 / 钱包 / 换门 工具 */

  function numOr(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  /** 可用的存档后端（deps.store 优先，其次全局 CodexStore）。 */
  function storeRef() {
    var st = null;
    try {
      if (Game && typeof Game._store === 'function') st = Game._store();
    } catch (e) { /* 静默 */ }
    /* deps.store 必须是 CodexStore 形状；原样传 localStorage 时退回全局 CodexStore
       （它内部已包住同一个 localStorage，写入的键完全一致）。 */
    if (st && typeof st.loadWallet === 'function' && typeof st.saveWallet === 'function') return st;
    return root.CodexStore || st || null;
  }

  /**
   * 难度表：data/config.json 的 difficulty（对象 {normal,hard,hell} 或数组 [{id,...}]）优先；
   * 字段名兼容 coins/startingCoins、suspicion/startingSuspicion、patience/startingPatience、
   * reward/rewardMul。缺失的档位退回契约 §2.4 的内置值（normal 用 config.initial 兜底）。
   */
  function difficultyTable() {
    var cfg = config();
    var init = cfg.initial || root.DEFAULT_RESOURCES || {};
    var out = {
      normal: Object.assign({}, DEFAULT_DIFFICULTY.normal, {
        coins: numOr(init.coins, DEFAULT_DIFFICULTY.normal.coins),
        suspicion: numOr(init.suspicion, DEFAULT_DIFFICULTY.normal.suspicion),
        patience: numOr(init.patience, DEFAULT_DIFFICULTY.normal.patience)
      }),
      hard: Object.assign({}, DEFAULT_DIFFICULTY.hard),
      hell: Object.assign({}, DEFAULT_DIFFICULTY.hell)
    };
    var raw = cfg.difficulty;
    var apply = function (def) {
      if (!def || typeof def !== 'object') return;
      var id = def.id;
      if (DIFFICULTY_IDS.indexOf(id) < 0) return;
      var base = out[id];
      if (def.name != null) base.name = String(def.name);
      if (def.desc != null) base.desc = String(def.desc);
      base.lieBase = numOr(def.lieBase != null ? def.lieBase : def.lie, base.lieBase);
      /* 数据层可能把初始值放在 def.initial / def.resources 里（契约 v6 data/config.json.difficulty.tiers）。 */
      var nest = (def.initial && typeof def.initial === 'object') ? def.initial
        : ((def.resources && typeof def.resources === 'object') ? def.resources : null);
      var pickNum = function (a, b, c, fallback) {
        if (a != null) return numOr(a, fallback);
        if (b != null) return numOr(b, fallback);
        if (c != null) return numOr(c, fallback);
        return fallback;
      };
      base.coins = pickNum(def.coins, def.startingCoins, nest ? nest.coins : null, base.coins);
      base.suspicion = pickNum(def.suspicion, def.startingSuspicion, nest ? nest.suspicion : null, base.suspicion);
      base.patience = pickNum(def.patience, def.startingPatience, nest ? nest.patience : null, base.patience);
      base.reward = pickNum(def.reward, def.rewardMul, def.rewardMultiplier != null ? def.rewardMultiplier : def.multiplier, base.reward);
    };
    var i;
    var src = raw;
    /* 新数据形状：{ default, order, tiers:{ normal:{...}, ... } } */
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.tiers && typeof raw.tiers === 'object') src = raw.tiers;
    if (Array.isArray(src)) {
      for (i = 0; i < src.length; i++) apply(src[i]);
    } else if (src && typeof src === 'object') {
      for (i = 0; i < DIFFICULTY_IDS.length; i++) {
        var one = src[DIFFICULTY_IDS[i]];
        if (one && typeof one === 'object') {
          if (one.id == null) one = Object.assign({ id: DIFFICULTY_IDS[i] }, one);
          apply(one);
        }
      }
    }
    return out;
  }

  /** 单档难度的规范化视图。 */
  function difficultyDef(id) {
    var table = difficultyTable();
    var key = DIFFICULTY_IDS.indexOf(id) >= 0 ? id : 'normal';
    var d = table[key] || DEFAULT_DIFFICULTY[key];
    return {
      id: key,
      name: d.name || DIFFICULTY_NAMES[key] || key,
      desc: d.desc || '',
      lieBase: numOr(d.lieBase, DEFAULT_DIFFICULTY[key].lieBase),
      coins: Math.max(0, Math.round(numOr(d.coins, DEFAULT_DIFFICULTY[key].coins))),
      suspicion: Math.max(0, Math.round(numOr(d.suspicion, DEFAULT_DIFFICULTY[key].suspicion))),
      patience: Math.max(0, Math.round(numOr(d.patience, DEFAULT_DIFFICULTY[key].patience))),
      reward: numOr(d.reward, DEFAULT_DIFFICULTY[key].reward)
    };
  }

  /** 当前难度 id（偏好设置是本机持久来源）。 */
  function currentDifficultyId() {
    var prefs = prefsOf();
    if (DIFFICULTY_IDS.indexOf(prefs.difficulty) >= 0) return prefs.difficulty;
    var s = Game.state;
    if (s && DIFFICULTY_IDS.indexOf(s.difficulty) >= 0) return s.difficulty;
    /* 数据层 config.difficulty.default（契约 v6 §2.4）。 */
    var raw = config().difficulty;
    if (raw && typeof raw === 'object') {
      var def = raw.default != null ? raw.default : raw.Default;
      if (DIFFICULTY_IDS.indexOf(def) >= 0) return def;
    }
    return 'normal';
  }

  /** 升级表：GameData.upgrades / config.upgrades 优先，缺失退回内置 6 条。 */
  function upgradeTable() {
    var data = Game.deps && Game.deps.data;
    var cfg = config();
    var list = null;
    if (data) {
      if (Array.isArray(data.upgrades)) list = data.upgrades;
      else if (Array.isArray(data.upgradeList)) list = data.upgradeList;
      else if (data.upgrades && Array.isArray(data.upgrades.items)) list = data.upgrades.items;
    }
    if ((!list || !list.length) && cfg) {
      if (Array.isArray(cfg.upgrades)) list = cfg.upgrades;
      else if (cfg.upgrades && Array.isArray(cfg.upgrades.items)) list = cfg.upgrades.items;
    }
    if (!list || !list.length) list = DEFAULT_UPGRADES;
    return list.filter(function (u) { return u && typeof u.id === 'string'; });
  }

  function upgradeDef(id) {
    var list = upgradeTable();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function upgradeMaxLevel(u) {
    var m = Math.round(numOr(u && u.maxLevel, 1));
    return m < 1 ? 1 : m;
  }

  /** 升级价格：数据层给 costs 数组则按级取，否则 cost 固定（缺失时 0 级免费，不建议）。 */
  function upgradeCostOf(u, level) {
    if (!u) return 0;
    var lv = Math.max(0, Math.round(numOr(level, 0)));
    if (Array.isArray(u.costs) && u.costs.length) {
      var c = numOr(u.costs[Math.min(lv, u.costs.length - 1)], NaN);
      if (isFinite(c)) return Math.max(0, Math.round(c));
    }
    return Math.max(0, Math.round(numOr(u.cost != null ? u.cost : u.price, 0)));
  }

  /**
   * 数据层 effect.stat → 引擎内部 type 的别名表。
   * （data/upgrades.json：{ stat:'coins', perLevel:50, unit:'coins', delta:{coins:50} }）
   */
  var EFFECT_TYPE_ALIAS = {
    coins: 'starting_coins', startingCoins: 'starting_coins', starting_coins: 'starting_coins', startCoins: 'starting_coins',
    suspicion: 'starting_suspicion', startingSuspicion: 'starting_suspicion', starting_suspicion: 'starting_suspicion',
    patience: 'starting_patience', startingPatience: 'starting_patience', starting_patience: 'starting_patience',
    shopDiscount: 'shop_discount', discount: 'shop_discount', shop_discount: 'shop_discount', priceDiscount: 'shop_discount',
    freePeeks: 'peek_plus', freePeek: 'peek_plus', peek: 'peek_plus', peekPlus: 'peek_plus', peek_plus: 'peek_plus',
    deathInsurance: 'death_insurance', revive: 'death_insurance', death_insurance: 'death_insurance', immortal: 'death_insurance'
  };

  /** 升级效果规范化：{ type, value }。兼容 effect 为字符串 / 对象 / 数据层直接给 type+value。 */
  function upgradeEffectOf(u) {
    if (!u) return { type: '', value: 0 };
    var e = u.effect != null ? u.effect : (u.effects != null ? u.effects : u);
    var type = (typeof e === 'string') ? e : (e.type || e.stat || u.type || u.stat || u.id || '');
    type = EFFECT_TYPE_ALIAS[type] || type;
    var value = null;
    if (typeof e === 'object' && e != null) {
      if (e.value != null) value = e.value;
      else if (e.amount != null) value = e.amount;
      else if (e.perLevel != null) value = e.perLevel;
      else if (e.delta && typeof e.delta === 'object') {
        for (var k in e.delta) {
          if (Object.prototype.hasOwnProperty.call(e.delta, k)) {
            var dv = numOr(e.delta[k], NaN);
            if (isFinite(dv)) { value = Math.abs(dv); break; }
          }
        }
      }
    }
    if (value == null) value = u.value != null ? u.value : u.amount;
    value = numOr(value, 0);
    if (type === 'shop_discount' && value > 1) value = value / 100;   // 数据层也可能写 10 表示 −10%
    return { type: type, value: value };
  }

  /** 已购升级等级（白名单过滤 + 上限截断）。 */
  function upgradeLevelsMap() {
    var store = storeRef();
    var raw = {};
    if (store && typeof store.loadUpgrades === 'function') {
      try { raw = store.loadUpgrades() || {}; } catch (e) { raw = {}; }
    }
    var out = {};
    var table = upgradeTable();
    for (var i = 0; i < table.length; i++) {
      var u = table[i];
      var lv = Math.round(numOr(raw[u.id], 0));
      var max = upgradeMaxLevel(u);
      if (lv > max) lv = max;
      if (lv > 0) out[u.id] = lv;
    }
    return out;
  }

  /** 某类升级效果的累计加成值。 */
  function upgradeBonus(type) {
    var levels = upgradeLevelsMap();
    var table = upgradeTable();
    var sum = 0;
    for (var i = 0; i < table.length; i++) {
      var u = table[i];
      var lv = levels[u.id] || 0;
      if (!lv) continue;
      var eff = upgradeEffectOf(u);
      if (eff.type === type) sum += numOr(eff.value, 0) * lv;
    }
    return sum;
  }

  /** 熟客折扣率（0–0.5）。 */
  function shopDiscountRate() {
    var r = upgradeBonus('shop_discount');
    if (r > 0.5) r = 0.5;
    if (r < 0) r = 0;
    return r;
  }

  /** 商店 / 换门价格套用折扣。 */
  function priceAfterDiscount(price) {
    var p = numOr(price, 0);
    var r = shopDiscountRate();
    if (!r) return Math.round(p);
    return Math.max(0, Math.round(p * (1 - r)));
  }

  /** 首页剧情 3 段（data/config.json 的 story；字符串数组或 {paragraphs} 均可）。 */
  function storyLines() {
    var s = config().story;
    var list = null;
    if (Array.isArray(s)) list = s;
    else if (s && Array.isArray(s.paragraphs)) list = s.paragraphs;
    else if (s && Array.isArray(s.lines)) list = s.lines;
    if (!list || !list.length) return DEFAULT_STORY.slice();
    return list.filter(function (p) { return typeof p === 'string' && p.length; });
  }

  /** HTML 转义（剧情文案要拼进 innerHTML）。 */
  function htmlEscape(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 契约 §2.5：首页剧情 3 段用 <p> 拼接（字符串数组或段落对象都可）。 */
  function storyHtml() {
    var lines = storyLines();
    if (!lines.length) return '';
    return lines.map(function (line) { return '<p>' + htmlEscape(line) + '</p>'; }).join('');
  }

  /** 物品展示名（缺数据时退回 id）。 */
  function itemLabelOf(id) {
    var it = null;
    try { it = itemOf(id); } catch (e) { it = null; }
    return (it && it.name) ? it.name : String(id == null ? '' : id);
  }

  /**
   * 契约 v6 §2.2：把驳回线索（claim）翻成人话提示。
   * claim 形如 { type:'slot_kind'|'picked_kind'|'big_prize_in', slot?, kind?, truthful }。
   */
  function claimHintText(claim) {
    if (!claim || typeof claim !== 'object') return '';
    var kindName = itemLabelOf(claim.kind);
    var slotNo = (claim.slot != null) ? (claim.slot + 1) : null;
    var tail = claim.truthful ? '这句是真话。' : '这句是假的。';
    if (claim.type === 'picked_kind') {
      return '旁白说你选的那扇门是「' + kindName + '」——' + tail;
    }
    if (claim.type === 'big_prize_in') {
      return '旁白说大奖在 ' + (slotNo != null ? slotNo + ' 号门' : '某扇门') + '——' + tail;
    }
    if (slotNo != null && claim.kind != null) {
      return '旁白说 ' + slotNo + ' 号门是「' + kindName + '」——' + tail;
    }
    return '';
  }

  /**
   * 契约 v6 §2.4：本局开局资源 = 难度初值 + 升级加成（叠加，不替换）。
   * @returns {{coins:number, suspicion:number, patience:number, rewardMul:number,
   *            peekFree:number, discount:number, insurance:boolean}}
   */
  function resourcePlan(diffId) {
    var d = difficultyDef(diffId);
    var plan = {
      coins: d.coins, suspicion: d.suspicion, patience: d.patience,
      rewardMul: d.reward, peekFree: 0, discount: 0, insurance: false,
      difficulty: d.id, lieBase: d.lieBase
    };
    var levels = upgradeLevelsMap();
    var table = upgradeTable();
    for (var i = 0; i < table.length; i++) {
      var u = table[i];
      var lv = levels[u.id] || 0;
      if (!lv) continue;
      var eff = upgradeEffectOf(u);
      var v = numOr(eff.value, 0);
      if (eff.type === 'starting_coins') plan.coins += v * lv;
      else if (eff.type === 'starting_suspicion') plan.suspicion += v * lv;
      else if (eff.type === 'starting_patience') plan.patience += v * lv;
      else if (eff.type === 'peek_plus') plan.peekFree += v * lv;
      else if (eff.type === 'shop_discount') plan.discount += (v > 1 ? v / 100 : v) * lv;
      else if (eff.type === 'death_insurance') plan.insurance = true;
    }
    if (plan.discount > 0.5) plan.discount = 0.5;
    if (plan.discount < 0) plan.discount = 0;
    plan.coins = Math.max(0, Math.round(plan.coins));
    plan.suspicion = Math.max(0, Math.round(plan.suspicion));
    plan.patience = Math.max(0, Math.round(plan.patience));
    plan.peekFree = Math.max(0, Math.round(plan.peekFree));
    return plan;
  }

  /* -------------------------------------------------------------- Game 本体 */

  var Game = {
    state: null,
    deps: null,
    _emitter: null,
    _timers: [],
    _generation: 0,
    _endingModal: null,   // 结算页弹层 spec，供「看图鉴 → 关闭」后返回

    /** 初始化：解析依赖、建立初始状态、绑定 UI。 */
    init: function (opts) {
      opts = opts || {};
      Game.deps = Object.assign(defaultDeps(), opts.deps || {});
      Game._emitter = new root.Emitter();
      Game._timers = [];
      Game._generation = 0;
      rehearsalPref = rehearsalFromUrl(opts, Game.deps);
      seedPref = seedFromUrl(opts, Game.deps);
      forceDoorCount = doorsFromUrl(opts, Game.deps);
      Game.state = Game._freshState(opts.mode || MODES.DEMO, opts.seed);
      var ui = Game._ui();
      if (ui.init) { try { ui.init(Game); } catch (e) { Game._warn('ui.init', e); } }
      Game._render();
      return Game;
    },

    /** 订阅状态变化（UI 也可用，但主要给测试/调试）。 */
    subscribe: function (fn) { return Game._emitter.on(fn); },

    /** 当前状态深拷贝（用于结算页 / 断言 / 复盘）。 */
    snapshot: function () { return cloneState(Game.state); },

    /** 开局（IDLE/结算页 → 第 1 轮）。 */
    start: function (mode) {
      var m = (mode === MODES.NORMAL) ? MODES.NORMAL : MODES.DEMO;
      Game._clearTimers();
      Game._generation++;
      Game.state = Game._freshState(m);
      Game._endingModal = null;
      Game._render();
      Game.beginRound();
      return Game.state;
    },

    /** 一键重置：1 秒内回到演示起点（对应清单阶段 4 P1「全局控制」）。 */
    reset: function () {
      var gen = ++Game._generation;
      Game._clearTimers();
      Game.state = Game._freshState(MODES.DEMO);
      Game._endingModal = null;
      Game._render();
      var self = this;
      var wait = timings().resetMs;
      Game._wait(wait).then(function () {
        if (gen !== Game._generation) return;
        Game.beginRound();
      });
      return Game.state;
    },

    /* ------------------------------------------------------------ 状态切换 */

    /** 唯一的状态切换入口。 */
    setState: function (next) {
      if (!Object.prototype.hasOwnProperty.call(STATES, next)) {
        Game._warn('未知状态', next);
        return false;
      }
      var cur = Game.state.phase;
      if (next !== cur) {
        var allowed = ALLOWED[cur] || [];
        if (allowed.indexOf(next) < 0) {
          Game._warn('非法状态切换 ' + cur + ' -> ' + next);
          return false;
        }
      }
      Game.state.phase = next;
      if (typeof root.document !== 'undefined' && root.document.body) {
        root.document.body.setAttribute('data-state', next);
      }
      Game._render();
      Game._emitter.emit({ type: 'state', from: cur, to: next, state: Game.state });
      return true;
    },

    /* ---------------------------------------------------------- 玩家动作表 */

    /**
     * 统一动作入口：UI 只调 Game.action({type, ...})，不直接改 state。
     * type ∈ start | pick | peek | decide | skip_line | settle | modal_choice |
     *        reset | toggle_demo | toggle_mute | skip_anim | shop | use_item
     */
    action: function (type, payload) {
      if (type && typeof type === 'object') { payload = type; type = payload.type; }
      payload = payload || {};
      var s = Game.state;
      switch (type) {
        case 'start': return Game.start(payload.mode);
        case 'reset': return Game.reset();
        case 'toggle_demo': return Game._toggleMode();
        case 'toggle_mute': return Game._toggleMute();
        case 'skip_anim': return Game._skipAnim();
        case 'skip_line': return Game._skipLine();

        case 'pick':
          if (s.phase !== STATES.PICK) return false;
          return Game.chooseDoor(payload.slot);

        case 'peek':
          if (s.phase !== STATES.PICK) return false;
          return Game.peek(payload.slot);

        case 'decide':
          if (s.phase !== STATES.DECIDE) return false;
          return Game.decide(payload.choice);

        case 'settle':
        case 'modal_choice':
          return Game.modalChoice(payload.choice);

        case 'shop':
          return Game.openShop();

        case 'use_item':
          return Game.useItem(payload.id).ok;

        /* ---- 契约 v4：体验增强 ---- */
        case 'set_personality':
          return Game.setPersonality(payload.id || payload.persona);

        case 'set_pref':
          return !!Game.savePref(payload.key, payload.value);

        /* 兼容契约 §2.3 的 apply_speed{value}：映射到偏好 animationSpeed。 */
        case 'apply_speed':
          return !!Game.savePref('animationSpeed', payload.value);

        case 'save_seed':
          return Game.saveSeed();

        case 'tutorial_done':
          Game.savePref('onboarded', true);
          if (Game.state) Game.state.flags.onboarded = true;
          return true;

        case 'tutorial_skip':
          Game.savePref('onboarded', true);
          if (Game.state) Game.state.flags.onboarded = true;
          Game._toast('已跳过新手引导，随时按 ? 看规则。');
          return true;

        case 'open_help':
          return Game.openHelp();

        case 'open_settings':
          return Game.openSettings();

        case 'clear_save':
          return Game.clearSave();

        /* ---- 契约 v6：首页 / 难度 / 升级 / 换门 ---- */
        case 'set_difficulty':
          return Game.setDifficulty(payload.id || payload.difficulty || payload.value);

        case 'buy_upgrade':
          return Game.buyUpgrade(payload.id).ok;

        case 'upgrade_shop':
        case 'open_upgrade':
          return Game.openUpgrade();

        case 'home':
        case 'home_start':
          return Game.home();

        /* 契约 §2.3：换门 = 弹「重新选门」，不自动换。 */
        case 'switch':
          return Game.beginSwitch();

        case 'choose_switch':
          return Game.chooseSwitch(payload.slot);

        case 'cancel_switch':
          return Game.cancelSwitch();

        default:
          Game._warn('未知动作', type);
          return false;
      }
    },

    /* ------------------------------------------------------------ 单轮流程 */

    /** 进入本轮：发牌 → 轮次横幅 → 旁白。 */
    beginRound: function () {
      var s = Game.state;
      s.roundResult = null;
      s.pickedSlot = null;
      s.hostOpenedSlot = null;
      s.doubled = false;
      s.peekUsed = false;
      s.challengedThisRound = false;
      s.hostScriptFallback = false;
      s.narratorLines = [];
      s.lastChallenge = null;
      s.lastHint = null;                 // 契约 v6 §2.2：提示随轮次清空
      s.switchedThisRound = false;       // 契约 v6 §2.3：每轮最多换一次门
      s.flags.switchPick = false;        // 契约 v6 §2.3：换门选门子流程复位
      s.flags.revealLocked = false;
      s.itemBuffs = { fuse: false };   // 道具增益只在「使用的这一轮」有效
      /* 闭嘴卡不在这里重置：它在 DECIDE 里使用，沉默的是**下一轮**的旁白
         （本轮旁白早已念完），由 narrate() 消费后自动清空。 */
      s.doorCount = Game.doorCountFor(s.round);   // 契约 v5：先定门数，再发牌
      s.doors = Game.generateDoors(s.round);
      Game.setState(STATES.ROUND_INTRO);

      var ui = Game._ui();
      if (ui.banner) Game._safe(function () { ui.banner(Game.roundHint(s.round), timings().introMs); });

      var gen = Game._generation;
      Game._wait(timings().introMs).then(function () {
        if (gen !== Game._generation) return;
        if (Game.state.phase !== STATES.ROUND_INTRO) return;
        Game.narrate();
      });
      return s;
    },

    /** 本轮风险提示。 */
    roundHint: function (round) {
      var hints = config().roundHints;
      if (hints && hints[round]) return hints[round];
      return ROUND_HINTS[round] || ('第 ' + round + ' 轮：旁白已经不装了，自己看着办。');
    },

    /** 旁白阶段：逐句播放 2 句，可点「跳过本句」。 */
    narrate: function () {
      var s = Game.state;
      var narrator = Game.deps.narrator;
      /* 闭嘴卡：本轮旁白一句话都不说（防剧透）；
         代价是这一轮也没有「旁白的话」可供质疑——见 challenge() 里的同一处判定。 */
      if (s.muteCardUsed) {
        s.narratorLines = [];
        s.muteCardUsed = false;        // 一次生效一轮，消费掉
        Game._toast('闭嘴卡生效：这一轮旁白一句话都不说。');
        Game.setState(STATES.PICK);
        return;
      }
      if (!narrator || typeof narrator.pickRoundLines !== 'function') {
        Game.setState(STATES.PICK);
        return;
      }
      s.narratorLines = narrator.pickRoundLines(s, Game.script()) || [];
      /* 旁白记录（可回看）：本局每一句都留档 —— 玩家错过一句也能在「旁白记录」里补看。 */
      s.narratorLog = (s.narratorLog || []).concat(s.narratorLines.map(function (ln) {
        return { round: s.round, text: (ln && ln.text) || ln || '' };
      }));
      Game.setState(STATES.NARRATOR);

      var gen = Game._generation;
      var i = 0;
      var step = function () {
        if (gen !== Game._generation) return;
        if (Game.state.phase !== STATES.NARRATOR) return;
        if (i >= s.narratorLines.length) { Game.setState(STATES.PICK); return; }
        var line = s.narratorLines[i];
        i++;
        Game._unlockLine(line);
        Game._play('playNarratorLine', [line, i - 1]).then(step);
      };
      step();
    },

    /** 点门：进入 HOST_OPEN，由主持人打开一扇「非大奖且非玩家所选」的门。 */
    chooseDoor: function (slot) {
      var s = Game.state;
      if (slot == null || slot < 0 || slot >= s.doors.length) return false;
      if (s.doors[slot].opened) return false;
      s.pickedSlot = slot;
      Game.setState(STATES.HOST_OPEN);

      var script = Game.script();
      var hostSlot = (script && script.hostOpensSlot != null) ? script.hostOpensSlot : null;
      /* 剧本门位是「口味」不是「特权」：它同样必须满足主持人的硬不变量——
         不能是玩家所选的门、必须是一扇「空门」（kind==='no-prize'）、且必须是未开的合法槽位。
         否则 R3 玩家点 1 号门时会出现「主持人打开玩家自己那扇门」的穿帮（评审 P0-1），
         或者主持人当众开出一件大奖/炸弹（契约 v6 §2.1）。不合法就退化为真实 hostPick。 */
      if (hostSlot != null && (hostSlot === slot || !s.doors[hostSlot] || s.doors[hostSlot].opened
        || !isNoPrize(s.doors[hostSlot].itemId))) {
        s.hostScriptFallback = true;
        hostSlot = null;
      }
      if (hostSlot == null) hostSlot = Game.hostPick(s.doors, slot);
      s.hostOpenedSlot = hostSlot;
      if (hostSlot != null) s.doors[hostSlot].opened = true;
      Game._render();

      var gen = Game._generation;
      Game._play('playHostOpen', [hostSlot, hostSlot == null ? null : s.doors[hostSlot].itemId])
        .then(function () {
          if (gen !== Game._generation) return;
          if (Game.state.phase !== STATES.HOST_OPEN) return;
          Game.setState(STATES.DECIDE);
        });
      return true;
    },

    /** 长按窥视：每轮 1 次（「第六感」升级每级 +1 次），给一条模糊提示（不改数值、不影响开奖）。 */
    peek: function (slot) {
      var s = Game.state;
      var quota = Game._peekQuota();
      var used = s.peekUsed === true ? 1 : Math.round(numOr(s.peekUsed, 0));
      if (used >= quota) { Game._toast('本轮已经窥视过了。'); return false; }
      if (slot == null || !s.doors[slot] || s.doors[slot].opened) return false;
      s.peekUsed = quota > 1 ? (used + 1) : true;
      s.doors[slot].peeked = true;
      var kind = kindOf(s.doors[slot].itemId);
      var text = kind === 'prize' ? '门缝里透出金光……这扇门里有值钱的东西。'
        : kind === 'no-prize' ? '门后一片漆黑，什么都没有。'
          : '门后有东西在响，不像好东西。';
      Game._toast(text);
      Game._render();
      return true;
    },

    /**
     * 决策：stick / switch / cashout 离开 DECIDE；double / challenge 属于原地强化，留在 DECIDE。
     * （《开工清单》阶段 3「加倍后按钮显示已加倍，不可重复叠加」要求加倍后仍能继续选门，
     *   故这两个动作不迁移状态，其余三个严格遵循状态机表格的「选中其一」。）
     */
    decide: function (choice) {
      var s = Game.state;
      switch (choice) {
        case CHOICES.DOUBLE:
          if (s.doubled) { Game._toast('本轮已经加倍过了。'); return false; }
          s.doubled = true;
          s.doublesUsed = (s.doublesUsed || 0) + 1;
          Game._toast('已加倍：本轮收益与负面效果 ×2');
          Game._render();
          return true;

        case CHOICES.CHALLENGE:
          return Game.challenge();

        case CHOICES.SWITCH:
          /* 契约 v6 §2.3：换门必须先弹出「重新选门」弹层，绝不能自动换门；
             真正换门与开奖交给 chooseSwitch()（玩家选了 slot 之后）。 */
          return Game.beginSwitch();

        case CHOICES.STICK:
          s.switchStreak = 0;
          return Game.reveal();

        case CHOICES.CASHOUT:
          return Game.cashout('decide');

        default:
          Game._warn('未知决策', choice);
          return false;
      }
    },

    /**
     * 换门：在未被主持人打开的门里换到另一扇。
     * 代价（评审：换门此前免费即恒为正收益，券也就成了废纸）：
     *   有换门券 → 消耗 1 张，不花金币；否则要花 economy.switchCost（默认 15）金币；
     *   两者都没有 → 不换门，留在 DECIDE。
     */
    switchDoor: function () {
      var s = Game.state;
      var from = s.pickedSlot;
      var cands = s.doors.filter(function (d) {
        return d.slot !== from && !d.opened && !d.revealed;
      });
      if (!cands.length) return false;
      var cost = Number(economy().switchCost);
      if (!isFinite(cost) || cost < 0) cost = DEFAULT_ECONOMY.switchCost;
      var ticket = Game._itemCount('switch_ticket');
      if (ticket > 0) {
        Game._consumeItem('switch_ticket', 1);
      } else if (s.coins >= cost) {
        Game._apply({ id: 'shop_switch', label: '换门', coins: -cost }, { multiplier: 1, source: 'shop' });
      } else {
        Game._toast('换门需要 ' + cost + ' 金币或一张换门券（现在只有 ' + s.coins + ' 金币）。');
        return false;
      }
      var next = cands[0].slot;
      /* _apply 内部会把 Game.state 换成新对象（clone + 冻结），
         所以这里必须重新取当前 state，否则改写落在旧对象上：钱扣了、横幅说换了门，结算却仍按原门。 */
      var cur = Game.state;
      cur.pickedSlot = next;
      cur.switchStreak = (cur.switchStreak || 0) + 1;
      Game._render();
      Game._toast('换到 ' + (next + 1) + ' 号门' + (ticket > 0 ? '（消耗换门券）' : '（−' + cost + ' 金币）'));
      return true;
    },

    /** 质疑旁白：每轮一次，消耗怀疑值，成功给奖励 / 失败扣金币与耐心；失败让旁白记仇。 */
    challenge: function () {
      var s = Game.state;
      var narrator = Game.deps.narrator;
      var cfg = config().suspicion || {};
      var cost = cfg.cost == null ? 1 : cfg.cost;
      /* 评审 P0-2：质疑原地不迁移状态，且判定固定用本轮第一条旁白（无随机），
         于是同一轮连点就是「每次 +20 且 100% 成功」的送分按钮（演示 R2 实测 130→150→170）。
         限制为每轮一次，并把这次机会算作已用（失败也消耗），让它重新变成资源决策。 */
      if (s.challengedThisRound) {
        Game._toast('同一轮的旁白只会被拆穿一次。');
        return false;
      }
      if (s.muteCardUsed) {
        Game._toast('旁白已经被闭嘴卡按住了，没什么可质疑的。');
        return false;
      }
      if (!narrator || typeof narrator.resolveChallenge !== 'function') {
        Game._toast('旁白不在线，质疑无效。');
        return false;
      }
      if (s.suspicion < cost) {
        Game._toast('怀疑值不足（需要 ' + cost + ' 点）。');
        return false;
      }
      s.challengedThisRound = true;
      var line = s.narratorLines[0] || null;
      var res = narrator.resolveChallenge(s, line) || {};

      /* 契约 v3 §2.1：连击奖励 —— 连续识破给递增金币（20 / 30 / 40 封顶）。 */
      var comboStep = cfg.comboStep == null ? 10 : cfg.comboStep;
      var comboCap = cfg.comboCap == null ? 20 : cfg.comboCap;
      var effect = { id: 'challenge', suspicion: -cost };
      if (res.ok) {
        var streakAfter = (s.challengeStreak || 0) + 1;
        var bonus = Math.min(streakAfter - 1, Math.floor(comboCap / comboStep)) * comboStep;
        var base = res.coins == null ? (cfg.winCoins == null ? 20 : cfg.winCoins) : res.coins;
        effect.coins = base + bonus;
        s.challengeStreak = streakAfter;
        s.challengesWon = (s.challengesWon || 0) + 1;
      } else {
        effect.coins = -(res.coins == null ? (cfg.loseCoins == null ? 20 : cfg.loseCoins) : Math.abs(res.coins));
        effect.patience = res.patience == null ? -(cfg.losePatience == null ? 1 : cfg.losePatience) : -Math.abs(res.patience);
        s.challengeStreak = 0;
        s.challengesLost = (s.challengesLost || 0) + 1;
        s.grudge = (s.grudge || 0) + 1;
      }
      var applied = Game._apply(effect, { source: 'challenge' });
      s = applied.state;
      s.lastChallenge = {
        ok: !!res.ok, text: res.text || '', hint: res.hint || null,
        claim: res.claim || null,             // 契约 v3 §1.3：本轮被验证的线索
        grudgeLevel: s.grudge, delta: applied.delta
      };
      /* 契约 v6 §2.2：质疑之后必须给出提示（无论识破还是猜错）。
         优先用旁白层给的具体线索（res.hint / res.claim），拿不到就兜底一句话。 */
      var claim = res.claim || null;
      var hint = (typeof res.hint === 'string' && res.hint) ? res.hint : claimHintText(claim);
      var truthful = claim ? claim.truthful !== false : !res.ok;
      if (!hint) {
        hint = truthful
          ? '旁白这次说的是真话——信不信由你。'
          : '旁白这次说的是假话——信不信由你。';
      }
      s.lastHint = {
        text: hint,
        truthful: truthful,
        slot: (claim && claim.slot != null) ? claim.slot : null
      };
      Game._render();
      Game._flashAll(applied.delta);
      Game._toast(res.text || (res.ok ? '你抓住了旁白的破绽。' : '旁白笑了：你猜错了。'));

      if (s.patience <= 0 && !Game._deathSave()) { Game.gameOver(); return true; }
      var special = narrator.special ? narrator.special(s, 'challenge') : null;
      if (special) Game._playLine(special);
      return true;
    },

    /* -------------------------------------------------------------- 商店 */

    /** 打开商店（仅 DECIDE / SETTLE_ROUND；商店是弹层遮罩，不是状态机状态）。 */
    openShop: function () {
      var s = Game.state;
      var states = economy().shopOpenStates || DEFAULT_ECONOMY.shopOpenStates;
      if (states.indexOf(s.phase) < 0) {
        Game._toast('商店只在决策阶段开门。');
        return false;
      }
      var spec = Game.shopSpec();
      var ui = Game._ui();
      if (ui.openModal) Game._safe(function () { ui.openModal(spec); });
      Game._emitter.emit({ type: 'shop', state: Game.state, spec: spec });
      return true;
    },

    /** 商店弹层 spec（ui 只渲染，不做业务判断）。 */
    shopSpec: function () {
      var s = Game.state;
      var list = shopTable();
      var items = list.map(function (d) {
        var cap = shopCap(d);
        var instant = shopInstant(d);
        var unlimited = (cap === Infinity);
        var owned = instant ? (((s.shopBought || {})[d.id]) || 0) : Game._itemCount(d.id);
        // 续命符：耐心已到天花板时不给买（否则花 60 金币买一次空操作）
        var patienceFull = instant && d.id === 'patience_charm' && s.patience >= patienceCapOf(d);
        var price = priceAfterDiscount(d.price);   // 契约 v6 §2.4：熟客折扣
        return {
          id: d.id, name: d.name, price: price, basePrice: d.price, desc: d.desc, icon: d.icon || d.id,
          kind: instant ? 'instant' : 'bag', immediate: instant, unlimited: unlimited,
          owned: owned,
          cap: cap === Infinity ? null : cap,     // null = 不限购（神秘盒）
          affordable: s.coins >= price,
          capped: patienceFull || owned >= cap
        };
      });
      return {
        kind: 'shop',
        title: '道具商店',
        body: '金币 ' + s.coins + ' · 花掉的金币不会回来，换来的道具当场生效或进背包。',
        coins: s.coins,
        items: items,
        actions: [{ label: '关闭', choice: 'close' }]
      };
    },

    /**
     * 买一件商品。返回 { ok, reason }；reason ∈ '' | unknown | phase | cap | insufficient。
     * 扣款走 _apply（显式 multiplier:1），避免「加倍」状态下把售价也翻倍。
     */
    buy: function (id) {
      var s = Game.state;
      var def = shopDef(id);
      if (!def) { Game._toast('没有这件商品。'); return { ok: false, reason: 'unknown' }; }
      var states = economy().shopOpenStates || DEFAULT_ECONOMY.shopOpenStates;
      if (states.indexOf(s.phase) < 0) {
        Game._toast('商店只在决策阶段开门。');
        return { ok: false, reason: 'phase' };
      }
      var instant = shopInstant(def);
      var cap = shopCap(def);
      var price = priceAfterDiscount(def.price);   // 契约 v6 §2.4：熟客折扣
      // 背包商品看 items；即时商品（购买即结算、不进背包）看 shopBought 计数，两者都要吃单局限购
      var ownedBought = instant ? (((s.shopBought || {})[id]) || 0) : Game._itemCount(id);
      if (ownedBought >= cap) {
        Game._toast(instant
          ? (def.name + '一局最多买 ' + cap + ' 次。')
          : (def.name + '已经拿满了（最多 ' + cap + ' 个）。'));
        return { ok: false, reason: 'cap' };
      }
      if (instant && id === 'patience_charm' && s.patience >= patienceCapOf(def)) {
        Game._toast('耐心已经满了（最多 ' + patienceCapOf(def) + ' 点），这 ' + price + ' 金币先省着。');
        return { ok: false, reason: 'cap' };
      }
      if (s.coins < price) {
        Game._toast('金币不够：' + def.name + '要 ' + price + '，现在只有 ' + s.coins + '。');
        return { ok: false, reason: 'insufficient' };
      }

      if (instant) {
        /* 即时道具：购买当场结算（同种子可复现；扣款与结算分两步，便于测试与文案拆分）。 */
        var paid = Game._apply({ id: 'shop_buy', label: def.name, coins: -price }, { multiplier: 1, source: 'shop' });
        s = paid.state;
        s.spentCoins = (s.spentCoins || 0) + price;
        s.shopBuys = (s.shopBuys || 0) + 1;
        s.shopBought = s.shopBought || {};
        s.shopBought[id] = ownedBought + 1;
        if (id === 'patience_charm') {
          Game._apply({ id: 'patience_charm', label: def.name, patience: 1 }, { multiplier: 1, source: 'item' });
          Game._toast('续命符：耐心 +1（现在 ' + Game.state.patience + '）。');
        } else {
          Game._apply(id, { multiplier: 1, source: 'item' });
          Game._toast('神秘盒开出来了，自己看 HUD。');
        }
      } else {
        var applied = Game._apply(
          { id: 'shop_buy', label: def.name, coins: -price, items: [{ id: id, count: 1 }] },
          { multiplier: 1, source: 'shop' }
        );
        s = applied.state;
        s.spentCoins = (s.spentCoins || 0) + price;
        s.shopBuys = (s.shopBuys || 0) + 1;
        Game._toast('买到 ' + def.name + '（−' + price + ' 金币），去背包里用。');
      }
      Game._emitter.emit({ type: 'buy', id: id, price: price, state: Game.state });
      Game._render();
      return { ok: true, reason: '' };
    },

    /**
     * 用一件背包道具（仅 DECIDE）。返回 { ok, reason }；reason ∈ '' | empty | phase | noop | unknown。
     * double_coins 复用 decide(DOUBLE) 的既有语义；switch_ticket 只在换门时被动消耗。
     */
    useItem: function (id) {
      var s = Game.state;
      var def = shopDef(id);
      if (!def) return { ok: false, reason: 'unknown' };
      if (Game._itemCount(id) <= 0) return { ok: false, reason: 'empty' };
      if (s.phase !== STATES.DECIDE) return { ok: false, reason: 'phase' };

      if (id === 'switch_ticket') {
        Game._toast('换门券不用点，换门时自动消耗。');
        return { ok: false, reason: 'noop' };
      }
      if (id === 'double_coins') {
        if (s.doubled) { Game._toast('本轮已经加倍了。'); return { ok: false, reason: 'noop' }; }
        Game.decide(CHOICES.DOUBLE);
        Game._consumeItem(id, 1);
        return { ok: true, reason: '' };
      }
      if (id === 'mute_card') {
        s.muteCardUsed = true;
        Game._consumeItem(id, 1);
        Game._toast('闭嘴卡：下一轮旁白闭嘴（这一轮剩下的质疑也一并挡掉）。');
        return { ok: true, reason: '' };
      }
      if (id === 'fuse') {
        s.itemBuffs = s.itemBuffs || {};
        s.itemBuffs.fuse = true;
        Game._consumeItem(id, 1);
        Game._toast('保险丝已接好：本轮第一次负面结算归零。');
        return { ok: true, reason: '' };
      }
      Game._toast('这件道具暂时用不上。');
      return { ok: false, reason: 'noop' };
    },

    /* ------------------------------ 契约 v6：钱包 / 升级 / 难度 / 首页 / 换门 */

    /** 契约 §2.4：本机持久金币余额（结算/死亡后保存；首页展示）。 */
    wallet: function () {
      var store = storeRef();
      if (!store || typeof store.loadWallet !== 'function') return 0;
      var n = 0;
      try { n = store.loadWallet(); } catch (e) { n = 0; }
      n = Math.round(numOr(n, 0));
      return n < 0 ? 0 : n;
    },

    /** 保存钱包（幂等；结算/死亡时调用）。 */
    saveWallet: function (n) {
      var v = Math.round(numOr(n, 0));
      if (v < 0) v = 0;
      var store = storeRef();
      if (store && typeof store.saveWallet === 'function') {
        try { store.saveWallet(v); } catch (e) { /* 静默：坏存档不阻塞游戏 */ }
      }
      return v;
    },

    /** 花钱包里的金币；不足返回 false 且不改档。 */
    spendWallet: function (n) {
      var cost = Math.round(numOr(n, 0));
      if (cost < 0) cost = 0;
      var cur = Game.wallet();
      if (cur < cost) return false;
      Game.saveWallet(cur - cost);
      return true;
    },

    /** 本局结算时把 state.coins 存进钱包（每局一次，state.walletSaved 幂等标记）。 */
    _bankRun: function () {
      var s = Game.state;
      if (!s) return Game.wallet();
      if (s.walletSaved) return Game.wallet();
      s.walletSaved = true;
      return Game.saveWallet(s.coins);
    },

    /** 已购升级等级表 {id: level}。 */
    upgradeLevels: function () { return upgradeLevelsMap(); },

    /** 契约 §2.4：升级列表（供首页「升级商店」渲染）。 */
    upgrades: function () {
      var levels = upgradeLevelsMap();
      var wallet = Game.wallet();
      return upgradeTable().map(function (u) {
        var lv = levels[u.id] || 0;
        var max = upgradeMaxLevel(u);
        var eff = upgradeEffectOf(u);
        var cost = upgradeCostOf(u, lv);
        return {
          id: u.id, name: u.name || u.id, desc: u.desc || '',
          cost: cost, maxLevel: max, level: lv,
          effect: eff, maxed: lv >= max, affordable: wallet >= cost,
          wallet: wallet
        };
      });
    },

    /** 买一级升级。返回 { ok, reason }；reason ∈ '' | unknown | max | insufficient。 */
    buyUpgrade: function (id) {
      var u = upgradeDef(id);
      if (!u) return { ok: false, reason: 'unknown' };
      var levels = upgradeLevelsMap();
      var lv = levels[id] || 0;
      var max = upgradeMaxLevel(u);
      if (lv >= max) {
        Game._toast((u.name || id) + '已经满级了。');
        return { ok: false, reason: 'max' };
      }
      var cost = upgradeCostOf(u, lv);
      var cur = Game.wallet();
      if (cur < cost) {
        Game._toast('金币不够：' + (u.name || id) + '要 ' + cost + '，钱包里只有 ' + cur + '。');
        return { ok: false, reason: 'insufficient' };
      }
      var next = {};
      for (var k in levels) {
        if (Object.prototype.hasOwnProperty.call(levels, k)) next[k] = levels[k];
      }
      next[id] = lv + 1;
      var store = storeRef();
      if (store) {
        Game.saveWallet(cur - cost);
        if (typeof store.saveUpgrades === 'function') {
          try { store.saveUpgrades(next); } catch (e) { /* 静默 */ }
        }
      }
      Game._toast('升级成功：' + (u.name || id) + ' Lv.' + (lv + 1) + '（−' + cost + ' 金币）');
      Game._render();
      Game._emitter.emit({ type: 'upgrade', id: id, level: lv + 1, cost: cost, wallet: Game.wallet() });
      return { ok: true, reason: '', id: id, level: lv + 1, cost: cost, wallet: Game.wallet() };
    },

    /** 契约 §2.4：当前难度 id。 */
    difficulty: function () { return currentDifficultyId(); },

    /** 契约 §2.4：三档难度（首页展示 + 选中态）。 */
    difficultyList: function () {
      return DIFFICULTY_IDS.map(function (id) {
        var d = difficultyDef(id);
        return { id: d.id, name: d.name, desc: d.desc, lieBase: d.lieBase, coins: d.coins, suspicion: d.suspicion, patience: d.patience, reward: d.reward };
      });
    },

    /** 切换难度（本机偏好；IDLE 时立即生效，局内切换从下一局开始）。 */
    setDifficulty: function (id) {
      if (DIFFICULTY_IDS.indexOf(id) < 0) return false;
      Game.savePref('difficulty', id);
      if (Game.state) Game.state.difficulty = id;
      Game._render();
      Game._emitter.emit({ type: 'difficulty', id: id });
      return true;
    },

    /** 契约 §2.5：首页剧情（data/config.json.story 优先，缺失用内置 3 段）。 */
    story: function () { return storyHtml(); },

    /** 首页 spec：标题 / 剧情 / 钱包 / 难度 / 升级（ui 只渲染）。 */
    homeSpec: function () {
      return {
        kind: 'home',
        title: '命运之门',
        story: storyHtml(),
        coins: Game.wallet(),
        difficulty: currentDifficultyId(),
        difficulties: Game.difficultyList(),
        upgrades: Game.upgrades()
      };
    },

    /** 回到首页（IDLE）。可从结算页 / 死亡页 / 对局中返回。 */
    home: function () {
      Game._clearTimers();
      Game._generation++;
      Game._endingModal = null;
      var ui = Game._ui();
      Game._safe(function () { if (ui.closeModal) ui.closeModal(); });
      var mode = (Game.state && Game.state.mode) ? Game.state.mode : MODES.DEMO;
      Game.state = Game._freshState(mode, null);
      Game.state.phase = STATES.IDLE;
      if (root.document && root.document.body) {
        root.document.body.setAttribute('data-state', STATES.IDLE);
      }
      Game._render();
      Game._emitter.emit({ type: 'state', state: Game.state });
      return true;
    },

    /** 升级商店弹层（首页按钮 / 死亡页「用金币继续」都走这里）。 */
    openUpgrade: function () {
      var ui = Game._ui();
      var items = Game.upgrades();
      var body = '<p>钱包余额：<b>' + Game.wallet() + '</b> 金币（每局结算后自动存入）。</p>';
      var spec = {
        kind: 'upgrade',
        title: '升级商店',
        body: body,
        coins: Game.wallet(),
        items: items,
        actions: items.map(function (u) {
          return { label: u.name + (u.maxed ? '（满级）' : ' Lv.' + (u.level + 1) + ' · ' + u.cost), choice: 'buy_upgrade:' + u.id, id: u.id };
        }).concat([{ label: '关闭', choice: 'close' }])
      };
      if (ui.openModal) Game._safe(function () { ui.openModal(spec); });
      Game._emitter.emit({ type: 'upgrade_shop', state: Game.state, spec: spec });
      return true;
    },

    /** 契约 §2.2：当前提示文案（UI 的 .hint-claim 显示它）。 */
    hintText: function () {
      var s = Game.state;
      if (!s || !s.lastHint) return '';
      return s.lastHint.text || '';
    },

    /** 本轮免费窥视次数：1 + 第六感升级。 */
    _peekQuota: function () {
      var extra = Math.round(upgradeBonus('peek_plus'));
      return 1 + (extra > 0 ? extra : 0);
    },

    /** 契约 §2.3：可换的目标门 slot 列表（不含当前门 / 已开 / 已翻）。 */
    switchCandidates: function () {
      var s = Game.state;
      if (!s || !Array.isArray(s.doors)) return [];
      return s.doors.filter(function (d) {
        return d.slot !== s.pickedSlot && !d.opened && !d.revealed;
      }).map(function (d) { return d.slot; });
    },

    /** 契约 §2.3：换门费用（含熟客折扣）。 */
    switchCost: function () {
      var cost = Number(economy().switchCost);
      if (!isFinite(cost) || cost < 0) cost = DEFAULT_ECONOMY.switchCost;
      return priceAfterDiscount(cost);
    },

    /**
     * 契约 §2.3：开始换门 = 弹出「重新选门」弹层（绝不自动换门）。
     * 仅 DECIDE、本轮未换过、有候选门时可用。返回 { ok, candidates, cost }。
     */
    beginSwitch: function () {
      var s = Game.state;
      if (!s || s.phase !== STATES.DECIDE) {
        Game._toast('换门只能在决策阶段。');
        return { ok: false, reason: 'phase', candidates: [], cost: Game.switchCost() };
      }
      if (s.flags.switchPick) return { ok: false, reason: 'open', candidates: Game.switchCandidates(), cost: Game.switchCost() };
      if (s.switchedThisRound) {
        Game._toast('这一轮已经换过门了。');
        return { ok: false, reason: 'used', candidates: [], cost: Game.switchCost() };
      }
      var candidates = Game.switchCandidates();
      if (!candidates.length) {
        Game._toast('没有可以换的门了。');
        return { ok: false, reason: 'no-candidate', candidates: [], cost: Game.switchCost() };
      }
      var cost = Game.switchCost();
      var ticket = Game._itemCount('switch_ticket');
      s.flags.switchPick = true;
      Game._render();
      var ui = Game._ui();
      var body = '<p>换门要付 <b>' + (ticket > 0 ? '1 张换门券' : cost + ' 金币') + '</b>，挑一扇新门：</p>';
      if (ui.openModal) {
        Game._safe(function () {
          ui.openModal({
            kind: 'switch',
            title: '换到哪扇门？',
            body: body,
            candidates: candidates,
            cost: cost,
            ticket: ticket,
            actions: candidates.map(function (slot) {
              return { label: (slot + 1) + ' 号门', choice: 'switch:' + slot, slot: slot };
            }).concat([{ label: '算了，不换', choice: 'cancel_switch' }])
          });
        });
      }
      Game._emitter.emit({ type: 'switch_begin', state: Game.state, candidates: candidates, cost: cost, ticket: ticket });
      return { ok: true, candidates: candidates, cost: cost, ticket: ticket };
    },

    /** 契约 §2.3：玩家在「重新选门」弹层里选了 slot → 扣费、换门、开奖。非法 slot 拒绝。 */
    chooseSwitch: function (slot) {
      var s = Game.state;
      if (!s || s.phase !== STATES.DECIDE) return false;
      if (!s.flags.switchPick) { Game._toast('现在没有在选门。'); return false; }
      var n = Math.round(numOr(slot, -1));
      var candidates = Game.switchCandidates();
      if (candidates.indexOf(n) < 0) {
        Game._toast('这扇门不能换。');
        return false;
      }
      var cost = Game.switchCost();
      var ticket = Game._itemCount('switch_ticket');
      if (ticket > 0) {
        Game._consumeItem('switch_ticket', 1);
      } else if (s.coins >= cost) {
        Game._apply({ id: 'shop_switch', label: '换门', coins: -cost }, { multiplier: 1, source: 'shop' });
      } else {
        Game._toast('换门需要 ' + cost + ' 金币或一张换门券（现在只有 ' + Game.state.coins + ' 金币）。');
        return false;
      }
      var cur = Game.state;
      cur.pickedSlot = n;
      cur.switchStreak = (cur.switchStreak || 0) + 1;
      cur.switchedThisRound = true;
      cur.flags.switchPick = false;
      Game._closeModal();
      Game._toast('换到 ' + (n + 1) + ' 号门' + (ticket > 0 ? '（消耗换门券）' : '（−' + cost + ' 金币）'));
      return Game.reveal();
    },

    /** 契约 §2.3：取消换门 —— 只关弹层，回到 DECIDE（不扣费、不换门）。 */
    cancelSwitch: function () {
      var s = Game.state;
      var was = !!(s && s.flags.switchPick);
      if (s) s.flags.switchPick = false;
      Game._closeModal();
      Game._render();
      if (was) Game._toast('没换门，留在决策。');
      return true;
    },

    /** 契约 §2.4：死亡保险 —— 每局一次，耐心归零时改为金币清零并继续。 */
    _deathSave: function () {
      var s = Game.state;
      if (!s) return false;
      if (s.deathInsuranceUsed) return false;
      if (!upgradeLevelsMap().death_insurance) return false;
      s.deathInsuranceUsed = true;
      s.patience = 1;
      s.coins = 0;
      s.dead = false;
      Game._toast('死亡保险生效：金币清零，你活了下来。');
      Game._render();
      return true;
    },

    /* -------------------------------------------------------------- 开奖 */

    /** 翻门开奖：结算 → 动画 → 本轮结算页。flags.revealLocked 防止重复结算。 */
    reveal: function () {
      var s = Game.state;
      if (s.flags.revealLocked) return false;
      s.flags.revealLocked = true;

      var slot = s.pickedSlot;
      if (slot == null || !s.doors[slot]) { Game._warn('无有效选门'); return false; }
      var itemId = s.doors[slot].itemId;
      var multiplier = s.doubled ? 2 : 1;
      /* 契约 v6 §2.4：难度奖励倍率只放大「赚到的金币」，不放大惩罚。 */
      var rewardMul = numOr(s.rewardMul, 1);
      if (!(rewardMul > 0)) rewardMul = 1;

      // 状态机只能由 game.js 迁移：内容层（applyEffect）在耐心归零时会顺手写
      // phase='GAME_OVER'，那会让下面的 setState(REVEAL) 被 ALLOWED 拒绝、
      // 动画回调也因 phase!==REVEAL 提前返回 → 结算层永不弹出。这里先把它还原，
      // 死亡判定仍由 settleRound 的 patience<=0 分支负责。
      var prevPhase = s.phase;
      var applied = Game._apply(itemId, { multiplier: multiplier, source: 'reveal' });
      var delta = applied.delta || {};
      var events = applied.events || [];
      if (rewardMul !== 1 && delta.coins > 0) {
        var bonus = Math.round(delta.coins * (rewardMul - 1));
        if (bonus > 0) {
          var boosted = Game._apply({ id: 'difficulty_reward', label: '难度奖励', coins: bonus }, { multiplier: 1, source: 'reveal' });
          delta = {
            coins: delta.coins + bonus,
            suspicion: delta.suspicion || 0,
            patience: delta.patience || 0
          };
          applied.state = boosted.state || applied.state;
          events = events.concat(boosted.events || []);
        }
      }
      applied.delta = delta;
      applied.events = events;
      s = applied.state;
      s.phase = prevPhase;
      Game.state = s;
      s.doors[slot].revealed = true;
      /* 契约 v4 §5：孤注一掷成就 —— 加倍后开出大奖。 */
      if (multiplier === 2 && itemId === 'big_prize') s.allInWin = true;
      Game.setState(STATES.REVEAL);
      Game._flashAll(applied.delta);

      var payload = {
        slot: slot, itemId: itemId, item: itemOf(itemId),
        delta: applied.delta, multiplier: multiplier, events: applied.events
      };
      Game._play('playReveal', [payload]).then(function () {
        if (Game.state.phase !== STATES.REVEAL) return;
        Game.settleRound();
      });
      return true;
    },

    /** 本轮结算：写入 log / 图鉴，判断耐心归零或进入结算展示。 */
    settleRound: function () {
      var s = Game.state;
      var slot = s.pickedSlot;
      var itemId = s.doors[slot] ? s.doors[slot].itemId : null;
      var result = {
        round: s.round,
        pickedSlot: slot,
        hostOpenedSlot: s.hostOpenedSlot,
        itemId: itemId,
        doubled: s.doubled,
        challenged: !!(s.lastChallenge && s.lastChallenge.ok),
        coins: s.coins,
        suspicion: s.suspicion,
        patience: s.patience,
        coinsAfter: s.coins
      };
      s.roundResult = result;
      s.log.push(result);
      if (itemId) Game._unlockItem(itemId);
      // 连续空门彩蛋计数
      s.emptyStreak = (itemId === 'empty') ? (s.emptyStreak || 0) + 1 : 0;

      var narrator = Game.deps.narrator;
      var special = null;
      if (narrator && narrator.special) {
        if (s.switchStreak >= 3) special = narrator.special(s, 'switch3');
        else if (s.challengeStreak >= 2) special = narrator.special(s, 'challenge2');
        else if (s.emptyStreak >= 3) special = narrator.special(s, 'empty3');
      }

      if (s.patience <= 0 && !Game._deathSave()) { Game.gameOver(); return result; }

      var next = function () {
        if (special) { Game._playLine(special); }
        Game.showRoundModal(result);
        Game.setState(STATES.SETTLE_ROUND);
      };
      if (special) {
        // 彩蛋旁白先播，再进结算展示
        var line = special;
        Game._play('playNarratorLine', [line, 2]).then(function () { next(); });
      } else {
        next();
      }
      return result;
    },

    /** 本轮结算弹层：继续 / 收手（两处都能收手）。 */
    showRoundModal: function (result) {
      var ui = Game._ui();
      var item = itemOf(result.itemId) || {};
      var delta = Game._deltaText(result);
      /* 契约 v4 §3.6：结算页旁白点评一句（展示用，不扰动主随机流）。 */
      var kv = kindOf(result.itemId);
      var settle = Game._settleLineFor(kv === 'hazard' ? 'lose' : 'win');
      Game.state.settleLine = (settle && settle.text) ? settle.text : null;
      var body = '<p>你选了 <b>' + (result.pickedSlot + 1) + ' 号门</b>：' +
        (item.name || result.itemId || '什么也没有') + '</p>' +
        '<p>' + delta + '</p>' +
        (result.doubled ? '<p class="muted">已加倍：本轮收益与代价 ×2</p>' : '');
      if (ui.openModal) {
        Game._safe(function () {
          ui.openModal({
            kind: 'round',
            title: '第 ' + result.round + ' 轮结算',
            body: body,
            actions: [
              { label: '继续下一轮', choice: 'continue', primary: true },
              { label: '见好就收', choice: 'cashout' }
            ]
          });
        });
      }
    },

    /** 结算页：最终金币、闯到第几轮、称号、高光一句话。 */
    cashout: function (from) {
      var s = Game.state;
      Game._clearTimers();
      var rating = Game.rating(s);
      s.ending = { from: from || 'decide', coins: s.coins, round: s.round, title: rating.title };
      s.codex.endings = s.codex.endings || [];
      if (s.codex.endings.indexOf(rating.title) < 0) s.codex.endings.push(rating.title);
      Game.setState(STATES.CASHOUT);

      var narrator = Game.deps.narrator;
      var highlight = '';
      if (narrator && typeof narrator.highlight === 'function') {
        highlight = narrator.highlight(s, s.roundResult) || '';
      }
      /* 契约 v3 §4.2：多结局（在称号之外再给一层结局 + 旁白赛后点评）。 */
      s.endingId = Game.computeEndingId(s);
      var ending = Game.endingSpec(s.endingId);
      var endingLine = null;
      if (narrator && typeof narrator.endingLine === 'function') {
        try { endingLine = narrator.endingLine(s, s.endingId); } catch (e) { endingLine = null; }
      }
      if (!endingLine) endingLine = Game._settleLineFor('cashout');
      s.settleLine = (endingLine && endingLine.text) ? endingLine.text : null;
      if (s.codex.endings.indexOf(ending.title) < 0) s.codex.endings.push(ending.title);
      /* 契约 v6 §2.4：结算时把本局金币存进钱包（幂等，一局只存一次）。 */
      Game._bankRun();
      var wallet = Game.wallet();
      var body = '<p class="muted">你带着金币离开——这些金币已存入钱包（<b>' + wallet + '</b>），可去「升级商店」花掉。</p>' +
        '<p class="big">最终金币：<b>' + s.coins + '</b></p>' +
        '<p>闯到第 <b>' + s.round + '</b> 轮</p>' +
        '<p>称号：<b>' + rating.title + '</b></p>' +
        '<p>结局：<b>' + ending.title + '</b>' + (ending.desc ? '（' + ending.desc + '）' : '') + '</p>' +
        (s.spentCoins > 0
          ? '<p class="muted">你在商店花了 <b>' + s.spentCoins + '</b> 金币，买了 ' + (s.shopBuys || 0) + ' 件道具。</p>'
          : '') +
        (highlight ? '<p class="muted">' + highlight + '</p>' : '') +
        '<p class="muted">种子：<b>' + Game.seedTag() + '</b>（点「复制种子」可重放这一局）</p>' +
        '<p class="fine">游戏内金币纯属娱乐，非真实货币。</p>';
      Game._saveCodex();
      Game._saveBest();
      /* 契约 v4 §5：局终写统计 + 判定成就。 */
      Game._finishStats();
      Game._checkAchievements();
      var ui = Game._ui();
      Game._endingModal = {
        kind: 'cashout', title: '活下来了', body: body, ending: ending,
        actions: [
          { label: '再来一局', choice: 'restart', primary: true },
          { label: '复制种子', choice: 'save_seed' },
          { label: '看图鉴', choice: 'codex' }
        ]
      };
      if (ui.openModal) {
        Game._safe(function () {
          ui.openModal(Game._endingModal);
        });
      }
      Game._emitter.emit({ type: 'cashout', state: Game.state, rating: rating });
      return Game.state;
    },

    /** 耐心归零结算（契约 v6 §2.5：这是一次「死亡」，不只是本局结束）。 */
    gameOver: function () {
      var s = Game.state;
      Game._clearTimers();
      Game.setState(STATES.GAME_OVER);
      s.dead = true;
      /* 契约 v3 §4.2：失败局同样给结局（契约 v6 新增 death 结局，优先级最高）。 */
      s.endingId = Game.computeEndingId(s);
      var ending = Game.endingSpec(s.endingId);
      if (s.codex.endings.indexOf(ending.title) < 0) s.codex.endings.push(ending.title);
      var bustLine = Game._settleLineFor('bust');
      s.settleLine = (bustLine && bustLine.text) ? bustLine.text : null;
      /* 契约 v6 §2.4：死亡也把本局金币存进钱包（幂等），攒钱升级下一局买命。 */
      Game._bankRun();
      var wallet = Game.wallet();
      var body = '<p class="big">你死了。</p>' +
        '<p>你没能撑过去……旁白最后看了你一眼，什么都没说。</p>' +
        '<p>你倒在第 <b>' + s.round + '</b> 轮，手里还剩 <b>' + s.coins + '</b> 金币（已存入钱包：<b>' + wallet + '</b>）。</p>' +
        '<p class="muted">耐心归零，旁白赢了这一局。</p>' +
        '<p>结局：<b>' + ending.title + '</b>' + (ending.desc ? '（' + ending.desc + '）' : '') + '</p>' +
        '<p class="muted">种子：<b>' + Game.seedTag() + '</b></p>' +
        '<p class="fine">游戏内金币纯属娱乐，非真实货币。</p>';
      Game._saveCodex();
      Game._saveBest();
      Game._finishStats();
      Game._checkAchievements();
      var ui = Game._ui();
      Game._endingModal = {
        kind: 'gameover', title: '你死了', body: body, ending: ending,
        actions: [
          { label: '用金币继续（升级商店）', choice: 'upgrade_shop', primary: true },
          { label: '重新挑战', choice: 'restart' }
        ]
      };
      if (ui.openModal) {
        Game._safe(function () {
          ui.openModal(Game._endingModal);
        });
      }
      return Game.state;
    },

    /** 弹层按钮回调：continue / cashout / restart / codex / clear_codex / close。 */
    modalChoice: function (choice) {
      switch (choice) {
        case 'continue':
          if (Game.state.phase !== STATES.SETTLE_ROUND) return false;
          Game.state.round++;
          Game._closeModal();
          Game.beginRound();
          return true;
        case 'cashout':
          Game._closeModal();
          return Game.cashout('settle');
        case 'restart':
          Game._closeModal();
          Game.start(MODES.DEMO);
          return true;
        case 'codex':
          return Game.showCodex();
        case 'clear_codex':
          Game.clearCodex();
          return Game.showCodex();
        case 'save_seed':
          Game.saveSeed();
          return true;
        case 'help':
          return Game.openHelp();
        case 'settings':
          return Game.openSettings();
        case 'clear_save':
          Game.clearSave();
          return Game.openSettings();
        case 'close':
        case 'dismiss':
          Game._closeModal();
          if (Game._endingModal &&
              (Game.state.phase === STATES.CASHOUT || Game.state.phase === STATES.GAME_OVER)) {
            var ui = Game._ui();
            if (ui.openModal) Game._safe(function () { ui.openModal(Game._endingModal); });
          }
          return true;
        /* ---- 契约 v6：首页 / 升级 / 换门弹层 ---- */
        case 'upgrade_shop':
          return Game.openUpgrade();
        case 'home':
        case 'home_start':
          return Game.home();
        case 'cancel_switch':
          return Game.cancelSwitch();
        default:
          if (typeof choice === 'string' && choice.indexOf('switch:') === 0) {
            return Game.chooseSwitch(parseInt(choice.slice(7), 10));
          }
          if (typeof choice === 'string' && choice.indexOf('buy_upgrade:') === 0) {
            var up = Game.buyUpgrade(choice.slice(12));
            /* 升级成功就刷新弹层（钱包与等级都变了）；失败只 toast，弹层留着。 */
            if (up.ok) Game.openUpgrade();
            return up.ok;
          }
          if (typeof choice === 'string' && choice.indexOf('persona:') === 0) {
            Game.setPersonality(choice.slice(8));
            return Game.openSettings();
          }
          if (typeof choice === 'string' && choice.indexOf('pref:') === 0) {
            var pk = choice.slice(5);
            var pp = prefsOf();
            if (pk === 'sound') Game.savePref('sound', pp.sound === false);
            else if (pk === 'bgm') Game.savePref('bgm', pp.bgm === false);
            else if (pk === 'speed') Game.savePref('animationSpeed', pp.animationSpeed === 'fast' ? 'full' : 'fast');
            else if (pk === 'narrator') {
              /* 慢 → 标准 → 快 → 慢 循环。 */
              Game.savePref('narrator', pp.narrator === 'slow' ? 'normal' : pp.narrator === 'fast' ? 'slow' : 'fast');
            } else if (pk === 'log') { Game.openNarratorLog(); return true; }
            return Game.openSettings();
          }
          if (typeof choice === 'string' && choice.indexOf('buy:') === 0) {
            var bought = Game.buy(choice.slice(4));
            /* 买成功就重开弹层刷新金币与「已有」；买不起/到上限只 toast，弹层留着。 */
            if (bought.ok) Game.openShop();
            return bought.ok;
          }
          return false;
      }
    },

    /* ------------------------------------------------------------ 纯函数区 */

    /**
     * 发牌（契约 v6 §2.1 不变量）：
     *   - 每局至少 2 扇空门（kind==='no-prize'），且恰好 ≤1 扇大奖；
     *   - 3 门 = 大奖 + 空门 + 空门（3 门不再出小奖，小奖从 4 门起）；
     *   - 4–6 门 = 大奖 + 至少 2 空门 + 其余按权重池抽取（不超过 1 扇大奖）；
     *   - 演示剧本只决定「口味」，同样经过不变量修正（条款见 _enforceDoorInvariants）。
     * 不变量保证主持人永远有「空门」可开：3 门时玩家最多拿走 1 扇空门。
     */
    generateDoors: function (round) {
      var s = Game.state;
      var rng = s.rng;
      var script = Game.script();
      var n = (s && s.doorCount != null) ? clampDoorCount(s.doorCount) : Game.doorCountFor(round);
      var ids;
      var scripted = !!(script && Array.isArray(script.doors) && script.doors.length);
      if (scripted) {
        ids = script.doors.slice();
      } else if (n <= 3) {
        ids = ['big_prize', 'empty', 'empty'];
      } else {
        ids = ['big_prize', 'empty', 'empty'];
        ids = ids.concat(Game._drawExtra(round, n - 3, n));
      }
      if (scripted) {
        /* 剧本牌面是数据层写好的「口味」：位置有意义（hostOpensSlot 指向某扇门），
           所以不洗牌；只做最低限度的安全修正（门数、≤1 大奖、≥1 空门）。 */
        while (ids.length < n) ids.push('empty');
        if (ids.length > n) ids = ids.slice(0, n);
        var tops = 0, empt = 0;
        ids.forEach(function (id) {
          if (isTopPrize(id)) tops++;
          if (isNoPrize(id)) empt++;
        });
        for (var si = 0; si < ids.length && tops > 1; si++) {
          if (isTopPrize(ids[si])) { ids[si] = 'empty'; tops--; empt++; }
        }
        for (var sj = 0; sj < ids.length && empt < 1; sj++) {
          if (!isNoPrize(ids[sj]) && !isTopPrize(ids[sj])) { ids[sj] = 'empty'; empt++; }
        }
      } else {
        ids = Game._enforceDoorInvariants(ids, n);
        ids = RNG.shuffle(rng, ids);
      }
      var out = ids.map(function (id, i) {
        return { slot: i, itemId: id, opened: false, revealed: false };
      });
      Game._lastDeal = out;
      return out;
    },

    /**
     * 契约 v6 §2.1：4–6 门的「其余门」从权重池抽；排除大奖（大奖已固定 1 扇）。
     */
    _drawExtra: function (round, k, doors) {
      var s = Game.state;
      var data = Game.deps.data;
      var out = [];
      var guard = 0;
      while (out.length < k && guard++ < 200) {
        var pool = (data && typeof data.poolForRound === 'function')
          ? data.poolForRound(round, doors)
          : Game._fallbackPool(round);
        var usable = pool.filter(function (e) {
          var id = e && e.id ? e.id : e;
          return !isTopPrize(id) && out.indexOf(id) < 0;
        });
        if (!usable.length) break;
        var chosen = RNG.weighted(s.rng, usable, function (e) { return e.weight; });
        var id = (chosen && chosen.id) ? chosen.id : chosen;
        if (id == null || isTopPrize(id) || out.indexOf(id) >= 0) continue;
        out.push(id);
      }
      while (out.length < k) out.push('empty');
      return out;
    },

    /**
     * 契约 v6 §2.1：把任意牌面修正到满足发牌不变量。
     * 修正顺序：补足门数 → 多出的大奖换空门 → 没有大奖就补 1 扇 →
     * 空门不足 2 扇时，优先把危害门换成空门，其次把奖项换成空门。
     */
    _enforceDoorInvariants: function (ids, n) {
      var out = (ids || []).slice();
      var i;
      while (out.length < n) out.push('empty');
      if (out.length > n) out = out.slice(0, n);

      /* 恰好 ≤1 扇大奖。 */
      var topSeen = 0;
      for (i = 0; i < out.length; i++) {
        if (!isTopPrize(out[i])) continue;
        topSeen++;
        if (topSeen > 1) out[i] = 'empty';
      }
      /* 至少 1 扇大奖（保证每局都有终极目标）。 */
      if (topSeen === 0 && out.length) {
        var topIdx = -1;
        for (i = 0; i < out.length; i++) { if (isNoPrize(out[i])) { topIdx = i; break; } }
        if (topIdx >= 0) out[topIdx] = 'big_prize';
      }
      /* 至少 2 扇空门。 */
      var empties = out.filter(function (id) { return isNoPrize(id); }).length;
      for (i = 0; i < out.length && empties < 2; i++) {
        if (isNoPrize(out[i]) || isTopPrize(out[i])) continue;
        if (kindOf(out[i]) === 'hazard') { out[i] = 'empty'; empties++; }
      }
      for (i = 0; i < out.length && empties < 2; i++) {
        if (isNoPrize(out[i]) || isTopPrize(out[i])) continue;
        out[i] = 'empty';
        empties++;
      }
      return out;
    },

    /**
     * 契约 v5：本轮门数（3–6）。
     * 优先级：演示剧本的 doors 长度 → 普通模式 / 打开 ?doors=N → config.doorCount 权重抽 → 3。
     * 注意：权重抽会推进 state.rng；beginRound 只调一次并写入 state.doorCount，
     * 其余调用方（测试直接调 generateDoors）走无副作用的分支。
     */
    doorCountFor: function (round) {
      var s = Game.state || {};
      var script = Game.script();
      if (s.mode !== MODES.NORMAL && script && Array.isArray(script.doors) && script.doors.length) {
        return clampDoorCount(script.doors.length);
      }
      if (s.mode === MODES.NORMAL && forceDoorCount) return forceDoorCount;
      var dc = config().doorCount;
      if (!dc || typeof dc !== 'object') return 3;
      var lo = clampDoorCount(dc.min);
      var hi = clampDoorCount(dc.max);
      if (hi < lo) hi = lo;
      var weights = dc.weights || {};
      var entries = [];
      for (var k in weights) {
        if (!Object.prototype.hasOwnProperty.call(weights, k)) continue;
        var n = parseInt(k, 10);
        var w = Number(weights[k]);
        if (isFinite(n) && n >= lo && n <= hi && isFinite(w) && w > 0) entries.push({ n: n, w: w });
      }
      if (!entries.length) return lo;
      var chosen = RNG.weighted(s.rng || { seed: 1, cursor: 0 }, entries, function (e) { return e.w; });
      return (chosen && chosen.n) ? chosen.n : lo;
    },

    /** 从权重池抽 n 个不重复物品，并修正到满足不变量。 */
    _drawPool: function (round, n) {
      var data = Game.deps.data;
      var s = Game.state;
      var picks = [];
      var guard = 0;
      while (picks.length < n && guard++ < 200) {
        var pool = (data && typeof data.poolForRound === 'function')
          ? data.poolForRound(round, n)
          : Game._fallbackPool(round);
        var usable = pool.filter(function (e) { return picks.indexOf(e.id) < 0; });
        if (!usable.length) break;
        var chosen = RNG.weighted(s.rng, usable, function (e) { return e.weight; });
        var id = chosen && chosen.id ? chosen.id : chosen;
        if (picks.indexOf(id) >= 0) continue;
        if (id === 'big_prize' && picks.indexOf('big_prize') >= 0) continue;
        picks.push(id);
      }
      // 不变量修正：至少一扇非大奖门
      var hasNonTop = picks.some(function (id) { return !isTopPrize(id); });
      if (!hasNonTop) picks[picks.length - 1] = 'empty';
      var hasEmptyish = picks.some(function (id) { return isNoPrize(id); });
      if (!hasEmptyish) {
        // 全是不利门时补一扇空门，避免主持人开不出「空门」
        var idx = picks.findIndex(function (id) { return kindOf(id) === 'hazard'; });
        if (idx < 0) idx = 0;
        picks[idx] = 'empty';
      }
      while (picks.length < n) picks.push('empty');
      return RNG.shuffle(s.rng, picks.slice(0, n));
    },

    _fallbackPool: function (round) {
      return [
        { id: 'big_prize', weight: 8 },
        { id: 'small_prize', weight: 30 },
        { id: 'empty', weight: 25 },
        { id: 'bomb', weight: round >= 4 ? 18 : 0 },
        { id: 'trap', weight: round >= 4 ? 16 : 8 }
      ].filter(function (e) { return e.weight > 0; });
    },

    /**
     * 主持人开门规则（契约 v6 §2.1 冻结）：
     * 只从「kind==='no-prize'（空门）且未被玩家选中、未开」的门里挑，RNG 均匀、同种子可复现。
     * 发牌不变量保证这个集合在正常牌面上恒非空（每局 ≥2 扇空门）。
     * 退化牌面（数据层给的剧本/异常牌面）才依次放宽到「非大奖门」→「任意未开门」，但绝不开玩家所选的门。
     * 兼容调用方式：hostPick(doors, pickedSlot) 或 hostPick(state)。
     */
    hostPick: function (state) {
      var st = null;
      var list = [];
      var pickedSlot = null;
      if (Array.isArray(state)) {
        /* 兼容旧调用 hostPick(doors, pickedSlot)（旧测试/外部调用），新代码请传 state。 */
        list = state;
        pickedSlot = arguments[1];
        st = Game.state || null;
      } else {
        st = state || Game.state || null;
        list = (st && Array.isArray(st.doors)) ? st.doors : [];
        pickedSlot = st ? st.pickedSlot : null;
        /* 防御：state 尚未发牌时（纯函数调用场景）用最近一次发牌结果/临时发牌，
           保证「主持人恒有门可开」。 */
        if (!list.length) {
          var last = Game._lastDeal;
          if (Array.isArray(last) && last.length) {
            list = last;
            if (st) st.doors = last;
          } else {
            list = Game.generateDoors(st && st.round ? st.round : 1);
            if (st) st.doors = list;
          }
        }
      }
      var rng = (st && st.rng) ? st.rng : (Game.state && Game.state.rng);
      var pickOne = function (arr) {
        if (!arr.length) return null;
        if (rng && typeof RNG.pick === 'function') return RNG.pick(rng, arr).slot;
        return arr[0].slot;
      };
      var open = function (d) { return !d.opened && !d.revealed; };
      var legal = list.filter(function (d) {
        return d.slot !== pickedSlot && open(d) && isNoPrize(d.itemId);
      });
      if (legal.length) return pickOne(legal);
      var nonTop = list.filter(function (d) {
        return d.slot !== pickedSlot && open(d) && !isTopPrize(d.itemId);
      });
      if (nonTop.length) return pickOne(nonTop);
      var any = list.filter(function (d) { return d.slot !== pickedSlot && open(d); });
      return pickOne(any);
    },

    /* ------------------------------------------- 契约 v3：结局与提词器 */

    /**
     * 契约 v3 §4.2：结局判定（纯函数，qa 直接调）。
     * 按 config.endings[id].priority 从高到低取第一个满足条件的；未配置时用内置优先级。
     */
    computeEndingId: function (state) {
      var s = state || Game.state || {};
      var cfg = config();
      var table = cfg.endings || {};
      var initial = cfg.initial || {};
      var master = cfg.cashoutMaster || {};
      var TIER = { death: 999, all_in: 100, comeback: 90, iron_patience: 80, master: 70, pua: 60, euro: 50, anti: 40, normal: 0 };
      var coins = s.coins || 0;
      var low = (s.minCoins == null) ? coins : s.minCoins;
      var conds = {
        /* 契约 v6 §2.5：死亡结局优先级最高（数据层 endings.death 的 priority 会覆盖该值）。 */
        death: s.phase === 'GAME_OVER' || s.dead === true,
        all_in: (s.challengesWon || 0) >= 3 && (s.challengesLost || 0) === 0,
        comeback: low <= 10 && coins >= 200,
        iron_patience: s.patience != null && initial.patience != null &&
          s.patience === initial.patience && (s.round || 0) >= 3,
        master: (s.round || 0) >= (master.minRound == null ? 4 : master.minRound) &&
          coins >= (master.minCoins == null ? 200 : master.minCoins),
        pua: coins <= 99,
        euro: coins >= 200 && coins <= 299,
        anti: coins >= 300,
        normal: true
      };
      var ids = Object.keys(conds);
      var priorityOf = function (id) {
        var def = table[id];
        if (def && def.priority != null) return def.priority;
        return TIER[id] == null ? 0 : TIER[id];
      };
      ids.sort(function (a, b) { return priorityOf(b) - priorityOf(a); });
      for (var i = 0; i < ids.length; i++) {
        if (conds[ids[i]]) return ids[i];
      }
      return 'normal';
    },

    /** 结局展示文案（数据层未就绪时退回内置表）。 */
    endingSpec: function (id) {
      var table = config().endings || {};
      var def = table[id] || null;
      if (def) return { id: id, title: def.title || id, desc: def.desc || '', lineKind: def.lineKind || (id === 'death' ? 'death' : null) };
      var fallback = {
        death: '你没撑过去', all_in: '全识破', comeback: '绝地翻盘', iron_patience: '稳如老狗', master: '见好就收大师',
        pua: '被旁白 PUA', euro: '欧皇候选', anti: '反杀旁白', normal: '普通赌徒'
      };
      return { id: id, title: fallback[id] || id, desc: '', lineKind: id === 'death' ? 'death' : null };
    },

    /**
     * 契约 v3 §5.1：演示提词器 —— 告诉操作者「现在该点什么」。
     * 只读状态，不产生副作用；ui.js 在 flags.rehearsal 为真时调用。
     */
    hintNextAction: function () {
      var s = Game.state;
      var out = { phase: (s && s.phase) || '', text: '', choice: null };
      if (!s) return out;
      switch (s.phase) {
        case STATES.IDLE:
          out.text = '点「开始」进入第 1 轮（演示模式按固定剧本走）。';
          break;
        case STATES.ROUND_INTRO:
        case STATES.NARRATOR:
          out.text = '听旁白说完，再点一扇门。';
          break;
        case STATES.PICK:
          out.text = '点任意一扇门——旁白说的真假由你判断。';
          break;
        case STATES.HOST_OPEN:
          out.text = '看主持人开哪扇门，那是这一轮的线索。';
          break;
        case STATES.DECIDE: {
          var tickets = Game._itemCount ? Game._itemCount('switch_ticket') : 0;
          if (s.mode === MODES.DEMO && s.round === 2) {
            out.text = '剧本第 2 轮：先点「质疑旁白」识破它，再决定换不换门。';
            out.choice = 'challenge';
          } else if (tickets > 0) {
            out.text = '你有换门券：这轮换门免费。先质疑，再换门。';
            out.choice = 'switch';
          } else {
            out.text = '选：坚持 / 换门 / 质疑旁白 / 加倍 / 收手。';
          }
          break;
        }
        case STATES.REVEAL:
          out.text = '开奖中……';
          break;
        case STATES.SETTLE_ROUND:
          out.text = '点「继续下一轮」或「见好就收」。';
          break;
        case STATES.CASHOUT:
        case STATES.GAME_OVER:
          out.text = '点「再来一局」重开，或「看图鉴」。';
          break;
        default:
          out.text = '';
      }
      return out;
    },

    /** 评级（阶段 3 P0）：金币档位 + 高轮次收手加成。 */
    rating: function (state) {
      var cfg = config().ratings;
      var bands = Array.isArray(cfg) ? cfg : DEFAULT_RATINGS;
      var master = config().cashoutMaster;
      var coins = state.coins;
      if (master && state.round >= master.minRound && coins >= master.minCoins) {
        return { title: master.title || '见好就收大师', coins: coins, round: state.round };
      }
      if (!master && state.round >= 4 && coins >= 200) {
        return { title: '见好就收大师', coins: coins, round: state.round };
      }
      for (var i = 0; i < bands.length; i++) {
        var b = bands[i];
        // 最高档在 JSON 里是 max:null（Infinity 无法序列化）→ 视为无上限
        var max = (b.max == null) ? Infinity : b.max;
        var min = (b.min == null) ? -Infinity : b.min;
        if (coins >= min && coins <= max) return { title: b.title, coins: coins, round: state.round };
      }
      return { title: '普通赌徒', coins: coins, round: state.round };
    },

    /** demo 模式的固定剧本（阶段 4）：仅 demo 模式且轮次在剧本范围内生效。 */
    script: function () {
      var s = Game.state;
      if (!s || s.mode !== MODES.DEMO) return null;
      var data = Game.deps.data;
      var seq = data && data.seedDemo && data.seedDemo.rounds;
      if (!seq) return null;
      return seq[s.round - 1] || null;
    },

    /**
     * 固定种子演示脚本的确定性走法（给测试与彩排用）。
     * 不依赖固定时长：按状态机相位推进（PICK→选门 / DECIDE→决策 / SETTLE_ROUND→继续）。
     * 第 1 轮：选小奖门 → 坚持；第 2 轮：选大奖门 → 质疑 → 坚持；第 3 轮：选大奖门 → 收手。
     */
    autoDemo: function () {
      var out = { rounds: [], final: null };
      if (!Game.deps.data || !Game.deps.data.seedDemo) return Promise.resolve(out);

      var plan = [
        { pick: 'small_prize', choice: CHOICES.STICK },
        { pick: 'big_prize', challenge: true, choice: CHOICES.STICK },
        { pick: 'big_prize', choice: CHOICES.CASHOUT }
      ];
      Game.start(MODES.DEMO);

      var idx = 0, guard = 0;
      var delay = function (ms) {
        return new Promise(function (resolve) {
          (Game.deps.setTimeout || fallbackTimeout)(resolve, ms);
        });
      };
      var slotOf = function (itemId) {
        var doors = Game.state.doors;
        for (var i = 0; i < doors.length; i++) {
          if (doors[i].itemId === itemId && !doors[i].opened) return i;
        }
        return 0;
      };

      var tick = function () {
        if (guard++ > 5000) { out.error = 'autoDemo 超时（相位未推进）'; return Promise.resolve(out); }
        var s = Game.state;
        if (s.phase === STATES.PICK && idx < plan.length) {
          Game.action({ type: 'pick', slot: slotOf(plan[idx].pick) });
        } else if (s.phase === STATES.DECIDE && idx < plan.length) {
          var step = plan[idx];
          if (step.challenge && !s.lastChallenge) {
            Game.action({ type: 'decide', choice: CHOICES.CHALLENGE });
          } else {
            out.rounds.push(Game.snapshot());
            Game.action({ type: 'decide', choice: step.choice });
            idx++;
            if (step.choice === CHOICES.CASHOUT) {
              out.final = Game.snapshot();
              return Promise.resolve(out);
            }
          }
        } else if (s.phase === STATES.SETTLE_ROUND) {
          Game.action({ type: 'modal_choice', choice: 'continue' });
        } else if (s.phase === STATES.CASHOUT || s.phase === STATES.GAME_OVER) {
          out.final = Game.snapshot();
          return Promise.resolve(out);
        } else if (s.phase === STATES.IDLE) {
          out.final = Game.snapshot();
          return Promise.resolve(out);
        }
        return delay(2).then(tick);
      };
      return delay(0).then(tick);
    },

    /* ------------------------------------- 契约 v4：人格 / 偏好 / 成就 / 统计 / 种子 */

    /** 当前人格 id。 */
    personality: function () { return (Game.state && Game.state.personality) || 'sarcastic'; },

    /** 全部人格（含名称/图标/说明/撒谎率偏移）。 */
    personalities: function () {
      return personaTable().map(function (p) {
        return { id: p.id, name: p.name || p.id, icon: p.icon || '', desc: p.desc || '', lieRateDelta: Number(p.lieRateDelta) || 0 };
      });
    },

    /** 切换旁白人格：写 state + 偏好，同步旁白层。 */
    setPersonality: function (id) {
      if (!personaOf(id)) return false;
      var s = Game.state;
      if (s) s.personality = id;
      var prefs = prefsOf();
      prefs.persona = id;
      var seen = prefs.personasSeen || [];
      if (seen.indexOf(id) < 0) seen.push(id);
      prefs.personasSeen = seen;
      writePrefs(prefs);
      var narrator = Game.deps && Game.deps.narrator;
      if (narrator && typeof narrator.setPersonality === 'function') {
        try { narrator.setPersonality(id); } catch (e) { /* 静默 */ }
      }
      var p = personaOf(id);
      Game._toast('旁白人格：' + (p && p.name ? p.name : id));
      Game._checkAchievements();
      Game._render();
      return true;
    },

    /** 本机偏好（读）。 */
    prefs: function () { return prefsOf(); },

    /** 写一条偏好并落盘（onboarded / muted / persona / animationSpeed / bgm / sound）。 */
    savePref: function (key, value) {
      var prefs = prefsOf();
      prefs[key] = value;
      writePrefs(prefs);
      if (key === 'muted') { mutedPref = value === true; if (Game.state) Game.state.flags.muted = mutedPref; }
      if (key === 'onboarded' && Game.state) Game.state.flags.onboarded = value === true;
      if (key === 'persona' && Game.state && personaOf(value)) Game.state.personality = value;
      Game._render();
      return prefs;
    },

    /** 体验过的人格（persona3 成就判定用）。 */
    personaSeen: function () {
      var prefs = prefsOf();
      return Array.isArray(prefs.personasSeen) ? prefs.personasSeen.slice() : [];
    },

    /** 已解锁成就 id 列表（读存档，合并当前 state）。 */
    achievements: function () {
      var store = Game._store();
      var list = [];
      if (store && typeof store.loadAchievements === 'function') {
        try { list = store.loadAchievements() || []; } catch (e) { list = []; }
      }
      var s = Game.state;
      if (s) {
        (s.achievements || []).forEach(function (id) { if (list.indexOf(id) < 0) list.push(id); });
        s.achievements = list.slice();
      }
      return list;
    },

    /** 成就完整视图：[{id,name,icon,desc,unlocked}]。 */
    achievementList: function () {
      var unlocked = Game.achievements();
      return achievementTable().map(function (a) {
        return {
          id: a.id, name: a.name || a.id, icon: a.icon || 'star',
          desc: a.desc || '', unlocked: unlocked.indexOf(a.id) >= 0
        };
      });
    },

    /** 判定并解锁成就，返回本次新解锁的 id 列表。 */
    _checkAchievements: function () {
      var s = Game.state;
      if (!s) return [];
      var unlocked = Game.achievements();
      var fresh = [];
      achievementTable().forEach(function (a) {
        if (!a || !a.id || unlocked.indexOf(a.id) >= 0) return;
        var ck = a.check || {};
        var fn = ACH_CHECK[ck.type];
        if (typeof fn !== 'function') return;
        var ok = false;
        try { ok = fn(s, ck.threshold); } catch (e) { ok = false; }
        if (ok) { unlocked.push(a.id); fresh.push(a.id); }
      });
      if (fresh.length) {
        var store = Game._store();
        if (store && typeof store.saveAchievements === 'function') { try { store.saveAchievements(unlocked); } catch (e) { /* 静默 */ } }
        s.achievements = unlocked.slice();
        var names = fresh.map(function (id) { var a = achievementById(id); return (a && a.name) || id; });
        Game._toast('解锁成就：' + names.join('、'));
      }
      return fresh;
    },

    /** 统计档案（读存档）。 */
    stats: function () {
      var store = Game._store();
      var st = null;
      if (store && typeof store.loadStats === 'function') {
        try { st = store.loadStats(); } catch (e) { st = null; }
      }
      if (!st) st = { games: 0, totalCoins: 0, bestCoins: 0, bestRound: 0, challenges: 0, challengeWins: 0, endings: [] };
      if (Game.state) Game.state.stats = st;
      return st;
    },

    /** 局终写统计（幂等：每局只写一次）。 */
    _finishStats: function () {
      var s = Game.state;
      if (!s || s.statsSaved) return false;
      s.statsSaved = true;
      var st = Game.stats();
      st.games = (Number(st.games) || 0) + 1;
      st.totalCoins = (Number(st.totalCoins) || 0) + (Number(s.coins) || 0);
      st.bestCoins = Math.max(Number(st.bestCoins) || 0, Number(s.coins) || 0);
      st.bestRound = Math.max(Number(st.bestRound) || 0, Number(s.round) || 0);
      st.challenges = (Number(st.challenges) || 0) + (s.challengesWon || 0) + (s.challengesLost || 0);
      st.challengeWins = (Number(st.challengeWins) || 0) + (s.challengesWon || 0);
      var ending = s.endingId ? Game.endingSpec(s.endingId) : null;
      if (ending && ending.title && st.endings.indexOf(ending.title) < 0) st.endings.push(ending.title);
      var store = Game._store();
      if (store && typeof store.saveStats === 'function') { try { store.saveStats(st); } catch (e) { /* 静默 */ } }
      s.stats = st;
      return true;
    },

    /** 当前种子标签（8 位十六进制）。 */
    seedTag: function () {
      var s = Game.state;
      return (s && s.seedTag) || seedTagOf((s && s.rng && s.rng.seed) || root.DEMO_SEED);
    },

    /** 当前种子的分享链接。 */
    seedUrl: function () { return seedUrlOf(Game.seedTag()); },

    /** 复制种子（有剪贴板就复制，否则只 toast）。 */
    saveSeed: function () {
      var tag = Game.seedTag();
      var url = Game.seedUrl();
      var cb = Game.deps && Game.deps.clipboard;
      if (cb && typeof cb.copy === 'function') {
        try { cb.copy(url); Game._toast('种子已复制：' + tag); return true; } catch (e) { /* 降级 */ }
      }
      Game._toast('种子：' + tag + '（' + url + '）');
      return false;
    },

    /** 新手引导步骤（已完成 → []）。 */
    tutorialSteps: function () {
      var s = Game.state;
      var prefs = prefsOf();
      if ((s && s.flags && s.flags.onboarded) || prefs.onboarded) return [];
      return [
        { id: 'tut_door', step: 1, title: '三扇门', text: '每轮三扇门：一扇大奖、一扇小奖、一扇空门。你选一扇，主持人会再打开一扇。', anchor: '#doors' },
        { id: 'tut_narrator', step: 2, title: '旁白会骗你', text: '旁白每轮说两句话，真假掺着来。别信它，自己看代价。', anchor: '#narrator' },
        { id: 'tut_decide', step: 3, title: '五个决策', text: '坚持 / 换门 / 质疑 / 加倍 / 收手——收手最稳，加倍最刺激。', anchor: '#decide' },
        { id: 'tut_challenge', step: 4, title: '质疑与加倍', text: '怀疑值只有 2 点，用在刀刃上；加倍让收益和惩罚一起翻倍。', anchor: '#decide' },
        { id: 'tut_cashout', step: 5, title: '随时收手', text: '按 C 或点「收手」把金币带回家；随时按 ? 看规则。', anchor: 'cashout' }
      ];
    },

    /** 规则弹层（「规则」按钮 / ?）。 */
    openHelp: function () {
      /* 必选流程弹层（本轮结算/结算页/结束页）优先：信息弹层盖上去后一关就会把玩家卡在无弹层的状态里。 */
      if (blockingModalOpen()) { Game._toast('先处理当前弹层里的选择'); return false; }
      var ui = Game._ui();
      var body =
        '<p><b>三扇门</b>：每轮一扇大奖、一扇小奖、一扇空门。选一扇后主持人会开一扇空门，然后你决策。</p>' +
        '<p><b>五个决策</b>：坚持（免费）· 换门（现金币）· 质疑（花 1 怀疑值赌旁白在骗你）· 加倍（本轮收益与代价 ×2）· 收手（落袋为安）。</p>' +
        '<p><b>快捷键</b>：1/2/3 选门 · Q 质疑 · D 加倍 · S 换门 · C 收手 · 空格 坚持 · M 静音 · ? 规则 · Esc 关闭弹层。</p>' +
        '<p class="muted">金币可去商店买道具；怀疑值每轮最多用一次；耐心归零就结束。' +
        '看不清旁白？设置里可调「旁白速度」，或点「旁白记录」回看本局每一句旁白。</p>';
      if (ui.openModal) {
        Game._safe(function () {
          ui.openModal({ kind: 'help', title: '怎么玩', body: body, actions: [{ label: '知道了', choice: 'close', primary: true }] });
        });
      }
      return true;
    },

    /** 设置弹层（人格 / 音效 / 动画 / 清空数据）。 */
    openSettings: function () {
      if (blockingModalOpen()) { Game._toast('先处理当前弹层里的选择'); return false; }
      var ui = Game._ui();
      var prefs = prefsOf();
      var personas = Game.personalities().map(function (p) {
        return '<li class="persona-row' + (p.id === prefs.persona ? ' is-active' : '') + '">' +
          '<button type="button" class="modal-btn persona-btn" data-choice="persona:' + p.id + '">' +
          (p.icon ? p.icon + ' ' : '') + p.name + '</button>' +
          '<span class="muted">' + (p.desc || '') + '</span></li>';
      }).join('');
      var body =
        '<p><b>旁白人格</b></p><ul class="persona-list">' + personas + '</ul>' +
        '<p><b>旁白速度</b>：' + (prefs.narrator === 'slow' ? '慢' : prefs.narrator === 'fast' ? '快' : '标准') +
        '（慢 6 / 标准 9 / 快 13 字每秒）</p>' +
        '<p><b>声音</b>：' + (prefs.sound !== false ? '开' : '关') + ' · <b>BGM</b>：' + (prefs.bgm !== false ? '开' : '关') +
        ' · <b>动画速度</b>：' + (prefs.animationSpeed === 'fast' ? '快' : prefs.animationSpeed === 'off' ? '关' : '正常') + '</p>' +
        '<p class="muted">种子：' + Game.seedTag() + ' · 错过旁白可点「旁白记录」回看</p>';
      if (ui.openModal) {
        Game._safe(function () {
          ui.openModal({
            kind: 'settings', title: '设置', body: body,
            actions: [
              { label: '旁白速度：' + (prefs.narrator === 'slow' ? '慢' : prefs.narrator === 'fast' ? '快' : '标准'), choice: 'pref:narrator' },
              { label: '旁白记录', choice: 'pref:log' },
              { label: '有声音效：' + (prefs.sound !== false ? '关' : '开'), choice: 'pref:sound' },
              { label: 'BGM：' + (prefs.bgm !== false ? '关' : '开'), choice: 'pref:bgm' },
              { label: '动画：' + (prefs.animationSpeed === 'fast' ? '正常' : '快'), choice: 'pref:speed' },
              { label: '清空全部数据', choice: 'clear_save' },
              { label: '关闭', choice: 'close', primary: true }
            ]
          });
        });
      }
      return prefs;
    },

    /** 旁白记录弹层：本局每一句旁白都留档，错过也能慢慢回看（信息不再一闪而过）。 */
    openNarratorLog: function () {
      var s = Game.state;
      var log = (s && s.narratorLog) || [];
      var rows = log.length ? log.map(function (r2) {
        return '<li><span class="muted">第 ' + r2.round + ' 轮</span> ' + r2.text + '</li>';
      }).join('') : '<li class="muted">本局还没有旁白。</li>';
      if (Game._ui().openModal) {
        Game._safe(function () {
          Game._ui().openModal({
            kind: 'info', title: '旁白记录（本局）',
            body: '<ul class="narrator-log">' + rows + '</ul>',
            actions: [{ label: '关闭', choice: 'close', primary: true }]
          });
        });
      }
      return log;
    },

    /** 清空全部本地数据（图鉴 / 最佳 / 统计 / 成就 / 偏好 / 钱包 / 升级）。 */
    clearSave: function () {
      var store = Game._store();
      if (store && typeof store.clearAll === 'function') { try { store.clearAll(); } catch (e) { /* 静默 */ } }
      var s = Game.state;
      if (s) {
        s.codex = { items: [], lines: [], endings: [] };
        s.achievements = [];
        s.stats = null;
        s.lastHint = null;
        s.flags.onboarded = false;
      }
      Game._toast('本地数据已清空。');
      Game._render();
      return true;
    },

    /* ------------------------------------------------------------ 内部工具 */

    _freshState: function (mode, seed) {
      var prefs = prefsOf();
      if (seedPref != null) { mode = MODES.NORMAL; seed = seedPref; }   // 契约 v4 §6：?seed= 重放优先
      var demo = (mode !== MODES.NORMAL);
      var data = Game.deps.data;
      var seedValue = demo
        ? ((data && data.seedDemo && data.seedDemo.seed) || root.DEMO_SEED)
        : (seed == null ? (Game.deps.now() >>> 0) : seed);
      /* 契约 v6 §2.4：开局资源 = 难度初值 + 已购升级加成（叠加，不替换）。 */
      var diffId = currentDifficultyId();
      var plan = resourcePlan(diffId);
      var res = { coins: plan.coins, suspicion: plan.suspicion, patience: plan.patience };
      var st = createInitialState(mode, {
        seed: seedValue, resources: res, rehearsal: rehearsalPref,
        difficulty: diffId, rewardMul: plan.rewardMul, peekFree: plan.peekFree
      });
      st.deathInsurance = plan.insurance === true;
      st.personality = personaOf(prefs.persona) ? prefs.persona : 'sarcastic';
      st.seedTag = seedTagOf(st.rng.seed);
      st.flags.onboarded = prefs.onboarded === true;
      st.flags.muted = mutedPref || prefs.muted === true;   // 静音跨重置/切换模式保持（见 mutedPref 注释）
      st.joinedAt = Game.deps.now();
      Game._loadCodexInto(st);
      Game._loadExtrasInto(st);
      return st;
    },

    _ui: function () {
      if (!Game.deps.ui) Game.deps.ui = noopUI();
      return Game.deps.ui;
    },

    _render: function () {
      var ui = Game._ui();
      Game._safe(function () {
        if (ui.render) ui.render(Game.state);
        if (ui.setControls) ui.setControls(Game.state);
      });
    },

    _flashAll: function (delta) {
      if (!delta) return;
      var ui = Game._ui();
      ['coins', 'suspicion', 'patience'].forEach(function (key) {
        if (!delta[key]) return;
        Game._safe(function () { if (ui.flash) ui.flash(key, delta[key], Game.state); });
      });
    },

    /** 唯一资源结算入口：调用内容层的纯函数 applyEffect。 */
    _apply: function (effect, opts) {
      var fn = Game.deps.applyEffect;
      if (typeof fn !== 'function') {
        // 内容层未就绪时给出可解释的降级结果，而不是崩掉
        return { state: Game.state, delta: { coins: 0, suspicion: 0, patience: 0 }, events: [] };
      }
      var res = fn(Game.state, effect, opts) || {};
      Game.state = res.state || Game.state;
      /* 契约 v3 §4.2：记录本局金币最低点（「绝地翻盘」结局判定）。 */
      if (Game.state.coins != null) {
        Game.state.minCoins = (Game.state.minCoins == null)
          ? Game.state.coins
          : Math.min(Game.state.minCoins, Game.state.coins);
      }
      return Game._fuseGuard(res, opts);
    },

    /**
     * 保险丝（商店道具）：本轮第一次「负面结算」的金币 / 耐心 / 怀疑值损失全部归零，
     * 顺带撤掉耐心归零的死亡标记。只在开奖结算（source==='reveal'）时生效，
     * 买道具被宰不算（那是玩家自己的选择）。
     */
    _fuseGuard: function (res, opts) {
      var s = Game.state;
      if (!s.itemBuffs || !s.itemBuffs.fuse) return res;
      if (!opts || opts.source !== 'reveal') return res;
      var d = res.delta || {};
      var back = {
        coins: d.coins < 0 ? -d.coins : 0,
        patience: d.patience < 0 ? -d.patience : 0,
        suspicion: d.suspicion < 0 ? -d.suspicion : 0
      };
      if (!back.coins && !back.patience && !back.suspicion) return res;

      var fn = Game.deps.applyEffect;
      var fixed = fn(Game.state, {
        id: 'fuse_save', label: '保险丝',
        coins: back.coins, patience: back.patience, suspicion: back.suspicion
      }, { multiplier: 1, source: 'item' }) || {};
      Game.state = fixed.state || Game.state;
      Game.state.itemBuffs.fuse = false;   // 一根保险丝只顶一次
      Game.state.gameOver = false;         // 死亡标记一并撤销（耐心已被补回）
      var merged = fixed;
      merged.delta = { coins: 0, patience: 0, suspicion: 0 };
      merged.events = (res.events || []).concat([{ type: 'fuse_saved', coins: back.coins, patience: back.patience, suspicion: back.suspicion }]);
      return merged;
    },

    _play: function (method, args) {
      var ui = Game._ui();
      if (typeof ui[method] !== 'function') return Promise.resolve();
      try {
        var r = ui[method].apply(ui, args);
        if (r && typeof r.then === 'function') return r;
        return Promise.resolve(r);
      } catch (e) {
        Game._warn(method, e);
        return Promise.resolve();
      }
    },

    _playLine: function (line) {
      /* 契约 v3 §3：播过即解锁（图鉴可达）。 */
      if (line && line.id) Game._unlockLine(line);
      return Game._play('playNarratorLine', [line, 2]);
    },

    /**
     * 结算 / 收手点评句（契约 v4 §3.6）。
     * 展示用：取句后把 RNG 游标还原，避免影响后续发牌与固定种子演示的确定性。
     */
    _settleLineFor: function (kind) {
      var s = Game.state;
      var narrator = Game.deps && Game.deps.narrator;
      if (!s || !s.rng || !narrator || typeof narrator.settleLine !== 'function') return null;
      var before = { seed: s.rng.seed, cursor: s.rng.cursor };
      var line = null;
      try { line = narrator.settleLine(s, { kind: kind, round: s.round }); } catch (e) { line = null; }
      s.rng.cursor = before.cursor;
      if (line) Game._unlockLine(line);
      return line;
    },

    _wait: function (ms) {
      var setT = Game.deps.setTimeout || fallbackTimeout;
      return new Promise(function (resolve) {
        var id = setT(function () { resolve(); }, ms);
        if (id !== undefined) Game._timers.push(id);
      });
    },

    _clearTimers: function () {
      var clear = Game.deps && Game.deps.clearTimeout;
      (Game._timers || []).forEach(function (id) { if (clear) Game._safe(function () { clear(id); }); });
      Game._timers = [];
    },

    _toggleMode: function () {
      var next = Game.state.mode === MODES.DEMO ? MODES.NORMAL : MODES.DEMO;
      Game._toast(next === MODES.DEMO ? '已切到演示模式（固定剧本）' : '已切到普通模式（时间种子）');
      return Game.start(next);
    },

    _toggleMute: function () {
      Game.state.flags.muted = !Game.state.flags.muted;
      mutedPref = Game.state.flags.muted;   // 记住选择，重置/切换模式后仍然静音
      Game._render();
      return Game.state.flags.muted;
    },

    _skipAnim: function () {
      Game.state.flags.skipAnim = true;
      Game._render();
      var ui = Game._ui();
      if (ui.skip) Game._safe(function () { ui.skip(); });
      return true;
    },

    _skipLine: function () {
      var ui = Game._ui();
      if (ui.skip) Game._safe(function () { ui.skip(); });
      return true;
    },

    _closeModal: function () {
      var ui = Game._ui();
      if (ui.closeModal) Game._safe(function () { ui.closeModal(); });
    },

    _itemCount: function (id) {
      var list = Game.state.items || [];
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].count || 0;
      return 0;
    },

    _consumeItem: function (id, n) {
      var list = Game.state.items || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id !== id) continue;
        list[i].count = clampInt((list[i].count || 0) - n, 0, 99);
        if (list[i].count <= 0) list.splice(i, 1);
        break;
      }
      Game._render();
    },

    /* ---------------------------------------- 图鉴与本地存档（阶段 5 P1） */

    _store: function () {
      return (Game.deps && Game.deps.store) || null;
    },

    /** 开局时把上一次的图鉴读回 state.codex；无存档/坏存档 → 保持空图鉴。 */
    _loadCodexInto: function (st) {
      var store = Game._store();
      if (!store || !store.loadCodex) return st;
      var saved = null;
      try { saved = store.loadCodex(); } catch (e) { saved = null; }
      if (saved && (saved.items.length || saved.lines.length || saved.endings.length)) {
        st.codex = {
          items: (saved.items || []).slice(),
          lines: (saved.lines || []).slice(),
          endings: (saved.endings || []).slice()
        };
      }
      return st;
    },

    /** 图鉴写入后落盘（失败静默）。 */
    _saveCodex: function () {
      var store = Game._store();
      if (!store || !store.saveCodex) return false;
      try { return !!store.saveCodex(Game.state.codex); } catch (e) { return false; }
    },

    /** 契约 v4：开局把成就 / 统计读进 state（无存档 → 空）。 */
    _loadExtrasInto: function (st) {
      var store = Game._store();
      if (!store) return st;
      try {
        if (typeof store.loadAchievements === 'function') {
          var a = store.loadAchievements();
          if (Array.isArray(a) && a.length) st.achievements = a.slice();
        }
      } catch (e) { /* 静默 */ }
      try {
        if (typeof store.loadStats === 'function') st.stats = store.loadStats();
      } catch (e) { /* 静默 */ }
      return st;
    },

    /** 最佳成绩：金币取最大、轮次取最高、称号取并集。 */
    best: function () {
      var store = Game._store();
      var prev = { coins: 0, round: 0, titles: [] };
      if (store && store.loadBest) {
        try { prev = store.loadBest() || prev; } catch (e) { prev = { coins: 0, round: 0, titles: [] }; }
      }
      var s = Game.state || {};
      var titles = (prev.titles || []).slice();
      var rating = Game.rating(s);
      if (rating && rating.title && titles.indexOf(rating.title) < 0) titles.push(rating.title);
      return {
        coins: Math.max(Number(prev.coins) || 0, Number(s.coins) || 0),
        round: Math.max(Number(prev.round) || 0, Number(s.round) || 0),
        titles: titles
      };
    },

    _saveBest: function () {
      var store = Game._store();
      if (!store || !store.saveBest) return false;
      try { return !!store.saveBest(Game.best()); } catch (e) { return false; }
    },

    /** 清空收集进度（图鉴 + 最佳成绩）。 */
    clearCodex: function () {
      var store = Game._store();
      var s = Game.state;
      if (s) s.codex = { items: [], lines: [], endings: [] };
      if (store && store.clearAll) { try { store.clearAll(); } catch (e) { /* 静默 */ } }
      Game._toast('收集进度已清空。');
      Game._render();
      return true;
    },

    _unlockItem: function (id) {
      var codex = Game.state.codex;
      if (codex.items.indexOf(id) < 0) { codex.items.push(id); Game._saveCodex(); }
    },

    _unlockLine: function (line) {
      if (!line || !line.id) return;
      var codex = Game.state.codex;
      if (codex.lines.indexOf(line.id) < 0) { codex.lines.push(line.id); Game._saveCodex(); }
    },

    /** 图鉴弹层：物品 / 语录 / 结局称号 + 最佳成绩 + 清空按钮。 */
    showCodex: function () {
      var s = Game.state;
      var codex = (s && s.codex) || { items: [], lines: [], endings: [] };
      var names = [];
      for (var i = 0; i < codex.items.length; i++) {
        var it = itemOf(codex.items[i]);
        names.push(it && it.name ? it.name : codex.items[i]);
      }
      var best = Game.best();
      var body = '<p>物品图鉴：<b>' + names.length + '</b>' +
        (names.length ? '（' + names.join('、') + '）' : '（还没有）') + '</p>' +
        '<p>语录图鉴：<b>' + codex.lines.length + '</b> 句</p>' +
        '<p>结局称号：<b>' + codex.endings.length + '</b>' +
        (codex.endings.length ? '（' + codex.endings.join('、') + '）' : '（还没有）') + '</p>' +
        '<p class="muted">最佳：金币 ' + best.coins + ' · 最高第 ' + best.round + ' 轮</p>' +
        '<p class="fine">存档仅保存在本机浏览器（three_doors_codex_v1 / three_doors_best_v1），不上传。</p>';
      var ui = Game._ui();
      if (ui.openModal) {
        Game._safe(function () {
          ui.openModal({
            kind: 'codex', title: '图鉴', body: body,
            actions: [
              { label: '清空收集进度', choice: 'clear_codex' },
              { label: '关闭', choice: 'close', primary: true }
            ]
          });
        });
      }
      return codex;
    },

    _deltaText: function (result) {
      if (!result) return '';
      var parts = [];
      var it = itemOf(result.itemId);
      if (it && it.coins) parts.push('金币 ' + (it.coins > 0 ? '+' : '') + it.coins);
      if (it && it.patience) parts.push('耐心 ' + it.patience);
      if (it && it.suspicion) parts.push('怀疑值 ' + it.suspicion);
      return parts.length ? parts.join(' · ') : '没有任何变化';
    },

    _toast: function (msg) {
      var ui = Game._ui();
      if (ui.toast) Game._safe(function () { ui.toast(msg); });
    },

    _safe: function (fn) {
      try { fn(); } catch (e) { Game._warn('ui', e); }
    },

    _warn: function () {
      if (root.console && root.console.warn) {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[三扇门]');
        root.console.warn.apply(root.console, args);
      }
    }
  };

  root.Game = Game;

  /** DOM 就绪后自动启动（Node 无 DOM 时只挂载 API，便于无头测试）。 */
  if (typeof root.document !== 'undefined') {
    var boot = function () {
      if (root.GameBooted) return;
      root.GameBooted = true;
      Game.init({ mode: MODES.DEMO });
    };
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

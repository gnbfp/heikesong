/* ============================================================================
 * js/state.js —— 阶段 0「全局状态定稿」+ 可复现随机数（无 DOM、可在 Node 直接跑）
 * ----------------------------------------------------------------------------
 * 契约（冻结，勿改语义，只可扩展字段）：
 *   GameState            初始状态模板（Object.freeze，只读参照物）
 *   createInitialState(mode, opts) -> state   每次开局/重开都走这里
 *   STATES               状态机常量（阶段 1 表格逐字对应）
 *   CHOICES              决策按钮常量
 *   RNG                  固定种子随机数：{seed, cursor} 可快照、可重放
 *   cloneState(state)    深拷贝；渲染层禁止直接改 state 引用
 *   Emitter              极简订阅器：Emitter.on(fn) -> off()
 *   DEFAULT_RESOURCES    金币 100 / 怀疑值 2 / 耐心 3
 * 所有脚本挂在全局（经典脚本，零构建，file:// 双击可用）。
 * ========================================================================== */
(function (root) {
  'use strict';

  /** 状态机常量：与《开工清单》阶段 1 表格一一对应。所有切换只能走 Game.setState。 */
  var STATES = Object.freeze({
    IDLE: 'IDLE',
    ROUND_INTRO: 'ROUND_INTRO',
    NARRATOR: 'NARRATOR',
    PICK: 'PICK',
    HOST_OPEN: 'HOST_OPEN',
    DECIDE: 'DECIDE',
    REVEAL: 'REVEAL',
    SETTLE_ROUND: 'SETTLE_ROUND',
    CASHOUT: 'CASHOUT',
    GAME_OVER: 'GAME_OVER'
  });

  /** 决策按钮常量（阶段 1 五个按钮，阶段 2/3 补齐各自资源语义）。 */
  var CHOICES = Object.freeze({
    STICK: 'stick',
    SWITCH: 'switch',
    CHALLENGE: 'challenge',
    DOUBLE: 'double',
    CASHOUT: 'cashout'
  });

  var MODES = Object.freeze({ DEMO: 'demo', NORMAL: 'normal' });

  var DEFAULT_RESOURCES = Object.freeze({ coins: 100, suspicion: 2, patience: 3 });

  /** 演示模式固定种子（阶段 4）。 */
  var DEMO_SEED = 20261024;

  /**
   * 全局状态模板 —— 阶段 0 定稿字段。新增字段只能追加，且必须在下面给默认值。
   * 界面渲染只读本结构；动画回调里禁止直接改数值（统一走 applyEffect / Game.setState）。
   */
  var GameState = Object.freeze({
    mode: 'demo',                    // 'demo' | 'normal'
    phase: 'IDLE',                   // STATES 之一：状态机当前状态
    rng: { seed: 20261024, cursor: 0 },
    round: 1,
    doorCount: 3,                    // 契约 v5：本轮门数（3–6）
    coins: 100,
    suspicion: 2,
    patience: 3,
    items: [],                       // 背包：{ id, count }
    doors: [                         // 长度 3
      { slot: 0, itemId: 'small_prize', opened: false, revealed: false },
      { slot: 1, itemId: 'empty', opened: false, revealed: false },
      { slot: 2, itemId: 'bomb', opened: false, revealed: false }
    ],
    pickedSlot: null,
    peekUsed: false,
    doubled: false,
    narratorLines: [],               // 本轮 2 句
    hostOpenedSlot: null,
    log: [],                         // 每轮结果，用于结算页
    spentCoins: 0,                   // 商店累计消费（结算页“商店花了 X 金币”）
    shopBuys: 0,                     // 商店累计购买件数
    shopBought: {},                  // 即时商品的单局购买计数 { itemId: n }（背包商品看 items）
    itemBuffs: { fuse: false },      // 已激活的本轮道具增益（保险丝等）
    muteCardUsed: false,             // 闭嘴卡待生效：沉默「下一轮」的旁白，narrate 消费后自动清空
    codex: { items: [], lines: [], endings: [] },

    /* ---- 契约 v3 追加字段（新玩法 F1-F5） ---- */
    endingId: null,                  // 本局结局 id（computeEndingId 结果，结算页展示）
    challengesWon: 0,                // 本局识破次数（累计，不清零）
    challengesLost: 0,               // 本局质疑失败次数（累计）
    minCoins: 100,                   // 本局金币最低点（“绝地翻盘”结局判定用）

    /* ---- 契约 v4 追加字段（体验增强 G1-G8） ---- */
    personality: 'sarcastic',        // 旁白人格：'sarcastic' | 'gentle' | 'crazy'
    seedTag: null,                   // 本局种子标签（结算页展示 / 分享）
    achievements: [],                // 已解锁成就 id 列表（跨局持久）
    stats: null,                     // 统计档案对象（跨局持久，见 CodexStore.loadStats）
    flags: {
      skipAnim: false,
      muted: false,
      revealLocked: false,
      speakerMuted: false,
      onboarded: false,              // 新手引导是否已完成
      portraitWarned: false          // 竖屏降级提示是否已触发过
    }
  });

  var createInitialState = function createInitialState(mode, opts) {
    opts = opts || {};
    var res = opts.resources || DEFAULT_RESOURCES;
    return {
      mode: mode === MODES.NORMAL ? MODES.NORMAL : MODES.DEMO,
      phase: STATES.IDLE,
      rng: { seed: (opts.seed == null ? DEMO_SEED : opts.seed) >>> 0, cursor: 0 },
      round: 1,
      doorCount: 3,
      coins: res.coins,
      suspicion: res.suspicion,
      patience: res.patience,
      items: [],
      doors: [
        { slot: 0, itemId: 'small_prize', opened: false, revealed: false },
        { slot: 1, itemId: 'empty', opened: false, revealed: false },
        { slot: 2, itemId: 'bomb', opened: false, revealed: false }
      ],
      pickedSlot: null,
      peekUsed: false,
      doubled: false,
      narratorLines: [],
      hostOpenedSlot: null,
      log: [],
      spentCoins: 0,
      shopBuys: 0,
      shopBought: {},
      itemBuffs: { fuse: false },
      muteCardUsed: false,
      codex: { items: [], lines: [], endings: [] },

      /* ---- 契约 v3 追加字段（新玩法 F1-F5） ---- */
      endingId: null,
      challengesWon: 0,
      challengesLost: 0,
      minCoins: res.coins,

      /* ---- 契约 v4 追加字段（体验增强 G1-G8） ---- */
      personality: 'sarcastic',
      seedTag: null,
      achievements: [],
      stats: null,

      /* ---- 阶段 2+ 追加字段（默认值即“未触发”） ---- */
      grudge: 0,              // 连续质疑触发的“旁白记仇”层级，每层撒谎率 +20%
      challengeStreak: 0,     // 连续质疑成功次数（彩蛋用）
      switchStreak: 0,        // 连续换门次数（彩蛋用）
      emptyStreak: 0,         // 连续开空门次数（彩蛋用）
      doublesUsed: 0,         // 本局加倍次数
      roundResult: null,      // 本轮得失：{ itemId, coins, suspicion, patience, challenged }
      lastChallenge: null,    // 最近一次质疑结果（文案 + 判定）
      joinedAt: 0,            // 开局时间戳（结算页 / 计时用）
      flags: {
        skipAnim: false,
        muted: false,
        revealLocked: false,
        speakerMuted: false,
        rehearsal: opts.rehearsal === true,  // 契约 v3 §5.1：提词器（不写 localStorage，重置后保持）
        onboarded: false,
        portraitWarned: false
      }
    };
  };

  /** 深拷贝（优先 structuredClone，降级 JSON）。 */
  function cloneState(state) {
    if (state == null) return state;
    if (typeof structuredClone === 'function') {
      try { return structuredClone(state); } catch (e) { /* 含函数时降级 */ }
    }
    return JSON.parse(JSON.stringify(state));
  }

  /* ------------------------------------------------------------------ RNG */
  /** mulberry32 —— 32 位种子、单步确定性。 */
  function mulberry32(a) {
    return function () {
      a |= 0;a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * 随机数游标：为了「固定种子下连续跑 10 次结果完全一致」并支持快照/重放，
   * 每个 cursor 独立派生一个 mulberry32 单元（seed 与 cursor 混合），游标只增不减。
   */
  var RNG = {
    create: function (seed, cursor) {
      return { seed: (seed >>> 0) || 1, cursor: cursor >>> 0 || 0 };
    },
    /** [0,1) 浮点，推进 cursor。 */
    next: function (rng) {
      var mixed = (rng.seed ^ Math.imul((rng.cursor | 0) + 1, 0x9E3779B1)) >>> 0;
      var v = mulberry32(mixed)();
      rng.cursor = (rng.cursor | 0) + 1;
      return v;
    },
    /** [min, max] 闭区间整数。 */
    int: function (rng, min, max) {
      if (max < min) { var t = min; min = max; max = t; }
      return min + Math.floor(RNG.next(rng) * (max - min + 1));
    },
    /** 等概率取一项。 */
    pick: function (rng, arr) {
      if (!arr || !arr.length) return null;
      return arr[Math.floor(RNG.next(rng) * arr.length)];
    },
    /**
     * 按权重取一项。
     * @param entries 形如 [{ id, weight }] 或 [id, ...]（后者 weightOf 必填）
     */
    weighted: function (rng, entries, weightOf) {
      if (!entries || !entries.length) return null;
      var total = 0, i, w;
      for (i = 0; i < entries.length; i++) {
        w = Number(weightOf ? weightOf(entries[i]) : entries[i].weight) || 0;
        if (w > 0) total += w;
      }
      if (total <= 0) return entries[0];
      var roll = RNG.next(rng) * total;
      for (i = 0; i < entries.length; i++) {
        w = Number(weightOf ? weightOf(entries[i]) : entries[i].weight) || 0;
        if (w <= 0) continue;
        roll -= w;
        if (roll <= 0) return entries[i];
      }
      return entries[entries.length - 1];
    },
    /** 洗牌（Fisher-Yates），返回新数组，不改入参。 */
    shuffle: function (rng, arr) {
      var out = arr.slice();
      for (var i = out.length - 1; i > 0; i--) {
        var j = Math.floor(RNG.next(rng) * (i + 1));
        var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
      }
      return out;
    },
    snapshot: function (rng) { return { seed: rng.seed, cursor: rng.cursor }; }
  };

  /* -------------------------------------------------------------- Emitter */
  function Emitter() { this._handlers = []; }
  Emitter.prototype.on = function (fn) {
    var self = this;
    this._handlers.push(fn);
    return function off() {
      var i = self._handlers.indexOf(fn);
      if (i >= 0) self._handlers.splice(i, 1);
    };
  };
  Emitter.prototype.emit = function (evt) {
    var list = this._handlers.slice();
    for (var i = 0; i < list.length; i++) {
      try { list[i](evt); } catch (e) { if (root.console) root.console.error('[emitter]', e); }
    }
  };

  /** 取整并做 NaN 保护，资源结算统一走这里。 */
  function clampInt(v, min, max) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) n = 0;
    if (min != null && n < min) n = min;
    if (max != null && n > max) n = max;
    return n;
  }

  /* ------------------------------------------- 本地存档（阶段 5 P1，静默降级） */
  /**
   * 图鉴 / 最佳成绩本地存档。键名由《开工清单》阶段 5 固定：
   *   three_doors_codex_v1   物品图鉴 + 语录图鉴 + 结局称号
   *   three_doors_best_v1    最佳金币 / 最高轮次 / 已解锁称号
   * 任何异常（隐私模式、配额、无 localStorage 的 Node 测试环境、坏 JSON）
   * 都只返回空图鉴并返回 false，绝不上抛、绝不白屏。
   */
  var STORE_KEYS = Object.freeze({
    codex: 'three_doors_codex_v1',
    best: 'three_doors_best_v1',
    stats: 'three_doors_stats_v1',
    achievements: 'three_doors_achievements_v1',
    prefs: 'three_doors_prefs_v1'
  });

  function arr(v) { return Object.prototype.toString.call(v) === '[object Array]' ? v : []; }

  /** 拿到可用的 localStorage；不可用返回 null（不抛）。 */
  function backing() {
    try {
      var ls = root.localStorage;
      if (!ls || typeof ls.getItem !== 'function') return null;
      ls.setItem('__doors_probe__', '1');
      ls.removeItem('__doors_probe__');
      return ls;
    } catch (e) { return null; }
  }

  function readJson(key, fallback) {
    var ls = backing();
    if (!ls) return fallback;
    try {
      var raw = ls.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return (v && typeof v === 'object') ? v : fallback;
    } catch (e) { return fallback; }
  }

  function writeJson(key, value) {
    var ls = backing();
    if (!ls) return false;
    try { ls.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  function drop(key) {
    var ls = backing();
    if (!ls) return false;
    try { ls.removeItem(key); return true; } catch (e) { return false; }
  }

  var CodexStore = {
    keys: STORE_KEYS,
    /** 存档是否可用（浏览器且未被禁用）。 */
    available: function () { return !!backing(); },
    /** 读图鉴；失败/缺失 → 空图鉴。 */
    loadCodex: function () {
      var c = readJson(STORE_KEYS.codex, {});
      return { items: arr(c.items).slice(), lines: arr(c.lines).slice(), endings: arr(c.endings).slice() };
    },
    saveCodex: function (codex) {
      if (!codex) return false;
      return writeJson(STORE_KEYS.codex, {
        items: arr(codex.items), lines: arr(codex.lines), endings: arr(codex.endings)
      });
    },
    clearCodex: function () { return drop(STORE_KEYS.codex); },
    loadBest: function () {
      var b = readJson(STORE_KEYS.best, {});
      return { coins: Number(b.coins) || 0, round: Number(b.round) || 0, titles: arr(b.titles).slice() };
    },
    saveBest: function (best) {
      if (!best) return false;
      return writeJson(STORE_KEYS.best, {
        coins: Number(best.coins) || 0, round: Number(best.round) || 0, titles: arr(best.titles)
      });
    },
    clearBest: function () { return drop(STORE_KEYS.best); },

    /* ---- 契约 v4：统计档案 / 成就 / 偏好设置（同样静默降级） ---- */
    /** 读统计档案；失败/缺失 → 全 0。 */
    loadStats: function () {
      var s = readJson(STORE_KEYS.stats, {});
      return {
        games: Number(s.games) || 0,
        totalCoins: Number(s.totalCoins) || 0,
        bestCoins: Number(s.bestCoins) || 0,
        bestRound: Number(s.bestRound) || 0,
        challenges: Number(s.challenges) || 0,
        challengeWins: Number(s.challengeWins) || 0,
        endings: arr(s.endings).slice()
      };
    },
    saveStats: function (stats) {
      if (!stats) return false;
      return writeJson(STORE_KEYS.stats, {
        games: Number(stats.games) || 0,
        totalCoins: Number(stats.totalCoins) || 0,
        bestCoins: Number(stats.bestCoins) || 0,
        bestRound: Number(stats.bestRound) || 0,
        challenges: Number(stats.challenges) || 0,
        challengeWins: Number(stats.challengeWins) || 0,
        endings: arr(stats.endings)
      });
    },
    clearStats: function () { return drop(STORE_KEYS.stats); },
    /** 读已解锁成就 id 列表；失败 → []。 */
    loadAchievements: function () {
      var a = readJson(STORE_KEYS.achievements, {});
      return arr(a.ids || a).filter(function (x) { return typeof x === 'string'; }).slice();
    },
    saveAchievements: function (list) {
      return writeJson(STORE_KEYS.achievements, { ids: arr(list) });
    },
    clearAchievements: function () { return drop(STORE_KEYS.achievements); },
    /** 读偏好设置；失败 → 默认值。 */
    loadPrefs: function () {
      var p = readJson(STORE_KEYS.prefs, {});
      return {
        onboarded: p.onboarded === true,
        muted: p.muted === true,
        persona: typeof p.persona === 'string' ? p.persona : 'sarcastic',
        animationSpeed: typeof p.animationSpeed === 'string' ? p.animationSpeed : 'full',
        bgm: p.bgm !== false,
        sound: p.sound !== false,
        portraitWarned: p.portraitWarned === true,
        personasSeen: arr(p.personasSeen).slice()
      };
    },
    savePrefs: function (prefs) {
      if (!prefs) return false;
      return writeJson(STORE_KEYS.prefs, {
        onboarded: prefs.onboarded === true,
        muted: prefs.muted === true,
        persona: typeof prefs.persona === 'string' ? prefs.persona : 'sarcastic',
        animationSpeed: typeof prefs.animationSpeed === 'string' ? prefs.animationSpeed : 'full',
        bgm: prefs.bgm !== false,
        sound: prefs.sound !== false,
        portraitWarned: prefs.portraitWarned === true,
        personasSeen: arr(prefs.personasSeen)
      });
    },
    clearPrefs: function () { return drop(STORE_KEYS.prefs); },
    /** 清空收集进度（图鉴 + 最佳成绩 + 统计 + 成就 + 偏好）。 */
    clearAll: function () {
      var ok = false;
      [STORE_KEYS.codex, STORE_KEYS.best, STORE_KEYS.stats, STORE_KEYS.achievements, STORE_KEYS.prefs].forEach(function (k) {
        if (drop(k)) ok = true;
      });
      return ok;
    }
  };

  root.CodexStore = CodexStore;
  root.STORE_KEYS = STORE_KEYS;

  root.STATES = STATES;
  root.CHOICES = CHOICES;
  root.MODES = MODES;
  root.DEFAULT_RESOURCES = DEFAULT_RESOURCES;
  root.DEMO_SEED = DEMO_SEED;
  root.GameState = GameState;
  root.createInitialState = createInitialState;
  root.cloneState = cloneState;
  root.RNG = RNG;
  root.Emitter = Emitter;
  root.clampInt = clampInt;
})(typeof globalThis !== 'undefined' ? globalThis : this);

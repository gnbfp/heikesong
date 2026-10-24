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
    codex: { items: [], lines: [], endings: [] }
  });

  var createInitialState = function createInitialState(mode, opts) {
    opts = opts || {};
    var res = opts.resources || DEFAULT_RESOURCES;
    return {
      mode: mode === MODES.NORMAL ? MODES.NORMAL : MODES.DEMO,
      phase: STATES.IDLE,
      rng: { seed: (opts.seed == null ? DEMO_SEED : opts.seed) >>> 0, cursor: 0 },
      round: 1,
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
      codex: { items: [], lines: [], endings: [] },

      /* ---- 阶段 2+ 追加字段（默认值即“未触发”） ---- */
      grudge: 0,              // 连续质疑触发的“旁白记仇”层级，每层撒谎率 +20%
      challengeStreak: 0,     // 连续质疑成功次数（彩蛋用）
      switchStreak: 0,        // 连续换门次数（彩蛋用）
      emptyStreak: 0,         // 连续开空门次数（彩蛋用）
      doublesUsed: 0,         // 本局加倍次数
      roundResult: null,      // 本轮得失：{ itemId, coins, suspicion, patience, challenged }
      lastChallenge: null,    // 最近一次质疑结果（文案 + 判定）
      joinedAt: 0,            // 开局时间戳（结算页 / 计时用）
      flags: { skipAnim: false, muted: false, revealLocked: false, speakerMuted: false }
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

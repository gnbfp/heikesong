/* ============================================================================
 * js/effects.js —— 唯一资源结算入口 applyEffect（纯函数）
 * ----------------------------------------------------------------------------
 * 契约（《开工清单》阶段 2 + js/game.js 实际调用）：
 *   applyEffect(state, effect, opts) -> 新状态对象
 *     · 绝不修改入参 state / effect（纯函数），永不抛异常；
 *     · effect 可以是物品 id 字符串，也可以是内联描述：
 *         { id?, coins?, suspicion?, patience?, items?: [{ id, count }] }
 *       （引擎用它结算质疑：{ id:'challenge', coins:±20, suspicion:-1, patience:-1 }）
 *     · opts.multiplier（1|2）由调用方指定时优先；未指定时按 state.doubled 推导；
 *       source 为 'challenge' / 'item' 时不参与加倍（质疑成本与消耗品不该被翻倍）。
 *     · 返回值同时满足两种取用习惯：
 *         res.coins / res.patience / res.suspicion  —— 直接读新状态（tests/sim.js 约定）
 *         res.state / res.delta / res.events        —— 信封字段（js/game.js 约定）
 *       其中 res.state 是非枚举自引用，structuredClone / JSON.stringify 都不会产生环。
 *     · coins / suspicion 下限 0，耐心下限 0；耐心归零时写入 phase='GAME_OVER'。
 *     · 神秘盒走 state.rng + RNG.weighted，保证同种子完全可复现。
 * ========================================================================== */
(function (root) {
  'use strict';

  var RES_KEYS = ['coins', 'suspicion', 'patience'];
  var MAX_COINS = 999999;
  var MAX_SUSPICION = 99;
  var MAX_PATIENCE = 99;

  function gameData() { return root.GameData || null; }
  function config() { var d = gameData(); return (d && d.config) || {}; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  /**
   * 怀疑值上限：契约 v3 §2.2 要求挂在 config.suspicion.max（=3）；
   * 配置缺失时退回 MAX_SUSPICION（99），保证老存档/裸加载不至于卡死。
   */
  function suspicionMax() {
    var sus = config().suspicion || {};
    var m = Number(sus.max);
    return (isFinite(m) && m > 0) ? Math.round(m) : MAX_SUSPICION;
  }

  function clampInt(v, min, max) {
    if (typeof root.clampInt === 'function') {
      try { return root.clampInt(v, min, max); } catch (e) { /* 兜底走下面 */ }
    }
    var n = Math.round(num(v));
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }

  /** 按 id 取物品定义（含别名 shutup_card -> mute_card）。 */
  function itemDef(id) {
    var d = gameData();
    if (!d || !id) return null;
    if (typeof d.itemById === 'function') {
      var byFn = d.itemById(id);
      if (byFn) return byFn;
    }
    if (d.items && d.items[id]) return d.items[id];
    if (d.itemList && d.itemList.length) {
      for (var i = 0; i < d.itemList.length; i++) if (d.itemList[i].id === id) return d.itemList[i];
    }
    return null;
  }

  /** 深拷贝：优先用 state.js 的 cloneState，其次 structuredClone，最后 JSON 兜底。 */
  function cloneStateSafe(state) {
    if (state == null || typeof state !== 'object') return {};
    if (typeof root.cloneState === 'function') {
      try { return root.cloneState(state); } catch (e) { /* 继续尝试 */ }
    }
    if (typeof structuredClone === 'function') {
      try { return structuredClone(state); } catch (e) { /* 继续尝试 */ }
    }
    try {
      /* 跳过非枚举的自引用信封字段，避免 JSON 循环报错。 */
      return JSON.parse(JSON.stringify(state, function (k, v) { return k === 'state' ? undefined : v; }));
    } catch (e) { /* 最后兜底：浅拷贝 */ }
    var out = {};
    for (var k in state) if (Object.prototype.hasOwnProperty.call(state, k)) out[k] = state[k];
    return out;
  }

  /** 从 state.rng 取一个 [0,1) 随机数（确定性；无 RNG 时退化为同轮固定值）。 */
  function rngFloat(state) {
    var r = state && state.rng;
    if (r && root.RNG && typeof root.RNG.next === 'function') {
      try { return root.RNG.next(r); } catch (e) { /* 兜底 */ }
    }
    var seed = num(state && state.round) || 1;
    var x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  /** 神秘盒：随机小奖 / 小陷阱（权重取自 config.mystery.outcomes）。 */
  function rollMystery(state) {
    var cfg = config().mystery || {};
    var list = Array.isArray(cfg.outcomes) && cfg.outcomes.length
      ? cfg.outcomes
      : [{ id: 'small_prize', label: '小奖', weight: 60 }, { label: '小陷阱', coins: -15, weight: 40 }];
    var pick = null;
    if (state && state.rng && root.RNG && typeof root.RNG.weighted === 'function') {
      try { pick = root.RNG.weighted(state.rng, list, function (o) { return num(o.weight) || 1; }); } catch (e) { pick = null; }
    }
    if (!pick) {
      var total = 0, i;
      for (i = 0; i < list.length; i++) total += num(list[i].weight) || 1;
      var roll = rngFloat(state) * total, acc = 0;
      for (i = 0; i < list.length; i++) {
        acc += num(list[i].weight) || 1;
        if (roll < acc) { pick = list[i]; break; }
      }
      pick = pick || list[list.length - 1];
    }
    var item = pick && pick.id ? itemDef(pick.id) : null;
    return {
      label: (pick && (pick.label || pick.name)) || (item && item.name) || '神秘盒',
      coins: (pick && pick.coins != null) ? num(pick.coins) : (item ? num(item.coins) : 0),
      patience: (pick && pick.patience != null) ? num(pick.patience) : (item ? num(item.patience) : 0),
      suspicion: (pick && pick.suspicion != null) ? num(pick.suspicion) : (item ? num(item.suspicion) : 0),
      grantId: (item && item.special === 'gain_item') ? item.id : null
    };
  }

  /** 把字符串 / 内联描述统一成可结算的规格；未给出的数值字段回落到物品表。 */
  function normalizeEffect(effect) {
    var spec = { id: null, label: null, coins: null, suspicion: null, patience: null, grants: [], double: false, mystery: false };
    if (effect == null) return spec;

    if (typeof effect === 'string') {
      spec.id = effect;
    } else if (typeof effect === 'number') {
      spec.coins = num(effect);
    } else if (typeof effect === 'object') {
      if (effect.id != null) spec.id = String(effect.id);
      if (effect.label != null) spec.label = String(effect.label);
      if (effect.coins != null) spec.coins = num(effect.coins);
      if (effect.suspicion != null) spec.suspicion = num(effect.suspicion);
      if (effect.patience != null) spec.patience = num(effect.patience);
      if (Array.isArray(effect.items)) {
        for (var i = 0; i < effect.items.length; i++) {
          var g = effect.items[i];
          if (g && g.id) spec.grants.push({ id: String(g.id), count: clampInt(g.count == null ? 1 : g.count, 1, MAX_SUSPICION) });
        }
      }
    }
    if (spec.label == null) spec.label = spec.id;

    var def = spec.id ? itemDef(spec.id) : null;
    if (def) {
      if (spec.label == null || def.name) spec.label = def.name || spec.label;
      if (spec.coins == null) spec.coins = num(def.coins);
      if (spec.suspicion == null) spec.suspicion = num(def.suspicion);
      if (spec.patience == null) spec.patience = num(def.patience);
      if (def.special === 'gain_item') spec.grants.push({ id: def.id, count: 1 });
      if (def.special === 'double') spec.double = true;
      if (def.special === 'mystery') spec.mystery = true;
    } else {
      if (spec.coins == null) spec.coins = 0;
      if (spec.suspicion == null) spec.suspicion = 0;
      if (spec.patience == null) spec.patience = 0;
    }
    return spec;
  }

  /** 本轮已入账的正向金币（用于 double_coins 的「本轮收益×2」补一份）。 */
  function roundPositiveGain(state) {
    var coins = num(state && state.coins);
    var base = null;
    var log = state && state.log;
    if (Array.isArray(log) && log.length) {
      var last = log[log.length - 1];
      if (last && last.coinsAfter != null) base = num(last.coinsAfter);
      else if (last && last.coins != null) base = num(last.coins);
    }
    if (base == null) {
      var ini = config().initial;
      base = ini && ini.coins != null ? num(ini.coins) : null;
    }
    if (base == null) return 0;
    return Math.max(0, coins - base);
  }

  /** 结算翻倍系数：调用方显式指定优先，其次 state.doubled。 */
  function multiplierFor(state, opts) {
    if (opts && opts.multiplier != null) return num(opts.multiplier) >= 2 ? 2 : 1;
    var source = opts && opts.source;
    if (source === 'challenge' || source === 'item') return 1;
    return (state && state.doubled) ? 2 : 1;
  }

  /**
   * 纯函数结算入口。返回新状态（信封字段见文件头注释）。
   */
  function applyEffect(state, effect, opts) {
    var src = (state && typeof state === 'object') ? state : {};
    opts = opts || {};
    var spec = normalizeEffect(effect);
    var multiplier = multiplierFor(src, opts);

    var events = [];
    var dc = num(spec.coins), ds = num(spec.suspicion), dp = num(spec.patience);

    if (spec.mystery) {
      var m = rollMystery(src);
      dc += m.coins;
      ds += m.suspicion;
      dp += m.patience;
      if (m.grantId) spec.grants.push({ id: m.grantId, count: 1 });
      events.push({
        type: 'mystery', outcome: m.label, coins: m.coins,
        patience: m.patience, suspicion: m.suspicion, multiplier: multiplier
      });
    }

    dc *= multiplier;
    ds *= multiplier;
    dp *= multiplier;

    var next = cloneStateSafe(src);
    delete next.delta;
    delete next.events;
    delete next.state;

    /* double_coins：登记本轮加倍，并补一份本轮已赚到的正向金币。 */
    if (spec.double) {
      next.doubled = true;
      var copied = roundPositiveGain(src);
      if (copied > 0) dc += copied;
      events.push({ type: 'double_armed', multiplier: 2, copiedCoins: copied, source: opts.source || null });
    }

    var coins0 = num(next.coins);
    var sus0 = num(next.suspicion);
    var pat0 = num(next.patience);

    next.coins = clampInt(coins0 + dc, 0, MAX_COINS);
    next.suspicion = clampInt(sus0 + ds, 0, suspicionMax());
    next.patience = clampInt(pat0 + dp, 0, MAX_PATIENCE);

    var delta = {
      coins: next.coins - coins0,
      suspicion: next.suspicion - sus0,
      patience: next.patience - pat0
    };

    /* 背包入账（同 id 累加，不新增重复行）。 */
    if (spec.grants.length) {
      if (!Array.isArray(next.items)) next.items = [];
      for (var i = 0; i < spec.grants.length; i++) {
        var g = spec.grants[i];
        var found = null;
        for (var j = 0; j < next.items.length; j++) {
          if (next.items[j] && next.items[j].id === g.id) { found = next.items[j]; break; }
        }
        if (found) found.count = clampInt(num(found.count) + g.count, 0, 99);
        else next.items.push({ id: g.id, count: clampInt(g.count, 1, 99) });
        events.push({ type: 'item_gain', id: g.id, count: g.count });
      }
    }

    if (next.patience <= 0 && dp < 0) {
      events.push({ type: 'patience_zero', patience: next.patience });
      /* 只置标志位：状态机迁移统一由 game.js Game.setState 负责（阶段 1 P0）。 */
      next.gameOver = true;
    }

    var res = next;
    res.delta = delta;
    res.events = events;
    try {
      /* 非枚举自引用：game.js 读 res.state，而 JSON.stringify / structuredClone 不会形成环。 */
      Object.defineProperty(res, 'state', { value: res, enumerable: false, writable: true, configurable: true });
    } catch (e) { /* 极端环境下降级：直接用返回对象本身 */ }

    return res;
  }

  root.applyEffect = applyEffect;
  root.Effects = {
    applyEffect: applyEffect,
    normalizeEffect: normalizeEffect,
    multiplierFor: multiplierFor,
    suspicionMax: suspicionMax,
    itemDef: itemDef,
    rollMystery: rollMystery,
    RES_KEYS: RES_KEYS
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

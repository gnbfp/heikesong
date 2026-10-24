/* ============================================================================
 * js/narrator.js —— 旁白（别信旁白）唯一决策入口
 * ----------------------------------------------------------------------------
 * 契约（《开工清单》阶段 2/4 + js/game.js 实际调用）：
 *   Narrator.pickRoundLines(state, script) -> [line, line]（长度恒为 2）
 *     line = { id, text, kind, truthful }
 *     · script 非空（演示剧本）时按 script.narrator = 'truth'|'lie'|'lie_hard' 出牌；
 *     · script 为 null（普通模式）时用 state.rng 走 lieRate(state) 决定真/假，
 *       同 seed + 同 cursor 必得同一结果（不额外消耗随机数来做文案挑选）。
 *   Narrator.lieRate(state) -> 0..1：base + grudge × grudgeLieBonus（封顶 cap）。
 *   Narrator.resolveChallenge(state, line) -> { ok, rewardMode, coins, patience,
 *     suspicion, text, grudgeLevel, hint }：只判定，绝不改 state。
 *   Narrator.highlight(state, roundResult) -> 结算页高亮文案（字符串）。
 *   Narrator.special(state, trigger) -> line | null，trigger ∈ switch3 /
 *     challenge2 / empty3 / challenge（顺带兼容 intro / flavor）。
 * 语料全部来自 js/data.js 内联的 data/narrator.json，无外链、无 fetch。
 * ========================================================================== */
(function (root) {
  'use strict';

  function gameData() { return root.GameData || null; }
  function config() { var d = gameData(); return (d && d.config) || {}; }
  function doc() {
    var d = gameData();
    return (d && d.narrator) || { lines: [], pairs: {} };
  }
  function num(v, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback == null ? 0 : fallback;
    return n;
  }

  function lineById(id) {
    var list = doc().lines || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  /** 拷贝成独立 line，避免调用方（或 UI）改到内联语料。 */
  function cloneLine(l) {
    if (!l) return null;
    return {
      id: l.id,
      text: l.text,
      kind: l.kind,
      truthful: l.truthful !== false,
      trigger: l.trigger == null ? null : l.trigger
    };
  }

  function linesOfKind(kind) {
    var list = doc().lines || [];
    var out = [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].kind === kind) out.push(list[i]);
    return out;
  }

  /** 从 state.rng 取 [0,1)：可复现；无 RNG 时退化为与轮次绑定的确定值。 */
  function rngFloat(state) {
    var r = state && state.rng;
    if (r && root.RNG && typeof root.RNG.next === 'function') {
      try { return root.RNG.next(r); } catch (e) { /* 兜底 */ }
    }
    var seed = num(state && state.round, 1) || 1;
    var x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  /** 撒谎率：基础值 + 累计怨恨 × 每次 +20%，封顶。 */
  function lieRate(state) {
    var lies = config().lies || {};
    var sus = config().suspicion || {};
    var base = num(lies.base, 0.35);
    var bonus = num(sus.grudgeLieBonus, 0.2);
    var grudge = num(state && state.grudge, 0);
    var cap = num(lies.cap, 0.95);
    var rate = base + grudge * bonus;
    if (rate < 0) rate = 0;
    if (cap > 0 && rate > cap) rate = cap;
    return rate;
  }

  /** 普通模式下用 state.rng 决定本轮说真话还是撒谎。 */
  function rollMode(state) {
    var rate = lieRate(state);
    var roll = rngFloat(state);
    if (roll >= rate) return 'truth';
    var hardAt = num((config().lies || {}).hardLineGrudge, 2);
    return (num(state && state.grudge, 0) >= hardAt) ? 'lie_hard' : 'lie';
  }

  /**
   * 本轮旁白：恒定 2 句。第一句是判定句、第二句是补刀 —— 引擎用
   * narratorLines[0] 交给 resolveChallenge，所以两种模式的 truthfulness 必须整组一致。
   */
  function pickRoundLines(state, script) {
    var pairs = doc().pairs || {};
    var mode = null;
    if (script && typeof script === 'object') {
      var n = script.narrator;
      if (n === 'truth' || n === 'lie' || n === 'lie_hard') mode = n;
    }
    if (!mode) mode = rollMode(state);

    var list = pairs[mode];
    if (!Array.isArray(list) || !list.length) list = pairs.truth || [];
    var round = Math.max(1, Math.round(num(state && state.round, 1)));
    var out = [];
    if (list.length) {
      var idx = (round - 1) % list.length;
      var pair = list[idx] || list[0];
      for (var i = 0; i < pair.length; i++) {
        var l = cloneLine(lineById(pair[i]));
        if (l) out.push(l);
      }
    }

    /* 兜底：语料被裁剪时也要凑满 2 句，且保持 kind 一致。 */
    var pool = linesOfKind(mode === 'lie_hard' ? 'lie_hard' : mode);
    if (!pool.length) pool = linesOfKind('truth');
    for (var k = 0; out.length < 2 && pool.length && k < pool.length; k++) {
      out.push(cloneLine(pool[k]));
    }
    return out;
  }

  /** 质疑成功但配置给的是「真实提示」时的提示文本。 */
  function prizeHint(state) {
    var doors = (state && state.doors) || [];
    for (var i = 0; i < doors.length; i++) {
      if (doors[i] && doors[i].id === 'big_prize') return '真话：第 ' + (i + 1) + ' 扇门里是大奖。';
    }
    return '真话：这一轮没有大奖，别下注。';
  }

  function challengeText(state, kind) {
    var pool = linesOfKind(kind);
    if (!pool.length) return kind === 'challenge_win' ? '……算你赢。' : '我说的是真的，你偏不信。';
    var seed = Math.round(num(state && state.round, 1)) + Math.round(num(state && state.grudge, 0));
    return pool[Math.abs(seed) % pool.length].text;
  }

  /**
   * 判定质疑：line.truthful === false（旁白撒谎）才算成功。纯函数，不改 state。
   */
  function resolveChallenge(state, line) {
    var sus = config().suspicion || {};
    var cost = num(sus.cost, 1);
    var winCoins = num(sus.winCoins, 20);
    var loseCoins = num(sus.loseCoins, 20);
    var losePatience = num(sus.losePatience, 1);
    var rewardMode = sus.rewardMode === 'hint' ? 'hint' : 'coins';
    var lied = !!(line && line.truthful === false);

    var out = {
      ok: lied,
      rewardMode: rewardMode,
      coins: 0,
      patience: 0,
      suspicion: -cost,
      text: '',
      grudgeLevel: num(state && state.grudge, 0),
      hint: null
    };
    if (lied) {
      if (rewardMode === 'hint') {
        out.coins = 0;
        out.hint = prizeHint(state);
        out.text = out.hint;
      } else {
        out.coins = winCoins;
        out.text = challengeText(state, 'challenge_win');
      }
    } else {
      out.coins = -loseCoins;
      out.patience = -losePatience;
      out.text = challengeText(state, 'challenge_fail');
    }
    return out;
  }

  /** 结算页高亮文案：只用当前状态与当轮结果，纯字符串、不含 HTML。 */
  function highlight(state, roundResult) {
    var s = state || {};
    var r = roundResult || s.roundResult || {};
    var coins = num(s.coins, 0);
    var round = num(r.round, num(s.round, 1));
    var ending = s.ending || null;

    if (ending && ending.title) {
      return '你在第 ' + round + ' 轮收手，' + coins + ' 金币落袋——' + ending.title + '。';
    }
    if (s.patience <= 0 || s.gameOver) {
      return '你在第 ' + round + ' 轮被旁白劝退，只剩 ' + coins + ' 金币。';
    }
    var last = s.lastChallenge || null;
    if (last && last.ok) {
      return '你抓住了旁白的谎话，白拿 ' + num((config().suspicion || {}).winCoins, 20) + ' 金币。';
    }
    if (r.doubled) return '本轮加倍生效：收益和代价都翻了个身。';
    if (num(s.emptyStreak, 0) >= 3) return '三连空门，连旁白都替你尴尬。';
    if (r.itemId === 'bomb') return '一声闷响，金币和耐心一起少了。';
    if (r.itemId === 'big_prize') return '大奖到手，旁白的脸色不太好看。';
    return '第 ' + round + ' 轮结束：手气不好不坏。';
  }

  /** 彩蛋：按 trigger 取 line；state 上的连击数不满足需要时返回 null。 */
  function special(state, trigger) {
    if (!trigger) return null;
    var kind = (trigger === 'intro' || trigger === 'flavor') ? trigger : 'special';
    var list = [];
    var all = linesOfKind(kind);
    for (var i = 0; i < all.length; i++) {
      if (kind !== 'special' || all[i].trigger === trigger) list.push(all[i]);
    }
    if (!list.length) return null;

    var rules = config().specials;
    if (Array.isArray(rules)) {
      for (var j = 0; j < rules.length; j++) {
        var rule = rules[j];
        if (!rule || rule.trigger !== trigger) continue;
        var need = num(rule.need, 0);
        if (need > 0) {
          var field = rule.field || '';
          if (num(state && state[field], 0) < need) return null;
        }
        break;
      }
    }
    return cloneLine(list[0]);
  }

  root.Narrator = {
    pickRoundLines: pickRoundLines,
    lieRate: lieRate,
    resolveChallenge: resolveChallenge,
    highlight: highlight,
    special: special,
    lineById: lineById
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

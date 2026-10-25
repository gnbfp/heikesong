/* ============================================================================
 * js/narrator.js —— 旁白（别信旁白）唯一决策入口
 * ----------------------------------------------------------------------------
 * 契约（《开工清单》阶段 2/4 + js/game.js 实际调用）：
 *   Narrator.pickRoundLines(state, script) -> [line, line]（长度恒为 2）
 *     line = { id, text, kind, truthful[, claimable, claimType, claim, persona] }
 *     · script 非空（演示剧本）时按 script.narrator = 'truth'|'lie'|'lie_hard' 出牌；
 *     · script 为 null（普通模式）时用 state.rng 走 lieRate(state) 决定真/假，
 *       同 seed + 同 cursor 必得同一结果（不额外消耗随机数来做文案挑选）；
 *     · claimable 行会附一条可判定线索 claim（契约 v3 §1.1），只走 state.rng；
 *     · 契约 v4 §3.6：state.personality 合法时第 2 句换成人格开场 / 串场句，
 *       第 1 句仍是判定句，逐句带出 line.persona（供 UI 展示）。
 *   Narrator.lieRate(state) -> 0..1：base + grudge × grudgeLieBonus + 人格增量，
 *     夹在 [base, cap]（契约 v4 §3.6）。
 *   Narrator.settleLine(state, result) -> line | null：结算 / 收手点评，
 *     result.kind ∈ 'win' | 'lose' | 'cashout' | 'bust'，有人格时优先人格结算子池。
 *   Narrator.resolveChallenge(state, line) -> { ok, rewardMode, coins, patience,
 *     suspicion, text, grudgeLevel, hint, claim }：只判定，绝不改 state。
 *   Narrator.endingLine(state, endingId) -> line | null（结算页赛后点评）。
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
    var out = {
      id: l.id,
      text: l.text,
      kind: l.kind,
      truthful: l.truthful !== false,
      trigger: l.trigger == null ? null : l.trigger
    };
    if (l.claimable === true) {
      out.claimable = true;
      out.claimType = l.claimType || null;
    }
    if (l.claim) out.claim = l.claim;
    if (l.lineKind) out.lineKind = l.lineKind;
    return out;
  }

  function linesOfKind(kind) {
    var list = doc().lines || [];
    var out = [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].kind === kind) out.push(list[i]);
    return out;
  }

  /* ------------------------------------------------- 旁白人格（契约 v4 §3.1/§3.3/§3.6） */
  /* 人格只认 state.personality：非法 / 未设置一律回退通用池（缺配置不报错）。 */
  function personaOf(state) {
    var id = state && state.personality;
    if (typeof id !== 'string' || !id) return null;
    var d = gameData() || {};
    if (typeof d.personasById === 'function') return d.personasById(id) ? id : null;
    var list = d.personas || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return id;
    return null;
  }

  function personaDef(state) {
    var id = personaOf(state);
    if (!id) return null;
    var d = gameData() || {};
    if (typeof d.personasById === 'function') return d.personasById(id) || null;
    var list = d.personas || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  /** 人格撒谎率增量：夹在 ±config.personalities.lieRateDeltaCap（缺配置按 0.1）。 */
  function personaDeltaOf(state) {
    var def = personaDef(state);
    if (!def) return 0;
    var cap = num((config().personalities || {}).lieRateDeltaCap, 0.1);
    var d = num(def.lieRateDelta, 0);
    if (cap > 0) {
      if (d > cap) d = cap;
      if (d < -cap) d = -cap;
    }
    return d;
  }

  /** 结算点评池里按 id 取一条（人格子池的 settle 引用的是这里的 id）。 */
  function settleById(id) {
    var list = doc().settle || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  /**
   * 人格子池（intro 开场 / flavor 串场 / settle 结算）：未配置或引用失效返回空数组，
   * 调用方一律回退通用池。settle 取结算池，intro/flavor 取 lines。
   */
  function personaPool(state, key) {
    var pid = personaOf(state);
    if (!pid) return [];
    var table = doc().personas || {};
    var pool = table[pid];
    if (!pool || !Array.isArray(pool[key])) return [];
    var out = [];
    for (var i = 0; i < pool[key].length; i++) {
      var l = (key === 'settle') ? settleById(pool[key][i]) : lineById(pool[key][i]);
      if (l) out.push(key === 'settle' ? l : cloneLine(l));
    }
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

  /** 撒谎率：基础值 + 累计怨恨 × 每次 +20% + 人格增量，夹在 [base, cap]。 */
  function lieRate(state) {
    var lies = config().lies || {};
    var sus = config().suspicion || {};
    var base = num(lies.base, 0.35);
    var bonus = num(sus.grudgeLieBonus, 0.2);
    var grudge = num(state && state.grudge, 0);
    var cap = num(lies.cap, 0.95);
    var rate = base + grudge * bonus + personaDeltaOf(state);
    /* 契约 v4 §3.6：叠加人格增量后仍夹在 [base, cap]（温柔不会比基础更老实）。 */
    if (rate < base) rate = base;
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

  /* ---------------------------------------------------------------- 线索 */
  /* 契约 v3 §1.1：claimable 行可以带一条「可判定线索」，让质疑成功/失败 */
  /* 有客观依据。线索必须：按真实 state.doors 计算、避开主持人已开的门、 */
  /* 只走 state.rng（同种子可复现）、文案与槽位一致。                     */
  var CLAIM_TYPES = ['slot_kind', 'big_prize_in', 'picked_kind'];

  function itemIds() {
    var d = gameData() || {};
    var list = d.itemList || [];
    var out = [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id) out.push(list[i].id);
    if (!out.length) {
      var map = d.items || {};
      for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) out.push(k);
    }
    return out;
  }

  /** 门的统一视图：slot / itemId / opened（兼容 doors[i].id 命名）。 */
  function doorList(state) {
    var doors = (state && state.doors) || [];
    var out = [];
    for (var i = 0; i < doors.length; i++) {
      var d = doors[i];
      if (!d) continue;
      out.push({
        slot: (d.slot == null) ? i : Number(d.slot),
        itemId: d.itemId || d.id || null,
        opened: !!d.opened
      });
    }
    return out;
  }

  function pickedSlotOf(state) {
    var s = state || {};
    var p = (s.pickedSlot != null) ? s.pickedSlot
      : (s.selectedSlot != null) ? s.selectedSlot
        : (s.picked != null) ? s.picked : null;
    var n = Number(p);
    return (p != null && isFinite(n) && n >= 0) ? n : null;
  }

  function pickFrom(state, list) {
    if (!list || !list.length) return null;
    var r = state && state.rng;
    if (r && root.RNG && typeof root.RNG.pick === 'function') {
      try { return root.RNG.pick(r, list); } catch (e) { /* 兜底 */ }
    }
    var f = rngFloat(state);
    var idx = Math.floor(f * list.length);
    if (idx < 0) idx = 0;
    if (idx >= list.length) idx = list.length - 1;
    return list[idx];
  }

  /** 从文案里解析「N 号门」，保证 claim.slot 与播出的字一致。 */
  function slotFromText(text) {
    var m = String(text == null ? '' : text).match(/([1-9])\s*号门/);
    return m ? Number(m[1]) - 1 : null;
  }

  /**
   * 为一条 claimable 行生成线索；不可行时返回 null（例如 picked_kind 但玩家
   * 还没选门 —— 引擎在开旁白前不让玩家选门，故该类型延迟到质疑时刻生成）。
   * usedSlots 是同一轮内已占用的槽位（避免同一轮两句线索自相矛盾）。
   */
  function claimFor(state, line, usedSlots) {
    var src = (line && typeof line === 'object') ? line : lineById(line);
    if (!src || src.claimable !== true) return null;
    var type = src.claimType;
    if (CLAIM_TYPES.indexOf(type) < 0) return null;

    var doors = doorList(state);
    if (!doors.length) return null;
    var open = [];
    for (var i = 0; i < doors.length; i++) if (!doors[i].opened) open.push(doors[i]);
    if (!open.length) return null;

    var truth = (src.kind === 'truth');
    var used = usedSlots || [];

    function free(list) {
      var out = [];
      for (var j = 0; j < list.length; j++) {
        if (used.indexOf(list[j].slot) < 0) out.push(list[j]);
      }
      return out.length ? out : list;
    }
    function bySlot(slot) {
      for (var j = 0; j < open.length; j++) if (open[j].slot === slot) return open[j];
      return null;
    }
    function otherKind(id) {
      var all = itemIds();
      var alt = [];
      for (var j = 0; j < all.length; j++) if (all[j] !== id) alt.push(all[j]);
      return pickFrom(state, alt);
    }

    if (type === 'picked_kind') {
      var ps = pickedSlotOf(state);
      if (ps == null) return null;
      var pd = bySlot(ps);
      if (!pd || pd.itemId == null) return null;
      var pk = truth ? pd.itemId : (otherKind(pd.itemId) || pd.itemId);
      return { type: 'picked_kind', kind: pk, truthful: pk === pd.itemId };
    }

    if (type === 'big_prize_in') {
      if (truth) {
        var hit = null;
        for (var b = 0; b < open.length; b++) {
          if (open[b].itemId === 'big_prize') { hit = open[b]; break; }
        }
        if (!hit) return null;
        used.push(hit.slot);
        return { type: 'big_prize_in', slot: hit.slot, truthful: true };
      }
      var noTop = [];
      for (var c = 0; c < open.length; c++) if (open[c].itemId !== 'big_prize') noTop.push(open[c]);
      if (!noTop.length) return null;
      var lp = pickFrom(state, free(noTop));
      if (!lp) return null;
      used.push(lp.slot);
      return { type: 'big_prize_in', slot: lp.slot, truthful: false };
    }

    /* slot_kind：优先文案里点名的那扇门，保证「N 号门」与 claim.slot 一致。 */
    var named = slotFromText(src.text);
    var target = (named == null) ? null : bySlot(named);
    if (!target) target = pickFrom(state, free(open));
    if (!target) return null;
    if (truth && target.itemId == null) return null;
    var kind = truth ? target.itemId : (otherKind(target.itemId) || target.itemId);
    used.push(target.slot);
    return { type: 'slot_kind', slot: target.slot, kind: kind, truthful: kind === target.itemId };
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
    var usedSlots = [];
    function attach(l) {
      if (!l) return null;
      var c = claimFor(state, l, usedSlots);
      if (c) l.claim = c;
      return l;
    }
    var out = [];
    if (list.length) {
      var idx = (round - 1) % list.length;
      var pair = list[idx] || list[0];
      for (var i = 0; i < (pair || []).length; i++) {
        var l = attach(cloneLine(lineById(pair[i])));
        if (l) out.push(l);
      }
    }

    /* 兜底：语料被裁剪时也要凑满 2 句，且保持 kind 一致。 */
    var pool = linesOfKind(mode === 'lie_hard' ? 'lie_hard' : mode);
    if (!pool.length) pool = linesOfKind('truth');
    for (var k = 0; out.length < 2 && pool.length && k < pool.length; k++) {
      out.push(attach(cloneLine(pool[k])));
    }

    /* 契约 v4 §3.6：有人格时第 2 句改用该人格的串场句（第 1 轮取开场池，之后取串场池），
       第 1 句仍是 mode 判定句 —— 引擎用 narratorLines[0] 判定真伪，人格不改变判定。 */
    var pid = personaOf(state);
    if (pid) {
      var pkey = round <= 1 ? 'intro' : 'flavor';
      var pLines = personaPool(state, pkey);
      if (!pLines.length) pLines = personaPool(state, pkey === 'intro' ? 'flavor' : 'intro');
      for (var pi = 0; pi < out.length; pi++) if (out[pi]) out[pi].persona = pid;
      if (pLines.length && out.length >= 2) {
        var pl = pickFrom(state, pLines);
        if (pl) {
          pl.persona = pid;
          out[1] = pl;
        }
      }
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
   * 判定质疑：优先用 line.claim（线索真伪），没有线索时回退旧路径
   * line.truthful === false。纯函数，不改 state。
   */
  function resolveChallenge(state, line) {
    var sus = config().suspicion || {};
    var cost = num(sus.cost, 1);
    var winCoins = num(sus.winCoins, 20);
    var loseCoins = num(sus.loseCoins, 20);
    var losePatience = num(sus.losePatience, 1);
    var rewardMode = sus.rewardMode === 'hint' ? 'hint' : 'coins';

    /* claim 已在 pickRoundLines 生成则原样带回；picked_kind 这类当时不可行的
       线索（引擎先播旁白、后让玩家选门）在这里用同一 state 补生成一次。 */
    var claim = (line && line.claim) ? line.claim : null;
    if (!claim && line && line.claimable === true) claim = claimFor(state, line, null);
    var lied = claim ? !claim.truthful : !!(line && line.truthful === false);

    var out = {
      ok: lied,
      rewardMode: rewardMode,
      coins: 0,
      patience: 0,
      suspicion: -cost,
      text: '',
      grudgeLevel: num(state && state.grudge, 0),
      hint: null,
      claim: claim || null
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

  /**
   * 结局赛后点评：endingId（computeEndingId 的结果）→ config.endings[id].lineKind
   * → narrator.endings[lineKind] 里随机一句。纯读，走 state.rng 可复现。
   */
  function endingLine(state, endingId) {
    if (!endingId) return null;
    var table = doc().endings || {};
    var def = (config().endings || {})[endingId] || null;
    var keys = [];
    if (def && def.lineKind) keys.push(def.lineKind);
    keys.push(endingId);
    keys.push('ending_' + endingId);
    var pool = null;
    for (var i = 0; i < keys.length && !pool; i++) {
      var list = table[keys[i]];
      if (Array.isArray(list) && list.length) pool = list;
    }
    if (!pool) return null;
    var l = cloneLine(pickFrom(state, pool));
    if (l) {
      if (!l.kind) l.kind = 'ending';
      l.lineKind = keys[0];
    }
    return l;
  }

  var SETTLE_RESULTS = ['win', 'lose', 'cashout', 'bust'];

  /** result 没给（或给了非法值）时，按 state 兜底推断结算类型。 */
  function inferSettleKind(state, result) {
    var s = state || {};
    var rr = s.roundResult || {};
    var r = (result && typeof result === 'object') ? result : {};
    if (s.gameOver || num(s.patience, 1) <= 0 || r.bust || rr.bust) return 'bust';
    if (r.cashout || rr.cashout || s.ending) return 'cashout';
    var c = num(r.coins !== undefined ? r.coins : rr.coins, NaN);
    if (isFinite(c)) return c > 0 ? 'win' : (c < 0 ? 'lose' : 'cashout');
    return 'cashout';
  }

  /**
   * 结算 / 收手点评：result.kind ∈ win | lose | cashout | bust（也接受直接传字符串）。
   * 有人格时优先人格结算子池（且只取同 result 的行），挑句走 state.rng，同种子可复现。
   * 纯读，不改 state。
   */
  function settleLine(state, result) {
    var kind = '';
    if (typeof result === 'string') kind = result;
    else if (result && typeof result === 'object') kind = result.kind || result.result || '';
    if (SETTLE_RESULTS.indexOf(kind) < 0) kind = inferSettleKind(state, result);

    var list = doc().settle || [];
    var pool = [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].result === kind) pool.push(list[i]);
    if (!pool.length) pool = list;
    if (!pool.length) return null;

    var preferred = [];
    var personaList = personaPool(state, 'settle');
    for (var j = 0; j < personaList.length; j++) {
      if (personaList[j] && personaList[j].result === kind) preferred.push(personaList[j]);
    }
    if (preferred.length) pool = preferred;

    var l = cloneLine(pickFrom(state, pool));
    if (!l) return null;
    if (!l.kind) l.kind = 'settle';
    l.result = kind;
    return l;
  }

  /** 按门后真实 kind 取提示池：先精确匹配 forKind，再退回 any。 */
  function hintPoolFor(kind) {
    var list = doc().hints || [];
    var exact = [];
    var any = [];
    for (var i = 0; i < list.length; i++) {
      var h = list[i];
      if (!h || !h.text) continue;
      if (h.forKind === kind) exact.push(h);
      else if (h.forKind === 'any') any.push(h);
    }
    return exact.length ? exact : any;
  }

  /**
   * 质疑成功后的「具体提示」（设计契约 v6 §2.2）：返回 { text, truthful, slot }。
   * - truthful 是【旁白那一句】的真假（true = 旁白这次没骗你），由调用方或 claim 给出；
   * - text 是必真的门后情报：claim 有 slot 时按那扇门的**真实** kind 取句（谎话 claim 的
   *   kind 是反的，所以一律以 doors 里的真实 itemId 为准），把「N 号门」换成门号；
   * - 拿不到具体门 / 语料时返回 null，交给 js/game.js 的兜底文案。
   * 纯读：只在挑句时推进 state.rng，同种子可复现。
   */
  function hint(state, opts) {
    opts = opts || {};
    var claim = opts.claim || null;
    var doors = doorList(state);
    var slot = null;
    if (claim && num(claim.slot, -1) >= 0) slot = Math.round(num(claim.slot, -1));
    if (slot == null || slot < 0) slot = pickedSlotOf(state);
    if (slot == null || slot < 0) {
      for (var i = 0; i < doors.length; i++) {
        if (!doors[i].opened) { slot = doors[i].slot; break; }
      }
    }
    if (slot == null || slot < 0) return null;

    var door = null;
    for (var j = 0; j < doors.length; j++) if (doors[j].slot === slot) door = doors[j];
    if (!door || !door.itemId) return null;

    var data = gameData();
    var def = (data && data.items) ? data.items[door.itemId] : null;
    var kind = (def && def.kind) ? def.kind : (claim && claim.kind) || null;
    var pool = hintPoolFor(kind);
    if (!pool.length) return null;
    var picked = pickFrom(state, pool);
    if (!picked || !picked.text) return null;

    var slotLabel = '第 ' + (slot + 1) + ' 号门';
    var text = String(picked.text).replace(/N\s*号门/g, slotLabel);
    var truthful = null;
    if (typeof opts.truthful === 'boolean') truthful = opts.truthful;
    else if (claim && typeof claim.truthful === 'boolean') truthful = claim.truthful;
    return {
      text: text,
      truthful: truthful,
      slot: slot,
      kind: kind,
      id: picked.id || '',
      hintKind: picked.forKind || 'any'
    };
  }

  /**
   * 死亡台词（设计契约 v6 §2.5）：从 narrator.death 里挑一句，kind 为 'death'。
   * 走 state.rng 可复现；语料缺失返回 null，交给 js/game.js 的兜底文案。
   */
  function deathLine(state) {
    var list = doc().death || [];
    if (!Array.isArray(list) || !list.length) return null;
    var l = cloneLine(pickFrom(state, list));
    if (!l) return null;
    if (!l.kind) l.kind = 'death';
    return l;
  }

  /** 彩蛋：按 trigger 取 line；state 上的连击数不满足需要时返回 null。 */
  function special(state, trigger) {
    if (!trigger) return null;
    var kind = (trigger === 'intro' || trigger === 'flavor') ? trigger : 'special';
    /* 开场 / 串场句优先走人格子池（按轮次轮播，不额外消耗随机数）。 */
    if (kind !== 'special') {
      var pp = personaPool(state, kind);
      if (pp.length) {
        var prd = Math.max(1, Math.round(num(state && state.round, 1)));
        return pp[(prd - 1) % pp.length];
      }
    }
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
    /* 同一 trigger 有多句彩蛋时按轮次轮播（不额外消耗随机数）。 */
    var rd = Math.max(1, Math.round(num(state && state.round, 1)));
    return cloneLine(list[(rd - 1) % list.length]);
  }

  root.Narrator = {
    pickRoundLines: pickRoundLines,
    lieRate: lieRate,
    resolveChallenge: resolveChallenge,
    highlight: highlight,
    special: special,
    endingLine: endingLine,
    settleLine: settleLine,
    hint: hint,
    deathLine: deathLine,
    personaOf: personaOf,
    personaDelta: personaDeltaOf,
    claimFor: claimFor,
    lineById: lineById
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ============================================================================
 * tests/home.js —— 契约 v6「命运之门：首页 / 规则修正 / 剧情」验收（§5）
 * ----------------------------------------------------------------------------
 * 覆盖 docs/设计契约_v6_首页与规则修正.md：
 *   V0  接口与数据在场（hostPick(state) 单参 / hintText / beginSwitch 三件套 /
 *       wallet 三件套 / 难度两件套 / upgrades 两件套 / CodexStore 六方法 /
 *       存档键 / config.difficulty / config.story / data/upgrades.json /
 *       config.hostOpenLabel）
 *   V1  §2.1 主持人空门池：1000 次发牌样本（每局 ≥2 no-prize、≤1 大奖、
 *       3 门 = big+empty+empty）；1000 次 hostPick 样本（100% no-prize 且非玩家所选）；
 *       剧本 hostOpensSlot 违规 → hostScriptFallback=true 并退回真实 hostPick；
 *       data/seed_demo.json 每轮 hostOpensSlot 必须指向空门。
 *   V2  §2.2 质疑必给提示：lastHint.text 非空、含「门」或「真/假」、truthful 为布尔、
 *       Game.hintText() 与之一致、UI/DOM 里真的显示出来。
 *   V3  §2.3 换门两段式：decide('switch')/beginSwitch 只进入选门态（phase 仍 DECIDE、
 *       flags.switchPick=true、候选 ≥1、弹层 kind='switch'）；chooseSwitch 合法槽位才
 *       换门 + REVEAL 且扣费；非法槽位被拒；cancelSwitch 回 DECIDE 不扣费；
 *       action 路由 choose_switch / cancel_switch。
 *   V4  §2.4 钱包 / 升级 / 难度：saveWallet→wallet 读回、spendWallet 不足不改档、
 *       重启后从 localStorage 读回；buyUpgrade 扣钱 / 等级上限 / 重启读回；
 *       难度三档初值（金币/怀疑/耐心）与 lieBase；升级在难度初值上叠加。
 *   V5  §2.5/§4 首页与文案：<title> 含「命运之门」；#boot 含 3 个 [data-diff] 与
 *       #home-coins；剧情 3 段渲染；死亡弹层「你死了」；收手弹层「活下来了」；
 *       决策区高亮引导 .is-primary 与 #stage-hint 文案；主持人开门文案。
 *   V6  计数
 * 真实命令：node tests/home.js      （0 = 全绿，1 = 有 FAIL，2 = 运行时异常）
 * 说明：引擎/UI/数据三路与测试并行落地，本套件按契约「先写断言」，未落地的接口
 *       一律记 FAIL 并写明原因（绝不抛未捕获异常、绝不把缺失当 PASS）。
 *       由 tests/run-all.js 注册为正式套件。
 * ========================================================================== */
'use strict';

var path = require('path');
var fs = require('fs');
var L = require('./lib.js');
var Sh = require('./dom-shim.js');

var ck = new L.Checker('home.js —— 契约 v6（首页 / 主持人空门池 / 质疑提示 / 换门两段式 / 钱包升级难度）');

var SEED = 20261024;
var FIXED_NOW = 1730000000000;
var nV = 0;

/** 所有断言都过这里，便于末尾统计条数。 */
function c(id, cond, msg, detail) { nV++; return ck.ok(id, cond, msg, detail); }
/** 前置条件门：不满足时记 FAIL 并返回 false，后续依赖用例据此跳过（不误报 PASS）。 */
function gate(id, cond, msg, detail) { return c(id, cond, msg, detail); }

/* ------------------------------------------------------------------ 加载 */

var load = L.loadScripts({ withDom: false });
var G = load.sandbox;

if (!load.loaded.length) {
  ck.fail('V0.0', 'js/ 下至少要有 state.js / data.js / effects.js / narrator.js / ui.js / game.js 可加载',
    '缺失：' + load.missing.join(', ') + (load.errors.length ? '；错误：' + load.errors.join(' | ') : ''));
  ck.print();
  process.exit(1);
}

var gd = L.loadGameData(load.ctx, load.sandbox);
var DATA = gd.data || {};
var CFG = DATA.config || {};
var ITEMS = DATA.items || {};
var UPGRADES = DATA.upgrades || null;

function kindOfId(id) {
  var it = ITEMS[id];
  if (it && it.kind) return it.kind;
  if (id === 'big_prize' || id === 'small_prize' || id === 'jackpot') return 'prize';
  if (id === 'empty') return 'no-prize';
  if (id === 'bomb' || id === 'trap' || id === 'landmine' || id === 'quicksand') return 'hazard';
  return 'unknown';
}
function idsOf(doors) { return doors.map(function (d) { return d.itemId; }).join('/'); }
function jsonOf(x) { return JSON.stringify(x); }

var HAS = {
  game: !!(G.Game && typeof G.Game.init === 'function'),
  hostPick: !!(G.Game && typeof G.Game.hostPick === 'function'),
  hint: !!(G.Game && typeof G.Game.hintText === 'function'),
  sw: !!(G.Game && typeof G.Game.beginSwitch === 'function' &&
    typeof G.Game.chooseSwitch === 'function' && typeof G.Game.cancelSwitch === 'function'),
  wallet: !!(G.Game && typeof G.Game.wallet === 'function' &&
    typeof G.Game.saveWallet === 'function' && typeof G.Game.spendWallet === 'function'),
  diff: !!(G.Game && typeof G.Game.setDifficulty === 'function' && typeof G.Game.difficulty === 'function'),
  upg: !!(G.Game && typeof G.Game.upgrades === 'function' && typeof G.Game.buyUpgrade === 'function'),
  store: !!(G.CodexStore && typeof G.CodexStore.saveWallet === 'function' &&
    typeof G.CodexStore.loadWallet === 'function' && typeof G.CodexStore.saveUpgrades === 'function')
};

/* ------------------------------------------------------------------ 工具 */

function untilMs(pred, ms) {
  return new Promise(function (res) {
    var t0 = Date.now();
    (function step() {
      var v = false;
      try { v = !!pred(); } catch (e) { v = false; }
      if (v) return res(true);
      if (Date.now() - t0 > (ms || 4000)) return res(false);
      setTimeout(step, 15);
    })();
  });
}

function lastModalOf(rec, kind) {
  for (var k = rec.modals.length - 1; k >= 0; k--) {
    if (!kind || rec.modals[k].kind === kind) return rec.modals[k];
  }
  return null;
}

/** 假 localStorage（跨 loadScripts 复用同一份 → 模拟「重启后读回」）。 */
function fakeStorage() {
  var map = {};
  return {
    _map: map,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    setItem: function (k, v) { map[k] = String(v); },
    removeItem: function (k) { delete map[k]; },
    clear: function () { map = {}; },
    key: function (i) { var ks = Object.keys(map); return i < ks.length ? ks[i] : null; },
    get length() { return Object.keys(map).length; }
  };
}

function mkGame(mode, seed, over, storage) {
  var ui = L.recordingUI();
  var deps = {
    ui: ui,
    data: DATA,
    applyEffect: G.applyEffect,
    narrator: G.Narrator,
    setTimeout: L.immediateTimeout,
    clearTimeout: function () { return 0; },
    now: function () { return FIXED_NOW; },
    location: { search: '', hash: '', protocol: 'file:', href: 'file:///index.html' }
  };
  /* 存档后端必须走全局 CodexStore（它有 loadPrefs/savePrefs/loadWallet...）。
     引擎的 Game._store() 会**原样**返回 deps.store，而 prefsOf()/writePrefs() 只认
     loadPrefs/savePrefs —— 传裸 localStorage 会让偏好静默不落盘（钱包/升级却因 storeRef()
     校验回退而正常）。故这里只改 sandbox.localStorage，不覆盖 deps.store。 */
  if (storage) { G.localStorage = storage; }
  /* deps.store 必须显式指向 CodexStore：Game._store() 只认 deps.store，缺了它 prefs 一律读不到 */
  deps.store = G.CodexStore || null;
  if (over) {
    for (var k in over) {
      if (Object.prototype.hasOwnProperty.call(over, k)) deps[k] = over[k];
    }
  }
  G.Game.init({
    mode: mode || 'demo',
    seed: seed == null ? SEED : seed,
    doors: (mode === 'normal' && !(over && over.doors)) ? 3 : (over && over.doors),
    deps: deps
  });
  return { Game: G.Game, ui: ui, rec: ui.rec, deps: deps };
}

/** 开局并等到可交互相位；mode 'demo' 走剧本，'normal' 走权重池。 */
function startGame(mode, storage, over) {
  var g = mkGame(mode, SEED, over, storage);
  G.Game.action({ type: 'start', mode: mode === 'demo' ? 'demo' : 'normal' });
  return g;
}

async function toPick(ms) {
  return untilMs(function () { return G.Game.state.phase === 'PICK'; }, ms || 4000);
}
async function toDecide(ms) {
  return untilMs(function () { return G.Game.state.phase === 'DECIDE'; }, ms || 4000);
}
/** 选第一扇未开的门 → DECIDE。 */
async function pickFirstOpen() {
  var doors = G.Game.state.doors || [];
  for (var i = 0; i < doors.length; i++) {
    if (!doors[i].opened) { G.Game.action({ type: 'pick', slot: i }); break; }
  }
  return toDecide();
}
/** 走到「本轮 DECIDE」：demo 剧本每轮都可用。 */
async function freshToDecide(mode, storage) {
  startGame(mode || 'normal', storage);
  var ok = await toPick();
  if (!ok) return false;
  return pickFirstOpen();
}

async function main() {

  /* ======================================================================
   * V0 接口与数据在场（契约 §2）
   * ==================================================================== */

  ck.section('契约 v6 §2｜接口与数据在场');

  gate('V0.1', HAS.game, 'Game 可加载且 init 可用', '缺失：Game.init');
  gate('V0.2', HAS.hostPick, 'Game.hostPick 存在（§2.1）', '缺失：Game.hostPick');
  c('V0.3', HAS.hostPick && G.Game.hostPick.length === 1,
    'Game.hostPick(state) 为契约单参签名（§2.1）',
    '实际 arity=' + (HAS.hostPick ? G.Game.hostPick.length : '-'));
  c('V0.4', HAS.hint, 'Game.hintText() 存在（§2.2）', '缺失：Game.hintText');
  c('V0.5', HAS.sw, 'Game.beginSwitch/chooseSwitch/cancelSwitch 三件套存在（§2.3）',
    '缺失：' + ['beginSwitch', 'chooseSwitch', 'cancelSwitch'].filter(function (k) {
      return !(G.Game && typeof G.Game[k] === 'function');
    }).join(', '));
  c('V0.6', HAS.wallet, 'Game.wallet/saveWallet/spendWallet 存在（§2.4）',
    '缺失：' + ['wallet', 'saveWallet', 'spendWallet'].filter(function (k) {
      return !(G.Game && typeof G.Game[k] === 'function');
    }).join(', '));
  c('V0.7', HAS.diff, 'Game.setDifficulty/difficulty 存在（§2.4）',
    '缺失：' + ['setDifficulty', 'difficulty'].filter(function (k) {
      return !(G.Game && typeof G.Game[k] === 'function');
    }).join(', '));
  c('V0.8', HAS.upg, 'Game.upgrades/buyUpgrade 存在（§2.4）',
    '缺失：' + ['upgrades', 'buyUpgrade'].filter(function (k) {
      return !(G.Game && typeof G.Game[k] === 'function');
    }).join(', '));
  c('V0.9', HAS.store,
    'CodexStore 含 loadWallet/saveWallet/clearWallet 与 loadUpgrades/saveUpgrades/clearUpgrades（§2.4）',
    '缺失：' + ['loadWallet', 'saveWallet', 'clearWallet', 'loadUpgrades', 'saveUpgrades', 'clearUpgrades']
      .filter(function (k) { return !(G.CodexStore && typeof G.CodexStore[k] === 'function'); }).join(', '));
  c('V0.10', !!(G.STORE_KEYS && G.STORE_KEYS.wallet === 'three_doors_wallet_v1' &&
    G.STORE_KEYS.upgrades === 'three_doors_upgrades_v1'),
    '存档键 = three_doors_wallet_v1 / three_doors_upgrades_v1（§2.4）',
    '实际 STORE_KEYS=' + jsonOf(G.STORE_KEYS || {}));
  /* 难度表既可能是扁平 {normal:...}，也可能是 v6 引擎的 {default,order,tiers:{...}} 形状 */
  function diffTier(id) {
    var d = CFG.difficulty || {};
    if (d.tiers && d.tiers[id]) return d.tiers[id];
    return d[id] || {};
  }
  var diffOk = !!(diffTier('normal').id || diffTier('normal').coins != null) &&
    !!(diffTier('hard').id || diffTier('hard').coins != null) &&
    !!(diffTier('hell').id || diffTier('hell').coins != null);
  c('V0.11', diffOk, 'config.difficulty 三档齐备（§2.4/§3.2）',
    'difficulty=' + jsonOf(CFG.difficulty));
  c('V0.12', Array.isArray(CFG.story) && CFG.story.length >= 3,
    'config.story 至少 3 段（§2.5/§3.2）', 'story=' + jsonOf(CFG.story));
  var upList = UPGRADES ? (Array.isArray(UPGRADES) ? UPGRADES : (UPGRADES.items || UPGRADES.list || [])) : [];
  c('V0.13', upList.length >= 6, 'data/upgrades.json 已并入产物且 ≥6 条升级（§2.4/§3.5）',
    'upgrades=' + upList.length + ' 条' + (upList[0] ? '；例=' + jsonOf(upList[0].id) : ''));
  c('V0.14', CFG.hostOpenLabel === '一扇空门', 'config.hostOpenLabel = 「一扇空门」（§2.1/§3.2）',
    '实际 ' + jsonOf(CFG.hostOpenLabel));

  /* ======================================================================
   * V1 §2.1 主持人空门池
   * ==================================================================== */

  ck.section('§2.1 主持人只开空门（1000 样本）');

  var dealBad = [], threeBad = [], N_DEAL = 1000;
  if (HAS.game) {
    mkGame('normal', SEED);              // 仅用于拿到可复用的 Game.state（纯函数调用）
    for (var i = 0; i < N_DEAL; i++) {
      var n = 3 + (i % 4);               // 3–6 门
      var round = 1 + (i % 8);
      G.Game.state.doorCount = n;
      G.Game.state.round = round;
      var doors = G.Game.generateDoors(round);
      var empties = 0, bigs = 0, smalls = 0;
      doors.forEach(function (d) {
        var k = kindOfId(d.itemId);
        if (k === 'no-prize') empties++;
        if (d.itemId === 'big_prize') bigs++;
        if (d.itemId === 'small_prize') smalls++;
      });
      if (doors.length !== n || empties < 2 || bigs > 1) {
        dealBad.push({ n: n, round: round, ids: idsOf(doors), empties: empties, bigs: bigs });
      }
      if (n === 3 && !(empties === 2 && bigs === 1 && smalls === 0)) {
        threeBad.push({ round: round, ids: idsOf(doors), empties: empties, bigs: bigs, smalls: smalls });
      }
    }
  }

  c('V1.1', HAS.game && dealBad.length === 0,
    N_DEAL + ' 次发牌样本：每局 ≥2 扇 no-prize、≤1 扇 big_prize（§2.1 发牌不变量）',
    '违规 ' + dealBad.length + ' 例；样例=' + jsonOf(dealBad.slice(0, 3)));
  c('V1.2', HAS.game && threeBad.length === 0,
    '3 门发牌恒为 big_prize + empty + empty（小奖 4 门起，§2.1）',
    '违规 ' + threeBad.length + ' 例；样例=' + jsonOf(threeBad.slice(0, 3)));

  /* hostPick 1000 样本：只从 no-prize 且非玩家所选里挑（state 调用 + 旧 2 参调用都要合法） */
  var pickBad = [], pickBadLegacy = [], pickNull = [], pickErr = null, pickSamples = 0;
  if (HAS.hostPick && HAS.game) {
    for (var j = 0; j < 1000; j++) {
      var n2 = 3 + (j % 4);
      var round2 = 1 + (j % 8);
      G.Game.state.doorCount = n2;
      G.Game.state.round = round2;
      var doors2 = G.Game.generateDoors(round2);
      var picked = j % n2;
      /* 契约 §2.1：hostPick(state) 从 state.doors + state.pickedSlot 读牌面，测试必须把这一手真实写进 state */
      G.Game.state.doors = doors2;
      G.Game.state.pickedSlot = picked;
      var hs = null, hsLegacy = null;
      try {
        hs = G.Game.hostPick(G.Game.state);
        hsLegacy = G.Game.hostPick(doors2, picked);
      } catch (e) { pickErr = String(e && e.message ? e.message : e); break; }
      pickSamples++;
      if (hs == null) { pickNull.push({ ids: idsOf(doors2), picked: picked }); continue; }
      var hk = kindOfId(doors2[hs].itemId);
      if (hk !== 'no-prize' || hs === picked) {
        pickBad.push({ ids: idsOf(doors2), picked: picked, host: hs, hostItem: doors2[hs].itemId, kind: hk });
      }
      if (hsLegacy == null) {
        pickBadLegacy.push({ ids: idsOf(doors2), picked: picked, host: null, why: 'null' });
      } else if (kindOfId(doors2[hsLegacy].itemId) !== 'no-prize' || hsLegacy === picked) {
        pickBadLegacy.push({ ids: idsOf(doors2), picked: picked, host: hsLegacy, hostItem: doors2[hsLegacy].itemId });
      }
    }
  }
  c('V1.3', HAS.hostPick && pickErr == null && pickSamples === 1000 && pickNull.length === 0,
    '主持人恒有门可开：1000 次 hostPick 无 null 返回（§2.1）',
    '异常=' + pickErr + '；样本=' + pickSamples + '；null ' + pickNull.length + ' 例' +
    (pickNull[0] ? '；样例=' + jsonOf(pickNull.slice(0, 2)) : ''));
  c('V1.4', HAS.hostPick && pickBad.length === 0,
    '主持人开的门 100% 为 no-prize 且非玩家所选（hostPick(state)，1000 样本，§2.1 硬不变量）',
    '违规 ' + pickBad.length + ' 例；样例=' + jsonOf(pickBad.slice(0, 3)));
  c('V1.4b', HAS.hostPick && pickBadLegacy.length === 0,
    '旧 2 参调用 hostPick(doors, pickedSlot) 同样只开 no-prize 且非玩家所选（1000 样本，兼容性）',
    '违规 ' + pickBadLegacy.length + ' 例；样例=' + jsonOf(pickBadLegacy.slice(0, 3)));

  /* 剧本 hostOpensSlot 违规 → hostScriptFallback */
  async function scriptRun(hostSlot, pickSlot) {
    var saved = DATA.seedDemo;
    DATA.seedDemo = {
      seed: 777001,
      rounds: [{
        round: 1, doors: ['big_prize', 'empty', 'empty'],
        hostOpensSlot: hostSlot, narrator: 'truth', expect: 'big_prize'
      }]
    };
    var g = mkGame('demo', 777001);
    G.Game.action({ type: 'start', mode: 'demo' });
    var ok = await untilMs(function () { return G.Game.state.phase === 'PICK'; }, 4000);
    if (!ok) {
      DATA.seedDemo = saved;
      return { err: '未到 PICK，phase=' + G.Game.state.phase };
    }
    G.Game.action({ type: 'pick', slot: pickSlot });
    await untilMs(function () {
      var p = G.Game.state.phase;
      return p === 'DECIDE' || p === 'GAME_OVER' || p === 'CASHOUT';
    }, 4000);
    var s = G.Game.state;
    var out = {
      fallback: s.hostScriptFallback,
      host: s.hostOpenedSlot,
      picked: s.pickedSlot,
      hostItem: (s.hostOpenedSlot != null && s.doors[s.hostOpenedSlot]) ? s.doors[s.hostOpenedSlot].itemId : null,
      phase: s.phase
    };
    DATA.seedDemo = saved;
    return out;
  }

  var scriptBadCase = null, scriptPickedCase = null, scriptGoodCase = null;
  if (HAS.game) {
    scriptBadCase = await scriptRun(0, 1);   // hostOpensSlot=0 是大奖门 → 违规
    scriptPickedCase = await scriptRun(1, 1); // hostOpensSlot=1 是玩家所选 → 违规
    scriptGoodCase = await scriptRun(2, 1);  // hostOpensSlot=2 是空门且未被选 → 合规
  }
  c('V1.5', !!scriptBadCase && scriptBadCase.fallback === true &&
    scriptBadCase.host !== scriptBadCase.picked && scriptBadCase.hostItem === 'empty',
    '剧本 hostOpensSlot 指向大奖门（0 号）时 hostScriptFallback=true 且改开空门（§2.1）',
    jsonOf(scriptBadCase));
  c('V1.6', !!scriptPickedCase && scriptPickedCase.fallback === true &&
    scriptPickedCase.host !== scriptPickedCase.picked && scriptPickedCase.hostItem === 'empty',
    '剧本 hostOpensSlot 指向玩家所选门时 hostScriptFallback=true 且改开空门（§2.1）',
    jsonOf(scriptPickedCase));
  c('V1.7', !!scriptGoodCase && scriptGoodCase.fallback === false &&
    scriptGoodCase.host === 2 && scriptGoodCase.hostItem === 'empty',
    '剧本 hostOpensSlot 合法（空门且未被选）时按剧本开且 fallback=false（§2.1）',
    jsonOf(scriptGoodCase));

  /* 真实剧本（data/seed_demo.json）：门数可变（3/4/5/6，见 Lead m02939 裁定 2），
     每轮仍必须「≥2 空门 + ≤1 大奖 + hostOpensSlot 指向空门」。 */
  var realRounds = (DATA.seedDemo && DATA.seedDemo.rounds) || [];
  var realScriptBad = [];
  var doorCountsOk = realRounds.length >= 3 && realRounds.every(function (r) {
    return Array.isArray(r.doors) && r.doors.length >= 3 && r.doors.length <= 6;
  });
  realRounds.forEach(function (r) {
    var ids = r.doors || [];
    var empties = ids.filter(function (id) { return kindOfId(id) === 'no-prize'; }).length;
    var bigs = ids.filter(function (id) { return id === 'big_prize'; }).length;
    var hs = r.hostOpensSlot;
    var bad = [];
    if (!(ids.length >= 3 && ids.length <= 6)) bad.push('门数=' + ids.length);
    if (empties < 2) bad.push('空门=' + empties);
    if (bigs > 1) bad.push('大奖=' + bigs);
    if (hs == null || !ids[hs]) bad.push('hostOpensSlot 非法=' + hs);
    else if (kindOfId(ids[hs]) !== 'no-prize') bad.push('hostOpensSlot=' + hs + ' 指向 ' + ids[hs]);
    if (bad.length) realScriptBad.push({ round: r.round, ids: ids.join('/'), issues: bad.join('；') });
  });
  c('V1.8', doorCountsOk && realScriptBad.length === 0,
    'data/seed_demo.json 每轮门数在 3–6 之间、且都满足「≥2 空门 + hostOpensSlot 指向空门」（§3.3，v6 变门数）',
    '轮数=' + realRounds.length + '；门数=' + realRounds.map(function (r) { return (r.doors || []).length; }).join('/') +
    '；违规 ' + realScriptBad.length + ' 轮：' + jsonOf(realScriptBad));

  /* ======================================================================
   * V2 §2.2 质疑必给提示
   * ==================================================================== */

  ck.section('§2.2 质疑后必有提示（lastHint / hintText / UI 显示）');

  async function hintRounds() {
    var g = mkGame('demo', SEED);
    G.Game.action({ type: 'start', mode: 'demo' });
    var rows = [];
    for (var r = 1; r <= 3; r++) {
      var ok = await untilMs(function () { return G.Game.state.phase === 'PICK'; }, 4000);
      if (!ok) { rows.push({ round: r, err: '未到 PICK：' + G.Game.state.phase }); break; }
      var doors = G.Game.state.doors || [];
      var slot = 0;
      for (var i = 0; i < doors.length; i++) { if (!doors[i].opened) { slot = i; break; } }
      G.Game.action({ type: 'pick', slot: slot });
      if (!(await untilMs(function () { return G.Game.state.phase === 'DECIDE'; }, 4000))) {
        rows.push({ round: r, err: '未到 DECIDE：' + G.Game.state.phase });
        break;
      }
      G.Game.action({ type: 'decide', choice: 'challenge' });
      var s = G.Game.state;
      rows.push({
        round: r,
        hint: s.lastHint || null,
        hintText: (typeof G.Game.hintText === 'function') ? G.Game.hintText() : null,
        challengeOk: !!(s.lastChallenge && s.lastChallenge.ok),
        coins: s.coins,
        suspicion: s.suspicion
      });
      G.Game.action({ type: 'decide', choice: 'stick' });
      var settled = await untilMs(function () {
        var p = G.Game.state.phase;
        return p === 'SETTLE_ROUND' || p === 'GAME_OVER' || p === 'CASHOUT';
      }, 4000);
      if (!settled || G.Game.state.phase !== 'SETTLE_ROUND') break;
      G.Game.action({ type: 'settle', choice: 'continue' });
    }
    return rows;
  }

  var hints = HAS.game ? await hintRounds() : [];
  var hintRows = hints.filter(function (r) { return !r.err; });
  var hintMissing = hintRows.filter(function (r) {
    return !r.hint || typeof r.hint.text !== 'string' || r.hint.text.length === 0;
  });
  c('V2.1', hintRows.length >= 2 && hintMissing.length === 0,
    '每轮质疑后 state.lastHint.text 非空（§2.2 必给提示）',
    '有效轮=' + hintRows.length + '；缺失 ' + hintMissing.length + '：' + jsonOf(hints));
  var hintBadText = hintRows.filter(function (r) {
    return !r.hint || !/门|真|假/.test(String(r.hint.text));
  });
  c('V2.2', hintRows.length >= 2 && hintBadText.length === 0,
    'lastHint.text 含「N 号门」或「真/假」语义（§2.2）',
    '不合规 ' + hintBadText.length + '：' + jsonOf(hintBadText.map(function (r) { return r.hint && r.hint.text; })));
  var hintBadFlag = hintRows.filter(function (r) { return !r.hint || typeof r.hint.truthful !== 'boolean'; });
  c('V2.3', hintRows.length >= 2 && hintBadFlag.length === 0,
    'lastHint.truthful 为布尔（§2.2）',
    '不合规 ' + hintBadFlag.length + '：' + jsonOf(hintRows.map(function (r) { return r.hint; })));
  var hintTextMismatch = hintRows.filter(function (r) {
    return !HAS.hint || r.hintText !== (r.hint && r.hint.text);
  });
  c('V2.4', HAS.hint && hintRows.length >= 2 && hintTextMismatch.length === 0,
    'Game.hintText() 返回当前 lastHint.text（§2.2）',
    HAS.hint ? ('不一致 ' + hintTextMismatch.length + ' 轮：' + jsonOf(hintTextMismatch))
      : '缺失 Game.hintText');

  /* UI/DOM 里真的显示出来（页面走真定时器：压 timings + 固定一条可质疑的行，避免随机到不可 claim 的行） */
  var domHintOk = false, domHintDetail = '未执行';
  if (HAS.game && HAS.hint) {
    try {
      var page = Sh.createPage();
      var P = page.sandbox;
      speedUpPage(P);
      if (P.Narrator && P.Narrator.pickRoundLines) {
        P.Narrator.pickRoundLines = function (state) {
          var slot = 0;
          for (var i2 = 0; i2 < state.doors.length; i2++) {
            if (state.doors[i2].itemId !== 'empty') { slot = i2; break; }
          }
          return [{
            id: 'V2_claim_r' + state.round, text: '第 ' + (slot + 1) + ' 号门是空门。',
            kind: 'lie', truthful: false,
            claim: { type: 'slot_kind', slot: slot, kind: 'empty', truthful: false }
          }];
        };
      }
      P.Game.action({ type: 'start', mode: 'demo' });
      await untilMs(function () { return P.Game.state.phase === 'PICK'; }, 15000);
      P.Game.action({ type: 'pick', slot: 0 });
      await untilMs(function () { return P.Game.state.phase === 'DECIDE'; }, 15000);
      P.Game.action({ type: 'decide', choice: 'challenge' });
      var want = P.Game.state.lastHint && P.Game.state.lastHint.text;
      await untilMs(function () { return (P.Game.hintText() || '').length > 0; }, 4000);
      var body = (page.doc.body && page.doc.body.textContent) || '';
      var hintNode = page.doc.querySelector('.hint-claim');
      domHintOk = !!(want && (body.indexOf(want) >= 0 || (hintNode && String(hintNode.textContent).indexOf(want) >= 0)));
      domHintDetail = 'want=' + jsonOf(want) + '；phase=' + P.Game.state.phase +
        '；body 命中=' + !!(want && body.indexOf(want) >= 0) +
        '；.hint-claim=' + (hintNode ? jsonOf(String(hintNode.textContent).slice(0, 60)) : 'null');
    } catch (e) {
      domHintDetail = '异常：' + (e && e.message ? e.message : String(e));
    }
  }
  c('V2.5', domHintOk, '质疑提示在真实页面的 DOM 里可见（§2.2/§4.5）', domHintDetail);

  /* ======================================================================
   * V3 §2.3 换门两段式
   * ==================================================================== */

  ck.section('§2.3 换门 = 重新选门（两段式）');

  var sw1 = null, sw2 = null, sw3 = null, sw4 = null, sw5 = null, sw6 = null;
  if (HAS.sw && HAS.game) {
    /* V3.1 beginSwitch 只进入选门态 */
    var g3 = startGame('normal');
    if (await toPick() && await pickFirstOpen()) {
      var s3 = G.Game.state;
      var pickedBefore = s3.pickedSlot;
      var coinsBefore = s3.coins;
      var ret = null;
      try { ret = G.Game.beginSwitch(); } catch (e) { ret = { err: String(e && e.message ? e.message : e) }; }
      var modal3 = lastModalOf(g3.rec, 'switch');
      sw1 = {
        ret: ret, phase: G.Game.state.phase, pickedBefore: pickedBefore,
        pickedAfter: G.Game.state.pickedSlot, coinsBefore: coinsBefore, coinsAfter: G.Game.state.coins,
        switchPick: !!(G.Game.state.flags && G.Game.state.flags.switchPick),
        modal: modal3 ? { kind: modal3.kind, title: modal3.title, actions: (modal3.actions || []).length } : null
      };
      /* V3.3 chooseSwitch(合法) → 换门 + 进入开奖 + 扣费 */
      var cands = (ret && ret.candidates) || [];
      if (cands.length) {
        var target = cands[0];
        var before = { coins: G.Game.state.coins, picked: G.Game.state.pickedSlot, items: (G.Game.state.items || []).length };
        var okSw = null;
        try { okSw = G.Game.chooseSwitch(target); } catch (e) { okSw = { err: String(e && e.message ? e.message : e) }; }
        await untilMs(function () {
          var p = G.Game.state.phase;
          return p === 'REVEAL' || p === 'SETTLE_ROUND' || p === 'GAME_OVER' || p === 'CASHOUT';
        }, 4000);
        sw3 = {
          target: target, ret: okSw, phase: G.Game.state.phase,
          picked: G.Game.state.pickedSlot, coinsBefore: before.coins, coinsAfter: G.Game.state.coins,
          cost: (ret && ret.cost != null) ? ret.cost : null,
          switchPick: !!(G.Game.state.flags && G.Game.state.flags.switchPick)
        };
      } else {
        sw3 = { err: 'beginSwitch 未给出 candidates', ret: ret };
      }
    } else {
      sw1 = { err: '未到 DECIDE：' + G.Game.state.phase };
      sw3 = { err: '前置未到 DECIDE' };
    }

    /* V3.2 decide('switch') 同样只进入选门态（不自动换门） */
    var g3b = startGame('normal');
    if (await toPick() && await pickFirstOpen()) {
      var pB = G.Game.state.pickedSlot, cB = G.Game.state.coins;
      G.Game.action({ type: 'decide', choice: 'switch' });
      var modalB = lastModalOf(g3b.rec, 'switch');
      sw2 = {
        phase: G.Game.state.phase, pickedBefore: pB, pickedAfter: G.Game.state.pickedSlot,
        coinsBefore: cB, coinsAfter: G.Game.state.coins,
        switchPick: !!(G.Game.state.flags && G.Game.state.flags.switchPick),
        modal: modalB ? modalB.kind : null
      };
      /* V3.4 非法槽位被拒 + V3.5 cancelSwitch 不扣费 */
      var badSlot = pB;                 /* 候选外：玩家自己那扇门 */
      var c4 = G.Game.state.coins;
      var badRet = null;
      try { badRet = G.Game.chooseSwitch(badSlot); } catch (e) { badRet = { err: String(e && e.message ? e.message : e) }; }
      var badRet2 = null;               /* 候选外：越界槽位 */
      try { badRet2 = G.Game.chooseSwitch(99); } catch (e) { badRet2 = { err: String(e && e.message ? e.message : e) }; }
      sw4 = {
        badSlot: badSlot, pickedBefore: pB, ret: badRet, ret2: badRet2, phase: G.Game.state.phase,
        picked: G.Game.state.pickedSlot, coinsBefore: c4, coinsAfter: G.Game.state.coins,
        switchPick: !!(G.Game.state.flags && G.Game.state.flags.switchPick)
      };
      var c5 = G.Game.state.coins;
      var cancelRet = null;
      try { cancelRet = G.Game.cancelSwitch(); } catch (e) { cancelRet = { err: String(e && e.message ? e.message : e) }; }
      sw5 = {
        ret: cancelRet, phase: G.Game.state.phase,
        coinsBefore: c5, coinsAfter: G.Game.state.coins,
        switchPick: !!(G.Game.state.flags && G.Game.state.flags.switchPick),
        picked: G.Game.state.pickedSlot
      };
    } else {
      sw2 = { err: '未到 DECIDE：' + G.Game.state.phase };
    }

    /* V3.6 action 路由 choose_switch / cancel_switch */
    var g3c = startGame('normal');
    if (await toPick() && await pickFirstOpen()) {
      G.Game.action({ type: 'decide', choice: 'switch' });
      var cands6 = (G.Game.state.flags && G.Game.state.flags.switchCandidates) || null;
      var routeCancel = G.Game.action({ type: 'cancel_switch' });
      var afterCancel = { phase: G.Game.state.phase, switchPick: !!(G.Game.state.flags && G.Game.state.flags.switchPick) };
      G.Game.action({ type: 'decide', choice: 'switch' });
      var candsAfter = null;
      try { var rr = G.Game.beginSwitch(); candsAfter = rr && rr.candidates; } catch (e) { candsAfter = null; }
      var routeChoose = null;
      if (candsAfter && candsAfter.length) routeChoose = G.Game.action({ type: 'choose_switch', slot: candsAfter[0] });
      await untilMs(function () {
        var p = G.Game.state.phase;
        return p === 'REVEAL' || p === 'SETTLE_ROUND' || p === 'GAME_OVER' || p === 'CASHOUT';
      }, 3000);
      sw6 = {
        cancelRet: routeCancel, afterCancel: afterCancel, cands: cands6,
        chooseRet: routeChoose, picked: G.Game.state.pickedSlot,
        phase: G.Game.state.phase,
        switchPick: !!(G.Game.state.flags && G.Game.state.flags.switchPick)
      };
    } else {
      sw6 = { err: '未到 DECIDE：' + G.Game.state.phase };
    }
  }

  c('V3.1', !!sw1 && sw1.ret && sw1.ret.ok === true && sw1.phase === 'DECIDE' &&
    sw1.switchPick === true && sw1.pickedAfter === sw1.pickedBefore && sw1.coinsAfter === sw1.coinsBefore &&
    Array.isArray(sw1.ret.candidates) && sw1.ret.candidates.length >= 1,
    'beginSwitch() 只进入选门态：phase 仍 DECIDE、switchPick=true、候选 ≥1、未扣费（§2.3）',
    jsonOf(sw1));
  c('V3.2', !!sw1 && !!sw1.modal && sw1.modal.kind === 'switch',
    'beginSwitch() 打开 kind="switch" 选门弹层（§2.3/§4.2）', jsonOf(sw1 && sw1.modal));
  c('V3.3', !!sw2 && sw2.phase === 'DECIDE' && sw2.switchPick === true &&
    sw2.pickedAfter === sw2.pickedBefore && sw2.coinsAfter === sw2.coinsBefore && sw2.modal === 'switch',
    "decide('switch') 不再自动换门，同样只进入选门态（§2.3 兼容条款）", jsonOf(sw2));
  c('V3.4', !!sw3 && sw3.ret && sw3.ret !== false && sw3.picked === sw3.target &&
    ['REVEAL', 'SETTLE_ROUND', 'GAME_OVER', 'CASHOUT'].indexOf(sw3.phase) >= 0 && sw3.switchPick === false &&
    sw3.coinsAfter === sw3.coinsBefore - (sw3.cost || 0),
    'chooseSwitch(合法) → 换门 + 进入开奖 + 按 cost 扣费（§2.3）', jsonOf(sw3));
  c('V3.5', !!sw4 && sw4.ret === false && sw4.ret2 === false && sw4.phase === 'DECIDE' &&
    sw4.picked === sw4.pickedBefore && sw4.coinsAfter === sw4.coinsBefore && sw4.switchPick === true,
    'chooseSwitch(候选外/自己那扇门/越界) 被拒：门与金币不变、仍停在选门态（§2.3）', jsonOf(sw4));
  c('V3.6', !!sw5 && sw5.ret !== false && sw5.phase === 'DECIDE' &&
    sw5.switchPick === false && sw5.coinsAfter === sw5.coinsBefore,
    'cancelSwitch() 回到 DECIDE 且不扣费（§2.3）', jsonOf(sw5));
  c('V3.7', !!sw6 && sw6.cancelRet === true && sw6.afterCancel.phase === 'DECIDE' &&
    sw6.afterCancel.switchPick === false && sw6.chooseRet === true &&
    sw6.picked != null && ['REVEAL', 'SETTLE_ROUND', 'GAME_OVER', 'CASHOUT'].indexOf(sw6.phase) >= 0,
    "action 路由：{type:'cancel_switch'} / {type:'choose_switch',slot} 均生效（§2.3）", jsonOf(sw6));

  /* ======================================================================
   * V4 §2.4 钱包 / 升级 / 难度
   * ==================================================================== */

  ck.section('§2.4 钱包 / 升级 / 难度');

  function loadWith(storage) {
    var l = L.loadScripts({ withDom: false, globals: { localStorage: storage } });
    var d = L.loadGameData(l.ctx, l.sandbox);
    var S = l.sandbox;
    if (S.Game && typeof S.Game.init === 'function') {
      S.Game.init({
        mode: 'normal', seed: 1, doors: 3,
        deps: {
          ui: L.recordingUI(), data: d.data, applyEffect: S.applyEffect, narrator: S.Narrator,
          setTimeout: L.immediateTimeout, clearTimeout: function () { return 0; },
          localStorage: storage
        }
      });
    }
    return { sandbox: S, data: d.data };
  }

  var walletRun = null;
  if (HAS.wallet && HAS.store) {
    var st4 = fakeStorage();
    var A = loadWith(st4);
    var GA = A.sandbox.Game;
    if (A.sandbox.CodexStore && typeof A.sandbox.CodexStore.clearWallet === 'function') A.sandbox.CodexStore.clearWallet();
    var w0 = GA.wallet();
    GA.saveWallet(123);
    var w1 = GA.wallet();
    var sp1 = GA.spendWallet(23);
    var w2 = GA.wallet();
    var sp2 = GA.spendWallet(1000);
    var w3 = GA.wallet();
    var keys4 = Object.keys(st4._map);
    var B = loadWith(st4);              // 重启：同一 localStorage
    var w4 = B.sandbox.Game.wallet();
    walletRun = {
      w0: w0, w1: w1, sp1: sp1, w2: w2, sp2: sp2, w3: w3, w4: w4,
      keys: keys4, raw: st4._map[G.STORE_KEYS ? G.STORE_KEYS.wallet : 'three_doors_wallet_v1']
    };
  }
  c('V4.1', !!walletRun && walletRun.w0 === 0 && walletRun.w1 === 123,
    'saveWallet(123) → wallet() === 123（§2.4）', jsonOf(walletRun));
  c('V4.2', !!walletRun && walletRun.sp1 === true && walletRun.w2 === 100 &&
    walletRun.sp2 === false && walletRun.w3 === 100,
    'spendWallet：够则扣、不足返回 false 且不改档（§2.4）', jsonOf(walletRun));
  c('V4.3', !!walletRun && walletRun.w4 === 100,
    '钱包落盘键 three_doors_wallet_v1，重启后读回 100（§2.4）', jsonOf(walletRun));

  var upgRun = null;
  if (HAS.upg && HAS.wallet && HAS.store) {
    var st5 = fakeStorage();
    var C = loadWith(st5);
    var GC = C.sandbox.Game;
    var list5 = GC.upgrades() || [];
    var first = list5[0] || null;
    C.sandbox.CodexStore.clearWallet();
    var poor = first ? GC.buyUpgrade(first.id) : { ok: false, reason: 'no-upgrades' };
    GC.saveWallet(100000);
    var wBefore = GC.wallet();
    var buy1 = first ? GC.buyUpgrade(first.id) : { ok: false, reason: 'no-upgrades' };
    var wAfter1 = GC.wallet();
    var lvl1 = first ? (GC.upgrades().filter(function (u) { return u.id === first.id; })[0] || {}).level : null;
    /* 买到上限：最后一个成功的购买把等级推到 maxLevel，再买一次必须被拒 */
    var guard = 0, maxBuy = null, overBuy = null;
    while (first && guard++ < 20) {
      var r = GC.buyUpgrade(first.id);
      var cur = GC.upgrades().filter(function (u) { return u.id === first.id; })[0] || {};
      if (!r.ok) { overBuy = r; break; }
      maxBuy = r;
      if (cur.level >= (cur.maxLevel || 1)) { overBuy = GC.buyUpgrade(first.id); break; }
    }
    var curAtMax = first ? (GC.upgrades().filter(function (u) { return u.id === first.id; })[0] || {}) : {};
    var D = loadWith(st5);              // 重启读回
    var lvlAfter = first ? (D.sandbox.Game.upgrades().filter(function (u) { return u.id === first.id; })[0] || {}).level : null;
    upgRun = {
      count: list5.length, first: first ? { id: first.id, cost: first.cost, maxLevel: first.maxLevel } : null,
      poor: poor, wBefore: wBefore, buy1: buy1, wAfter1: wAfter1, lvl1: lvl1,
      atMax: curAtMax.level, maxLevel: curAtMax.maxLevel, maxBuy: maxBuy, lastReason: overBuy,
      lvlAfter: lvlAfter, keys: Object.keys(st5._map)
    };
  }
  c('V4.4', !!upgRun && upgRun.count >= 6,
    'Game.upgrades() 返回 ≥6 条升级项（§2.4）', jsonOf(upgRun && { count: upgRun.count, first: upgRun.first }));
  c('V4.5', !!upgRun && upgRun.poor && upgRun.poor.ok === false,
    'buyUpgrade：钱包不足时 ok=false 且不改档（§2.4）', jsonOf(upgRun && upgRun.poor));
  c('V4.6', !!upgRun && upgRun.buy1 && upgRun.buy1.ok === true && upgRun.lvl1 === 1 &&
    upgRun.wAfter1 === upgRun.wBefore - (upgRun.first ? upgRun.first.cost : 0),
    'buyUpgrade：成功扣 cost、等级 +1（§2.4）', jsonOf(upgRun && {
      buy1: upgRun.buy1, lvl1: upgRun.lvl1, before: upgRun.wBefore, after: upgRun.wAfter1, cost: upgRun.first && upgRun.first.cost
    }));
  c('V4.7', !!upgRun && upgRun.atMax === upgRun.maxLevel && upgRun.maxBuy && upgRun.maxBuy.ok === true &&
    upgRun.lastReason && upgRun.lastReason.ok === false,
    'buyUpgrade：到达 maxLevel 后拒绝继续购买（§2.4）',
    jsonOf(upgRun && { atMax: upgRun.atMax, maxLevel: upgRun.maxLevel, maxBuy: upgRun.maxBuy, lastReason: upgRun.lastReason }));
  c('V4.8', !!upgRun && upgRun.lvlAfter === upgRun.atMax && upgRun.lvlAfter >= 1,
    '升级等级落盘 three_doors_upgrades_v1，重启后读回（§2.4）',
    jsonOf(upgRun && { lvlAfter: upgRun.lvlAfter, keys: upgRun.keys }));

  /* 难度三档初值 */
  var diffRun = null;
  if (HAS.diff && HAS.game && diffOk) {
    var rowsD = [];
    var stD = fakeStorage();          /* 难度是本机偏好：必须同一个 store 才能读回 */
    mkGame('normal', SEED, null, stD);
    ['normal', 'hard', 'hell'].forEach(function (id) {
      G.Game.setDifficulty(id);
      G.Game.action({ type: 'reset' });
      G.Game.action({ type: 'start', mode: 'normal' });
      var s = G.Game.state;
      var d = diffTier(id);
      rowsD.push({
        id: id, set: G.Game.difficulty(), stateDiff: s.difficulty,
        coins: s.coins, patience: s.patience, suspicion: s.suspicion,
        wantCoins: d.coins != null ? d.coins : d.initial && d.initial.coins,
        wantPatience: d.patience != null ? d.patience : d.initial && d.initial.patience,
        wantSuspicion: d.suspicion != null ? d.suspicion : d.initial && d.initial.suspicion,
        lieBase: d.lieBase
      });
    });
    diffRun = rowsD;
  }
  var diffBad = (diffRun || []).filter(function (r) {
    return r.set !== r.id || r.coins !== r.wantCoins || r.patience !== r.wantPatience || r.suspicion !== r.wantSuspicion;
  });
  /* 根因定位：难度偏好必须真的写进存档（state.js 的 prefs 白名单曾经漏过键） */
  var diffPrefRaw = '（未执行）', diffPrefOk = false;
  if (HAS.diff && HAS.game && diffOk) {
    var stR = fakeStorage();
    mkGame('normal', SEED, null, stR);
    G.Game.setDifficulty('hell');
    diffPrefRaw = String(stR.getItem('three_doors_prefs_v1') || 'null');
    diffPrefOk = /"difficulty"\s*:\s*"hell"/.test(diffPrefRaw) && G.Game.prefs().difficulty === 'hell';
  }
  c('V4.9', !!diffRun && diffRun.length === 3 && diffBad.length === 0,
    '难度三档初值生效：normal 100/3/2、hard 80/2/1、hell 60/1/0（§2.4）',
    '不合规 ' + diffBad.length + '：' + jsonOf(diffRun));
  c('V4.9b', diffPrefOk,
    'setDifficulty(id) 必须落盘到 three_doors_prefs_v1.difficulty（§2.4 本机偏好）',
    '存档原文=' + jsonOf(diffPrefRaw.slice(0, 200)) + '；prefs().difficulty=' + jsonOf(G.Game.prefs && G.Game.prefs().difficulty));
  var lieBad = (diffRun || []).filter(function (r) {
    var want = { normal: 0.35, hard: 0.5, hell: 0.65 }[r.id];
    return r.lieBase !== want;
  });
  c('V4.10', !!diffRun && lieBad.length === 0,
    'config.difficulty 的 lieBase = 0.35/0.5/0.65（§2.4）', jsonOf((diffRun || []).map(function (r) {
      return { id: r.id, lieBase: r.lieBase };
    })));

  /* 升级叠加在难度初值上：starting_coins +50/级 */
  var stackRun = null;
  if (HAS.upg && HAS.diff && HAS.wallet && HAS.store) {
    var st6 = fakeStorage();
    var E = loadWith(st6);
    var GE = E.sandbox.Game;
    GE.saveWallet(100000);
    var sc = (GE.upgrades() || []).filter(function (u) { return u.id === 'starting_coins'; })[0] || null;
    var buySc = sc ? GE.buyUpgrade('starting_coins') : { ok: false, reason: 'no-such-upgrade' };
    GE.setDifficulty('normal');
    GE.init({ mode: 'normal', seed: 2, doors: 3, deps: { ui: L.recordingUI(), data: E.data, applyEffect: E.sandbox.applyEffect, narrator: E.sandbox.Narrator, setTimeout: L.immediateTimeout, clearTimeout: function () { return 0; }, localStorage: st6 } });
    GE.setDifficulty('normal');
    GE.action({ type: 'start', mode: 'normal' });
    stackRun = { hasUpgrade: !!sc, buy: buySc, coins: GE.state.coins, base: 100, level: sc ? 1 : 0 };
  }
  c('V4.11', !!stackRun && stackRun.coins === stackRun.base + 50 * stackRun.level,
    '升级在难度初值上叠加：starting_coins Lv1 → 初始金币 150（§2.4）', jsonOf(stackRun));

  /* 结算后钱包增长 + 幂等标记 */
  var walletGame = null;
  if (HAS.wallet && HAS.store && HAS.game) {
    var st7 = fakeStorage();
    var F = loadWith(st7);
    var GF = F.sandbox.Game;
    F.sandbox.CodexStore.clearWallet();
    GF.init({
      mode: 'demo', seed: SEED,
      deps: {
        ui: L.recordingUI(), data: F.data, applyEffect: F.sandbox.applyEffect, narrator: F.sandbox.Narrator,
        setTimeout: L.immediateTimeout, clearTimeout: function () { return 0; }, localStorage: st7
      }
    });
    var dw0 = GF.wallet();
    var demoP = GF.autoDemo();
    await untilMs(function () { var p = GF.state.phase; return p === 'CASHOUT' || p === 'GAME_OVER'; }, 5000);
    await demoP;
    await untilMs(function () { return GF.state.walletSaved === true; }, 2000);
    walletGame = {
      before: dw0, coins: GF.state.coins, after: GF.wallet(),
      walletSaved: GF.state.walletSaved, phase: GF.state.phase,
      raw: st7._map[G.STORE_KEYS ? G.STORE_KEYS.wallet : 'three_doors_wallet_v1']
    };
  }
  c('V4.12', !!walletGame && walletGame.after === walletGame.coins && walletGame.after > walletGame.before,
    '结算后钱包增加为本局最终金币（§2.4/§5.4）', jsonOf(walletGame));
  c('V4.13', !!walletGame && walletGame.walletSaved === true,
    '同一局钱包只存一次（state.walletSaved 幂等标记，§2.4）', jsonOf(walletGame));

  /* ======================================================================
   * V5 §2.5 / §4 首页、文案与剧情
   * ==================================================================== */

  ck.section('§2.5/§4 首页标题、难度选择、剧情与死亡文案');

  var html = L.readText(L.INDEX);
  c('V5.1', /<title>[^<]*命运之门[^<]*<\/title>/.test(html), '<title> 含「命运之门」（§4.4）',
    '实际 ' + jsonOf((/<title>([^<]*)<\/title>/.exec(html) || [])[1]));

  var page5 = null, domErr5 = null;
  try { page5 = Sh.createPage(); } catch (e) { domErr5 = String(e && e.message ? e.message : e); }
  var D5 = page5 ? page5.doc : null;
  function q5(s) { return D5 ? D5.querySelector(s) : null; }
  var boot5 = q5('#boot');
  var diffBtns5 = boot5 ? boot5.querySelectorAll('[data-diff]') : [];
  var homeCoins5 = q5('#home-coins');
  c('V5.2', !!boot5, '#boot 首页区块存在（§4.1）', domErr5 || ('boot=' + !!boot5));
  c('V5.3', diffBtns5.length === 3 &&
    diffBtns5.map(function (b) { return b.getAttribute('data-diff'); }).join(',') === 'normal,hard,hell',
    '#boot 内 3 个难度按钮 [data-diff] = normal/hard/hell（§4.1/§5.5）',
    '实际 ' + diffBtns5.length + '：' + diffBtns5.map(function (b) { return b.getAttribute('data-diff'); }).join(','));
  c('V5.4', !!homeCoins5 && /\d/.test(String(homeCoins5.textContent || '')),
    '#boot 内显示金币余额 #home-coins（§4.1/§5.5）',
    'home-coins=' + (homeCoins5 ? jsonOf(String(homeCoins5.textContent).slice(0, 30)) : 'null'));
  var story = Array.isArray(CFG.story) ? CFG.story : [];
  var bootText5 = boot5 ? String(boot5.textContent || '') : '';
  var bootParas5 = boot5 ? boot5.querySelectorAll('p') : [];
  var paraTexts5 = bootParas5.map(function (p) { return String(p.textContent || '').trim(); });
  var storyHit = story.map(function (p) {
    var s = String(p || '').trim();
    return s ? bootText5.indexOf(s.slice(0, 6)) >= 0 : false;
  });
  c('V5.5', story.length >= 3 && storyHit.length >= 3 && storyHit.slice(0, 3).every(Boolean),
    '首页渲染 config.story 的 3 段剧情（§2.5/§4.1）',
    'story=' + story.length + ' 段；命中=' + jsonOf(storyHit) +
    '；config.story[0]=' + jsonOf(String(story[0] || '').slice(0, 40)) +
    '；#boot 段落=' + jsonOf(paraTexts5.slice(0, 4).map(function (t) { return t.slice(0, 40); })));
  var bootBtns5 = boot5 ? boot5.querySelectorAll('button') : [];
  var bootBtnText = bootBtns5.map(function (b) { return String(b.textContent || '').trim(); }).join('|');
  c('V5.6', bootBtns5.length >= 4 && /开始/.test(bootBtnText) && /升级/.test(bootBtnText),
    '#boot 提供开始/升级商店等入口按钮（§4.1）',
    '按钮=' + bootBtns5.length + '：' + jsonOf(bootBtnText.slice(0, 120)));

  /* 页面用的是真实定时器（introMs 800 / narratorMs 2000 / hostOpenMs 600）；把页面 config.timings 压小，
   * 只影响「等 DOM 渲染」的耗时，不改变任何被断言的语义。压不动就退回长超时。 */
  function speedUpPage(P) {
    var ok = false;
    try {
      var d = P.GameData;
      if (d && d.config && !Object.isFrozen(d.config)) {
        d.config.timings = { introMs: 20, narratorMs: 40, hostOpenMs: 20, revealMs: 30, revealDoubledExtraMs: 10, resetMs: 60 };
        ok = true;
      }
    } catch (e) { ok = false; }
    return ok;
  }

  /* 决策阶段高亮引导（§4.3）：等 DOM 真正更新，避免「刚进 DECIDE 还没渲染」造成的假 FAIL */
  var hintBar = null, primaryCnt = 0, decideErr = null, decidePhase = null, speed5 = false;
  if (page5 && page5.sandbox.Game) {
    try {
      var P5 = page5.sandbox;
      speed5 = speedUpPage(P5);
      await untilMs(function () { return P5.Game.prefs && P5.Game.prefs().onboarded !== false; }, 1500);
      P5.Game.action({ type: 'start', mode: 'demo' });
      await untilMs(function () { return P5.Game.state.phase === 'PICK'; }, 15000);
      P5.Game.action({ type: 'pick', slot: 0 });
      await untilMs(function () { return P5.Game.state.phase === 'DECIDE'; }, 15000);
      decidePhase = P5.Game.state.phase;
      await untilMs(function () {
        var el = D5.getElementById('stage-hint');
        return !!el && /轮到你决策/.test(String(el.textContent || ''));
      }, 8000);
      await untilMs(function () {
        var bs = D5.querySelectorAll('#decide button, .decide-actions button, #stage button');
        return bs.filter(function (b) { return b.classList && b.classList.contains('is-primary'); }).length >= 1;
      }, 8000);
      hintBar = D5.getElementById('stage-hint');
      var btns5 = D5.querySelectorAll('#decide button, .decide-actions button, #stage button');
      primaryCnt = btns5.filter(function (b) { return b.classList && b.classList.contains('is-primary'); }).length;
    } catch (e) { decideErr = String(e && e.message ? e.message : e); }
  }
  c('V5.7', !!hintBar && /轮到你决策/.test(String(hintBar.textContent || '')),
    '#stage-hint 提示「轮到你决策：坚持本门 / 换门 / 质疑 / 加倍 / 收手」（§4.3）',
    'phase=' + decidePhase + '；加速=' + speed5 + '；hint=' + (hintBar ? jsonOf(String(hintBar.textContent).slice(0, 80)) : 'null') + (decideErr ? '；异常=' + decideErr : ''));
  c('V5.8', primaryCnt >= 1,
    'DECIDE 可用按钮带 .is-primary 高亮引导（§4.3）', 'is-primary 按钮数=' + primaryCnt);

  /* 死亡弹层（§2.5）：v6 的 3 门恒为 big+empty+empty，所以用 4 门剧本塞一颗炸弹 + 把耐心压到 1 */
  async function deathRun() {
    var saved = DATA.seedDemo;
    DATA.seedDemo = {
      seed: 880011,
      rounds: [{
        round: 1, doors: ['bomb', 'empty', 'empty', 'big_prize'],
        hostOpensSlot: 1, narrator: 'truth', expect: 'bomb'
      }]
    };
    var g = mkGame('demo', 880011);
    G.Game.action({ type: 'start', mode: 'demo' });
    await untilMs(function () { return G.Game.state.phase === 'PICK'; }, 4000);
    var doors = G.Game.state.doors.map(function (d) { return d.itemId; });
    var hazard = -1;
    doors.forEach(function (id, i) {
      if (hazard < 0 && ['bomb', 'trap', 'landmine', 'quicksand'].indexOf(id) >= 0) hazard = i;
    });
    G.Game.state.patience = 1;
    if (hazard >= 0) G.Game.action({ type: 'pick', slot: hazard });
    await untilMs(function () { return G.Game.state.phase === 'DECIDE'; }, 4000);
    G.Game.action({ type: 'decide', choice: 'stick' });
    await untilMs(function () { return G.Game.state.phase === 'GAME_OVER'; }, 5000);
    await untilMs(function () { return !!lastModalOf(g.rec, 'gameover'); }, 2000);
    var modal = lastModalOf(g.rec, 'gameover');
    var out = {
      phase: G.Game.state.phase, patience: G.Game.state.patience, coins: G.Game.state.coins,
      doors: doors, hazard: hazard,
      modal: modal ? { kind: modal.kind, title: modal.title, body: String(modal.body || '').slice(0, 160), actions: (modal.actions || []).map(function (a) { return a.label; }) } : null
    };
    DATA.seedDemo = saved;
    return out;
  }
  var death = HAS.game ? await deathRun() : null;
  c('V5.9', !!death && death.phase === 'GAME_OVER' && !!death.modal && death.modal.title === '你死了',
    '耐心归零 → 死亡弹层标题「你死了」（§2.5）', jsonOf(death));
  c('V5.10', !!death && !!death.modal && /没能撑过去/.test(death.modal.body) &&
    death.modal.actions.join('|').indexOf('重新挑战') >= 0,
    '死亡弹层正文含「你没能撑过去……」且按钮含「重新挑战」（§2.5）', jsonOf(death && death.modal));

  /* 收手弹层（§2.5） */
  var cash = null;
  if (HAS.game) {
    var g5 = startGame('normal');
    if (await toPick() && await pickFirstOpen()) {
      G.Game.action({ type: 'decide', choice: 'cashout' });
      await untilMs(function () {
        var p = G.Game.state.phase;
        return p === 'CASHOUT' || p === 'GAME_OVER';
      }, 4000);
      await untilMs(function () { return !!lastModalOf(g5.rec, 'cashout'); }, 2000);
      var m5 = lastModalOf(g5.rec, 'cashout');
      cash = {
        phase: G.Game.state.phase, coins: G.Game.state.coins,
        modal: m5 ? { kind: m5.kind, title: m5.title, body: String(m5.body || ''), snippet: String(m5.body || '').slice(0, 120) } : null
      };
    } else {
      cash = { err: '未到 DECIDE：' + G.Game.state.phase };
    }
  }
  c('V5.11', !!cash && cash.modal && cash.modal.title === '活下来了' && /带着金币离开/.test(cash.modal.body || ''),
    '收手弹层标题「活下来了」且正文含「带着金币离开」（§2.5）',
    jsonOf(cash && cash.modal ? { title: cash.modal.title, snippet: cash.modal.snippet, fullLen: cash.modal.body.length } : cash));

  /* 主持人开门文案（§2.1） */
  var hostLabelOk = false, hostLabelDetail = '未执行';
  if (page5 && page5.sandbox.Game) {
    try {
      var P6 = page5.sandbox;
      speedUpPage(P6);
      P6.Game.action({ type: 'reset' });
      await untilMs(function () { return P6.Game.state.phase === 'IDLE'; }, 4000);
      P6.Game.action({ type: 'start', mode: 'demo' });
      await untilMs(function () { return P6.Game.state.phase === 'PICK'; }, 15000);
      P6.Game.action({ type: 'pick', slot: 0 });
      await untilMs(function () { return P6.Game.state.phase === 'DECIDE'; }, 15000);
      var body6 = String(D5.body.textContent || '');
      hostLabelOk = /主持人打开了[^。]{0,12}空门/.test(body6);
      hostLabelDetail = '命中=' + hostLabelOk + '；片段=' + jsonOf(body6.replace(/\s+/g, ' ').slice(0, 160));
    } catch (e) { hostLabelDetail = '异常：' + (e && e.message ? e.message : e); }
  }
  c('V5.12', hostLabelOk, '主持人开门文案固定为「主持人打开了一扇空门」（§2.1）', hostLabelDetail);

  /* ======================================================================
   * V6 计数
   * ==================================================================== */

  ck.section('新增断言计数');
  c('V6.1', nV >= 40, '本套件断言条数 ≥ 40（实际 ' + nV + ' 条）', '实际 ' + nV + ' 条');
}

main().then(function () {
  ck.print();
  var c2 = ck.counts();
  process.exitCode = c2.FAIL > 0 ? 1 : 0;
}).catch(function (e) {
  console.log('\n[home.js 运行时异常] ' + (e && e.stack ? e.stack : e));
  ck.print();
  process.exitCode = 2;
});

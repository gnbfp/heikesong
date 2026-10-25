/* ============================================================================
 * tests/shop.js —— 商店与道具经济（依据 docs/设计契约_商店与美术.md §2 / §3）
 * ----------------------------------------------------------------------------
 * 覆盖契约：
 *   §2.1 换门经济：有券免金币 / 无券扣 15 / 钱 <15 不换门且留在 DECIDE
 *   §2.2 六件商品的价格、上限、类型、图标
 *   §2.3 背包 [{id,count}]、买不起 toast 且弹层不关、成功扣款并累加 spentCoins/shopBuys
 *   §2.4 新状态字段 spentCoins / shopBuys / shopBought{id:次数} / itemBuffs{fuse} / muteCardUsed（v2：闭嘴卡管「下一轮」，由 narrate() 消费）
 *   §3.1 DOM（由 tests/dom-smoke.js 断言）
 *   §3.2 Game.action({type:'shop'|'use_item'}) / Game.buy / Game.useItem / Game.shopSpec
 *   §3.3 弹层 spec：kind 'shop'、购买走 modal_choice 'buy:<id>'
 *   §3.4 背包使用：double_coins 等价 DOUBLE（每轮一次）/ mute_card / fuse / switch_ticket
 * 用法：node tests/shop.js  → 退出码 0 全 PASS，1 有 FAIL
 * ========================================================================== */
'use strict';

var path = require('path');
var L = require('./lib.js');

var ck = new L.Checker('shop.js —— 商店与道具经济（契约 §2 / §3）');

var SEED = 20261024;
var FIXED_NOW = 1730000000000;
var nShop = 0;

/** 所有断言都过这里，便于末尾统计本次新增断言条数。 */
function c(id, cond, msg, detail) {
  nShop++;
  return ck.ok(id, cond, msg, detail);
}

/* 契约 §2.2 商品表（价格 / 背包上限 / 类型）。mystery_box 上限契约写「不限」。 */
var SHOP_SPEC = {
  switch_ticket: { name: '换门券', price: 25, cap: 3, kind: 'bag', icon: 'ticket' },
  mute_card: { name: '闭嘴卡', price: 20, cap: 2, kind: 'bag', icon: 'mute' },
  double_coins: { name: '双倍金币', price: 40, cap: 2, kind: 'bag', icon: 'double' },
  fuse: { name: '保险丝', price: 35, cap: 2, kind: 'bag', icon: 'fuse' },
  mystery_box: { name: '神秘盒', price: 15, cap: null, kind: 'instant', icon: 'box' },
  patience_charm: { name: '续命符', price: 60, cap: 2, kind: 'instant', icon: 'charm' }
};
var SHOP_IDS = Object.keys(SHOP_SPEC);

/* ------------------------------------------------------------------ 加载 */

var load = L.loadScripts({ withDom: false });
var G = load.sandbox;

if (!load.loaded.length) {
  c('SH0.0', false, 'js/ 下至少要有 state.js / data.js / effects.js / narrator.js / game.js 可加载',
    load.missing.join('\n         '));
  ck.print();
  process.exit(1);
}

var gd = L.loadGameData(load.ctx, load.sandbox);
var HAS_SHOP = !!(G.Game && typeof G.Game.buy === 'function' && typeof G.Game.useItem === 'function' &&
  typeof G.Game.openShop === 'function' && typeof G.Game.shopSpec === 'function');

/* ------------------------------------------------------------------ 工具 */

function until(pred, tries) {
  return new Promise(function (res) {
    var i = 0;
    (function step() {
      var v = false;
      try { v = !!pred(); } catch (e) { v = false; }
      if (v) return res(true);
      if (++i > (tries || 500)) return res(false);
      setImmediate(step);
    })();
  });
}

function jsonOf(x) { return JSON.stringify(x); }

function lastModalOf(rec, kind) {
  for (var k = rec.modals.length - 1; k >= 0; k--) {
    if (!kind || rec.modals[k].kind === kind) return rec.modals[k];
  }
  return null;
}

/** 建一个全新的 Game 实例（每个用例独立，避免单例互相污染）。 */
function mkGame(mode, seed, over) {
  var ui = L.recordingUI();
  ui.rec.closes = 0;
  ui.closeModal = function () { ui.rec.closes++; };   /* 记录弹层是否被关闭 */
  var deps = {
    ui: ui,
    data: gd.data,
    applyEffect: G.applyEffect,
    narrator: G.Narrator,
    setTimeout: L.immediateTimeout,
    clearTimeout: function () { return 0; },
    now: function () { return FIXED_NOW; }
  };
  if (over) for (var k in over) deps[k] = over[k];
  G.Game.init({ mode: mode || 'demo', seed: seed == null ? SEED : seed, doors: (mode === 'normal' ? 3 : undefined), deps: deps });
  return { Game: G.Game, ui: ui, rec: ui.rec, deps: deps };
}

function slotOfItem(g, id) {
  var d = g.Game.state.doors || [];
  for (var i = 0; i < d.length; i++) if (d[i].itemId === id) return i;
  return -1;
}

function countOf(g, id) {
  var list = g.Game.state.items || [];
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].count || 0;
  return 0;
}

/** 直接把道具塞进背包（背包结构由契约 §2.3 冻结为 [{id,count}]）。 */
function grant(g, id, n) {
  var s = g.Game.state;
  s.items = s.items || [];
  for (var i = 0; i < s.items.length; i++) {
    if (s.items[i].id === id) { s.items[i].count = (s.items[i].count || 0) + (n || 1); return s.items[i]; }
  }
  s.items.push({ id: id, count: n || 1 });
  return s.items[s.items.length - 1];
}

/** 把所有门改成空门：隔离「换门要花 15 金币」这一条，开奖本身 0 收益。 */
function neutralizeDoors(g) {
  var d = g.Game.state.doors || [];
  for (var i = 0; i < d.length; i++) { d[i].itemId = 'empty'; d[i].kind = 'no-prize'; }
}

async function demoToPick(g, tries) {
  g.Game.start('demo');
  return until(function () { return g.Game.state.phase === 'PICK'; }, tries || 400);
}

async function pickSlot(g, slot) {
  if (!g.Game.action({ type: 'pick', slot: slot })) return false;
  return until(function () { return g.Game.state.phase === 'DECIDE'; }, 400);
}

async function stickToSettle(g) {
  g.Game.action({ type: 'decide', choice: 'stick' });
  return until(function () { return g.Game.state.phase === 'SETTLE_ROUND'; }, 600);
}

async function nextRound(g) {
  g.Game.action({ type: 'settle', choice: 'continue' });
  return until(function () { return g.Game.state.phase === 'PICK'; }, 600);
}

/** 演示第 1 轮选到指定牌面并停在 DECIDE。 */
async function demo1Decide(g, wantItem) {
  if (!await demoToPick(g)) return false;
  var slot = slotOfItem(g, wantItem);
  if (slot < 0) return false;
  return pickSlot(g, slot);
}

/* ------------------------------------------------------------------ main */

async function main() {
  ck.section('阶段 0｜加载与商店依赖');

  c('SH0.1', load.missing.length === 0, 'js/ 六个经典脚本齐全', load.missing.join('\n         '));
  c('SH0.2', load.errors.length === 0, '无 DOM 环境下加载无异常', load.errors.join('\n         '));
  c('SH0.3', HAS_SHOP, '契约 §3.2 的商店 API 存在：Game.buy / Game.useItem / Game.openShop / Game.shopSpec',
    'Game.buy=' + typeof (G.Game && G.Game.buy) + ' Game.useItem=' + typeof (G.Game && G.Game.useItem) +
    ' Game.openShop=' + typeof (G.Game && G.Game.openShop) + ' Game.shopSpec=' + typeof (G.Game && G.Game.shopSpec));

  if (!HAS_SHOP) {
    ck.section('商店 API 缺失 —— 后续用例无法执行');
    return;
  }

  /* ------------------------------------------------------------ SH1 数据契约 */
  ck.section('契约 §2.1/§2.2｜经济配置与商品表');

  var cfg = gd.data.config || {};
  var eco = cfg.economy || null;
  c('SH1.1', !!eco && eco.switchCost === 15, '§2.1 config.economy.switchCost === 15', jsonOf(eco));
  c('SH1.2', !!eco && Array.isArray(eco.shopOpenStates) &&
    eco.shopOpenStates.length === 2 && eco.shopOpenStates.indexOf('DECIDE') >= 0 &&
    eco.shopOpenStates.indexOf('SETTLE_ROUND') >= 0,
    '§2.1 shopOpenStates === [DECIDE, SETTLE_ROUND]', jsonOf(eco && eco.shopOpenStates));

  var g1 = mkGame('demo');
  var spec1 = g1.Game.shopSpec();
  c('SH1.3', spec1 && spec1.kind === 'shop' && spec1.title === '道具商店' &&
    Array.isArray(spec1.items) && spec1.items.length === SHOP_IDS.length &&
    Array.isArray(spec1.actions) && spec1.actions.length === 1 && spec1.actions[0].choice === 'close',
    '§3.3 弹层 spec：kind=shop / title=道具商店 / 6 件商品 / actions=[关闭]',
    jsonOf({ kind: spec1 && spec1.kind, title: spec1 && spec1.title, n: spec1 && spec1.items && spec1.items.length, actions: spec1 && spec1.actions }));

  var byId1 = {};
  (spec1.items || []).forEach(function (it) { byId1[it.id] = it; });
  var specBad = [];
  SHOP_IDS.forEach(function (id) {
    var want = SHOP_SPEC[id], got = byId1[id];
    if (!got) { specBad.push(id + ' 缺失'); return; }
    if (got.price !== want.price) specBad.push(id + ' 价格 ' + got.price + ' ≠ ' + want.price);
    if (got.name !== want.name) specBad.push(id + ' 名称 ' + got.name + ' ≠ ' + want.name);
    if (got.icon !== want.icon) specBad.push(id + ' 图标 key ' + got.icon + ' ≠ ' + want.icon);
    var wantKind = want.kind === 'instant' ? 'instant' : 'bag';
    if (got.kind !== wantKind) specBad.push(id + ' 类型 ' + got.kind + ' ≠ ' + wantKind);
    if (want.cap != null && got.cap !== want.cap) specBad.push(id + ' 上限 ' + got.cap + ' ≠ ' + want.cap);
    if (!(got.price > 0)) specBad.push(id + ' 价格必须为正');
  });
  c('SH1.4', specBad.length === 0, '§2.2 六件商品的价格 / 名称 / 图标 key / 类型 / 上限与契约逐项一致',
    specBad.join('；') + ' 实际=' + jsonOf(spec1.items));

  c('SH1.5', (spec1.items || []).length === SHOP_IDS.length &&
    SHOP_IDS.every(function (id) { return byId1[id] && typeof byId1[id].desc === 'string' && byId1[id].desc.length > 0; }),
    '§2.2 每件商品都有非空 desc（弹层要显示说明）',
    jsonOf(spec1.items && spec1.items.map(function (i) { return [i.id, i.desc]; })));

  c('SH1.6', (spec1.items || []).every(function (i) {
    return typeof i.immediate === 'boolean' && typeof i.unlimited === 'boolean' &&
      typeof i.affordable === 'boolean' && typeof i.capped === 'boolean' &&
      typeof i.owned === 'number' && (i.cap == null || typeof i.cap === 'number');
  }), '§3.3（v2）spec.items 每项都带 owned/immediate/unlimited/affordable/capped，且 cap 可为 null（不限购）',
    jsonOf(spec1.items.map(function (i) {
      return [i.id, i.owned, i.cap, i.immediate, i.unlimited, i.affordable, i.capped];
    })));

  c('SH1.7', spec1.coins === g1.Game.state.coins && /金币/.test(String(spec1.body)),
    '§3.3 spec 带 coins（= state.coins）且 body 说明金币', jsonOf({ coins: spec1.coins, body: spec1.body }));

  c('SH1.8', spec1.items.every(function (i) { return i.kind !== 'bag' || i.cap <= 3; }),
    '§2.3 背包型商品上限都不超过 3（同 id 最多 3 个）',
    jsonOf(spec1.items.map(function (i) { return [i.id, i.kind, i.cap]; })));

  var st1 = g1.Game.state;
  var snap1 = g1.Game.snapshot();
  c('SH1.9', st1.spentCoins === 0 && st1.shopBuys === 0 && st1.muteCardUsed === false &&
    (st1.shopBought == null || Object.keys(st1.shopBought).length === 0) &&
    !!st1.itemBuffs && st1.itemBuffs.fuse === false,
    '§2.4（v2）开局 spentCoins=0 / shopBuys=0 / muteCardUsed=false / shopBought={} / itemBuffs.fuse=false',
    jsonOf({ spentCoins: st1.spentCoins, shopBuys: st1.shopBuys, muteCardUsed: st1.muteCardUsed, shopBought: st1.shopBought, itemBuffs: st1.itemBuffs }));
  /* 契约 §3.2 写的是 snapshot().state.* ，而 js/game.js:171 实际返回 state 本身；
     这里按「字段可达」断言（两种形状都接受），形状差异单独报给 Lead。 */
  var snapState1 = snap1 && (snap1.state || snap1);
  c('SH1.10', !!snapState1 && snapState1.spentCoins === 0 && snapState1.shopBuys === 0 &&
    !!snapState1.itemBuffs && snapState1.muteCardUsed === false,
    '§3.2 snapshot() 暴露 spentCoins / shopBuys / itemBuffs / muteCardUsed（实测直接返回 state，非 {state:…}）',
    jsonOf({ keys: Object.keys(snap1 || {}), state: snapState1 }));

  if (Array.isArray(gd.data.shop) && gd.data.shop.length) {
    var dataShopBad = [];
    SHOP_IDS.forEach(function (id) {
      var d = null;
      gd.data.shop.forEach(function (x) { if (x && x.id === id) d = x; });
      if (!d) { dataShopBad.push(id + ' 不在 GameData.shop'); return; }
      if (d.price !== SHOP_SPEC[id].price) dataShopBad.push(id + ' 产物价格 ' + d.price);
    });
    c('SH1.11', dataShopBad.length === 0, 'GameData.shop（内容层产物）与契约价格一致', dataShopBad.join('；'));
  } else {
    ck.skip('SH1.11', 'GameData.shop 尚未生成 —— 当前走 js/game.js 的 SHOP_FALLBACK，契约值已由 SH1.4 覆盖',
      'js/data.js 里没有 shop 数组（data 层商品表未落地）');
  }

  /* §2.4（v2）即时商品的限购口径：神秘盒不限购（cap=null/unlimited），续命符单局 2 次。 */
  var byId1b = {};
  (spec1.items || []).forEach(function (i) { byId1b[i.id] = i; });
  var mb1 = byId1b.mystery_box, pc1 = byId1b.patience_charm;
  c('SH1.12', !!mb1 && !!pc1 && mb1.cap === null && mb1.unlimited === true && mb1.immediate === true &&
    pc1.cap === 2 && pc1.unlimited === false && pc1.immediate === true && pc1.capped === false,
    '§2.4（v2）神秘盒 cap=null/unlimited/immediate；续命符 cap=2/immediate/初始 capped=false',
    jsonOf({ mystery_box: mb1, patience_charm: pc1 }));

  /* -------------------------------------------------------- SH2 开合时机 */
  ck.section('契约 §2.1/§3.2｜商店开合时机（只有 DECIDE / SETTLE_ROUND 能开）');

  var g2a = mkGame('demo');
  var open1 = g2a.Game.action({ type: 'shop' });
  c('SH2.1', !open1 && g2a.rec.modals.length === 0 && g2a.Game.state.phase === 'IDLE',
    'IDLE 阶段 action(shop) 不弹层、不改状态', jsonOf({ ret: open1, modals: g2a.rec.modals.length, phase: g2a.Game.state.phase }));

  var g2b = mkGame('demo');
  g2b.Game.start('demo');
  var phaseIntro = g2b.Game.state.phase;
  var open2 = g2b.Game.action({ type: 'shop' });
  c('SH2.2', phaseIntro === 'ROUND_INTRO' && !open2 && g2b.rec.modals.length === 0,
    'ROUND_INTRO 阶段 action(shop) 不弹层', jsonOf({ phase: phaseIntro, ret: open2 }));

  var g2c = mkGame('demo');
  await demoToPick(g2c);
  var open3 = g2c.Game.action({ type: 'shop' });
  c('SH2.3', g2c.Game.state.phase === 'PICK' && !open3 && g2c.rec.modals.length === 0,
    'PICK 阶段 action(shop) 不弹层（验收要求：仅 DECIDE / SETTLE_ROUND）',
    jsonOf({ phase: g2c.Game.state.phase, ret: open3, modals: g2c.rec.modals.length }));

  var g2d = mkGame('demo');
  await demo1Decide(g2d, 'small_prize');
  var before2 = jsonOf({
    phase: g2d.Game.state.phase, coins: g2d.Game.state.coins, items: g2d.Game.state.items,
    cursor: g2d.Game.state.rng && g2d.Game.state.rng.cursor, round: g2d.Game.state.round
  });
  var evShop = 0;
  g2d.Game.subscribe(function (ev) { if (ev && ev.type === 'shop') evShop++; });
  var open4 = g2d.Game.action({ type: 'shop' });
  var after2 = jsonOf({
    phase: g2d.Game.state.phase, coins: g2d.Game.state.coins, items: g2d.Game.state.items,
    cursor: g2d.Game.state.rng && g2d.Game.state.rng.cursor, round: g2d.Game.state.round
  });
  var shopModal2 = lastModalOf(g2d.rec, 'shop');
  c('SH2.4', open4 === true && !!shopModal2 && g2d.Game.state.phase === 'DECIDE',
    'DECIDE 阶段 action(shop) 返回 true 且弹出 kind=shop（弹层不是状态机状态，phase 仍为 DECIDE）',
    jsonOf({ ret: open4, kind: shopModal2 && shopModal2.kind, phase: g2d.Game.state.phase }));
  c('SH2.5', before2 === after2, '开商店是纯 UI 行为：coins / items / rng.cursor / round / phase 全不变',
    'before=' + before2 + '\n      after =' + after2);
  c('SH2.6', evShop === 1, '开商店会 emit({type:"shop"}) 事件一次', '实际 ' + evShop + ' 次');

  var g2e = mkGame('demo');
  if (await demo1Decide(g2e, 'small_prize')) {
    if (await stickToSettle(g2e)) {
      var open5 = g2e.Game.action({ type: 'shop' });
      c('SH2.7', open5 === true && !!lastModalOf(g2e.rec, 'shop'),
        'SETTLE_ROUND 阶段也能开商店（§2.1 shopOpenStates 含 SETTLE_ROUND）',
        jsonOf({ phase: g2e.Game.state.phase, ret: open5, kind: lastModalOf(g2e.rec, 'shop') && lastModalOf(g2e.rec, 'shop').kind }));
    } else {
      c('SH2.7', false, 'SETTLE_ROUND 阶段也能开商店', '未能到达 SETTLE_ROUND，phase=' + g2e.Game.state.phase);
    }
  } else {
    c('SH2.7', false, 'SETTLE_ROUND 阶段也能开商店', '未能到达 R1 DECIDE');
  }

  var g2f = mkGame('demo');
  await demo1Decide(g2f, 'small_prize');
  g2f.Game.action({ type: 'decide', choice: 'cashout' });
  var open6 = g2f.Game.action({ type: 'shop' });
  c('SH2.8', g2f.Game.state.phase === 'CASHOUT' && !open6 && !lastModalOf(g2f.rec, 'shop'),
    'CASHOUT 阶段 action(shop) 不弹商店（弹层是结算页）',
    jsonOf({ phase: g2f.Game.state.phase, ret: open6 }));

  /* --------------------------------------------------- SH3 buy 四类失败与副作用 */
  ck.section('契约 §2.3/§3.2｜Game.buy 的四类失败 + 扣款与累加');

  var g3 = mkGame('demo');
  await demo1Decide(g3, 'small_prize');

  var rUnk = g3.Game.buy('no_such_item');
  c('SH3.1', rUnk && rUnk.ok === false && rUnk.reason === 'unknown',
    'buy(未知 id) → {ok:false, reason:"unknown"}', jsonOf(rUnk));

  var g3idle = mkGame('demo');
  var rPhase = g3idle.Game.buy('switch_ticket');
  c('SH3.2', rPhase && rPhase.ok === false && rPhase.reason === 'phase' &&
    g3idle.Game.state.coins === 100 && countOf(g3idle, 'switch_ticket') === 0,
    'buy 在非 DECIDE/SETTLE_ROUND 阶段 → {ok:false, reason:"phase"} 且不扣款',
    jsonOf({ r: rPhase, coins: g3idle.Game.state.coins }));

  /* 注意：Game 是单例 —— 新建实例会把共享 state 重置，所以每个用例都要独立实例，不能交叉复用。 */
  var g3poor = mkGame('demo');
  await demo1Decide(g3poor, 'small_prize');
  g3poor.Game.action({ type: 'shop' });
  g3poor.Game.state.coins = 10;
  var coinsB = g3poor.Game.state.coins;
  var spentB = g3poor.Game.state.spentCoins;
  var buysB = g3poor.Game.state.shopBuys;
  var rPoor = g3poor.Game.buy('switch_ticket');
  c('SH3.3', rPoor && rPoor.ok === false && rPoor.reason === 'insufficient' &&
    g3poor.Game.state.coins === coinsB && g3poor.Game.state.spentCoins === spentB && g3poor.Game.state.shopBuys === buysB &&
    countOf(g3poor, 'switch_ticket') === 0,
    'buy 钱不够 → {ok:false, reason:"insufficient"}，金币 / spentCoins / shopBuys / 背包全不变',
    jsonOf({ r: rPoor, coins: g3poor.Game.state.coins, spent: g3poor.Game.state.spentCoins, bag: countOf(g3poor, 'switch_ticket') }));
  c('SH3.4', (g3poor.rec.toasts || []).some(function (t) { return /金币不够/.test(t) && /25/.test(t) && /10/.test(t); }),
    '§2.3 买不起的提示含「金币不够」+ 商品价格 + 现有金币',
    jsonOf(g3poor.rec.toasts));

  var g3cap = mkGame('demo');
  await demo1Decide(g3cap, 'small_prize');
  grant(g3cap, 'switch_ticket', 3);
  var coinsCapB = g3cap.Game.state.coins;
  var rCap = g3cap.Game.buy('switch_ticket');
  c('SH3.5', rCap && rCap.ok === false && rCap.reason === 'cap' &&
    g3cap.Game.state.coins === coinsCapB && countOf(g3cap, 'switch_ticket') === 3,
    'buy 到上限（背包 3 张换门券）→ {ok:false, reason:"cap"} 且不扣款',
    jsonOf({ r: rCap, coins: g3cap.Game.state.coins, bag: countOf(g3cap, 'switch_ticket') }));

  var g3ok = mkGame('demo');
  await demo1Decide(g3ok, 'small_prize');
  var ok1 = g3ok.Game.buy('switch_ticket');
  c('SH3.6', ok1 && ok1.ok === true && ok1.reason === '' &&
    g3ok.Game.state.coins === 75 && g3ok.Game.state.spentCoins === 25 && g3ok.Game.state.shopBuys === 1 &&
    countOf(g3ok, 'switch_ticket') === 1,
    '买换门券成功：coins 100→75、spentCoins 25、shopBuys 1、背包 1 张',
    jsonOf({ r: ok1, coins: g3ok.Game.state.coins, spent: g3ok.Game.state.spentCoins, buys: g3ok.Game.state.shopBuys, bag: countOf(g3ok, 'switch_ticket') }));

  c('SH3.7', JSON.stringify(Object.keys(ok1).sort()) === JSON.stringify(['ok', 'reason']),
    '§3.2 buy 只返回 {ok, reason} 两个字段（UI 不依赖别的字段）', jsonOf(Object.keys(ok1)));

  var ok2 = g3ok.Game.buy('mute_card');
  c('SH3.8', ok2 && ok2.ok === true && g3ok.Game.state.coins === 55 &&
    g3ok.Game.state.spentCoins === 45 && g3ok.Game.state.shopBuys === 2 &&
    countOf(g3ok, 'mute_card') === 1,
    '连续买两件：coins 75→55、spentCoins 45、shopBuys 2、两件都在背包',
    jsonOf({ r: ok2, coins: g3ok.Game.state.coins, spent: g3ok.Game.state.spentCoins, buys: g3ok.Game.state.shopBuys, items: g3ok.Game.state.items }));

  /* 同种子、同游标的另一次实例独立测出「神秘盒抽奖」本身的值（applyEffect 是纯函数），
     这样就能把「15 金币售价」与「抽奖收益」分开验证，而不是写死一个结果数字。
     顺序很重要：单例 state 会被新实例重置，所以先测基线再建被测实例。 */
  var g3myst = mkGame('demo');
  await demo1Decide(g3myst, 'small_prize');
  var coinsMyst0 = g3myst.Game.state.coins;
  var mres = G.applyEffect(g3myst.Game.state, { id: 'mystery_box' }, { multiplier: 1, source: 'item' });
  var mysteryDelta = mres.state.coins - coinsMyst0;

  var g3ins = mkGame('demo');
  await demo1Decide(g3ins, 'small_prize');
  var coinsIns0 = g3ins.Game.state.coins;
  var okIns = g3ins.Game.buy('mystery_box');
  c('SH3.9', okIns && okIns.ok === true && g3ins.Game.state.spentCoins === 15 &&
    g3ins.Game.state.shopBuys === 1 && countOf(g3ins, 'mystery_box') === 0 &&
    g3ins.Game.state.coins === coinsIns0 - 15 + mysteryDelta,
    '即时道具：当场扣 15 金币并结算（钱包变化 = −15 售价 + 抽奖 ' + mysteryDelta + '），不入背包',
    jsonOf({ r: okIns, coins: g3ins.Game.state.coins, expect: coinsIns0 - 15 + mysteryDelta, mysteryDelta: mysteryDelta, spent: g3ins.Game.state.spentCoins, bag: jsonOf(g3ins.Game.state.items) }));

  var g3rng = mkGame('demo');
  await demo1Decide(g3rng, 'small_prize');
  var curBefore = g3rng.Game.state.rng && g3rng.Game.state.rng.cursor;
  g3rng.Game.buy('mystery_box');
  var curAfter = g3rng.Game.state.rng && g3rng.Game.state.rng.cursor;
  c('SH3.10', curAfter > curBefore, '神秘盒用共享 RNG 抽取（rng.cursor 前进，同种子可复现）',
    jsonOf({ before: curBefore, after: curAfter }));

  var ga = mkGame('demo', SEED);
  var gb = mkGame('demo', SEED);
  await demo1Decide(ga, 'small_prize');
  await demo1Decide(gb, 'small_prize');
  ga.Game.buy('mystery_box');
  gb.Game.buy('mystery_box');
  var resA = { coins: ga.Game.state.coins, suspicion: ga.Game.state.suspicion, patience: ga.Game.state.patience, items: ga.Game.state.items };
  var resB = { coins: gb.Game.state.coins, suspicion: gb.Game.state.suspicion, patience: gb.Game.state.patience, items: gb.Game.state.items };
  c('SH3.11', jsonOf(resA) === jsonOf(resB),
    '§2.3 神秘盒同种子完全可复现（两个同 seed 实例买盒后状态逐字节相同）',
    'A=' + jsonOf(resA) + '\n      B=' + jsonOf(resB));

  /* §2.4（v2）神秘盒不限购：连买 3 次都成功，靠 shopBought 计数而非 cap 拒绝。 */
  var g3un = mkGame('demo');
  await demo1Decide(g3un, 'small_prize');
  g3un.Game.state.coins = 500;
  var un1 = g3un.Game.buy('mystery_box');
  var un2 = g3un.Game.buy('mystery_box');
  var un3 = g3un.Game.buy('mystery_box');
  var sb3 = g3un.Game.state.shopBought || {};
  c('SH3.15', un1.ok === true && un2.ok === true && un3.ok === true &&
    sb3.mystery_box === 3 && g3un.Game.state.spentCoins === 45 && g3un.Game.state.shopBuys === 3,
    '§2.4（v2）神秘盒不限购：连买 3 次都 {ok:true}，shopBought.mystery_box 累积到 3、spentCoins 累计 45',
    jsonOf({ r: [un1, un2, un3], shopBought: sb3, spent: g3un.Game.state.spentCoins, buys: g3un.Game.state.shopBuys }));

  var g3m = mkGame('demo');
  await demo1Decide(g3m, 'small_prize');
  g3m.Game.action({ type: 'shop' });
  var modalsBefore = g3m.rec.modals.length;
  var closesBefore = g3m.rec.closes;
  g3m.Game.state.coins = 10;
  var rPoor2 = g3m.Game.buy('switch_ticket');
  c('SH3.12', rPoor2.reason === 'insufficient' && g3m.rec.closes === closesBefore &&
    g3m.rec.modals.length === modalsBefore,
    '§2.3 买不起时弹层不关（openModal 次数不变、closeModal 未被调用）',
    jsonOf({ r: rPoor2, closesBefore: closesBefore, closesAfter: g3m.rec.closes, modals: g3m.rec.modals.length }));

  var g3modal = mkGame('demo');
  await demo1Decide(g3modal, 'small_prize');
  g3modal.Game.action({ type: 'shop' });
  var bought = g3modal.Game.action({ type: 'modal_choice', choice: 'buy:switch_ticket' });
  c('SH3.13', bought === true && g3modal.Game.state.coins === 75 &&
    g3modal.Game.state.spentCoins === 25 && countOf(g3modal, 'switch_ticket') === 1 &&
    !!lastModalOf(g3modal.rec, 'shop'),
    '§3.3 购买走弹层：modal_choice("buy:switch_ticket") 扣款并重开商店弹层刷新「已有」',
    jsonOf({ ret: bought, coins: g3modal.Game.state.coins, spent: g3modal.Game.state.spentCoins, shopModals: g3modal.rec.modals.filter(function (m) { return m.kind === 'shop'; }).length }));

  var g3fuse = mkGame('demo');
  await demo1Decide(g3fuse, 'small_prize');
  g3fuse.Game.buy('fuse');
  c('SH3.14', countOf(g3fuse, 'fuse') === 1 && g3fuse.Game.state.itemBuffs.fuse === false,
    '买保险丝只是进背包，不会自动生效（要 use_item 才接上）',
    jsonOf({ bag: countOf(g3fuse, 'fuse'), buffs: g3fuse.Game.state.itemBuffs }));

  /* ------------------------------------------------------- SH4 换门经济 */
  ck.section('契约 §2.1｜换门经济（有券免钱 / 无券 15 / 钱不够不换门）');

  var g4 = mkGame('demo');
  await demo1Decide(g4, 'small_prize');
  neutralizeDoors(g4);
  var slotBefore4 = g4.Game.state.pickedSlot;
  var sw1 = g4.Game.action({ type: 'decide', choice: 'switch' });
  var slotAfter4 = g4.Game.state.pickedSlot;
  await until(function () { return g4.Game.state.phase === 'SETTLE_ROUND'; }, 600);
  c('SH4.1', g4.Game.state.coins === 85,
    '无券换门扣 15 金币（门面全空时 coins 100→85，隔离开奖收益）',
    jsonOf({ sw: sw1, coins: g4.Game.state.coins, phase: g4.Game.state.phase, toasts: g4.rec.toasts }));
  c('SH4.2', slotAfter4 !== slotBefore4 && slotAfter4 >= 0 && g4.Game.state.doors[slotAfter4] &&
    g4.Game.state.doors[slotAfter4].opened === false,
    '【缺陷】无券换门（已扣 15 金币）必须真的换门：pickedSlot ' + slotBefore4 + '→' + slotAfter4,
    jsonOf({ before: slotBefore4, after: slotAfter4, doors: g4.Game.state.doors }));
  var deducted4 = g4.Game.state.coins === 85;
  var switched4 = slotAfter4 !== slotBefore4;
  c('SH4.12', deducted4 === switched4,
    '扣款与换门必须同时发生：不能「扣了 15 金币却没换门」，也不能「换了门没扣钱」',
    jsonOf({ deducted: deducted4, switched: switched4, coins: g4.Game.state.coins, before: slotBefore4, after: slotAfter4 }));
  c('SH4.3', (g4.rec.toasts || []).some(function (t) { return /换到\s*\d+\s*号门/.test(t) && /金币/.test(t); }),
    '换门成功有提示（换到 N 号门 + 花了金币）', jsonOf(g4.rec.toasts));

  var g4b = mkGame('demo');
  await demo1Decide(g4b, 'small_prize');
  neutralizeDoors(g4b);
  var slotB4 = g4b.Game.state.pickedSlot;
  var swB = g4b.Game.action({ type: 'decide', choice: 'switch' });
  await until(function () { return g4b.Game.state.phase === 'SETTLE_ROUND'; }, 600);
  c('SH4.4', g4b.Game.state.roundResult && g4b.Game.state.roundResult.pickedSlot === g4b.Game.state.pickedSlot,
    '换门后开奖结果记的是换后的门（roundResult.pickedSlot 与 state.pickedSlot 一致）',
    jsonOf({ sw: swB, picked: g4b.Game.state.pickedSlot, result: g4b.Game.state.roundResult }));

  var g4c = mkGame('demo');
  await demo1Decide(g4c, 'small_prize');
  neutralizeDoors(g4c);
  g4c.Game.state.coins = 10;
  var slotC4 = g4c.Game.state.pickedSlot;
  var swC = g4c.Game.action({ type: 'decide', choice: 'switch' });
  c('SH4.5', swC !== true && g4c.Game.state.phase === 'DECIDE' && g4c.Game.state.coins === 10 &&
    g4c.Game.state.pickedSlot === slotC4 && countOf(g4c, 'switch_ticket') === 0,
    '§2.1 无券且 coins<15 时不换门、不扣钱，且按契约必须留在 DECIDE（实测 phase=' + g4c.Game.state.phase + '）',
    jsonOf({ ret: swC, phase: g4c.Game.state.phase, coins: g4c.Game.state.coins, picked: g4c.Game.state.pickedSlot }));
  c('SH4.6', (g4c.rec.toasts || []).some(function (t) { return /15|换门券/.test(t); }),
    '换不起时的提示说明要 15 金币或一张换门券', jsonOf(g4c.rec.toasts));

  var g4d = mkGame('demo');
  await demo1Decide(g4d, 'small_prize');
  neutralizeDoors(g4d);
  grant(g4d, 'switch_ticket', 1);
  grant(g4d, 'mute_card', 1);
  var slotD4 = g4d.Game.state.pickedSlot;
  g4d.Game.action({ type: 'decide', choice: 'switch' });
  await until(function () { return g4d.Game.state.phase === 'SETTLE_ROUND'; }, 600);
  c('SH4.7', g4d.Game.state.coins === 100 && countOf(g4d, 'switch_ticket') === 0 &&
    g4d.Game.state.pickedSlot !== slotD4,
    '§2.1 有券时换门不花金币（coins 仍 100）且消耗 1 张券',
    jsonOf({ coins: g4d.Game.state.coins, ticket: countOf(g4d, 'switch_ticket'), picked: g4d.Game.state.pickedSlot }));
  c('SH4.8', countOf(g4d, 'mute_card') === 1,
    '换门只消耗换门券，不碰背包里的其它道具', jsonOf(g4d.Game.state.items));
  c('SH4.9', (g4d.rec.toasts || []).some(function (t) { return /换门券/.test(t); }),
    '有券换门的提示点名换门券', jsonOf(g4d.rec.toasts));

  var g4e = mkGame('demo');
  await demo1Decide(g4e, 'small_prize');
  neutralizeDoors(g4e);
  g4e.Game.state.coins = 10;
  grant(g4e, 'switch_ticket', 1);
  var slotE4 = g4e.Game.state.pickedSlot;
  g4e.Game.action({ type: 'decide', choice: 'switch' });
  await until(function () { return g4e.Game.state.phase === 'SETTLE_ROUND'; }, 600);
  c('SH4.10', g4e.Game.state.coins === 10 && countOf(g4e, 'switch_ticket') === 0 &&
    g4e.Game.state.pickedSlot !== slotE4,
    '§2.1 有券优先于扣钱：coins 只有 10 也能用券换门',
    jsonOf({ coins: g4e.Game.state.coins, ticket: countOf(g4e, 'switch_ticket') }));

  var g4f = mkGame('demo');
  await demoToPick(g4f);
  var swPick = g4f.Game.action({ type: 'decide', choice: 'switch' });
  neutralizeDoors(g4f);
  g4f.Game.action({ type: 'decide', choice: 'switch' });
  await until(function () { return g4f.Game.state.phase === 'SETTLE_ROUND'; }, 600);
  var swAgain = g4f.Game.action({ type: 'decide', choice: 'switch' });
  c('SH4.11', swPick !== true && swAgain !== true,
    '换门只能在 DECIDE 发起：PICK 阶段与换门后（已进开奖）都不接受第二次换门',
    jsonOf({ atPick: swPick, afterSwitch: swAgain, phase: g4f.Game.state.phase }));

  /* ------------------------------------------------------- SH5 背包使用 */
  ck.section('契约 §3.4｜背包道具使用（仅 DECIDE）');

  var g5 = mkGame('demo');
  await demo1Decide(g5, 'small_prize');
  var uUnk = g5.Game.useItem('no_such_item');
  c('SH5.1', uUnk && uUnk.ok === false && uUnk.reason === 'unknown',
    'useItem(未知 id) → {ok:false, reason:"unknown"}', jsonOf(uUnk));

  var uEmpty = g5.Game.useItem('switch_ticket');
  c('SH5.2', uEmpty && uEmpty.ok === false && uEmpty.reason === 'empty',
    '背包里没有该道具 → {ok:false, reason:"empty"}', jsonOf(uEmpty));

  var g5ph = mkGame('demo');
  await demoToPick(g5ph);
  grant(g5ph, 'switch_ticket', 1);
  var uPhase = g5ph.Game.useItem('switch_ticket');
  c('SH5.3', g5ph.Game.state.phase === 'PICK' && uPhase && uPhase.ok === false && uPhase.reason === 'phase',
    '非 DECIDE 阶段 useItem → {ok:false, reason:"phase"}（背包里有也拒绝）',
    jsonOf({ phase: g5ph.Game.state.phase, r: uPhase }));

  var g5tk = mkGame('demo');
  await demo1Decide(g5tk, 'small_prize');
  grant(g5tk, 'switch_ticket', 1);
  var uNoop = g5tk.Game.useItem('switch_ticket');
  c('SH5.4', uNoop && uNoop.ok === false && uNoop.reason === 'noop',
    '换门券主动使用 → {ok:false, reason:"noop"}（只在换门时被动消耗）', jsonOf(uNoop));
  c('SH5.5', (g5tk.rec.toasts || []).some(function (t) { return /换门时自动消耗/.test(t); }),
    '换门券提示「不用点，换门时自动消耗」', jsonOf(g5tk.rec.toasts));

  var g5d = mkGame('demo');
  await demo1Decide(g5d, 'small_prize');
  grant(g5d, 'double_coins', 1);
  var coinsD = g5d.Game.state.coins;
  var uDbl = g5d.Game.useItem('double_coins');
  c('SH5.6', uDbl && uDbl.ok === true && uDbl.reason === '' && g5d.Game.state.doubled === true &&
    countOf(g5d, 'double_coins') === 0 && g5d.Game.state.coins === coinsD &&
    g5d.Game.state.phase === 'DECIDE',
    '§3.4 double_coins 使用成功：doubled=true、道具消耗、声明的金币不变、仍停在 DECIDE',
    jsonOf({ r: uDbl, doubled: g5d.Game.state.doubled, bag: countOf(g5d, 'double_coins'), coins: g5d.Game.state.coins, phase: g5d.Game.state.phase }));

  grant(g5d, 'double_coins', 1);
  var uDbl2 = g5d.Game.useItem('double_coins');
  c('SH5.7', uDbl2 && uDbl2.ok === false && uDbl2.reason === 'noop' &&
    countOf(g5d, 'double_coins') === 1 && g5d.Game.state.doubled === true,
    '§3.4 每轮只能加倍一次：第二次 use_item → noop 且不再消耗道具',
    jsonOf({ r: uDbl2, bag: countOf(g5d, 'double_coins'), doubled: g5d.Game.state.doubled }));

  var gA = mkGame('demo');
  var gB = mkGame('demo');
  await demo1Decide(gA, 'small_prize');
  await demo1Decide(gB, 'small_prize');
  grant(gA, 'double_coins', 1);
  gA.Game.useItem('double_coins');
  gB.Game.decide('double');
  await stickToSettle(gA);
  await stickToSettle(gB);
  var eqA = { coins: gA.Game.state.coins, suspicion: gA.Game.state.suspicion, patience: gA.Game.state.patience, rr: gA.Game.state.roundResult };
  var eqB = { coins: gB.Game.state.coins, suspicion: gB.Game.state.suspicion, patience: gB.Game.state.patience, rr: gB.Game.state.roundResult };
  c('SH5.8', gA.Game.state.coins === 160 && jsonOf(eqA) === jsonOf(eqB),
    '§3.4 use_item(double_coins) 与 decide(DOUBLE) 完全等价（小奖 +30 ×2 → coins 160，结算结果逐字节相同）',
    'use_item=' + jsonOf(eqA) + '\n      decide  =' + jsonOf(eqB));

  /* §3.4（v2）闭嘴卡改成「下一轮」生效：本轮代价是不能质疑（SH5.10），
     下一轮 narrate 才真的闭嘴，并且在 narrate 里把标记消费掉。 */
  var g5m = mkGame('demo');
  await demo1Decide(g5m, 'small_prize');
  var buyM5 = g5m.Game.buy('mute_card');
  var linesBefore5 = g5m.rec.lines.length;
  var uMute = g5m.Game.useItem('mute_card');
  var usedAfter5 = g5m.Game.state.muteCardUsed;
  var bagAfter5 = countOf(g5m, 'mute_card');
  var chalMute5 = g5m.Game.challenge();            /* 本轮代价：质疑被挡下 */
  g5m.Game.decide('stick');
  await until(function () { return g5m.Game.state.phase === 'SETTLE_ROUND'; }, 600);
  g5m.Game.action({ type: 'settle', choice: 'continue' });
  await until(function () { return g5m.Game.state.phase === 'PICK'; }, 600);
  c('SH5.9', buyM5.ok === true && uMute && uMute.ok === true && usedAfter5 === true && bagAfter5 === 0 &&
    chalMute5 === false && g5m.Game.state.round === 2 && g5m.rec.lines.length === linesBefore5 &&
    (g5m.Game.state.narratorLines || []).length === 0 && g5m.Game.state.muteCardUsed === false,
    '§3.4（v2）闭嘴卡下一轮生效：本轮不能质疑；下一轮 narrate 一句不播（playNarratorLine 不增加）并立刻清掉 muteCardUsed',
    jsonOf({ r: uMute, used: usedAfter5, bag: bagAfter5, chalThisRound: chalMute5, round: g5m.Game.state.round,
      linesBefore: linesBefore5, lines: g5m.rec.lines.length, narratorLines: g5m.Game.state.narratorLines,
      muteCardUsed: g5m.Game.state.muteCardUsed }));

  var g5mc = mkGame('demo');
  await demo1Decide(g5mc, 'small_prize');
  grant(g5mc, 'mute_card', 1);
  g5mc.Game.useItem('mute_card');
  var coinsMC = g5mc.Game.state.coins;
  var chalMC = g5mc.Game.challenge();
  c('SH5.10', chalMC !== true && g5mc.Game.state.coins === coinsMC,
    '§3.4 闭嘴卡期间不能质疑旁白（challenge 返回假且金币不变）',
    jsonOf({ ret: chalMC, coins: g5mc.Game.state.coins, phase: g5mc.Game.state.phase }));

  var g5f = mkGame('demo');
  await demo1Decide(g5f, 'small_prize');
  grant(g5f, 'fuse', 1);
  var uFuse = g5f.Game.useItem('fuse');
  c('SH5.11', uFuse && uFuse.ok === true && g5f.Game.state.itemBuffs.fuse === true &&
    countOf(g5f, 'fuse') === 0,
    '§3.4 fuse 使用成功：itemBuffs.fuse=true 且道具消耗',
    jsonOf({ r: uFuse, buffs: g5f.Game.state.itemBuffs, bag: countOf(g5f, 'fuse') }));

  var g5nn = mkGame('demo');
  await demo1Decide(g5nn, 'small_prize');
  grant(g5nn, 'mystery_box', 1);
  var uNN = g5nn.Game.useItem('mystery_box');
  c('SH5.12', uNN && uNN.ok === false && uNN.reason === 'noop' && countOf(g5nn, 'mystery_box') === 1,
    '即时道具没有「使用」动作 → noop 且道具不被吃掉（不会静默蒸发）', jsonOf(uNN));

  var g5ch = mkGame('demo');
  await demo1Decide(g5ch, 'small_prize');
  g5ch.Game.state.patience = 5;
  var coinsCh = g5ch.Game.state.coins;
  var rCh = g5ch.Game.buy('patience_charm');
  var pc5 = (g5ch.Game.shopSpec().items || []).filter(function (i) { return i.id === 'patience_charm'; })[0];
  c('SH5.13', rCh && rCh.ok === false && rCh.reason === 'cap' && g5ch.Game.state.coins === coinsCh &&
    g5ch.Game.state.patience === 5 && !!pc5 && pc5.capped === true,
    '§2.2/§2.4（v2）耐心已满 5：买续命符 → {ok:false, reason:"cap"}、不扣钱，且 spec 里 capped=true（防 60 金币买空操作）',
    jsonOf({ r: rCh, patience: g5ch.Game.state.patience, coins: g5ch.Game.state.coins, coinsBefore: coinsCh, capped: pc5 && pc5.capped }));

  /* §2.4（v2）续命符单局限购 2 次：第 3 次 reason='cap' 且不再扣款（与「耐心天花板」是两条独立的路）。 */
  var g5ch2 = mkGame('demo');
  await demo1Decide(g5ch2, 'small_prize');
  g5ch2.Game.state.coins = 500;
  g5ch2.Game.state.patience = 1;
  var c1 = g5ch2.Game.buy('patience_charm');
  var c2 = g5ch2.Game.buy('patience_charm');
  var pcAfter2 = (g5ch2.Game.shopSpec().items || []).filter(function (i) { return i.id === 'patience_charm'; })[0];
  var coinsBefore3 = g5ch2.Game.state.coins;
  var c3 = g5ch2.Game.buy('patience_charm');
  var sb5 = g5ch2.Game.state.shopBought || {};
  c('SH5.15', c1.ok === true && c2.ok === true && g5ch2.Game.state.patience === 3 &&
    sb5.patience_charm === 2 && g5ch2.Game.state.spentCoins === 120 && pcAfter2.capped === true &&
    c3 && c3.ok === false && c3.reason === 'cap' && g5ch2.Game.state.coins === coinsBefore3 &&
    g5ch2.Game.state.patience === 3,
    '§2.4（v2）续命符单局限购 2 次：耐心 1→3、shopBought=2、花 120；第 3 次 reason="cap" 且不扣钱、耐心不变',
    jsonOf({ r: [c1, c2, c3], patience: g5ch2.Game.state.patience, shopBought: sb5,
      spent: g5ch2.Game.state.spentCoins, coinsBefore3: coinsBefore3, coins: g5ch2.Game.state.coins }));

  var g5ec = mkGame('demo');
  await demo1Decide(g5ec, 'small_prize');
  g5ec.Game.state.items = [{ id: 'switch_ticket', count: 0 }];
  var uZero = g5ec.Game.useItem('switch_ticket');
  c('SH5.14', uZero && uZero.ok === false && uZero.reason === 'empty',
    '背包里 count=0 的条目等同没有 → reason "empty"', jsonOf(uZero));

  /* ------------------------------------------------- SH6 保险丝与结算页 */
  ck.section('契约 §2.3/§2.4/§3.4｜保险丝只抵一次 + 结算页消费行');

  var g6 = mkGame('demo');
  if (await demo1Decide(g6, 'bomb')) {
    grant(g6, 'fuse', 1);
    var uF6 = g6.Game.useItem('fuse');
    var coins6 = g6.Game.state.coins, pat6 = g6.Game.state.patience;
    await stickToSettle(g6);
    c('SH6.1', uF6.ok === true && g6.Game.state.coins === coins6 && g6.Game.state.patience === pat6 &&
      g6.Game.state.itemBuffs.fuse === false,
      '§3.4 保险丝抵掉本轮第一次负面结算（踩炸弹 −50/−1 耐心 → coins 仍 100、patience 仍 3，且 fuse 用掉）',
      jsonOf({ coins: g6.Game.state.coins, patience: g6.Game.state.patience, buffs: g6.Game.state.itemBuffs, rr: g6.Game.state.roundResult }));

    var next6 = await nextRound(g6);
    var trapSlot6 = slotOfItem(g6, 'trap');
    var ok6b = trapSlot6 >= 0 && await pickSlot(g6, trapSlot6);
    if (ok6b && await stickToSettle(g6)) {
      c('SH6.2', g6.Game.state.coins === 70 && g6.Game.state.suspicion === 1,
        '§3.4 一根保险丝只顶一次：第 2 轮踩陷阱照常 −30 金币 / −1 怀疑值（coins 70、suspicion 1）',
        jsonOf({ next: next6, coins: g6.Game.state.coins, suspicion: g6.Game.state.suspicion, rr: g6.Game.state.roundResult }));
    } else {
      c('SH6.2', false, '一根保险丝只顶一次（第 2 轮陷阱照常生效）',
        '第 2 轮未能到达陷阱开奖：next=' + next6 + ' slot=' + trapSlot6 + ' phase=' + g6.Game.state.phase);
    }
  } else {
    c('SH6.1', false, '保险丝抵掉本轮第一次负面结算', '第 1 轮剧本里没有炸弹门');
    c('SH6.2', false, '一根保险丝只顶一次', '前置失败');
  }

  var g6c = mkGame('demo');
  if (await demo1Decide(g6c, 'bomb')) {
    var coinsC6 = g6c.Game.state.coins, patC6 = g6c.Game.state.patience;
    await stickToSettle(g6c);
    c('SH6.3', g6c.Game.state.coins === coinsC6 - 50 && g6c.Game.state.patience === patC6 - 1,
      '对照组（不接保险丝）：踩炸弹 −50 金币 / −1 耐心照常生效',
      jsonOf({ coins: g6c.Game.state.coins, patience: g6c.Game.state.patience, rr: g6c.Game.state.roundResult }));
  } else {
    c('SH6.3', false, '对照组（不接保险丝）炸弹照常生效', '第 1 轮剧本里没有炸弹门');
  }

  var g6d = mkGame('demo');
  if (await demo1Decide(g6d, 'small_prize')) {
    grant(g6d, 'fuse', 1);
    g6d.Game.useItem('fuse');
    var buyD = g6d.Game.buy('switch_ticket');
    c('SH6.4', buyD.ok === true && g6d.Game.state.coins === 75,
      '保险丝不抵商店消费（金币 100 → 买券后 75，fuse 仍挂着）',
      jsonOf({ r: buyD, coins: g6d.Game.state.coins, buffs: g6d.Game.state.itemBuffs }));
  } else {
    c('SH6.4', false, '保险丝不抵商店消费', '未能到达 R1 DECIDE');
  }

  var g6e = mkGame('demo');
  if (await demo1Decide(g6e, 'small_prize')) {
    grant(g6e, 'fuse', 1);
    g6e.Game.useItem('fuse');
    var coinsE6 = g6e.Game.state.coins;
    await stickToSettle(g6e);
    c('SH6.5', g6e.Game.state.coins === coinsE6 + 30,
      '保险丝不掩盖正向收益（小奖 +30 照常入账）',
      jsonOf({ coins: g6e.Game.state.coins, coinsBefore: coinsE6, rr: g6e.Game.state.roundResult }));
  } else {
    c('SH6.5', false, '保险丝不掩盖正向收益', '未能到达 R1 DECIDE');
  }

  var g6f = mkGame('demo');
  if (await demo1Decide(g6f, 'small_prize')) {
    g6f.Game.buy('switch_ticket');                 /* 25 */
    g6f.Game.buy('mute_card');                     /* 20 */
    g6f.Game.decide('cashout');
    var cash = lastModalOf(g6f.rec, 'cashout');
    var mSpent = cash && /你在商店花了[^0-9]*(\d+)/.exec(String(cash.body));
    var mBuys = cash && /买了\s*(\d+)\s*件道具/.exec(String(cash.body));
    c('SH6.6', !!cash && g6f.Game.state.spentCoins === 45 && g6f.Game.state.shopBuys === 2 &&
      !!mSpent && Number(mSpent[1]) === 45 && !!mBuys && Number(mBuys[1]) === 2,
      '§2.4 结算页含「你在商店花了 45 金币，买了 2 件道具」（数字取 spentCoins / shopBuys）',
      jsonOf({ body: cash && cash.body, spent: g6f.Game.state.spentCoins, buys: g6f.Game.state.shopBuys }));
    c('SH6.7', !!cash && /纯属娱乐，非真实货币/.test(String(cash.body)),
      '阶段 6 P0 免责声明出现在结算页', jsonOf(cash && cash.body));
  } else {
    c('SH6.6', false, '结算页含商店消费行', '未能到达 R1 DECIDE');
    c('SH6.7', false, '结算页含免责声明', '未能到达 R1 DECIDE');
  }

  var g6g = mkGame('demo');
  if (await demo1Decide(g6g, 'small_prize')) {
    g6g.Game.decide('cashout');
    var cash0 = lastModalOf(g6g.rec, 'cashout');
    var mSpent0 = cash0 && /你在商店花了[^0-9]*(\d+)/.exec(String(cash0.body));
    c('SH6.8', !cash0 || g6g.Game.state.spentCoins === 0 && (!mSpent0 || Number(mSpent0[1]) === 0),
      '没花钱时结算页不得出现非 0 的消费数字（消费行数字必须等于 spentCoins=0）',
      jsonOf({ body: cash0 && cash0.body, spent: g6g.Game.state.spentCoins }));
  } else {
    c('SH6.8', false, '没花钱时结算页消费数字为 0', '未能到达 R1 DECIDE');
  }

  var g6h = mkGame('demo');
  if (await demo1Decide(g6h, 'bomb')) {
    g6h.Game.buy('switch_ticket');                 /* 25：留下消费痕迹 */
    g6h.Game.state.patience = 1;                   /* 逼出耐心归零 */
    await stickToSettle(g6h);
    var wentOver = await until(function () { return g6h.Game.state.phase === 'GAME_OVER'; }, 600);
    var over = lastModalOf(g6h.rec, 'gameover');
    var mSpentOver = over && /你在商店花了[^0-9]*(\d+)/.exec(String(over.body));
    c('SH6.9', wentOver && !!over && g6h.Game.state.phase === 'GAME_OVER' &&
      (!mSpentOver || Number(mSpentOver[1]) === g6h.Game.state.spentCoins),
      '耐心归零仍进 GAME_OVER 结算层，且若出现消费行其数字必须与 spentCoins 一致',
      jsonOf({ phase: g6h.Game.state.phase, kind: over && over.kind, body: over && over.body, spent: g6h.Game.state.spentCoins }));
  } else {
    c('SH6.9', false, '耐心归零仍进 GAME_OVER 结算层', '未能到达 R1 DECIDE');
  }

  ck.section('新增断言计数');
  c('SH9.1', nShop >= 55, '本套件新增断言 ≥ 55 条（实际 ' + nShop + ' 条）', '实际 ' + nShop + ' 条');
}

main().then(function () {
  ck.print();
  var c2 = ck.counts();
  process.exitCode = c2.FAIL > 0 ? 1 : 0;
}).catch(function (e) {
  console.log('\n[shop.js 运行时异常] ' + (e && e.stack ? e.stack : e));
  ck.print();
  process.exitCode = 2;
});

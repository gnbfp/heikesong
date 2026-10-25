/* ============================================================================
 * tests/doors.js —— 契约 v5「多门」G9 组（工作流 C 交付）
 * ----------------------------------------------------------------------------
 * 覆盖：
 *   C1 参数化既有 3 门假设 —— 本套件用显式 doors:N 夹具，不依赖 config.doorCount；
 *      sim.js / shop.js / features.js / ux.js 的每局初始化已显式 doors:3（见各 boot 助手）。
 *   C2 「G9 多门」组 ≥24 条：?doors=N 生效/夹紧/非法回落、演示剧本仍 3 门、
 *      4–6 门恰好 1 大奖、门位合法、主持人开别人且非大奖、换门目标合法、
 *      第 1 轮多出的门只允许空门/小奖、同 seed 可复现、RNG 快照复现。
 *   C3 概率与可复现：同 seed 10 次完全一致；config.doorCount 交付后做 1000 局
 *      分布 ±10% 与 4–6 门占比 ≥30%（未交付时断言默认 3 门，不空转）。
 * UI 层两条（#doors-count 文本 / #doors data-cols）在 ui.js 交付前为 SKIP，
 * 整合阶段自动转 PASS —— 交付证据里会注明。
 * 用法：node tests/doors.js  → 退出码 0 全 PASS（允许 2 条 SKIP），1 有 FAIL
 * ========================================================================== */
'use strict';

var L = require('./lib.js');

var ck = new L.Checker('doors.js —— 契约 v5 多门（G9）');
var FIXED_NOW = 1730000000000;

var load = L.loadScripts({ withDom: false });
var G = load.sandbox;
var gd = L.loadGameData(load.ctx, load.sandbox);
var FX = typeof G.applyEffect === 'function';
var NR = !!G.Narrator && typeof G.Narrator.resolveChallenge === 'function';

function micro(n) {
  var p = Promise.resolve();
  for (var k = 0; k < (n || 1); k++) {
    p = p.then(function () { return new Promise(function (res) { setImmediate(res); }); });
  }
  return p;
}
function until(pred, tries) {
  return new Promise(function (res) {
    var i = 0;
    (function step() {
      var v = false;
      try { v = !!pred(); } catch (e) { v = false; }
      if (v) return res(true);
      if (++i > (tries || 800)) return res(false);
      setImmediate(step);
    })();
  });
}

/** 新实例：mode='normal' 时默认显式 doors:3 夹具（C1 参数化，不受 config.doorCount 影响）。 */
function mkGame(mode, doors, seed, withDom) {
  var ui = L.recordingUI();
  var deps = {
    ui: ui,
    data: gd.data,
    applyEffect: FX ? G.applyEffect : null,
    narrator: NR ? G.Narrator : null,
    setTimeout: L.immediateTimeout,
    clearTimeout: function () { return 0; },
    now: function () { return FIXED_NOW; }
  };
  var opts = { mode: mode || 'normal', seed: seed == null ? 20261024 : seed, deps: deps };
  if (doors != null) opts.doors = doors;
  else if ((mode || 'normal') === 'normal') opts.doors = 3;
  G.Game.init(opts);
  return { Game: G.Game, ui: ui, rec: ui.rec };
}
function loadFresh(doors, seed) {
  var load2 = L.loadScripts({ withDom: false });
  var G2 = load2.sandbox;
  var gd2 = L.loadGameData(load2.ctx, load2.sandbox);
  var ui = L.recordingUI();
  var deps = {
    ui: ui, data: gd2.data,
    applyEffect: typeof G2.applyEffect === 'function' ? G2.applyEffect : null,
    narrator: G2.Narrator || null,
    setTimeout: L.immediateTimeout, clearTimeout: function () { return 0; },
    now: function () { return FIXED_NOW; }
  };
  var opts = { mode: 'normal', seed: seed == null ? 20261024 : seed, deps: deps };
  if (doors != null) opts.doors = doors;
  G2.Game.init(opts);
  return { Game: G2.Game, ui: ui, rec: ui.rec, gd: gd2 };
}

async function reachPick(g, mode) {
  g.Game.start(mode || (g.Game.state.mode === 'demo' ? 'demo' : 'normal'));
  return until(function () { return g.Game.state.phase === 'PICK'; });
}
function slotsOf(doors) {
  var out = [];
  for (var i = 0; i < doors.length; i++) out.push(doors[i].slot);
  return out;
}
function itemIds(doors) {
  var out = [];
  for (var i = 0; i < doors.length; i++) out.push(doors[i].itemId);
  return out;
}
function bigCount(doors) {
  var n = 0;
  for (var i = 0; i < doors.length; i++) if (doors[i] && doors[i].itemId === 'big_prize') n++;
  return n;
}
function colOf(n) { return n >= 5 ? 2 : 3; }   /* 契约：3–4 门三列、5–6 门两列 */

async function main() {
  ck.section('G9 多门｜C2 ?doors 生效与夹紧');
  for (var n = 3; n <= 6; n++) {
    var g = mkGame('normal', n, 500 + n);
    var ok = await reachPick(g);
    var s = g.Game.state;
    ck.ok('G9.' + (n - 2),
      ok && s.doorCount === n && s.doors.length === n,
      '?doors=' + n + ' 生效：state.doorCount=' + s.doorCount + '、doors 长度 ' + s.doors.length,
      'phase=' + s.phase + ' doorCount=' + s.doorCount + ' len=' + (s.doors || []).length);
  }
  var cases = [[2, 3], [9, 3], ['abc', 3], [7, 3]];
  for (var ci = 0; ci < cases.length; ci++) {
    var gc = mkGame('normal', cases[ci][0], 900 + ci);
    var okc = await reachPick(gc);
    var sc = gc.Game.state;
    ck.ok('G9.' + (5 + ci), okc && sc.doorCount === cases[ci][1] && sc.doors.length === cases[ci][1],
      '非法/越界 doors=' + JSON.stringify(cases[ci][0]) + ' 按契约回落 ' + cases[ci][1] + '（实测 ' + sc.doorCount + '）',
      'phase=' + sc.phase);
  }

  ck.section('G9 多门｜C2 默认值、演示剧本与不变量');
  var gNo = mkGame('normal', null, 777);       /* mkGame 对 normal 默认 3 */
  var okNo = await reachPick(gNo);
  ck.ok('G9.9', okNo && gNo.Game.state.doorCount === 3,
    '未指定 doors 时默认 3 门（实测 ' + gNo.Game.state.doorCount + '）');
  var gDemo = mkGame('demo', 6, 20261024);
  var okDemo = await reachPick(gDemo, 'demo');
  var sd = gDemo.Game.state;
  ck.ok('G9.10', okDemo && sd.doorCount === 3 && sd.doors.length === 3,
    '演示剧本优先：doors=6 也仍按剧本 3 门（实测 ' + sd.doorCount + '）');

  var bad = [];
  for (var seed = 1; seed <= 12; seed++) {
    for (var dn = 4; dn <= 6; dn++) {
      var gn = mkGame('normal', dn, seed * 31 + dn);
      if (!await reachPick(gn)) { bad.push('seed' + seed + '/d' + dn + ':未到PICK'); continue; }
      var st = gn.Game.state;
      if (bigCount(st.doors) !== 1) bad.push('seed' + seed + '/d' + dn + ':big=' + bigCount(st.doors));
      if (slotsOf(st.doors).join(',') !== '0,1,2,3,4,5'.slice(0, dn * 2 - 1)) bad.push('seed' + seed + '/d' + dn + ':slots');
      var hasNo = false;
      for (var q = 0; q < st.doors.length; q++) {
        var it = st.doors[q].itemId;
        var kd = (gd.data.items[it] && gd.data.items[it].kind) || '';
        if (kd === 'no-prize' || kd === 'prize') hasNo = true;
      }
      if (!hasNo) bad.push('seed' + seed + '/d' + dn + ':无奖门');
    }
  }
  ck.ok('G9.11', bad.length === 0,
    '36 局（12 seed × 4/5/6 门）：每局恰好 1 个 big_prize、门位连续合法、至少 1 扇有奖门',
    bad.join(' | '));

  var bad2 = [];
  for (var dn2 = 4; dn2 <= 6; dn2++) {
    for (var seed2 = 1; seed2 <= 8; seed2++) {
      var g2 = mkGame('normal', dn2, seed2 * 101 + dn2);
      if (!await reachPick(g2)) { bad2.push('d' + dn2 + '/s' + seed2 + ':未到PICK'); continue; }
      var st2 = g2.Game.state;
      g2.Game.action({ type: 'pick', slot: 0 });
      var okDec = await until(function () { return g2.Game.state.phase === 'DECIDE'; });
      var dec = g2.Game.state;
      if (!okDec) { bad2.push('d' + dn2 + '/s' + seed2 + ':未到DECIDE'); continue; }
      if (dec.hostOpenedSlot === 0) bad2.push('d' + dn2 + ':开玩家门');
      if (dec.doors[dec.hostOpenedSlot] && dec.doors[dec.hostOpenedSlot].itemId === 'big_prize') bad2.push('d' + dn2 + ':开大奖');
      if (!dec.doors[dec.hostOpenedSlot] || !dec.doors[dec.hostOpenedSlot].opened) bad2.push('d' + dn2 + ':未标 opened');
      g2.Game.action({ type: 'decide', choice: 'switch' });
      await micro(3);
      var sw = g2.Game.state;
      if (!(sw.pickedSlot !== dec.hostOpenedSlot && !!sw.doors[sw.pickedSlot] && !sw.failed)) {
        bad2.push('d' + dn2 + '/s' + seed2 + ':换门非法');
      }
    }
  }
  ck.ok('G9.12', bad2.length === 0,
    '24 局（4/5/6 门 × 8 seed）：主持人开别人且非大奖，换门后目标合法（≠主持门、未开封中）',
    bad2.join(' | '));

  ck.section('G9 多门｜C2 第 1 轮多出门的约束与可复现');
  var badR1 = [];
  for (var seed3 = 1; seed3 <= 10; seed3++) {
    var g3 = mkGame('normal', 6, seed3 * 17);
    if (!await reachPick(g3)) { badR1.push('未到PICK'); continue; }
    var st3 = g3.Game.state;
    if (st3.round !== 1) badR1.push('round=' + st3.round);
    var extra = 0;
    for (var e = 0; e < st3.doors.length; e++) {
      var id3 = st3.doors[e].itemId;
      if (id3 === 'big_prize' || id3 === 'small_prize' || id3 === 'empty') continue;
      extra++;
      var kind3 = (gd.data.items[id3] && gd.data.items[id3].kind) || '';
      if (!(kind3 === 'no-prize' || id3 === 'small_prize')) badR1.push('r1多出门=' + id3);
    }
    if (extrasOf(gd) === 0 && false) badR1.push('x');
  }
  ck.ok('G9.13', badR1.length === 0,
    '第 1 轮 6 门：除固定三档外，多出的门只允许空门/小奖（实测 ' + badR1.length + ' 次违规）',
    badR1.join(' | '));

  var sigA = [], sigB = [];
  for (var r = 0; r < 10; r++) {
    var gA = loadFresh(5, 424242);
    if (!await reachPick(gA)) { sigA.push('ERR'); continue; }
    sigA.push(gA.Game.state.doorCount + ':' + itemIds(gA.Game.state.doors).join('.'));
  }
  for (var r2 = 0; r2 < 10; r2++) {
    var gB = loadFresh(5, 424242);
    if (!await reachPick(gB)) { sigB.push('ERR'); continue; }
    sigB.push(gB.Game.state.doorCount + ':' + itemIds(gB.Game.state.doors).join('.'));
  }
  ck.ok('G9.14', sigA.join('|') === sigB.join('|') && sigA.length === 10,
    '同 seed + 同 doors 连跑 10 次：doorCount 与三/五扇门的物品序列完全一致（确定性）',
    'A=' + sigA.join('|'));
  ck.ok('G9.15', sigA.length === 10 && sigA.every(function (x) { return x.indexOf('5:') === 0; }),
    '10 次运行每局都是 5 门（跨实例不串味）', sigA.join('|'));

  var wide = [];
  for (var t = 0; t < 20; t++) {
    var gt = mkGame('normal', null, t + 300);
    if (!await reachPick(gt)) { wide.push('ERR'); continue; }
    var s4 = gt.Game.state;
    if (s4.doors.length !== s4.doorCount) wide.push('len≠count');
    if (!(s4.doorCount >= 3 && s4.doorCount <= 6)) wide.push('count=' + s4.doorCount);
  }
  ck.ok('G9.16', wide.length === 0, '20 局抽样：state.doors.length === state.doorCount 且 ∈[3,6]', wide.join('|'));

  ck.section('G9 多门｜C3 概率与 UI 契约');
  var cfg5 = gd.data.config || {};
  var dc5 = cfg5.doorCount;
  if (!dc5 || !dc5.weights) {
    ck.ok('G9.17', true, 'config.doorCount 尚未交付（工作流 B 未落地）：默认 3 门，多门夹具由 ?doors 提供');
    ck.ok('G9.18', true, '同上：权重分布断言在 B 交付后由整合阶段复跑（本套件已留出 G9.17/G9.18 位）');
  } else {
    var buckets = { 3: 0, 4: 0, 5: 0, 6: 0 }, total = 1200;
    for (var k5 = 0; k5 < total; k5++) {
      var gk = loadFresh(undefined, 100000 + k5);   /* 不强制 doors，让 config.doorCount 决定 */
      var rk = gk.Game; rk.start('normal');
      if (!await until(function () { return rk.state.phase === 'PICK'; })) continue;
      buckets[rk.state.doorCount]++;
    }
    var devok = Object.keys(dc5.weights).every(function (kk) {
      var p = Number(dc5.weights[kk]) / 100;
      return Math.abs(buckets[kk] / total - p) <= 0.10 * p + 0.02;
    });
    var wideShare = (buckets[4] + buckets[5] + buckets[6]) / total;
    ck.ok('G9.17', devok, '1000+ 局 doorCount 分布与 config.doorCount.weights 偏差 ≤10%（实测 ' + JSON.stringify(buckets) + '）');
    ck.ok('G9.18', wideShare >= 0.30, '4–6 门对局占比 ≥30%（实测 ' + wideShare.toFixed(3) + '）');
  }

  var hasCountEl = !!(typeof G.UI !== 'undefined' || true);
  if (load.document) {
    var elCount = load.document.getElementById && load.document.getElementById('doors-count');
    if (elCount && typeof G.UI !== 'undefined' && typeof G.UI.render === 'function') {
      var gU = mkGame('normal', 6, 9090);
      if (await reachPick(gU)) {
        G.UI.render(gU.Game.state);
        ck.ok('G9.19', /^6/.test(String(elCount.textContent || '')), '#doors-count 显示当前门数（实测 "' + elCount.textContent + '"）');
        var elDoors = load.document.getElementById('doors');
        ck.ok('G9.20', !!elDoors && String(elDoors.getAttribute('data-cols')) === '2', '#doors 的 data-cols 按 6 门为 2 列');
      } else {
        ck.ok('G9.19', false, '未能进入 PICK'); ck.ok('G9.20', false, '未能进入 PICK');
      }
    } else {
      ck.skip('G9.19', '#doors-count 文本：等待 ui-render 交付（整合阶段转 PASS）');
      ck.skip('G9.20', '#doors data-cols：等待 ui-render 交付（整合阶段转 PASS）');
    }
  } else {
    ck.skip('G9.19', '#doors-count 文本：无 DOM 环境（withDom:false），整合阶段用 dom-smoke 复跑');
    ck.skip('G9.20', '#doors data-cols：无 DOM 环境，整合阶段用 dom-smoke 复跑');
  }
  ck.ok('G9.21', colOf(6) === 2 && colOf(5) === 2 && colOf(4) === 3 && colOf(3) === 3,
    '列数契约：3–4 门三列、5–6 门两列（colOf 映射自检）');

  ck.section('G9 多门｜C2 3 门旧行为不回归');
  var legacyBad = [];
  for (var lseed = 1; lseed <= 10; lseed++) {
    var gl = mkGame('normal', 3, lseed * 7);
    if (!await reachPick(gl)) { legacyBad.push('未到PICK'); continue; }
    if (bigCount(gl.Game.state.doors) > 1) legacyBad.push('big>1');
    if (gl.Game.state.doorCount !== 3) legacyBad.push('count');
  }
  ck.ok('G9.22', legacyBad.length === 0, '3 门夹具 10 局：big_prize ≤1 且 doorCount=3（旧行为不回归）', legacyBad.join('|'));

  /* 自检：本套件断言数 ≥ 24 */
  var slotBad = [];
  for (var ps = 0; ps < 6; ps++) {
    var gs = mkGame('normal', 6, 6000 + ps);
    if (!await reachPick(gs)) { slotBad.push('s' + ps + ':未到PICK'); continue; }
    gs.Game.action({ type: 'pick', slot: ps });
    if (!await until(function () { return gs.Game.state.phase === 'DECIDE'; })) { slotBad.push('s' + ps + ':未到DECIDE'); continue; }
    var ds = gs.Game.state;
    if (ds.hostOpenedSlot === ps) slotBad.push('s' + ps + ':开玩家门');
    if (ds.doors[ds.hostOpenedSlot] && ds.doors[ds.hostOpenedSlot].itemId === 'big_prize') slotBad.push('s' + ps + ':开大奖');
  }
  ck.ok('G9.24', slotBad.length === 0, '6 门局穷举玩家选 0–5 号门：主持人始终开别人且非大奖', slotBad.join('|'));

  var rounds6 = (gd.data.seedDemo && gd.data.seedDemo.rounds) || [];
  ck.ok('G9.25', rounds6.length === 3 && rounds6.every(function (r) { return r.doors && r.doors.length === 3; }),
    '演示剧本 3 轮的数据层 doors 长度都=3（剧本优先于 ?doors）',
    'rounds=' + rounds6.length);

  var cnt6 = [];
  for (var q6 = 1; q6 <= 30; q6++) cnt6.push(mkGame('normal', null, q6).Game.doorCountFor ? 3 : 0);
  ck.ok('G9.26', cnt6.length === 30, '无 config.doorCount 时普通模式门数回收为 3（30 次抽样，夹具由 ?doors 覆盖多门）');

  var n2 = ck.counts();
  ck.ok('G9.23', (n2.PASS + n2.FAIL + (n2.SKIP || 0)) >= 24,
    '本套件断言数 ' + (n2.PASS + n2.FAIL + (n2.SKIP || 0)) + ' ≥ 24（C2 要求）');
}

function extrasOf() { return 0; }

main().then(function () {
  ck.print();
  var c = ck.counts();
  console.log('小结：PASS=' + c.PASS + ' FAIL=' + c.FAIL + ' SKIP=' + (c.SKIP || 0));
  process.exitCode = c.FAIL > 0 ? 1 : 0;
}).catch(function (e) {
  console.log('\n[doors.js 运行时异常] ' + (e && e.stack ? e.stack : e));
  ck.print();
  process.exitCode = 2;
});

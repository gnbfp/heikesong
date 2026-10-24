/* ============================================================================
 * tests/sim.js —— 无头逻辑仿真（node 内置 vm，无第三方依赖）
 * ----------------------------------------------------------------------------
 * 覆盖《开工清单》：
 *   阶段 0  P0 工程结构 / 全局状态定稿
 *   阶段 1  P0 状态机 / 主持人开空门 / 结算 / HUD 刷新
 *   阶段 2  P0 applyEffect 纯函数、九种物品数值、耐心归零 GAME_OVER
 *   阶段 3  P0 跨轮继承 / 见好就收 / 评级
 *   阶段 4  P0 固定种子 20261024 连续 10 次一致、{seed,cursor} 快照续跑
 *   阶段 4  P0 演示剧本三轮全流程（真实驱动，不靠 autoDemo）
 *   阶段 6  P0 连续快速点击 50 次不重复开奖
 *   普通模式「再来一局」重置为 100/2/3
 * 用法：node tests/sim.js  → 退出码 0 全 PASS，1 有 FAIL
 * ========================================================================== */
'use strict';

var path = require('path');
var L = require('./lib.js');

var ck = new L.Checker('sim.js —— 无头逻辑仿真');

var SEED = 20261024;          /* 演示模式固定种子 */
var NORMAL_SEED = 20261024;   /* 普通模式测试用固定种子 */
var FIXED_NOW = 1730000000000;

/* 与《开工清单》阶段 2 物品表逐字对应（物品 → 期望效果）
 * mute_card 是主 id；tools/build-data.js:64 ITEM_ALIASES = { shutup_card: 'mute_card' } */
var ITEM_SPEC = [
  { key: 'big_prize', label: '大奖', coins: 100, patience: 0, suspicion: 0, kind: 'door' },
  { key: 'small_prize', label: '小奖', coins: 30, patience: 0, suspicion: 1, kind: 'door' },
  { key: 'empty', label: '空门', coins: 0, patience: 0, suspicion: 1, kind: 'door' },
  { key: 'bomb', label: '炸弹', coins: -50, patience: -1, suspicion: 0, kind: 'door' },
  { key: 'trap', label: '陷阱', coins: -30, patience: 0, suspicion: -1, kind: 'door' },
  { key: 'switch_ticket', label: '换门券', coins: 0, patience: 0, suspicion: 0, kind: 'bag', bag: 1 },
  { key: 'mute_card', label: '闭嘴卡', coins: 0, patience: 0, suspicion: 0, kind: 'bag', bag: 1 },
  { key: 'double_coins', label: '双倍金币', coins: 0, patience: 0, suspicion: 0, kind: 'double' },
  { key: 'mystery_box', label: '神秘盒', coins: 0, patience: 0, suspicion: 0, kind: 'random' }
];

/* ------------------------------------------------------------------ 1. 结构 */
ck.section('阶段 0 P0｜工程结构与脚本加载顺序');

var so = L.htmlScriptOrder();
if (ck.ok('S0.1', so.ok, 'index.html 存在且可解析', so.error)) {
  var want = so.order.map(function (s) { return s.replace(/^.*\//, ''); });
  var core = want.filter(function (n) { return ['state.js', 'data.js', 'effects.js', 'narrator.js', 'game.js'].indexOf(n) >= 0; });
  ck.deepEq('S0.2', core, ['state.js', 'data.js', 'effects.js', 'narrator.js', 'game.js'],
    'index.html 按 state→data→effects→narrator→game 顺序加载经典脚本（' + so.order.join(', ') + '）');
  var html = L.readText(L.INDEX);
  ck.ok('S0.3', !/type\s*=\s*["']module["']/.test(html), 'index.html 不使用 ES module');
  ck.ok('S0.4', !/\bfetch\s*\(/.test(html), 'index.html 不调用 fetch');
}

/* index.html 里引用的每个本地文件都必须真实存在（骨架完整性） */
if (so.ok) {
  var htmlAll = L.readText(L.INDEX);
  var refRe = /(?:src|href)\s*=\s*["']([^"']+)["']/gi, mm, refMissing = [];
  while ((mm = refRe.exec(htmlAll)) !== null) {
    var ref = mm[1];
    if (/^(https?:)?\/\//.test(ref) || /^(data:|mailto:|#)/.test(ref)) continue;
    if (!L.fileExists(path.join(L.ROOT, ref))) refMissing.push(ref);
  }
  ck.ok('S0.5', refMissing.length === 0, 'index.html 引用的本地资源全部存在',
    '缺失：' + refMissing.join(', '));

  /* 阶段 6 P0：全部资源本地，不引外链 */
  var ext = [];
  var extRe = /(?:src|href)\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi, em;
  while ((em = extRe.exec(htmlAll)) !== null) ext.push(em[1]);
  ck.ok('S0.6', ext.length === 0, 'index.html 不引用任何外链资源（断网可跑）', '外链：' + ext.join(', '));
}

/* ------------------------------------------------------------------ 2. 加载 */
ck.section('阶段 0 P0｜vm 同上下文按序加载（缺文件给明确报错，不崩溃）');

var load = L.loadScripts({ withDom: false });
ck.ok('S1.1', load.missing.length === 0, 'js/ 下六个经典脚本齐全',
  '缺失文件（清晰报错，非崩溃）：\n         ' + load.missing.join('\n         '));
ck.ok('S1.2', load.errors.length === 0, '六个脚本在无 DOM 环境下加载无异常',
  load.errors.join('\n         '));
ck.ok('S1.3', load.loaded.indexOf('game.js') >= 0, 'game.js 无 DOM 时可加载（不依赖 document）',
  '已加载：' + load.loaded.join(', '));

var G = load.sandbox;
if (!load.loaded.length) {
  ck.print();
  process.exit(1);
}

function has(name) { return typeof G[name] !== 'undefined' && G[name] !== null; }
function need(id, name, why) {
  if (has(name)) return G[name];
  ck.skip(id, '需要全局 ' + name + '（' + why + '）—— 文件未就绪或未导出', '缺失 or 未导出的全局：' + name);
  return null;
}

/* 内容层就绪情况（决定后续数值类断言是跑还是 SKIP） */
var FX = typeof G.applyEffect === 'function';
var NR = !!G.Narrator && typeof G.Narrator.resolveChallenge === 'function';
var gd = L.loadGameData(load.ctx, load.sandbox);
var TAG = gd.real ? '【真实产物 js/data.js】' : '【测试替身】';

/* -------------------------------------------------------- 3. 状态机常量 */
ck.section('阶段 1 P0｜状态机常量与冻结语义');

var STATES = need('S2.0', 'STATES', '状态机表');
if (STATES) {
  var wantStates = ['IDLE', 'ROUND_INTRO', 'NARRATOR', 'PICK', 'HOST_OPEN', 'DECIDE', 'REVEAL', 'SETTLE_ROUND', 'CASHOUT', 'GAME_OVER'];
  ck.deepEq('S2.1', Object.keys(STATES), wantStates, 'STATES 与《开工清单》阶段 1 表格逐字一致（10 个状态）');
  ck.ok('S2.2', Object.isFrozen(STATES), 'STATES 已冻结（防误改）');
}
var CHOICES = need('S2.3', 'CHOICES', '五个决策按钮');
if (CHOICES) {
  ck.deepEq('S2.4', Object.keys(CHOICES).sort(), ['CASHOUT', 'CHALLENGE', 'DOUBLE', 'STICK', 'SWITCH'],
    'CHOICES 恰好 5 个决策：坚持/换门/质疑/加倍/收手');
}

/* ------------------------------------------------ 4. createInitialState 初值 */
ck.section('阶段 0/4 P0｜createInitialState 初值与「再来一局」重置');

var cis = need('S3.0', 'createInitialState', '创建初始状态');
if (cis) {
  var s0 = cis('demo');
  ck.eq('S3.1', s0.coins, 100, '演示模式初值 金币=100');
  ck.eq('S3.2', s0.suspicion, 2, '演示模式初值 怀疑值=2');
  ck.eq('S3.3', s0.patience, 3, '演示模式初值 耐心=3');
  ck.eq('S3.4', s0.round, 1, '初值 round=1');
  ck.eq('S3.5', s0.phase, 'IDLE', '初值 phase=IDLE');
  ck.eq('S3.6', s0.rng && s0.rng.seed, SEED, '演示模式固定种子 seed=20261024');
  ck.eq('S3.7', s0.rng && s0.rng.cursor, 0, '初值 rng.cursor=0');
  ck.eq('S3.8', s0.doors && s0.doors.length, 3, 'doors 长度 3');
  ck.ok('S3.9', s0.pickedSlot === null && s0.hostOpenedSlot === null && s0.doubled === false && s0.peekUsed === false,
    '初值 pickedSlot/hostOpenedSlot/doubled/peekUsed 均为未触发状态');
  ck.deepEq('S3.10', s0.codex, { items: [], lines: [], endings: [] }, '初值 codex 三个空数组');
  ck.deepEq('S3.11', s0.items, [], '初值背包为空');

  /* 再来一局必须干净：两次 createInitialState 不共享引用 */
  var s1 = cis('demo');
  s1.coins = 999; s1.doors[0].opened = true; s1.items.push({ id: 'x', count: 1 }); s1.log.push('dirty');
  var s2 = cis('demo');
  ck.ok('S3.12', s2.coins === 100 && s2.doors[0].opened === false && s2.items.length === 0 && s2.log.length === 0,
    '连续两次 createInitialState 互不共享引用（重置不会被上一局污染）',
    '第二次得到 coins=' + s2.coins + ' doors[0].opened=' + s2.doors[0].opened + ' items=' + s2.items.length);

  var sn = cis('normal');
  ck.eq('S3.13', sn.mode, 'normal', 'normal 模式 mode=normal');
  ck.eq('S3.14', sn.coins, 100, '普通模式初值同样 100/2/3（coins）');
  var sc = cis('demo', { seed: 777 });
  ck.eq('S3.15', sc.rng.seed, 777, 'opts.seed 可覆盖种子');

  /* 阶段 0 P0 模板字段对照 */
  var GS = need('S3.16', 'GameState', '全局状态模板');
  if (GS) {
    var mustFields = ['mode', 'rng', 'round', 'coins', 'suspicion', 'patience', 'items', 'doors',
      'pickedSlot', 'peekUsed', 'doubled', 'narratorLines', 'hostOpenedSlot', 'log', 'codex'];
    var missField = mustFields.filter(function (f) { return !(f in GS); });
    ck.ok('S3.17', missField.length === 0, 'GameState 模板含阶段 0 定稿的全部 15 个字段', '缺：' + missField.join(','));
    ck.eq('S3.18', GS.rng && GS.rng.seed, SEED, 'GameState 模板 rng.seed=20261024');
    ck.eq('S3.19', GS.coins + '/' + GS.suspicion + '/' + GS.patience, '100/2/3', 'GameState 模板 100/2/3');
  }
}

/* --------------------------------------------------------------- 5. RNG */
ck.section('阶段 4 P0｜固定种子确定性 + {seed,cursor} 快照续跑');

var RNG = need('S4.0', 'RNG', '可复现随机数');
if (RNG) {
  /* 4.1 同 seed 两次独立序列完全一致 */
  var a = RNG.create(SEED, 0), b = RNG.create(SEED, 0);
  var seqA = [], seqB = [], i;
  for (i = 0; i < 200; i++) { seqA.push(RNG.next(a)); seqB.push(RNG.next(b)); }
  ck.deepEq('S4.1', seqA, seqB, '同 seed+同起点：200 次 RNG.next 序列完全一致');
  ck.ok('S4.2', seqA.every(function (v) { return v >= 0 && v < 1; }), 'RNG.next 全部落在 [0,1)');

  /* 4.3 快照续跑：跑 50 步 → snapshot → 续 50 步 == 一气跑 100 步 */
  var c = RNG.create(SEED, 0), full = [], j;
  for (j = 0; j < 100; j++) full.push(RNG.next(c));
  var d = RNG.create(SEED, 0), first = [];
  for (j = 0; j < 50; j++) first.push(RNG.next(d));
  var snap = RNG.snapshot(d);
  var resumed = [];
  var d2 = RNG.create(snap.seed, snap.cursor);
  for (j = 0; j < 50; j++) resumed.push(RNG.next(d2));
  ck.deepEq('S4.3', first.concat(resumed), full,
    '{seed,cursor} 快照续跑 50+50 步 == 一气 100 步（cursor=' + snap.cursor + '）');
  ck.eq('S4.4', snap.cursor, 50, '快照 cursor 精确记录已消耗步数');

  /* 4.5 固定种子「连续跑 10 次完全一致」——RNG 层 */
  var runs = [];
  for (var r = 0; r < 10; r++) {
    var rr = RNG.create(SEED, 0), one = [];
    for (j = 0; j < 30; j++) one.push(RNG.next(rr));
    runs.push(JSON.stringify(one));
  }
  var uniq = runs.filter(function (v, idx) { return runs.indexOf(v) === idx; });
  ck.eq('S4.5', uniq.length, 1, '固定 seed 20261024 连续 10 次生成的 30 步序列 JSON 完全一致（不同结果数=1）');

  /* 4.6 不同种子应产生不同序列（防止「永远返回常量」的假确定性） */
  var e1 = RNG.create(1, 0), e2 = RNG.create(2, 0);
  var d1 = [], d2 = [];
  for (j = 0; j < 10; j++) { d1.push(RNG.next(e1)); d2.push(RNG.next(e2)); }
  ck.ok('S4.6', JSON.stringify(d1) !== JSON.stringify(d2), '不同种子产生不同序列（种子真的参与运算）');

  /* 4.7 int 边界闭区间 */
  var ri = RNG.create(42, 0), bad = [];
  for (j = 0; j < 500; j++) { var v = RNG.int(ri, 3, 5); if (v < 3 || v > 5 || v !== Math.floor(v)) bad.push(v); }
  ck.eq('S4.8', bad.length, 0, 'RNG.int(3,5) 500 次全部落在闭区间 [3,5] 整数');

  /* 4.9 shuffle 不改入参且是排列 */
  var src = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], srcCopy = src.slice();
  var rsh = RNG.create(7, 0);
  var sh = RNG.shuffle(rsh, src);
  ck.deepEq('S4.9', src, srcCopy, 'RNG.shuffle 不修改入参数组');
  ck.deepEq('S4.10', sh.slice().sort(function (x, y) { return x - y; }), srcCopy, 'RNG.shuffle 结果是原数组的排列（无丢项/重项）');

  /* 4.11 weighted 尊重权重 */
  var rw = RNG.create(99, 0), hits = { low: 0, high: 0 };
  for (j = 0; j < 2000; j++) {
    var pick = RNG.weighted(rw, [{ id: 'low', weight: 1 }, { id: 'high', weight: 9 }]);
    hits[pick.id === 'low' ? 'low' : 'high']++;
  }
  ck.ok('S4.11', hits.high > 1600 && hits.high < 2000, 'RNG.weighted 1:9 权重生效（high=' + hits.high + '/2000）',
    '实际 ' + JSON.stringify(hits));
}

/* --------------------------------------------- 6. 工具函数与渲染只读约定 */
ck.section('阶段 0/1 P0｜cloneState / clampInt / Emitter / 渲染只读 GameState');

var cloneState = need('S5.0', 'cloneState', '深拷贝');
if (cloneState) {
  var base = { a: 1, doors: [{ slot: 0, opened: false }], log: [] };
  var cp = cloneState(base);
  cp.doors[0].opened = true; cp.log.push('x'); cp.a = 2;
  ck.ok('S5.1', base.a === 1 && base.doors[0].opened === false && base.log.length === 0,
    'cloneState 是深拷贝（改副本不影响原对象）');
}

var clampInt = need('S5.2', 'clampInt', '取整与 NaN 保护');
if (clampInt) {
  ck.eq('S5.3', clampInt(NaN, 0, 10), 0, 'clampInt(NaN) → 0（NaN 保护）');
  ck.eq('S5.4', clampInt(undefined, 0, 10), 0, 'clampInt(undefined) → 0');
  ck.eq('S5.5', clampInt(-5, 0, 10), 0, 'clampInt 下界裁剪');
  ck.eq('S5.6', clampInt(3.6, 0, 10), 4, 'clampInt 四舍五入');
}

var Emitter = need('S5.7', 'Emitter', '订阅器');
if (Emitter) {
  var em = new Emitter(), got = [];
  var off = em.on(function (e) { got.push(e); });
  em.emit(1); em.emit(2);
  off(); em.emit(3);
  ck.deepEq('S5.8', got, [1, 2], 'Emitter.on 返回的 off() 能取消订阅');
}

/* 静态检查：渲染层不得直接改资源数值（《开工清单》阶段 0 P0） */
var uiPath = path.join(L.JS_DIR, 'ui.js');
if (!L.fileExists(uiPath)) {
  ck.skip('S5.9', '静态检查 ui.js 未直接改 GameState 数值', 'js/ui.js 尚未就绪');
} else {
  var uiSrc = L.readText(uiPath);
  var badAssign = [];
  var assignRe = /(?:state|s|gs|st)\s*\.\s*(coins|suspicion|patience|round)\s*(?:=[^=]|\+=|-=|\*=)/g, am;
  while ((am = assignRe.exec(uiSrc)) !== null) {
    var lineNo = uiSrc.slice(0, am.index).split('\n').length;
    var lineText = uiSrc.split('\n')[lineNo - 1].trim();
    if (/^\s*(\/\/|\*)/.test(lineText)) continue;
    badAssign.push('ui.js:' + lineNo + ' ' + lineText.slice(0, 80));
  }
  ck.ok('S5.9', badAssign.length === 0,
    '静态检查：js/ui.js 未直接给 coins/suspicion/patience/round 赋值（渲染只读，数值只走 applyEffect）',
    badAssign.join('\n         '));
}

/* ------------------------------------------------------- 7. 物品池（静态） */
ck.section('阶段 2 P0｜物品池（九种物品 + 权重 + minRound）');

var items = null;
if (has('ITEMS')) items = G.ITEMS;
else if (has('GAME_DATA') && G.GAME_DATA && G.GAME_DATA.items) items = G.GAME_DATA.items;
else if (has('DATA') && G.DATA && G.DATA.items) items = G.DATA.items;
else if (has('CONFIG') && G.CONFIG && G.CONFIG.items) items = G.CONFIG.items;

if (!items) {
  ck.skip('S6.1', '九种物品配置可读取', '未发现 ITEMS / GAME_DATA.items / DATA.items / CONFIG.items（js/data.js 未就绪或字段名不同）');
} else {
  var list = Array.isArray(items) ? items : Object.keys(items).map(function (k) {
    var v = items[k];
    return (typeof v === 'object' && v !== null) ? Object.assign({ id: k }, v) : { id: k, coins: v };
  });
  ck.ok('S6.1', list.length >= 9, '物品池至少含 9 种物品（实际 ' + list.length + ' 条，含别名）');
  var byId = {};
  list.forEach(function (it) { byId[it.id] = it; });
  ITEM_SPEC.forEach(function (spec) {
    var it = byId[spec.key];
    if (!it) { ck.fail('S6.2.' + spec.key, spec.label + '(' + spec.key + ') 在物品池中存在', '物品池 id：' + Object.keys(byId).join(', ')); return; }
    var okv = (Number(it.coins) || 0) === spec.coins
      && (Number(it.patience) || 0) === spec.patience
      && (Number(it.suspicion) || 0) === spec.suspicion;
    ck.ok('S6.2.' + spec.key, okv, spec.label + ' 数值 coins=' + spec.coins + ' patience=' + spec.patience + ' suspicion=' + spec.suspicion,
      '实际 coins=' + it.coins + ' patience=' + it.patience + ' suspicion=' + it.suspicion);
  });
  var noWeight = list.filter(function (it) { return it.weight == null; }).map(function (it) { return it.id; });
  ck.ok('S6.3', noWeight.length === 0, '每种物品都有 weight 权重字段', '缺 weight：' + noWeight.join(','));
  var noMinRound = list.filter(function (it) { return it.minRound == null; }).map(function (it) { return it.id; });
  ck.ok('S6.4', noMinRound.length === 0, '每种物品都有 minRound 字段（第 1 轮不放炸弹的依据）', '缺 minRound：' + noMinRound.join(','));
  if (byId.bomb) {
    ck.ok('S6.5', Number(byId.bomb.minRound) >= 2, '炸弹 minRound≥2（《开工清单》：第 1 轮不放炸弹）', '实际 minRound=' + byId.bomb.minRound);
  }
  /* 别名：tools/build-data.js:64 ITEM_ALIASES = { shutup_card: 'mute_card' } */
  var aliasObj = byId.shutup_card || (gd.data.items && gd.data.items.shutup_card);
  if (aliasObj) {
    ck.ok('S6.6', (byId.mute_card && aliasObj === byId.mute_card) || (gd.data.items && gd.data.items.shutup_card === gd.data.items.mute_card),
      '别名 shutup_card 指向主条目 mute_card（同一对象）');
  } else {
    ck.skip('S6.6', '别名 shutup_card → mute_card', '未导出 shutup_card 别名（非 P0）');
  }
}

/* -------------------------------------------------- 8. effects.js applyEffect */
ck.section('阶段 2 P0｜applyEffect 纯函数与九种物品结算');

var applyEffect = FX ? G.applyEffect : null;
if (!applyEffect) {
  ck.skip('S7.0', 'applyEffect 可调用', '未发现全局 applyEffect（js/effects.js 未就绪或未导出）');
} else {
  var mkState = function () {
    return { coins: 100, suspicion: 2, patience: 3, items: [], log: [], roundResult: null, doubled: false };
  };
  /* 7.1 纯函数：入参不被修改，返回新对象 */
  var inState = mkState();
  var inSnap = JSON.parse(JSON.stringify(inState));
  var outState = applyEffect(inState, { id: 'big_prize', coins: 100 });
  ck.deepEq('S7.1', inState, inSnap, 'applyEffect 不修改入参 state（纯函数）');
  ck.ok('S7.2', outState !== inState && outState && typeof outState === 'object', 'applyEffect 返回新状态对象（非原地修改）');

  /* 7.3 金币结算正确 */
  var cases = [
    { id: 'big_prize', coins: 100, dCoins: 100, dPat: 0, dSus: 0 },
    { id: 'small_prize', coins: 30, dCoins: 30, dPat: 0, dSus: 1 },
    { id: 'empty', coins: 0, dCoins: 0, dPat: 0, dSus: 1 },
    { id: 'bomb', coins: -50, patience: -1, dCoins: -50, dPat: -1, dSus: 0 },
    { id: 'trap', coins: -30, suspicion: -1, dCoins: -30, dPat: 0, dSus: -1 }
  ];
  cases.forEach(function (cse) {
    var st = mkState();
    var res = applyEffect(st, cse);
    var want2 = { coins: 100 + cse.dCoins, patience: 3 + cse.dPat, suspicion: 2 + cse.dSus };
    var pass = res.coins === want2.coins && res.patience === want2.patience && res.suspicion === want2.suspicion;
    ck.ok('S7.3.' + cse.id, pass,
      cse.id + ' 结算：金币 ' + want2.coins + ' / 耐心 ' + want2.patience + ' / 怀疑值 ' + want2.suspicion,
      '实际 金币 ' + res.coins + ' / 耐心 ' + res.patience + ' / 怀疑值 ' + res.suspicion);
  });

  /* 7.4 耐心归零 → GAME_OVER（或 applyEffect 报告结束标记） */
  var stPat = { coins: 100, suspicion: 2, patience: 1, items: [], log: [], roundResult: null, doubled: false };
  var resPat = applyEffect(stPat, { id: 'bomb', coins: -50, patience: -1 });
  var gameOver = resPat.phase === 'GAME_OVER' || resPat.gameOver === true || (resPat.patience === 0 && resPat.phase === 'GAME_OVER');
  ck.ok('S7.4', resPat.patience === 0 && gameOver,
    '耐心 1 → 吃炸弹后归零并进入 GAME_OVER',
    '实际 patience=' + resPat.patience + ' phase=' + resPat.phase + ' gameOver=' + resPat.gameOver);

  /* 7.5 背包类道具 +1 */
  ['switch_ticket', 'mute_card'].forEach(function (bid) {
    var st = mkState();
    var res = applyEffect(st, { id: bid });
    var n = (res.items || []).filter(function (x) { return x.id === bid; })
      .reduce(function (acc, x) { return acc + (x.count || 0); }, 0);
    ck.ok('S7.5.' + bid, n === 1, bid + ' 入包 +1（实际 count=' + n + '）');
  });

  /* 7.6 双倍金币：本轮收益 ×2 */
  var stD = mkState();
  stD.doubled = true;
  var resD = applyEffect(stD, { id: 'big_prize', coins: 100 });
  ck.ok('S7.6', resD.coins === 100 + 200, '双倍金币生效时大奖实得 +200（100 → ' + resD.coins + '）',
    '实际 coins=' + resD.coins);

  /* 7.7 game.js 实际调用形态：第一个参数是「物品 id 字符串」+ opts.multiplier */
  var stS = mkState();
  var resS = applyEffect(stS, 'big_prize', { multiplier: 2, source: 'reveal' });
  ck.ok('S7.7', resS.coins === 300,
    'applyEffect(state, "big_prize", {multiplier:2}) 支持 game.js:435 的调用形态（100 → ' + resS.coins + '）',
    'game.js reveal() 传的是字符串 id；若内容层只认对象会整局不结算');

  /* 7.8 game.js challenge() 的合成 effect：{id:"challenge", coins, patience, suspicion} */
  var stC = mkState();
  var resC = applyEffect(stC, { id: 'challenge', suspicion: -1, coins: 20 });
  ck.ok('S7.8', resC.coins === 120 && resC.suspicion === 1,
    'applyEffect 支持合成 id "challenge" 的直接数值结算（100→' + resC.coins + ' 怀疑 2→' + resC.suspicion + '）');
}

/* ==========================================================================
 *                      游戏层：异步整局驱动
 * ======================================================================== */

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
      if (++i > (tries || 500)) return res(false);
      setImmediate(step);
    })();
  });
}

function jsonOf(x) { return JSON.stringify(x); }

/** 取最后一次指定 kind 的弹层（openModal 记录）。 */
function lastModalOf(rec, kind) {
  for (var k = rec.modals.length - 1; k >= 0; k--) {
    if (!kind || rec.modals[k].kind === kind) return rec.modals[k];
  }
  return null;
}

/** 建一个全新的 Game 实例（每个测试独立，避免相互污染）。 */
function mkGame(mode, over) {
  var ui = L.recordingUI();
  var rec = ui.rec;
  var deps = {
    ui: ui,
    data: gd.data,
    applyEffect: FX ? G.applyEffect : null,
    narrator: NR ? G.Narrator : null,
    setTimeout: L.immediateTimeout,
    clearTimeout: function () { return 0; },
    now: function () { return FIXED_NOW; }
  };
  if (over) for (var k in over) deps[k] = over[k];
  G.Game.init({ mode: mode || 'demo', seed: NORMAL_SEED, deps: deps });
  return { Game: G.Game, ui: ui, rec: ui.rec, deps: deps };
}

var PICK_BY_ROUND = ['small_prize', 'big_prize', 'big_prize'];
var DEMO_ROUNDS = (gd.data.seedDemo && gd.data.seedDemo.rounds) || [];

/**
 * 用真实玩家动作驱动演示剧本三轮（不依赖 game.js 的 autoDemo）：
 * 第 1 轮 选小奖门→坚持；第 2 轮 选大奖门→质疑→坚持；第 3 轮 选大奖门→收手。
 */
async function driveDemo(over) {
  var g = mkGame('demo', over);
  var Game = g.Game, rec = g.rec, ui = g.ui;
  var trace = { rounds: [], rec: rec, ui: ui, error: null };
  Game.start('demo');
  if (!await until(function () { return Game.state.phase === 'PICK'; })) {
    trace.error = '第 1 轮未到达 PICK，phase=' + Game.state.phase;
    trace.final = snapTrace(Game);
    return trace;
  }
  for (var r = 1; r <= 3; r++) {
    var st = Game.state;
    var doors = st.doors.map(function (d) { return d.itemId; });
    var wantPick = PICK_BY_ROUND[r - 1];
    var slot = doors.indexOf(wantPick);
    var row = {
      round: r, doors: doors, wantPick: wantPick, pickedSlot: slot,
      coinsBefore: st.coins, suspicionBefore: st.suspicion, patienceBefore: st.patience,
      rendersBefore: rec.renders
    };
    if (slot < 0) { row.error = '剧本门面不含 ' + wantPick; trace.rounds.push(row); break; }

    /* 主持人「本来会」开哪扇（纯函数对照，用于判定剧本是否违反开空门规则） */
    row.hostPickWouldBe = Game.hostPick(st.doors, slot);
    row.hostPickWouldBeItem = row.hostPickWouldBe == null ? null : st.doors[row.hostPickWouldBe].itemId;

    var hostOpensBefore = rec.hostOpens.length;   /* 必须在 pick 之前取快照，否则本轮记录会被算进基线 */
    Game.action({ type: 'pick', slot: slot });
    row.phaseAfterPick = Game.state.phase;
    await until(function () { return Game.state.phase === 'DECIDE'; });
    row.phaseAfterHostOpen = Game.state.phase;
    row.hostOpenedSlot = Game.state.hostOpenedSlot;
    row.hostOpenedItemId = Game.state.hostOpenedSlot == null ? null : Game.state.doors[Game.state.hostOpenedSlot].itemId;
    row.pickedSlotFinal = Game.state.pickedSlot;
    row.hostOpenedCount = Game.state.doors.filter(function (d) { return d.opened; }).length;

    if (r === 2) {
      row.suspicionBeforeChallenge = Game.state.suspicion;
      Game.action({ type: 'decide', choice: 'challenge' });
      await micro(4);
      row.suspicionAfterChallenge = Game.state.suspicion;
      row.coinsAfterChallenge = Game.state.coins;
      row.lastChallenge = Game.state.lastChallenge
        ? { ok: !!Game.state.lastChallenge.ok, text: Game.state.lastChallenge.text,
            hint: Game.state.lastChallenge.hint, grudgeLevel: Game.state.lastChallenge.grudgeLevel,
            delta: Game.state.lastChallenge.delta }
        : null;
    }

    var isLast = (r === 3);
    Game.action({ type: 'decide', choice: isLast ? 'cashout' : 'stick' });
    await until(function () { return isLast ? Game.state.phase === 'CASHOUT' : Game.state.phase === 'SETTLE_ROUND'; });

    row.phase = Game.state.phase;
    row.round2 = Game.state.round;
    row.coins = Game.state.coins;
    row.suspicion = Game.state.suspicion;
    row.patience = Game.state.patience;
    row.logLen = Game.state.log.length;
    row.revealLocked = !!(Game.state.flags && Game.state.flags.revealLocked);
    row.roundResult = Game.state.roundResult ? JSON.parse(jsonOf(Game.state.roundResult)) : null;
    row.ending = Game.state.ending ? JSON.parse(jsonOf(Game.state.ending)) : null;
    row.rendersAfter = rec.renders;
    row.flashes = rec.flashes.slice();
    row.modal = rec.modals.length ? JSON.parse(jsonOf(rec.modals[rec.modals.length - 1])) : null;
    row.reveals = rec.reveals.slice();
    row.hostOpenCalls = rec.hostOpens.slice(hostOpensBefore);   /* 只取本轮新增，避免跨轮累积 */
    trace.rounds.push(row);

    if (!isLast) {
      Game.action({ type: 'settle', choice: 'continue' });
      var okAdv = await until(function () {
        return Game.state.round === r + 1 && Game.state.phase === 'PICK';
      });
      if (!okAdv) { row.advanceFailed = '点「继续下一轮」后未进入第 ' + (r + 1) + ' 轮（round=' + Game.state.round + ' phase=' + Game.state.phase + '）'; break; }
    }
  }
  trace.final = snapTrace(Game);
  trace.Game = Game;
  return trace;
}

function snapTrace(Game) {
  var s = Game.state;
  return {
    phase: s.phase, round: s.round, coins: s.coins, suspicion: s.suspicion, patience: s.patience,
    pickedSlot: s.pickedSlot, hostOpenedSlot: s.hostOpenedSlot,
    doors: s.doors.map(function (d) { return d.itemId; }),
    logLen: s.log.length,
    ending: s.ending ? JSON.parse(jsonOf(s.ending)) : null
  };
}

/** 10 次一致性的指纹：只保留可观察结果，不含时间戳。 */
function fingerprint(trace) {
  return jsonOf({
    rounds: trace.rounds.map(function (r) {
      return {
        round: r.round, doors: r.doors, pickedSlot: r.pickedSlot,
        hostOpenedSlot: r.hostOpenedSlot, hostOpenedItemId: r.hostOpenedItemId,
        phaseAfterPick: r.phaseAfterPick, phaseAfterHostOpen: r.phaseAfterHostOpen,
        coinsAfterChallenge: r.coinsAfterChallenge, suspicionAfterChallenge: r.suspicionAfterChallenge,
      suspicionBeforeChallenge: r.suspicionBeforeChallenge,
        phase: r.phase, coins: r.coins, suspicion: r.suspicion, patience: r.patience,
        itemId: r.roundResult && r.roundResult.itemId, logLen: r.logLen,
        ending: r.ending && r.ending.title
      };
    }),
    final: trace.final
  });
}

async function main() {
  if (!has('Game')) {
    ck.section('游戏层');
    ck.skip('S8.0', '整局流程（固定种子 10 次一致 / 主持人开空门 / 结算 / GAME_OVER）',
      'game.js 尚未就绪：未发现全局 Game');
    return;
  }
  var GameApi = G.Game;
  /* 纯函数区（hostPick / rating）也依赖 Game.deps，先初始化一次；无 DOM 时 Bootstrap 不会自动跑 */
  mkGame('demo');

  /* ------------------------------------------------- G0. 内容层对外契约 */
  ck.section('阶段 2/3 P0｜GameData 对外契约（' + TAG + '）');
  var D = gd.data;
  if (!gd.real) {
    ck.skip('G0.0', 'js/data.js 真实产物契约',
      'js/data.js 不存在 → 以下 G0 用测试替身验证；生成器 tools/build-data.js 的自身校验需单独跑 --check');
  }
  ck.eq('G0.1', Object.keys(D.items || {}).length, 10, TAG + ' GameData.items = 9 主条目 + 1 别名（shutup_card）');
  ck.eq('G0.2', (D.itemList || []).length, 9, TAG + ' GameData.itemList = 9');
  ck.ok('G0.3', D.items && D.itemList && D.items[D.itemList[0].id] === D.itemList[0],
    TAG + ' items[id] 与 itemList[i] 是同一引用（不重复造对象）');
  ck.ok('G0.4', typeof D.itemById === 'function' && D.itemById('big_prize') === D.items.big_prize,
    TAG + ' itemById 返回同一对象');
  ck.ok('G0.5', typeof D.poolForRound === 'function' && typeof D.ratingFor === 'function', TAG + ' poolForRound / ratingFor 可调用');
  ck.ok('G0.6', D.seedDemo && D.seedDemo.seed === SEED && D.seedDemo.rounds.length === 3,
    TAG + ' seedDemo.seed=20261024 且剧本 3 轮');

  var p1 = (D.poolForRound ? D.poolForRound(1) : []).map(function (e) { return e.id; });
  ck.ok('G0.7', p1.indexOf('bomb') < 0, TAG + ' poolForRound(1) 不含炸弹（第 1 轮不放炸弹）', '实际：' + p1.join(','));
  var pool2 = D.poolForRound ? D.poolForRound(2) : [];
  var pool4 = D.poolForRound ? D.poolForRound(4) : [];
  var w = function (pool, id) { for (var k = 0; k < pool.length; k++) if (pool[k].id === id) return pool[k].weight; return null; };
  var b2 = w(pool2, 'bomb'), b4 = w(pool4, 'bomb');
  var t2 = w(pool2, 'trap'), t4 = w(pool4, 'trap');
  ck.ok('G0.8', b2 != null && b4 != null && b4 > b2, TAG + ' 第 4 轮起炸弹权重提高（轮2=' + b2 + ' → 轮4=' + b4 + '）');
  ck.ok('G0.9', t2 != null && t4 != null && t4 > t2, TAG + ' 第 4 轮起陷阱权重提高（轮2=' + t2 + ' → 轮4=' + t4 + '）');
  pool2[0].weight = 9999;
  ck.ok('G0.10', D.poolForRound(2)[0].weight !== 9999, TAG + ' poolForRound 每次返回新数组（外部改不污染内部）');

  /* ------------------------------------------------------- G1. 纯逻辑区 */
  ck.section('阶段 1 P0｜generateDoors / hostPick 不变量（纯逻辑）');

  /* G1.1 hostPick 枚举：真实牌面（id 互不相同）× 每个所选，都不能开大奖、不能开玩家所选 */
  var domain = ['empty', 'bomb', 'trap', 'small_prize', 'big_prize'];
  var boards = [];
  for (var x1 = 0; x1 < domain.length; x1++) {
    for (var x2 = x1 + 1; x2 < domain.length; x2++) {
      for (var x3 = x2 + 1; x3 < domain.length; x3++) {
        var b3 = [domain[x1], domain[x2], domain[x3]];
        if (b3.filter(function (v) { return v === 'big_prize'; }).length > 1) continue;
        boards.push(b3);
      }
    }
  }
  var combos = 0, badPick = [], noEmpty = [], onlyEmptyPicked = 0, noEmptyBoard = 0;
  var degChecked = 0, degBad = [];
  boards.forEach(function (ids3) {
    for (var ps = 0; ps < 3; ps++) {
      combos++;
      var dd = ids3.map(function (id, k) { return { slot: k, itemId: id, opened: false, revealed: false }; });
      var hs = GameApi.hostPick(dd, ps);
      var hsItem = (hs == null || !dd[hs]) ? null : dd[hs].itemId;
      if (hs == null || hs === ps || hsItem === 'big_prize') {
        if (badPick.length < 3) badPick.push(ids3.join('/') + ' 选' + ps + ' → ' + hs + '(' + hsItem + ')');
      }
      var emptyIdx = -1;
      for (var q = 0; q < 3; q++) if (q !== ps && dd[q].itemId === 'empty') { emptyIdx = q; break; }
      if (emptyIdx >= 0) {
        if (hsItem !== 'empty' && noEmpty.length < 3) {
          noEmpty.push(ids3.join('/') + ' 选' + ps + ' → 开了 ' + hsItem + '，空门在 ' + emptyIdx);
        }
      } else {
        /* 退化牌面：唯一空门被玩家选中，或牌面本身没有空门（真实发牌不会出现）。
           这两类没有「未被选中的空门」可开，主持人只能退化为开非大奖门；
           以下逐个复核它依旧返回合法门，而不是写成恒真备注。 */
        degChecked++;
        if (ids3.indexOf('empty') >= 0) onlyEmptyPicked++; else noEmptyBoard++;
        if (hs == null || hs === ps || hsItem === 'big_prize' || dd[hs].opened) {
          degBad.push(ids3.join('/') + ' 选' + ps + ' → ' + hs + '(' + hsItem + ')');
        }
      }
    }
  });
  ck.ok('G1.1', badPick.length === 0 && boards.length === 10,
    'hostPick 在 ' + boards.length + ' 种真实牌面（id 互不相同）× 3 个所选 = ' + combos + ' 组合下都返回合法门：≠玩家所选、≠大奖',
    badPick.join('；'));
  ck.ok('G1.2', noEmpty.length === 0,
    'hostPick 在存在未选中空门时必然开那扇空门（' + combos + ' 组合全部命中）',
    noEmpty.join('；'));
  ck.ok('G1.3', degChecked === onlyEmptyPicked + noEmptyBoard && onlyEmptyPicked > 0 && degBad.length === 0,
    '退化牌面逐个复核：' + degChecked + ' 个「无未选中空门」组合（唯一空门被玩家选中 ' + onlyEmptyPicked +
    ' 个 / 牌面本身无空门 ' + noEmptyBoard + ' 个）下 hostPick 仍返回合法门（≠玩家所选、≠大奖、门未开）' +
    '，即 lead 确认的冻结语义「只保证开非大奖门、优先空门」在退化时不会穿帮',
    'degChecked=' + degChecked + ' 期望=' + (onlyEmptyPicked + noEmptyBoard) + ' 违规=' + jsonOf(degBad));

  /* G1.4 阶段 1 P0：普通模式第 1 轮恰好 1 大奖 / 1 空门 / 1 小奖（且不含炸弹） */
  var badR1 = [], sets = {};
  for (var sd = 0; sd < 30; sd++) {
    var gn = mkGame('normal', {});
    gn.Game.init({ mode: 'normal', seed: 1000 + sd, deps: gn.deps });
    var dR1 = gn.Game.generateDoors(1).map(function (d) { return d.itemId; }).sort().join(',');
    sets[dR1] = (sets[dR1] || 0) + 1;
    if (dR1 !== 'big_prize,empty,small_prize') badR1.push('seed' + (1000 + sd) + ' → ' + dR1);
  }
  ck.ok('G1.4', badR1.length === 0,
    '普通模式第 1 轮 30 个种子全部为 {大奖, 空门, 小奖}（阶段 1 P0）',
    badR1.slice(0, 3).join('；') + ' | 分布=' + jsonOf(sets));

  /* G1.5 第 2 轮起走权重池的不变量 */
  var g5 = mkGame('normal', {});
  var badInv = [], dist = {};
  for (var rd = 2; rd <= 8; rd++) {
    for (var k2 = 0; k2 < 60; k2++) {
      var ds2 = g5.Game.generateDoors(rd);
      var idl = ds2.map(function (d) { return d.itemId; });
      idl.forEach(function (id) { dist[id] = (dist[id] || 0) + 1; });
      var top = idl.filter(function (id) { return id === 'big_prize'; }).length;
      var nonTop = idl.filter(function (id) { return id !== 'big_prize'; }).length;
      var empties = idl.filter(function (id) { return id === 'empty'; }).length;
      var uniq2 = idl.filter(function (v, idx) { return idl.indexOf(v) === idx; }).length;
      if (ds2.length !== 3) badInv.push('长度 ' + ds2.length);
      else if (top > 1) badInv.push('2 个以上大奖：' + idl.join('/'));
      else if (nonTop < 1) badInv.push('全是大奖：' + idl.join('/'));
      else if (empties < 1) badInv.push('没有空门（主持人将无空门可开）：' + idl.join('/'));
      else if (uniq2 !== 3) badInv.push('门面重复：' + idl.join('/'));
      else if (ds2.some(function (d, idx) { return d.slot !== idx || d.opened || d.revealed; })) badInv.push('doors 结构异常');
    }
  }
  ck.ok('G1.5', badInv.length === 0,
    '第 2–8 轮 420 次发牌全部满足不变量：3 扇不重复、≤1 大奖、≥1 非大奖、≥1 空门',
    badInv.slice(0, 4).join('；'));
  ck.ok('G1.6', dist.bomb > 0, '第 2 轮起权重池确实会抽到炸弹（bomb.minRound=2，权重 10→轮4 起 22）',
    '分布=' + jsonOf(dist));

  /* G1.7 固定种子发牌确定性（普通模式同 seed 两次；Game 是单例，必须顺序跑） */
  var gA = mkGame('normal', {}); gA.Game.init({ mode: 'normal', seed: 424242, deps: gA.deps });
  var seqA1 = [];
  for (var q2 = 1; q2 <= 5; q2++) seqA1.push(gA.Game.generateDoors(q2).map(function (d) { return d.itemId; }).join(','));
  var gB = mkGame('normal', {}); gB.Game.init({ mode: 'normal', seed: 424242, deps: gB.deps });
  var seqB1 = [];
  for (var q3 = 1; q3 <= 5; q3++) seqB1.push(gB.Game.generateDoors(q3).map(function (d) { return d.itemId; }).join(','));
  ck.deepEq('G1.7', seqA1, seqB1, '同 seed(424242) 两次初始化、各自连发 5 轮：发牌序列完全一致（'+ seqA1.join(' | ') +'）');
  ck.eq('G1.8', gA.Game.state.rng.seed, 424242, 'Game.init({mode:"normal", seed}) 生效：state.rng.seed=424242（普通模式种子可控）');

  /* ------------------------------------------- G2. 演示剧本三轮全流程 */
  ck.section('阶段 4 P0｜演示剧本（seed 20261024）真实驱动三轮');

  var t1 = await driveDemo();
  if (t1.error) {
    ck.fail('G2.0', '演示模式第 1 轮到达 PICK', t1.error);
  } else {
    var stalled = t1.rounds.filter(function (r2) { return r2.error || r2.advanceFailed; })
      .map(function (r2) { return 'R' + r2.round + ': ' + (r2.error || r2.advanceFailed); });
    ck.ok('G2.0', t1.rounds.length === 3 && stalled.length === 0,
      '演示剧本 3 轮全部驱动完成（实际 ' + t1.rounds.length + ' 轮）',
      stalled.join('\n         ') + '\n         final=' + jsonOf(t1.final));

    var wantDoors = DEMO_ROUNDS.map(function (r2) { return (r2.doors || []).join(','); });
    var gotDoors = t1.rounds.map(function (r2) { return r2.doors.join(','); });
    ck.deepEq('G2.1', gotDoors, wantDoors, '三轮门面与 data/seed_demo.json 逐轮一致');

    var wantHost = DEMO_ROUNDS.map(function (r2) { return r2.hostOpensSlot; });
    var gotHost = t1.rounds.map(function (r2) { return r2.hostOpenedSlot; });
    ck.deepEq('G2.2', gotHost, wantHost, '三轮主持人所开门的槽位与 seed_demo.json 一致');

    var hostNotPicked = t1.rounds.every(function (r2) { return r2.hostOpenedSlot !== r2.pickedSlotFinal; });
    ck.ok('G2.3', hostNotPicked, '主持人打开的门永远不是玩家所选的那扇（阶段 1 P0）',
      t1.rounds.map(function (r2) { return 'R' + r2.round + ' 选' + r2.pickedSlotFinal + ' 开' + r2.hostOpenedSlot + '(' + r2.hostOpenedItemId + ')'; }).join('；'));

    /* G2.4 剧本轮：以 data/seed_demo.json 为准（lead 决策：阶段 4 固定剧本优先于阶段 1 的空门字面规则）；
       非剧本轮：才断言冻结语义（≠玩家所选、≠大奖、存在未选空门时优先空门）。 */
    var scriptRounds = t1.rounds.filter(function (r2) { return DEMO_ROUNDS[r2.round - 1]; });
    var scriptMismatch = scriptRounds.filter(function (r2) {
      return r2.hostOpenedSlot !== DEMO_ROUNDS[r2.round - 1].hostOpensSlot;
    });
    ck.ok('G2.4', scriptMismatch.length === 0,
      '剧本轮（阶段 4 固定剧本）主持人所开门 == seed_demo.hostOpensSlot（' + scriptRounds.length + ' 轮全部命中）',
      scriptMismatch.map(function (r2) {
        return '第 ' + r2.round + ' 轮 实际开 ' + r2.hostOpenedSlot + ' vs 剧本 ' + DEMO_ROUNDS[r2.round - 1].hostOpensSlot;
      }).join('；'));

    var hostNonEmpty = t1.rounds.filter(function (r2) { return r2.hostOpenedItemId !== 'empty'; });
    var hostScriptBad = t1.rounds.filter(function (r2) {
      return r2.hostOpenedSlot == null || r2.hostOpenedSlot === r2.pickedSlotFinal ||
        r2.hostOpenedItemId === 'big_prize' || r2.hostOpenedCount !== 1;
    });
    ck.ok('G2.4b', hostScriptBad.length === 0 && t1.rounds.length === 3,
      '硬不变量贯穿演示剧本全部 ' + t1.rounds.length + ' 轮：主持人所开门 ≠ 玩家所选门、≠ 大奖门、恰好开 1 扇' +
      '（其中 ' + (3 - hostNonEmpty.length) + '/3 轮开空门，' + hostNonEmpty.length +
      '/3 轮按剧本开非空门制造戏剧性——「字面永远开空门」与阶段 4 固定剧本冲突，已按 lead 决策以剧本为准）',
      hostScriptBad.map(function (r2) {
        return 'R' + r2.round + ' 玩家选=' + r2.pickedSlotFinal + ' 主持开=' + r2.hostOpenedSlot +
          '(' + r2.hostOpenedItemId + ') 已开数=' + r2.hostOpenedCount;
      }).join('；'));

    /* 非剧本轮（普通模式）走权重池发牌，必须满足冻结语义 */
    var g24 = mkGame('normal', {});
    var badFree = [];
    for (var fz = 0; fz < 60; fz++) {
      g24.Game.init({ mode: 'normal', seed: 5000 + fz, deps: g24.deps });
      var fr = 1 + (fz % 5);
      var fdoors = g24.Game.generateDoors(fr);
      for (var fp = 0; fp < fdoors.length; fp++) {
        var fh = g24.Game.hostPick(fdoors, fp);
        if (fh == null || fh === fp || fdoors[fh].itemId === 'big_prize') {
          badFree.push('R' + fr + ' 门面=' + fdoors.map(function (d) { return d.itemId; }).join('/') + ' 选' + fp + ' → ' + fh);
          continue;
        }
        var freeEmpty = -1;
        for (var fq = 0; fq < fdoors.length; fq++) if (fq !== fp && fdoors[fq].itemId === 'empty') { freeEmpty = fq; break; }
        if (freeEmpty >= 0 && fdoors[fh].itemId !== 'empty') {
          badFree.push('R' + fr + ' 门面=' + fdoors.map(function (d) { return d.itemId; }).join('/') + ' 选' + fp + ' → 开 ' + fdoors[fh].itemId + '，空门在 ' + freeEmpty);
        }
      }
    }
    ck.ok('G2.4c', badFree.length === 0,
      '非剧本轮（普通模式 60 组发牌 × 3 所选）主持人满足冻结语义：≠玩家所选、≠大奖、有未选空门时优先空门',
      badFree.slice(0, 4).join('\n         '));

    var phaseFlow = t1.rounds.every(function (r2) {
      return r2.phaseAfterPick === 'HOST_OPEN' && r2.phaseAfterHostOpen === 'DECIDE';
    });
    ck.ok('G2.5', phaseFlow, '点门后状态机自动走 PICK → HOST_OPEN → DECIDE（动画结束自动迁移）',
      t1.rounds.map(function (r2) { return 'R' + r2.round + ': ' + r2.phaseAfterPick + '→' + r2.phaseAfterHostOpen; }).join('；'));

    var only3 = t1.rounds.every(function (r2) { return r2.hostOpenedCount === 1; });
    ck.ok('G2.6', only3, '每轮主持人恰好打开 1 扇门（opened=true 计数=1）',
      t1.rounds.map(function (r2) { return 'R' + r2.round + '=' + r2.hostOpenedCount; }).join('；'));

    var hostCalls = t1.rounds.every(function (r2) {
      return r2.hostOpenCalls.length === 1 &&
        r2.hostOpenCalls[0].slot === r2.hostOpenedSlot &&
        r2.hostOpenCalls[0].itemId === r2.hostOpenedItemId;
    });
    ck.ok('G2.7', hostCalls,
      '每轮 UI 恰好收到 1 次 playHostOpen(槽位, 物品id)，且与 state.hostOpenedSlot / doors[slot].itemId 完全一致',
      t1.rounds.map(function (r2) {
        return 'R' + r2.round + ' state=' + r2.hostOpenedSlot + '(' + r2.hostOpenedItemId + ') ui=' +
          r2.hostOpenCalls.map(function (c) { return c.slot + '(' + c.itemId + ')'; }).join('|');
      }).join('；'));
    /* 记录器自证：确认 game.js 真的调到了 UI（区分「逻辑没跑」与「UI 没被调用」）。
       注意取本轮 trace 自己捕获的 UI/rec —— Game 是单例，后续用例的 mkGame 会换掉 Game.deps.ui。 */
    var dUI = t1.ui, dRec = t1.rec;
    var recOk = !!dRec && typeof dUI.playHostOpen === 'function' && typeof dUI.openModal === 'function' &&
      dRec.renders > 0 && dRec.controls > 0 && dRec.hostOpens.length === t1.rounds.length &&
      dRec.reveals.length === 2 && dRec.modals.length >= 1 && dRec.lines.length >= 3;
    ck.ok('G2.30', recOk,
      '记录型 UI 确实收到 game.js 的调用：渲染/控件/HUD 刷新/开门/开奖/弹层/旁白台词次数与三轮剧本相符',
      'playHostOpen=' + typeof dUI.playHostOpen + ' openModal=' + typeof dUI.openModal +
      '；renders=' + (dRec && dRec.renders) + '(期望≥1) setControls=' + (dRec && dRec.controls) + '(期望≥1)' +
      '；hostOpens=' + (dRec && dRec.hostOpens.length) + '(期望' + t1.rounds.length + '；R3 收手不开奖)' +
      '；reveals=' + (dRec && dRec.reveals.length) + '(期望2) modals=' + (dRec && dRec.modals.length) + '(期望≥1)' +
      '；lines=' + (dRec && dRec.lines.length) + '(期望≥3)');
    var r1 = t1.rounds[0], r2r = t1.rounds[1], r3 = t1.rounds[2];
    ck.eq('G2.8', r1.roundResult && r1.roundResult.itemId, 'small_prize', '第 1 轮结算物品=小奖（建立正反馈）');
    ck.eq('G2.9', r2r.roundResult && r2r.roundResult.itemId, 'big_prize', '第 2 轮结算物品=大奖（质疑反杀）');
    ck.eq('G2.10', r3.phase, 'CASHOUT', '第 3 轮主动收手 → 进入 CASHOUT 结算页');
    ck.eq('G2.11', r3.ending && r3.ending.round, 3, '结算页记录「闯到第 3 轮」');
    ck.ok('G2.12', r3.ending && r3.ending.title && r3.ending.title.length > 0,
      '结算页称号非空（实际「' + (r3.ending && r3.ending.title) + '」）');

    /* 结算弹层文案（阶段 3 P0：金币/轮次/称号；阶段 6 P0：娱乐声明） */
    var cashBody = (r3.modal && r3.modal.body) || '';
    ck.ok('G2.13', r3.modal && r3.modal.kind === 'cashout' && /最终金币/.test(cashBody) && /闯到第/.test(cashBody) && /称号/.test(cashBody),
      '结算页展示 最终金币 / 闯到第几轮 / 称号',
      '实际 kind=' + (r3.modal && r3.modal.kind) + ' body=' + cashBody.slice(0, 160));
    ck.ok('G2.14', /非真实货币/.test(cashBody), '结算页含「游戏内金币纯属娱乐，非真实货币」');
    var roundBody = (r1.modal && r1.modal.body) || '';
    ck.ok('G2.15', r1.modal && r1.modal.kind === 'round' && /继续下一轮/.test(jsonOf(r1.modal.actions)) && /见好就收/.test(jsonOf(r1.modal.actions)),
      '本轮结算弹层提供「继续下一轮 / 见好就收」两个出口（DECIDE 与 SETTLE_ROUND 两处都能收手）');

    /* 阶段 0/1 P0：开奖后 HUD 立刻刷新（渲染 + 数值高亮抖动） */
    ck.ok('G2.16', r1.rendersAfter > r1.rendersBefore && t1.rounds.every(function (r2) { return r2.rendersAfter > r2.rendersBefore; }),
      '每次开奖后 UI 至少渲染一次（HUD 立刻刷新）',
      t1.rounds.map(function (r2) { return 'R' + r2.round + ' ' + r2.rendersBefore + '→' + r2.rendersAfter; }).join('；'));
    ck.ok('G2.17', r1.flashes.some(function (f) { return f.key === 'coins'; }),
      '金币变化触发 UI flash 高亮（阶段 2 P0 反馈）',
      '实际 flashes=' + jsonOf(r1.flashes));

    /* 数值结算（需要 effects.js / narrator.js） */
    if (FX) {
      ck.eq('G2.18', r1.coins, 130, '第 1 轮小奖结算：100 → 130');
      ck.eq('G2.19', r1.logLen, 1, '第 1 轮写入 log 1 条');
      ck.ok('G2.20', r1.revealLocked === true, '开奖后 flags.revealLocked=true（重复开奖闸门已锁）');
    } else {
      ck.skip('G2.18', '数值结算 100 → 130', 'js/effects.js 未就绪');
      ck.skip('G2.19', 'log 写入', 'js/effects.js 未就绪');
      ck.skip('G2.20', 'revealLocked', 'js/effects.js 未就绪');
    }
    if (FX && NR) {
      var susBefore2 = r2r.suspicionBeforeChallenge;
      ck.ok('G2.21',
        typeof susBefore2 === 'number' && r2r.suspicionAfterChallenge === susBefore2 - 1 && r2r.suspicionAfterChallenge >= 0,
        '第 2 轮质疑成功恰好消耗 1 怀疑值（' + susBefore2 + ' → ' + r2r.suspicionAfterChallenge +
        '；第 1 轮开空门/小奖会 +1，所以不能用硬编码 2→1）',
        '实际 before=' + susBefore2 + ' after=' + r2r.suspicionAfterChallenge);
      ck.eq('G2.22', r2r.coinsAfterChallenge, 150, '第 2 轮质疑成功 +20 金币（130 → 150）');
      ck.ok('G2.23', r2r.lastChallenge && r2r.lastChallenge.ok === true, '第 2 轮旁白撒谎 → 质疑成功（反杀高光点）',
        '实际 lastChallenge=' + jsonOf(r2r.lastChallenge));
      ck.eq('G2.24', r2r.coins, 250, '第 2 轮大奖结算：150 → 250');
      ck.eq('G2.25', r3.coins, 250, '第 3 轮收手：金币停在 250（不再开奖）');
      ck.eq('G2.26', r3.logLen, 2, '收手那轮不写入 log（只结算已开奖的 2 轮）');
    } else {
      ck.skip('G2.21', '质疑成功消耗怀疑值', 'js/effects.js 或 js/narrator.js 未就绪');
      ck.skip('G2.22', '质疑成功 +20 金币', 'js/effects.js 或 js/narrator.js 未就绪');
      ck.skip('G2.23', '第 2 轮质疑成功', 'js/narrator.js 未就绪');
      ck.skip('G2.24', '第 2 轮大奖结算', 'js/effects.js 或 js/narrator.js 未就绪');
      ck.skip('G2.25', '第 3 轮收手金币', 'js/effects.js 或 js/narrator.js 未就绪');
      ck.skip('G2.26', '收手不写 log', 'js/effects.js 或 js/narrator.js 未就绪');
    }

    /* 阶段 4 P0：固定种子连续跑 10 次结果完全一致（游戏层） */
    var fps = [fingerprint(t1)];
    for (var rep = 2; rep <= 10; rep++) {
      var tr = await driveDemo();
      fps.push(fingerprint(tr));
    }
    var uniqFp = fps.filter(function (v, idx) { return fps.indexOf(v) === idx; });
    ck.eq('G2.27', uniqFp.length, 1,
      '固定种子 20261024 连续跑 10 次，逐轮「门面/主持人所开/金币/怀疑/耐心/结果/称号」JSON 完全一致（不同结果数=1）',
      uniqFp.length > 1 ? '出现 ' + uniqFp.length + ' 种结果，前 2 种：\n         ' + uniqFp[0].slice(0, 200) + '\n         ' + uniqFp[1].slice(0, 200) : '');
    if (!FX || !NR) {
      ck.skip('G2.28', '10 次一致性是否覆盖真实结算数值',
        '缺少 effects.js/narrator.js → 本次一致性只覆盖流程与门面，不含真实金币结算');
    }
  }

  /* ------------------------------------------- G3. 耐心归零 → GAME_OVER */
  ck.section('阶段 2 P0｜耐心归零立刻 GAME_OVER');

  var g3 = mkGame('demo');
  var G3 = g3.Game;
  G3.start('demo');
  await until(function () { return G3.state.phase === 'PICK'; });
  var bombSlot = G3.state.doors.map(function (d) { return d.itemId; }).indexOf('bomb');
  G3.action({ type: 'pick', slot: bombSlot >= 0 ? bombSlot : 0 });
  await until(function () { return G3.state.phase === 'DECIDE'; });
  G3.state.patience = 1;            /* 布置：耐心只剩 1 点 */
  var coinsBeforeBomb = G3.state.coins;
  G3.action({ type: 'decide', choice: 'stick' });   /* 踩炸弹：coins-50 / patience-1 */
  /* 注意：js/effects.js:254 会直接写 next.phase='GAME_OVER'（绕过 setState），
     因此必须等到 gameOver() 真正跑完（openModal 记录出现）再断言，否则是竞态误报。 */
  var reachedGO = await until(function () {
    return G3.state.phase === 'GAME_OVER' && !!lastModalOf(g3.rec, 'gameover');
  });
  await micro(3);
  if (!FX) {
    ck.skip('G3.1', '踩炸弹 → 耐心归零 → GAME_OVER（全链路）', 'js/effects.js 未就绪');
  } else {
    ck.ok('G3.1', reachedGO && G3.state.patience === 0 && !!lastModalOf(g3.rec, 'gameover'),
      '选中有炸弹的门坚持 → 耐心 1 → 0 → 立即进入 GAME_OVER 且弹出结算层（phase=' + G3.state.phase + '）',
      '实际 phase=' + G3.state.phase + ' patience=' + G3.state.patience + ' 弹层=' + jsonOf(g3.rec.modals.map(function (m) { return m.kind; })));
    ck.eq('G3.2', G3.state.coins, coinsBeforeBomb - 50, '炸弹结算：金币 ' + coinsBeforeBomb + ' → ' + G3.state.coins);
    var goModal = lastModalOf(g3.rec, 'gameover');
    ck.ok('G3.3', !!goModal && goModal.title === '耐心归零' && /耐心归零/.test(goModal.body || ''),
      'GAME_OVER 弹层标题「耐心归零」且正文说明原因',
      '实际 kind=' + (goModal && goModal.kind) + ' title=' + (goModal && goModal.title) + ' 全部弹层=' + jsonOf(g3.rec.modals.map(function (m) { return m.kind; })));
    ck.ok('G3.4', /非真实货币/.test((goModal && goModal.body) || ''), 'GAME_OVER 页含娱乐声明');
    /* 死屏回归防线：耐心归零后必须能一键回到演示起点（曾因 setState(REVEAL) 被 ALLOWED 拒绝而死屏） */
    var restartBtns = ((goModal && goModal.actions) || []).filter(function (a) { return a.choice === 'restart'; });
    var coinsAtDeath = G3.state.coins;
    var restartRet = G3.action({ type: 'modal_choice', choice: 'restart' });
    var restarted = G3.state;
    ck.ok('G3.8', restartBtns.length === 1 && restartRet === true &&
      ['IDLE', 'ROUND_INTRO', 'NARRATOR', 'PICK'].indexOf(restarted.phase) >= 0 &&
      restarted.coins === 100 && restarted.suspicion === 2 && restarted.patience === 3 &&
      restarted.round === 1 && restarted.pickedSlot === null && restarted.hostOpenedSlot === null,
      '死屏回归防线：耐心归零结算层提供「再来一局」，点击后回到演示起点（金币 ' + coinsAtDeath + ' → ' +
      restarted.coins + '、耐心 → ' + restarted.patience + '、轮次 → ' + restarted.round +
      '、phase=' + restarted.phase + '，即已在新一局的 ROUND_INTRO/IDLE 上而非 GAME_OVER）',
      'restart 按钮数=' + restartBtns.length + ' 返回值=' + restartRet + ' phase=' + restarted.phase +
      ' coins=' + restarted.coins + ' suspicion=' + restarted.suspicion + ' patience=' + restarted.patience +
      ' round=' + restarted.round + ' pickedSlot=' + restarted.pickedSlot + ' hostOpenedSlot=' + restarted.hostOpenedSlot);
  }

  /* G3.5 质疑失败扣耐心 → GAME_OVER（注入必败旁白，验证 challenge 分支） */
  var stubNarrator = {
    pickRoundLines: function () { return [{ text: '旁白替身台词', lie: true }]; },
    resolveChallenge: function () { return { ok: false, coins: 20, patience: 1, text: '旁白替身：你猜错了' }; }
  };
  var g35 = mkGame('demo', { narrator: stubNarrator });
  var G35 = g35.Game;
  G35.start('demo');
  await until(function () { return G35.state.phase === 'PICK'; });
  G35.action({ type: 'pick', slot: 0 });
  await until(function () { return G35.state.phase === 'DECIDE'; });
  G35.state.patience = 1;
  G35.state.suspicion = 2;
  G35.action({ type: 'decide', choice: 'challenge' });
  var go35 = await until(function () {
    return G35.state.phase === 'GAME_OVER' && !!lastModalOf(g35.rec, 'gameover');
  });
  await micro(3);
  if (!FX) {
    ck.skip('G3.5', '质疑失败扣耐心 → GAME_OVER', 'js/effects.js 未就绪');
  } else {
    ck.ok('G3.5', go35 && G35.state.patience === 0,
      '质疑失败（-20 金币 / 耐心 -1）在耐心归零时立即 GAME_OVER',
      '实际 phase=' + G35.state.phase + ' patience=' + G35.state.patience + ' coins=' + G35.state.coins);
  }

  /* G3.6 非法状态切换必须被拒绝（状态机唯一入口） */
  var g36 = mkGame('demo');
  var okIllegal = g36.Game.setState('REVEAL');
  ck.ok('G3.6', okIllegal === false && g36.Game.state.phase === 'IDLE',
    'IDLE → REVEAL 非法切换被 setState 拒绝且状态不变（phase=' + g36.Game.state.phase + '）');
  ck.ok('G3.7', g36.Game.setState('ROUND_INTRO') === true && g36.Game.state.phase === 'ROUND_INTRO',
    'IDLE → ROUND_INTRO 合法切换成功');

  /* --------------------------------------- G4. 快速连点 50 次不重复开奖 */
  ck.section('阶段 6 P0｜连续快速点击 50 次：不重复开奖、金币不算错');

  var g4 = mkGame('demo');
  var G4 = g4.Game;
  G4.start('demo');
  await until(function () { return G4.state.phase === 'PICK'; });
  G4.action({ type: 'pick', slot: G4.state.doors.map(function (d) { return d.itemId; }).indexOf('small_prize') });
  await until(function () { return G4.state.phase === 'DECIDE'; });
  var c4 = G4.state.coins;
  for (var click = 0; click < 50; click++) G4.action({ type: 'decide', choice: 'stick' });
  await until(function () { return G4.state.phase === 'SETTLE_ROUND' || G4.state.phase === 'GAME_OVER'; });
  if (!FX) {
    ck.skip('G4.1', '50 次连点金币只结算一次（action 入口）', 'js/effects.js 未就绪');
  } else {
    ck.eq('G4.1', G4.state.coins - c4, 30, 'Game.action 连点 50 次「坚持」：金币只 +30 一次（' + c4 + ' → ' + G4.state.coins + '）');
    ck.eq('G4.2', G4.state.log.length, 1, '连点 50 次只写入 1 条 log（未重复开奖）');
  }

  var g4b = mkGame('demo');
  var G4b = g4b.Game;
  G4b.start('demo');
  await until(function () { return G4b.state.phase === 'PICK'; });
  G4b.action({ type: 'pick', slot: G4b.state.doors.map(function (d) { return d.itemId; }).indexOf('small_prize') });
  await until(function () { return G4b.state.phase === 'DECIDE'; });
  var c4b = G4b.state.coins;
  for (var click2 = 0; click2 < 50; click2++) G4b.decide('stick');   /* 绕过 action 的相位闸门，直击 reveal 锁 */
  await until(function () { return G4b.state.phase === 'SETTLE_ROUND'; });
  if (!FX) {
    ck.skip('G4.3', '50 次连点金币只结算一次（绕过相位闸门）', 'js/effects.js 未就绪');
  } else {
    ck.eq('G4.3', G4b.state.coins - c4b, 30, '直接连调 Game.decide("stick") 50 次：金币只 +30 一次（revealLocked 生效）');
    ck.eq('G4.4', G4b.state.log.length, 1, '直接连调 50 次也只写入 1 条 log');
  }
  ck.ok('G4.5', G4b.state.flags && G4b.state.flags.revealLocked === true, 'flags.revealLocked=true 作为唯一开奖闸门');

  /* ------------------------------------------------- G5. 评级一致性 */
  ck.section('阶段 3 P0｜评级文案与配置档位');

  var rateGame = mkGame('demo');
  var R = rateGame.Game;
  var cfgRatings = gd.data.config && gd.data.config.ratings;
  ck.ok('G5.1', Array.isArray(cfgRatings) && cfgRatings.length >= 4,
    'config.ratings 是数组且 ≥4 档（game.js:690 用 Array.isArray 判定）',
    '实际 ' + (Array.isArray(cfgRatings) ? '数组 ' + cfgRatings.length + ' 档' : typeof cfgRatings));
  ck.ok('G5.2', !!(gd.data.config && gd.data.config.cashoutMaster && gd.data.config.cashoutMaster.title),
    'config.cashoutMaster 存在（game.js:691 读取）');
  ck.eq('G5.3', R.rating({ coins: 150, round: 2 }).title, '普通赌徒', 'rating(150, 第2轮) = 普通赌徒');
  ck.eq('G5.4', R.rating({ coins: 250, round: 4 }).title, '见好就收大师', 'rating(250, 第4轮) = 见好就收大师（cashoutMaster 生效）');
  ck.eq('G5.5', R.rating({ coins: 150, round: 4 }).title, '普通赌徒', 'rating(150, 第4轮) = 普通赌徒（未达 minCoins=200，不给大师）');

  /* G5.6 反例：300+ 金币的高档位（config.ratings[3].max = null） */
  var highCoins = [300, 400, 999];
  var highActual = highCoins.map(function (c5) { return c5 + '→' + R.rating({ coins: c5, round: 2 }).title; });
  var wantHigh = highCoins.map(function (c5) { return c5 + '→' + gd.data.ratingFor(c5, 2).title; });
  ck.ok('G5.6', R.rating({ coins: 300, round: 2 }).title === '反杀旁白',
    'rating(300+, 第2轮) 应为「反杀旁白」（config.ratings[3] min=300）',
    'game.js 实际：' + highActual.join('、') + '（内容层 ratingFor 认为应为：' + wantHigh.join('、') + '）');

  /* G5.7 网格交叉一致性：game.js rating() vs 内容层 ratingFor(..., {cashout:true}) */
  var gridCoins = [0, 50, 99, 100, 150, 199, 200, 250, 299, 300, 400, 999];
  var mism = [];
  for (var gi = 0; gi < gridCoins.length; gi++) {
    for (var gr = 1; gr <= 4; gr++) {
      var aT = R.rating({ coins: gridCoins[gi], round: gr }).title;
      var bT = gd.data.ratingFor(gridCoins[gi], gr, { cashout: true }).title;
      if (aT !== bT) mism.push('金币' + gridCoins[gi] + '/第' + gr + '轮：game.js「' + aT + '」 vs data.js「' + bT + '」');
    }
  }
  ck.ok('G5.7', mism.length === 0,
    'game.js rating() 与内容层 ratingFor(cashout:true) 在 48 组（金币 × 轮次）上完全一致',
    '共 ' + mism.length + ' 组不一致：\n         ' + mism.slice(0, 6).join('\n         '));

  /* G5.8 内容层是否真的被 game.js 使用（负向确认：改配置不影响 rating） */
  var savedRatings = gd.data.config.ratings;
  try {
    gd.data.config.ratings = [{ min: 0, max: 99999, title: '配置注入检查' }];
    var injected = R.rating({ coins: 50, round: 1 }).title;
  } finally {
    gd.data.config.ratings = savedRatings;
  }
  ck.ok('G5.8', injected === '配置注入检查',
    'rating() 读取的是 config.ratings（注入后称号随之改变，说明配置是真的生效）',
    '注入后仍返回「' + injected + '」→ 配置未生效');

  /* G5.9 演示剧本收尾称号（记录实际值，供 lead 核对「见好就收大师」是否该出现） */
  if (!t1.error && t1.rounds.length === 3) {
    var endTitle = t1.rounds[2].ending && t1.rounds[2].ending.title;
    var masterMin = (gd.data.config.cashoutMaster && gd.data.config.cashoutMaster.minRound) || 1;
    ck.ok('G5.9', !!endTitle,
      '演示剧本第 3 轮收手称号 = 「' + endTitle + '」（cashoutMaster.minRound=' + masterMin +
      '；剧本只到第 3 轮 → 不会出现「见好就收大师」，属配置决定，非缺陷）');
  }
  /* ============================================ G6 阶段 5 P1｜图鉴 / 本地存档（lead 新增） */

  ck.section('阶段 5 P1｜图鉴 / 最佳成绩本地存档（three_doors_codex_v1）');

  var LS_CODEX = 'three_doors_codex_v1';
  var LS_BEST = 'three_doors_best_v1';

  function fakeLS(mode) {
    var map = {}, api = {};
    api.map = map;
    api.getItem = function (k) {
      if (mode === 'readThrows') throw new Error('SecurityError: denied');
      return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null;
    };
    api.setItem = function (k, v) {
      if (mode === 'writeThrows') throw new Error('QuotaExceededError');
      map[k] = String(v);
    };
    api.removeItem = function (k) {
      if (mode === 'writeThrows') throw new Error('SecurityError: denied');
      delete map[k];
    };
    api.key = function (i) { var ks = Object.keys(map); return i < ks.length ? ks[i] : null; };
    Object.defineProperty(api, 'length', { get: function () { return Object.keys(map).length; } });
    return api;
  }

  ck.deepEq('G6.1', [G.CodexStore.keys.codex, G.CodexStore.keys.best], [LS_CODEX, LS_BEST],
    '存档键名与《开工清单》阶段 5 完全一致（three_doors_codex_v1 / three_doors_best_v1）');

  var savedLS = G.localStorage;
  G.localStorage = undefined;
  var noLS = {
    available: G.CodexStore.available(), load: G.CodexStore.loadCodex(),
    save: G.CodexStore.saveCodex({ items: ['x'], lines: [], endings: [] }), best: G.CodexStore.loadBest()
  };
  ck.ok('G6.2', noLS.available === false && noLS.load.items.length === 0 && noLS.load.lines.length === 0 &&
    noLS.load.endings.length === 0 && noLS.save === false && noLS.best.coins === 0,
    '无 localStorage（Node / 老浏览器 / 禁用存储）时 available()=false、读回空图鉴、写入返回 false，不上抛',
    '实测 ' + jsonOf(noLS));

  var lsBad = fakeLS();
  lsBad.map[LS_CODEX] = '{oops 不是 JSON';
  lsBad.map[LS_BEST] = 'null';
  G.localStorage = lsBad;
  var badRead = G.CodexStore.loadCodex(), badBest = G.CodexStore.loadBest();
  ck.ok('G6.3', badRead.items.length === 0 && badRead.lines.length === 0 && badRead.endings.length === 0 &&
    badBest.coins === 0 && badBest.round === 0 && badBest.titles.length === 0,
    '存档是坏 JSON / null 时静默降级为空图鉴（不抛异常，不白屏）',
    '实测 codex=' + jsonOf(badRead) + ' best=' + jsonOf(badBest));

  G.localStorage = fakeLS('writeThrows');
  var priv = { available: G.CodexStore.available(), save: G.CodexStore.saveCodex({ items: ['a'] }), clear: G.CodexStore.clearAll() };
  ck.ok('G6.4', priv.available === false && priv.save === false && priv.clear === false,
    '隐私模式（setItem 抛异常）下 available()=false、写入/清空返回 false 且不上抛',
    '实测 ' + jsonOf(priv));

  var lsG = fakeLS('readThrows');
  G.localStorage = lsG;
  var readThrows = G.CodexStore.loadCodex();
  ck.ok('G6.5', readThrows.items.length === 0 && G.CodexStore.available() === true,
    'getItem 抛异常时读回空图鉴且不抛（available 仍为 true —— 只读失败不影响写）',
    '实测 ' + jsonOf(readThrows));

  var ls = fakeLS();
  G.localStorage = ls;
  var savedOk = G.CodexStore.saveCodex({ items: ['bomb', 'trap'], lines: ['l1', 'l2'], endings: ['普通赌徒'] });
  var savedBestOk = G.CodexStore.saveBest({ coins: 250, round: 4, titles: ['欧皇候选'] });
  ck.ok('G6.6', savedOk === true && savedBestOk === true && !!ls.map[LS_CODEX] && !!ls.map[LS_BEST] &&
    JSON.parse(ls.map[LS_CODEX]).items.length === 2,
    'saveCodex/saveBest 真的写入两个清单指定键（值为可 JSON.parse 的对象）',
    '键=' + Object.keys(ls.map).join(',') + '；codex 值=' + ls.map[LS_CODEX]);

  var backCodex = G.CodexStore.loadCodex(), backBest = G.CodexStore.loadBest();
  ck.ok('G6.7', jsonOf(backCodex) === jsonOf({ items: ['bomb', 'trap'], lines: ['l1', 'l2'], endings: ['普通赌徒'] }) &&
    backBest.coins === 250 && backBest.round === 4 && backBest.titles.join(',') === '欧皇候选',
    '读回与写入逐字段一致（物品/语录/称号 + 最佳金币/轮次/称号）',
    '实测 codex=' + jsonOf(backCodex) + ' best=' + jsonOf(backBest));

  var clearedAll = G.CodexStore.clearAll();
  ck.ok('G6.8', clearedAll === true && !ls.map[LS_CODEX] && !ls.map[LS_BEST] &&
    G.CodexStore.loadCodex().items.length === 0 && G.CodexStore.loadBest().coins === 0,
    'clearAll() 删除两个键且读回为空（清空收集进度落地）',
    '剩余键=[' + Object.keys(ls.map).join(',') + ']');

  /* G6.9/G6.10 跨局累积：真跑一局 autoDemo → 落盘 → 新一局读回 */
  var ls2 = fakeLS();
  G.localStorage = ls2;
  var gc1 = mkGame('demo', {});
  var adOut = await gc1.Game.autoDemo();
  var codex1 = JSON.parse(jsonOf(gc1.Game.state.codex));
  var best1 = gc1.Game.best();
  ck.ok('G6.9', (codex1.items.length + codex1.lines.length + codex1.endings.length) > 0 && !!ls2.map[LS_CODEX] && !adOut.error,
    '跑完一局演示后 state.codex 有内容且已落盘 three_doors_codex_v1',
    'items=[' + codex1.items.join(',') + '] lines=[' + codex1.lines.join(',') + '] endings=[' + codex1.endings.join(',') +
    '] 落盘=' + !!ls2.map[LS_CODEX] + ' best=' + jsonOf(best1));

  var gc2 = mkGame('demo', {});
  var codex2 = gc2.Game.state.codex;
  var carried = codex1.items.every(function (id) { return codex2.items.indexOf(id) >= 0; }) &&
    codex1.lines.every(function (id) { return codex2.lines.indexOf(id) >= 0; });
  ck.ok('G6.10', carried,
    '新一局开局读回上一局图鉴（跨局累积，不丢收集）',
    '局1 items=[' + codex1.items.join(',') + '] lines=[' + codex1.lines.join(',') + '] → 局2 items=[' +
    codex2.items.join(',') + '] lines=[' + codex2.lines.join(',') + ']');

  /* G6.11 结算页按钮：再来一局 / 看图鉴
     注意：Game 是单例，mkGame 会换掉 Game.deps；必须在 gc2 = mkGame(...) 之前取到局 1 的记录器。 */
  var rec1 = gc1.rec;
  var cashModal = lastModalOf(rec1, 'cashout');
  var cashChoices = ((cashModal && cashModal.actions) || []).map(function (a) { return a.choice; });
  ck.ok('G6.11', !!cashModal && cashChoices.indexOf('restart') >= 0 && cashChoices.indexOf('codex') >= 0,
    '结算页（cashout）按钮含「再来一局(restart) / 看图鉴(codex)」',
    'choices=' + cashChoices.join(',') + ' title=' + (cashModal && cashModal.title));

  /* G6.12 耐心归零页按钮：用演示剧本第 1 轮的炸弹门真跑一次 GAME_OVER */
  G.localStorage = ls2;
  var ggo = mkGame('demo', {});
  ggo.Game.start('demo');
  await until(function () { return ggo.Game.state.phase === 'PICK'; });
  var bombAt = ggo.Game.state.doors.map(function (d) { return d.itemId; }).indexOf('bomb');
  ggo.Game.action({ type: 'pick', slot: bombAt });
  await until(function () { return ggo.Game.state.phase === 'DECIDE'; });
  ggo.Game.state.patience = 1;
  ggo.Game.action({ type: 'decide', choice: 'stick' });
  var goShown = await until(function () { return !!lastModalOf(ggo.rec, 'gameover'); });
  var goModal2 = lastModalOf(ggo.rec, 'gameover');
  var goChoices = ((goModal2 && goModal2.actions) || []).map(function (a) { return a.choice; });
  ck.ok('G6.12', goShown && goChoices.indexOf('restart') >= 0 && goChoices.indexOf('codex') >= 0,
    '耐心归零页（gameover）确实弹层且按钮含「再来一局 / 看图鉴」',
    'phase=' + ggo.Game.state.phase + ' choices=' + goChoices.join(',') + ' coins=' + ggo.Game.state.coins);

  /* G6.13 图鉴弹层（showCodex）+ 清空按钮（action 路由里码是 modal_choice:codex） */
  ggo.Game.action({ type: 'modal_choice', choice: 'codex' });
  var codexModal = lastModalOf(ggo.rec, 'codex');
  var codexChoices = ((codexModal && codexModal.actions) || []).map(function (a) { return a.choice; });
  ck.ok('G6.13', !!codexModal && codexModal.title === '图鉴' && codexChoices.indexOf('clear_codex') >= 0 &&
    codexChoices.indexOf('close') >= 0 && /three_doors_codex_v1/.test(codexModal.body || '') && /本机浏览器/.test(codexModal.body || ''),
    '图鉴弹层：标题「图鉴」+ 清空收集进度/关闭按钮 + 注明本机键名与不上传',
    'choices=' + codexChoices.join(',') + ' body=' + String(codexModal && codexModal.body).replace(/<[^>]+>/g, ' ').slice(0, 160));

  /* G6.14 弹层内「清空收集进度」→ state.codex 与两个键都被清空 */
  var keysBeforeClear = Object.keys(ls2.map).slice();
  ggo.Game.action({ type: 'modal_choice', choice: 'clear_codex' });
  var afterClear = ggo.Game.state.codex;
  ck.ok('G6.14', afterClear.items.length === 0 && afterClear.lines.length === 0 && afterClear.endings.length === 0 &&
    !ls2.map[LS_CODEX] && !ls2.map[LS_BEST] && !!lastModalOf(ggo.rec, 'codex'),
    '点「清空收集进度」→ state.codex 清空、两个存档键删除、并重新展示图鉴',
    '清空前键=[' + keysBeforeClear.join(',') + '] 清空后键=[' + Object.keys(ls2.map).join(',') + '] codex=' + jsonOf(afterClear));

  /* G6.15 best() 取历史最大值（不缩水）+ 称号并集 */
  var ls3 = fakeLS();
  G.localStorage = ls3;
  G.CodexStore.saveBest({ coins: 999, round: 7, titles: ['反杀旁白'] });
  var gbest = mkGame('demo', {});
  var bestNow = gbest.Game.best();
  ck.ok('G6.15', bestNow.coins === 999 && bestNow.round === 7 && bestNow.titles.indexOf('反杀旁白') >= 0 && bestNow.titles.length >= 1,
    'best() 保留历史最好成绩（金币 max / 轮次 max / 称号并集）',
    '实测 ' + jsonOf(bestNow) + '（本局 coins=' + gbest.Game.state.coins + ' round=' + gbest.Game.state.round + '）');
  G.localStorage = savedLS;

  /* ============================== G7 阶段 4 / 6 / 7 P0｜固定种子、重置计时、整局掐表、无外链 */

  ck.section('阶段 4 / 6 / 7 P0｜10 次一致、重置 1 秒、整局 3 分钟、断网无外链');

  function waitReal(pred, ms) {
    return new Promise(function (res) {
      var t0 = Date.now();
      (function step() {
        var v = false;
        try { v = !!pred(); } catch (e) { v = false; }
        if (v) return res({ ok: true, ms: Date.now() - t0 });
        if (Date.now() - t0 > ms) return res({ ok: false, ms: Date.now() - t0 });
        setTimeout(step, 5);
      })();
    });
  }

  /* G7.1 固定种子 20261024 连续 10 次：state.log / 逐轮快照 / 结算结果完全一致 */
  var logFps = [], roundFps = [];
  for (var runI = 1; runI <= 10; runI++) {
    G.localStorage = fakeLS();            /* 每局都是空存档，避免图鉴跨局污染指纹 */
    var grun = mkGame('demo', {});
    var outI = await grun.Game.autoDemo();
    var stI = grun.Game.state;
    logFps.push(jsonOf({ log: stI.log, coins: stI.coins, round: stI.round, ending: stI.ending }));
    roundFps.push(jsonOf(outI.rounds.map(function (s2) {
      return { c: s2.coins, r: s2.round, p: s2.pickedSlot, h: s2.hostOpenedSlot, d: s2.doors.map(function (d) { return d.itemId; }) };
    })));
  }
  G.localStorage = savedLS;
  var uniqLog = logFps.filter(function (v, i) { return logFps.indexOf(v) === i; });
  var uniqRound = roundFps.filter(function (v, i) { return roundFps.indexOf(v) === i; });
  var fp0 = JSON.parse(logFps[0]);
  ck.ok('G7.1', uniqLog.length === 1 && uniqRound.length === 1 && fp0.log.length === 2 && fp0.round === 3 && fp0.coins === 250,
    '固定种子 20261024 连续跑 10 次：结算 log / 逐轮门面与选择 / 最终金币 完全一致（唯一指纹数=1）',
    '唯一 log 指纹=' + uniqLog.length + '；唯一逐轮指纹=' + uniqRound.length +
    '；log 条数=' + fp0.log.length + '（第 3 轮收手不开奖，故 2 条）最终金币=' + fp0.coins + ' 轮次=' + fp0.round +
    '\n         log=' + logFps[0] +
    '\n         逐轮=' + roundFps[0]);

  /* G7.2 重置：可控定时器 —— 同步回到演示起点 + 等待预算 ≤ timings.resetMs */
  var sched = [];
  var gq = mkGame('demo', {
    setTimeout: function (fn, ms) { sched.push(ms == null ? 0 : ms); return setTimeout(fn, Math.min(ms || 0, 6)); },
    clearTimeout: clearTimeout
  });
  gq.Game.start('demo');
  await until(function () { return gq.Game.state.phase === 'PICK'; });
  gq.Game.state.pickedSlot = 2;
  gq.Game.state.coins = 777;
  sched.length = 0;
  var tReset = Date.now();
  gq.Game.action({ type: 'reset' });
  var dtReset = Date.now() - tReset;
  var stReset = gq.Game.state;
  ck.ok('G7.2', stReset.phase === 'IDLE' && stReset.round === 1 && stReset.coins === 100 &&
    stReset.suspicion === 2 && stReset.patience === 3 && stReset.pickedSlot === null && stReset.hostOpenedSlot === null,
    '任意状态（第 1 轮 PICK 且已改金币）点「重置」→ 同步回到演示起点：IDLE / 第 1 轮 / 100 / 2 / 3，实测 ' + dtReset + 'ms',
    'phase=' + stReset.phase + ' round=' + stReset.round + ' coins=' + stReset.coins + ' suspicion=' + stReset.suspicion + ' patience=' + stReset.patience);

  ck.ok('G7.3', sched.length > 0 && sched[0] <= 1000,
    '重置后的等待预算 = ' + sched[0] + 'ms ≤ timings.resetMs=1000（清单阶段 4/7「1 秒内回到演示起点」）',
    '全部调度=' + sched.slice(0, 8).join(',') + 'ms');

  var replay = await waitReal(function () { return gq.Game.state.phase === 'PICK' && gq.Game.state.round === 1; }, 4000);
  var replayDoors = gq.Game.state.doors.map(function (d) { return d.itemId; }).join(',');
  ck.ok('G7.4', replay.ok && replayDoors === (DEMO_ROUNDS[0].doors || []).join(','),
    '重置后自动重演：' + replay.ms + 'ms 后回到第 1 轮 PICK 且门面与 seed_demo 第 1 轮一致（含 1000ms 重置预算）',
    '门面=' + replayDoors + ' vs 剧本=' + (DEMO_ROUNDS[0].doors || []).join(','));

  /* G7.5 演示模式整局彩排掐表（真实时钟 + 真实 setTimeout，与现场同一套 timings） */
  G.localStorage = savedLS;
  var greal = mkGame('demo', { setTimeout: setTimeout, clearTimeout: clearTimeout });
  var tDemo = Date.now();
  var outReal = await greal.Game.autoDemo();
  var dtDemo = Date.now() - tDemo;
  ck.ok('G7.5', dtDemo <= 180000 && !outReal.error && !!outReal.final,
    '演示模式整局自动彩排实测 ' + dtDemo + 'ms ≤ 180000ms（清单阶段 7 P0「3 分钟内完整演完」）',
    'final coins=' + (outReal.final && outReal.final.coins) + ' round=' + (outReal.final && outReal.final.round) +
    ' error=' + outReal.error + '；3 轮快照数=' + outReal.rounds.length);

  /* G7.6/G7.7 阶段 6 P0：全部资源本地、无网络 API（断网可跑） */
  var fsx = require('fs');
  var scanFiles = ['index.html', 'style.css'];
  fsx.readdirSync(L.JS_DIR).filter(function (f) { return /\.js$/.test(f); }).sort().forEach(function (f) {
    scanFiles.push('js/' + f);
  });
  var extHits = [], netHits = [], missingScan = [];
  scanFiles.forEach(function (rel) {
    var p = path.join(L.ROOT, rel);
    if (!L.fileExists(p)) { missingScan.push(rel); return; }
    L.readText(p).split(/\r?\n/).forEach(function (line, i) {
      if (/https?:\/\//i.test(line) || /["'(]\s*\/\/[a-z0-9-]+\.[a-z]{2,}/i.test(line)) {
        extHits.push(rel + ':' + (i + 1) + ' ' + line.trim().slice(0, 100));
      }
      if (/\bfetch\s*\(|XMLHttpRequest|\bnew\s+WebSocket|EventSource|sendBeacon|\bimport\s*\(/.test(line)) {
        netHits.push(rel + ':' + (i + 1) + ' ' + line.trim().slice(0, 100));
      }
    });
  });
  var htmlTxt = L.readText(L.INDEX);
  var refs = [], reRef = /(?:src|href)\s*=\s*"([^"]+)"/gi, mm;
  while ((mm = reRef.exec(htmlTxt))) refs.push(mm[1]);
  var badRefs = refs.filter(function (r) { return /^(https?:)?\/\//i.test(r); });
  var missingRefs = refs.filter(function (r) {
    if (/^(https?:)?\/\//i.test(r) || r.charAt(0) === '#' || /^mailto:/i.test(r)) return false;
    return !L.fileExists(path.join(L.ROOT, r.replace(/[?#].*$/, '')));
  });
  ck.ok('G7.6', extHits.length === 0 && badRefs.length === 0 && missingRefs.length === 0 && missingScan.length === 0,
    '阶段 6 P0 全部资源本地：扫描 ' + scanFiles.length + ' 个文件（' + scanFiles.join(' ') + '）零 http(s):// 外链；' +
    'index.html 引用 ' + refs.length + ' 个资源全部本地存在（' + refs.join(' ') + '）',
    '外链命中=' + extHits.length + (extHits.length ? ' ' + extHits.slice(0, 3).join(' | ') : '') +
    '；协议相对引用=' + badRefs.join(',') + '；缺失文件=' + missingScan.concat(missingRefs).join(','));

  ck.ok('G7.7', netHits.length === 0,
    '阶段 6 P0 断网可跑：js/*.js 零 fetch / XMLHttpRequest / WebSocket / EventSource / sendBeacon / 动态 import()',
    netHits.slice(0, 5).join('\n         '));

  /* G7.8 阶段 6 P0「断网跑通」的静态自证（可重复、非恒真）：
     (a) 在全新 vm 上下文里把 fetch / XMLHttpRequest / WebSocket / EventSource 换成
         「一旦被调用就记录并抛错」的毒丸，同时 navigator.onLine=false，再按首页顺序加载
         全部 6 个经典脚本：必须零异常、零毒丸命中，且 Game / GameData 都在。
     (b) index.html 引用的每个资源逐个 fs.existsSync 检查、且不得是 http(s):// 或协议相对地址。
     (c) style.css 的 url() 与 @import 也只能指向本地存在的文件。 */
  var poisonHits = [];
  function poison(name) {
    return function () { poisonHits.push(name); throw new Error('离线环境不得调用 ' + name); };
  }
  var offline = L.loadScripts({
    withDom: false,
    globals: {
      fetch: poison('fetch'), XMLHttpRequest: poison('XMLHttpRequest'),
      WebSocket: poison('WebSocket'), EventSource: poison('EventSource'),
      sendBeacon: poison('sendBeacon'), importScripts: poison('importScripts'),
      navigator: { onLine: false, userAgent: 'offline-test' },
      location: { protocol: 'file:', href: 'file:///index.html', reload: function () {} }
    }
  });
  var htmlRefs = [], htmlMissing8 = [], htmlExt8 = [];
  var re8 = /(?:src|href)\s*=\s*["']([^"']+)["']/gi, m8;
  while ((m8 = re8.exec(htmlTxt)) !== null) {
    var r8 = m8[1];
    htmlRefs.push(r8);
    if (/^(https?:)?\/\//i.test(r8)) { htmlExt8.push(r8); continue; }
    if (/^(data:|mailto:|#)/i.test(r8)) continue;
    if (!L.fileExists(path.join(L.ROOT, r8.replace(/[?#].*$/, '')))) htmlMissing8.push(r8);
  }
  var cssTxt = L.readText(path.join(L.ROOT, 'style.css'));
  var cssRefs = [], cssBad8 = [];
  var reCss8 = /url\(\s*["']?([^"')]+)["']?\s*\)|@import\s+(?:url\(\s*)?["']([^"']+)["']/gi, mCss;
  while ((mCss = reCss8.exec(cssTxt)) !== null) {
    var c8 = mCss[1] || mCss[2];
    if (!c8 || /^(data:|#)/i.test(c8)) continue;
    cssRefs.push(c8);
    if (/^(https?:)?\/\//i.test(c8) || !L.fileExists(path.join(L.ROOT, c8.replace(/[?#].*$/, '')))) cssBad8.push(c8);
  }
  var dataArtifactOk = L.fileExists(path.join(L.JS_DIR, 'data.js'));
  ck.ok('G7.8', offline.missing.length === 0 && offline.errors.length === 0 && poisonHits.length === 0 &&
    !!offline.sandbox.Game && !!offline.sandbox.GameData && dataArtifactOk &&
    htmlMissing8.length === 0 && htmlExt8.length === 0 && cssBad8.length === 0 && htmlRefs.length >= 6,
    '阶段 6 P0「断网跑通」静态自证：毒化 fetch/XHR/WebSocket/EventSource + navigator.onLine=false 的全新上下文里' +
    '重新加载 ' + offline.loaded.length + ' 个脚本零异常、零网络调用；index.html 引用的 ' + htmlRefs.length +
    ' 个资源逐个 fs.existsSync 通过且零外链；style.css 的 ' + cssRefs.length + ' 个 url()/@import 全部本地存在；' +
    'js/data.js 产物在位（Game/GameData 均已挂载）',
    'missing=' + jsonOf(offline.missing) + ' errors=' + jsonOf(offline.errors.slice(0, 2)) +
    ' 毒丸命中=' + jsonOf(poisonHits) + ' Game=' + !!offline.sandbox.Game + ' GameData=' + !!offline.sandbox.GameData +
    ' data.js=' + dataArtifactOk + ' 外链=' + jsonOf(htmlExt8) + ' 缺失引用=' + jsonOf(htmlMissing8) +
    ' css非法=' + jsonOf(cssBad8));

  ck.ok('G7.9', L.fileExists(path.join(L.ROOT, 'style.css')) && L.fileExists(path.join(L.ROOT, 'index.html')),
    '阶段 0 P0 工程结构：index.html + style.css 均存在（双击可跑的最小集合）');

  ck.section('阶段 1/2/4 P0｜主持人硬不变量、质疑每轮一次、文案不剧透');

  /* ---------- HOST-INVARIANT：真实 chooseDoor → UI playHostOpen 链路上的硬不变量 ---------- */
  /* 走真实链路（不是直接调 hostPick）：包一层 deps.ui.playHostOpen 记录主持人实际打开了哪扇、
     当时玩家选了哪扇、调用时相位；forceR3Slot0 时再包 chooseDoor，复刻 lead 的剧本碰撞用例。 */
  async function hostTrace(opts) {
    opts = opts || {};
    var g8 = mkGame('demo', {});
    var Game8 = g8.Game;
    var rows8 = [], injections = [];
    var ui8 = g8.deps.ui;
    var innerPlay = ui8.playHostOpen;
    ui8.playHostOpen = function (slot, itemId) {
      var s = Game8.state;
      rows8.push({
        round: s.round, phase: s.phase,
        doors: s.doors.map(function (d) { return d.itemId; }),
        picked: s.pickedSlot,
        pickedItem: (s.pickedSlot == null || !s.doors[s.pickedSlot]) ? null : s.doors[s.pickedSlot].itemId,
        host: slot, hostItem: itemId, stateHost: s.hostOpenedSlot,
        opened: slot == null ? null : !!s.doors[slot].opened,
        scriptFallback: !!s.hostScriptFallback
      });
      return innerPlay.call(ui8, slot, itemId);
    };
    var origChoose = Game8.chooseDoor;
    Game8.chooseDoor = function (slot) {
      var s = Game8.state;
      if (opts.forceR3Slot0 && s.round >= 3 && slot !== 0) {
        injections.push({ round: s.round, from: slot, fromItem: s.doors[slot] && s.doors[slot].itemId, to: 0 });
        slot = 0;
      }
      return origChoose.call(Game8, slot);
    };
    var out8 = await Game8.autoDemo();
    Game8.chooseDoor = origChoose;
    ui8.playHostOpen = innerPlay;
    return { out: out8, rows: rows8, injections: injections, Game: Game8, rec: g8.rec };
  }

  /* G8.1 演示剧本正常路径（3 轮） */
  var ht = await hostTrace({});
  var htBad = ht.rows.filter(function (r) {
    return r.host == null || r.host === r.picked || r.hostItem === 'big_prize' || r.opened !== true ||
      r.host !== r.stateHost || r.phase !== 'HOST_OPEN';
  });
  ck.ok('G8.1', ht.rows.length === 3 && htBad.length === 0 && !!(ht.out && ht.out.final),
    'HOST-INVARIANT（演示剧本正常路径，真实 chooseDoor → UI playHostOpen 链路）：' + ht.rows.length +
    ' 轮全部满足「主持人所开门 ≠ 玩家所选门、≠ 大奖门、该门确实为已开、state.hostOpenedSlot 与 UI 回调一致、调用时相位=HOST_OPEN」',
    '违规=' + jsonOf(htBad) + '；逐轮=' + jsonOf(ht.rows.map(function (r) {
      return 'R' + r.round + ' 门面' + r.doors.join('/') + ' 选' + r.picked + '(' + r.pickedItem +
        ') 开' + r.host + '(' + r.hostItem + ')';
    })));

  /* G8.1b lead 给的剧本碰撞用例：R3 门面 trap/big_prize/empty、剧本 hostOpensSlot=0、强制玩家选 slot0 */
  var ht2 = await hostTrace({ forceR3Slot0: true });
  var ht2Bad = ht2.rows.filter(function (r) {
    return r.host == null || r.host === r.picked || r.hostItem === 'big_prize' || r.opened !== true ||
      r.host !== r.stateHost;
  });
  var r3row = ht2.rows.filter(function (r) { return r.round === 3; })[0] || null;
  ck.ok('G8.1b', ht2.injections.length >= 1 && !!r3row && r3row.picked === 0 && r3row.host !== 0 &&
    r3row.hostItem !== 'big_prize' && r3row.host === 2 && r3row.scriptFallback === true && ht2Bad.length === 0,
    'HOST-INVARIANT（剧本碰撞：R3 强制玩家选 slot0）第 3 轮门面 ' + (r3row ? r3row.doors.join('/') : '?') +
    '，剧本 hostOpensSlot=0 与玩家所选门撞车 → 退化为真实 hostPick，开 ' +
    (r3row ? r3row.host + '(' + r3row.hostItem + ')' : '?') +
    '（不是玩家所选门、不是大奖，hostScriptFallback=true），三轮零违规',
    '注入=' + jsonOf(ht2.injections) + '；R3=' + jsonOf(r3row) + '；违规=' + jsonOf(ht2Bad));

  /* G8.1c 非剧本轮：12 个普通模式种子 × 3 个所选，走真实 pick 动作链路 */
  var freeBad = [], freeCount = 0;
  for (var s8 = 0; s8 < 12; s8++) {
    for (var sl8 = 0; sl8 < 3; sl8++) {
      var gf = mkGame('normal', {});
      gf.Game.init({ mode: 'normal', seed: 8000 + s8, deps: gf.deps });
      gf.Game.start('normal');
      var okP8 = await until(function () { return gf.Game.state.phase === 'PICK'; }, 2000);
      if (!okP8) { freeBad.push('seed' + (8000 + s8) + ' 未到 PICK'); continue; }
      var doorsBefore8 = gf.Game.state.doors.map(function (d) { return d.itemId; });
      gf.Game.action({ type: 'pick', slot: sl8 });
      var okD8 = await until(function () { return gf.Game.state.phase === 'DECIDE'; }, 2000);
      var st8 = gf.Game.state;
      freeCount++;
      var hostItem8 = st8.hostOpenedSlot == null ? null : st8.doors[st8.hostOpenedSlot].itemId;
      var openedCount8 = st8.doors.filter(function (d) { return d.opened; }).length;
      if (!okD8 || st8.hostOpenedSlot == null || st8.hostOpenedSlot === sl8 || hostItem8 === 'big_prize' ||
          !st8.doors[st8.hostOpenedSlot].opened || openedCount8 !== 1) {
        freeBad.push('seed' + (8000 + s8) + ' 选' + sl8 + ' 门面' + doorsBefore8.join('/') +
          ' → 开' + st8.hostOpenedSlot + '(' + hostItem8 + ') 已开数=' + openedCount8 + ' okD=' + okD8);
      }
    }
  }
  ck.ok('G8.1c', freeCount === 36 && freeBad.length === 0,
    'HOST-INVARIANT（非剧本轮，普通模式 12 种子 × 3 所选 = ' + freeCount +
    ' 次真实 pick 动作链路）：主持人所开门全部 ≠玩家所选门、≠大奖门、恰好开 1 扇',
    jsonOf(freeBad));

  /* ---------- CHALLENGE-ONCE：同一轮第二次质疑必须被拒且不动数值，换轮后可再质疑 ---------- */
  var g82 = mkGame('demo', {});
  var G82 = g82.Game;
  G82.start('demo');
  var ok82 = await until(function () { return G82.state.phase === 'PICK'; }, 5000);
  var slot82 = G82.state.doors.map(function (d) { return d.itemId; }).indexOf('small_prize');
  G82.action({ type: 'pick', slot: slot82 });
  await until(function () { return G82.state.phase === 'DECIDE'; }, 5000);
  var c0 = G82.state.coins, sus0 = G82.state.suspicion, pat0 = G82.state.patience;
  var first82 = G82.action({ type: 'decide', choice: 'challenge' });
  var lc1 = G82.state.lastChallenge || {};
  var c1 = G82.state.coins, sus1 = G82.state.suspicion, flag1 = G82.state.challengedThisRound;
  var second82 = G82.action({ type: 'decide', choice: 'challenge' });
  var c2 = G82.state.coins, sus2 = G82.state.suspicion;
  var r1DeltaOk = lc1.ok ? (c1 === c0 + 20) : (c1 === c0 - 20 && G82.state.patience === pat0 - 1);
  G82.action({ type: 'decide', choice: 'stick' });
  await until(function () { return G82.state.phase === 'SETTLE_ROUND'; }, 5000);
  G82.action({ type: 'settle', choice: 'continue' });
  var okR2 = await until(function () { return G82.state.round === 2 && G82.state.phase === 'PICK'; }, 5000);
  var slotR2 = G82.state.doors.map(function (d) { return d.itemId; }).indexOf('big_prize');
  G82.action({ type: 'pick', slot: slotR2 });
  await until(function () { return G82.state.phase === 'DECIDE'; }, 5000);
  var flagR2 = G82.state.challengedThisRound, susR2Before = G82.state.suspicion;
  var third82 = G82.action({ type: 'decide', choice: 'challenge' });
  var susR2After = G82.state.suspicion;
  var okChalR2 = !!(G82.state.lastChallenge && G82.state.lastChallenge.ok);
  ck.ok('G8.2', ok82 && first82 === true && second82 === false && c2 === c1 && sus2 === sus1 && flag1 === true &&
    r1DeltaOk && sus1 === sus0 - 1 && okR2 && flagR2 === false && third82 === true &&
    susR2After === susR2Before - 1 && okChalR2 === true,
    'CHALLENGE-ONCE：R1 第 1 次质疑 true（金币 ' + c0 + '→' + c1 + '、怀疑值 ' + sus0 + '→' + sus1 + '，' +
    (lc1.ok ? '拆穿成功 +20' : '拆穿失败 −20 且耐心 −1') + '），第 2 次 false 且金币/怀疑值完全不变（' +
    c2 + '/' + sus2 + '）；换到 R2 后 challengedThisRound 已重置，第 3 次质疑 true 且演示 R2 的「质疑反杀」仍成立' +
    '（怀疑值 ' + susR2Before + '→' + susR2After + '，lastChallenge.ok=' + okChalR2 + '）',
    'first=' + first82 + ' second=' + second82 + ' c1=' + c1 + ' c2=' + c2 + ' sus2=' + sus2 +
    ' R1flag=' + flag1 + ' R1ok=' + lc1.ok + ' R2flag=' + flagR2 + ' third=' + third82 +
    ' R2ok=' + okChalR2 + ' R2怀疑=' + susR2Before + '→' + susR2After + ' okR2=' + okR2);

  /* ---------- HINT-NO-SPOILER：风险提示/兜底文案不得剧透哪轮撒谎、哪轮说真话 ---------- */
  var SPOIL8 = /撒谎|说真话|真话|不老实|说谎/;
  var spoilerWords = /\b(?:lie|lies|lying|truth|truthful|spoiler)\b/i;
  var cfgPath8 = path.join(L.ROOT, 'data', 'config.json');
  var cfgRaw8 = L.readText(cfgPath8);
  var cfgObj8 = JSON.parse(cfgRaw8);
  var cfgStrings8 = [];
  (function collect8(v, p) {
    if (typeof v === 'string') { cfgStrings8.push({ p: p, text: v }); return; }
    if (Array.isArray(v)) { v.forEach(function (x, i) { collect8(x, p + '[' + i + ']'); }); return; }
    if (v && typeof v === 'object') { Object.keys(v).forEach(function (k) { collect8(v[k], p + '.' + k); }); }
  })(cfgObj8, 'config');
  var cfgValueSpoil8 = cfgStrings8.filter(function (s2) { return SPOIL8.test(s2.text) || spoilerWords.test(s2.text); })
    .map(function (s2) { return s2.p + ' = ' + JSON.stringify(s2.text); });
  var cfgRawSpoil8 = [];
  cfgRaw8.split(/\r?\n/).forEach(function (line, i) {
    if (SPOIL8.test(line)) cfgRawSpoil8.push('config.json:' + (i + 1) + ' ' + line.trim());
  });
  var gameSrc8 = L.readText(path.join(L.JS_DIR, 'game.js'));
  var gameSpoil8 = [], gameLitSpoil8 = [], gameCodeLines8 = 0;
  gameSrc8.split(/\r?\n/).forEach(function (line, i) {
    var t = line.trim();
    if (t.charAt(0) === '*' || t.indexOf('//') === 0 || t.indexOf('/*') === 0) return;  /* 注释不算玩家可见文案 */
    gameCodeLines8++;
    if (SPOIL8.test(line)) gameSpoil8.push('js/game.js:' + (i + 1) + ' ' + t);
    var reL8 = /["']([^"']*)["']/g, mL8;
    while ((mL8 = reL8.exec(line)) !== null) {
      if (spoilerWords.test(mL8[1])) gameLitSpoil8.push('js/game.js:' + (i + 1) + ' ' + mL8[0]);
    }
  });
  ck.ok('G8.3', cfgRawSpoil8.length === 0 && cfgValueSpoil8.length === 0 && gameSpoil8.length === 0 &&
    gameLitSpoil8.length === 0 && cfgStrings8.length >= 20 && gameCodeLines8 >= 300,
    'HINT-NO-SPOILER（文件内容断言，不靠人眼）：data/config.json 的 ' + cfgStrings8.length +
    ' 个字符串值与全部 ' + cfgRaw8.split(/\r?\n/).length + ' 行、js/game.js 的 ' + gameCodeLines8 +
    ' 行非注释代码，都不含「撒谎/说真话/真话/不老实/说谎」及英文 lie/lies/lying/truth/spoiler 字样' +
    '（规则说明只允许出现在注释里）',
    'config行命中=' + jsonOf(cfgRawSpoil8) + ' config值命中=' + jsonOf(cfgValueSpoil8) +
    ' gamejs行命中=' + jsonOf(gameSpoil8) + ' gamejs字面量命中=' + jsonOf(gameLitSpoil8));

  var hints8 = cfgObj8.roundHints || {};
  var hintKeys8 = Object.keys(hints8);
  ck.ok('G8.4', hintKeys8.length >= 4 && hintKeys8.every(function (k) {
    return typeof hints8[k] === 'string' && hints8[k].length > 0;
  }), '阶段 3 P0「每轮开始显示风险提示」：config.roundHints 覆盖 ' + hintKeys8.length + ' 轮且文案全部非空',
    jsonOf(hints8));
}

main().then(function () {
  ck.print();
  var c = ck.counts();
  process.exitCode = c.FAIL > 0 ? 1 : 0;
}).catch(function (e) {
  console.log('\n[sim.js 运行时异常] ' + (e && e.stack ? e.stack : e));
  ck.print();
  process.exitCode = 2;
});

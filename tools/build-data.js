/* ============================================================================
 * tools/build-data.js —— 把 data/*.json 内联生成 js/data.js（零构建、无第三方依赖）
 * ----------------------------------------------------------------------------
 * 用法：
 *   node tools/build-data.js           # 生成 / 覆盖 js/data.js
 *   node tools/build-data.js --check   # 只校验：产物与磁盘一致则 exit 0，否则 exit 1
 *
 * 设计要点：
 *   - 浏览器侧不允许 fetch JSON（file:// 双击必须能跑），所以 JSON 在构建期内联。
 *   - 产物完全确定：无时间戳、无随机数、LF 换行、键序取自源文件；同输入必同输出。
 *   - 构建期即做验收断言：物品数值表、物品 kind、旁白字数/条数与配对、演示剧本逐字一致、
 *     第 1 轮无炸弹、第 4 轮起炸弹/陷阱权重提高 —— 任何一条不满足直接报错退出。
 * ========================================================================== */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.resolve(__dirname, '..');
var DATA_DIR = path.join(ROOT, 'data');
var OUT_FILE = path.join(ROOT, 'js', 'data.js');

/* 生成产物里记录的数据来源（POSIX 相对路径，顺序固定，保证确定性）。 */
var GENERATED_FROM = [
  'data/items.json',
  'data/shop.json',
  'data/config.json',
  'data/narrator.json',
  'data/seed_demo.json'
];

/* 《开工清单》阶段 2 物品表 —— 逐项硬编码作为构建期防线，防手改源文件写错数值。 */
var EXPECT_ITEMS = {
  big_prize: { coins: 100, patience: 0, suspicion: 0 },
  small_prize: { coins: 30, patience: 0, suspicion: 0 },
  empty: { coins: 0, patience: 0, suspicion: 0 },
  bomb: { coins: -50, patience: -1, suspicion: 0 },
  trap: { coins: -30, patience: 0, suspicion: -1 },
  switch_ticket: { coins: 0, patience: 0, suspicion: 0 },
  mute_card: { coins: 0, patience: 0, suspicion: 0 },
  double_coins: { coins: 0, patience: 0, suspicion: 0 },
  mystery_box: { coins: 0, patience: 0, suspicion: 0 }
};
var EXPECT_ORDER = [
  'big_prize', 'small_prize', 'empty', 'bomb', 'trap',
  'switch_ticket', 'mute_card', 'double_coins', 'mystery_box'
];

/* 引擎 js/game.js 的 hostPick 按 kind 排序决定主持人开哪扇门，取值表冻结。 */
var KIND_BY_ID = {
  big_prize: 'prize',
  small_prize: 'prize',
  empty: 'no-prize',
  bomb: 'hazard',
  trap: 'hazard',
  switch_ticket: 'item',
  mute_card: 'item',
  double_coins: 'item',
  mystery_box: 'item'
};
var KIND_VALUES = ['prize', 'no-prize', 'hazard', 'item'];

/* 兼容别名：闭嘴卡在部分模块里叫 shutup_card（同一份定义，不占新物品名额）。 */
var ITEM_ALIASES = { shutup_card: 'mute_card' };

/* docs/设计契约_商店与美术.md §2.2 商品表 —— 价格 / 单局上限逐字硬编码为构建期防线。
   cap === null 表示不限购（当前只有神秘盒）。 */
var EXPECT_SHOP = [
  { id: 'switch_ticket', name: '换门券', price: 25, cap: 3, kind: 'bag', icon: 'ticket' },
  { id: 'mute_card', name: '闭嘴卡', price: 20, cap: 2, kind: 'bag', icon: 'mute' },
  { id: 'double_coins', name: '双倍金币', price: 40, cap: 2, kind: 'bag', icon: 'double' },
  { id: 'fuse', name: '保险丝', price: 35, cap: 2, kind: 'bag', icon: 'fuse' },
  { id: 'mystery_box', name: '神秘盒', price: 15, cap: null, kind: 'instant', icon: 'box' },
  { id: 'patience_charm', name: '续命符', price: 60, cap: 2, kind: 'instant', icon: 'charm' }
];
var SHOP_KINDS = ['bag', 'instant'];
/* 商店独占商品：只卖不进门的物品池（门的 9 种牌面不受商店影响）。
   fuse 是背包类但不在门池里；patience_charm 是购买即结算。 */
var SHOP_ONLY_IDS = ['fuse', 'patience_charm'];
/* ui.js 的 inline SVG 符号名白名单（<symbol id="ic-ticket"> 之类），不得引外部图片。 */
var SHOP_ICONS = ['ticket', 'mute', 'double', 'fuse', 'box', 'charm'];
var SHOP_DESC_MAX = 22;
/* 契约 §2：换门 15 金币；商店只在 DECIDE / SETTLE_ROUND 可开；结算页统计商店花费。 */
var EXPECT_ECONOMY = { switchCost: 15, shopOpenStates: ['DECIDE', 'SETTLE_ROUND'], spentStat: true };
/* 续命符的「上限 5」指【耐心资源天花板】（config.initial.patience=3 只是初值），
   与商店的【单局限购 cap=2】是两件事，故落成独立字段 patienceCap，二者解耦。 */
var EXPECT_PATIENCE_CAP = 5;

/* 《开工清单》阶段 4 固定种子剧本 —— 逐字比对（键序也固定）。 */
var EXPECT_SEED = {
  seed: 20261024,
  rounds: [
    { round: 1, doors: ['small_prize', 'empty', 'bomb'], hostOpensSlot: 2, narrator: 'truth', expect: 'small_prize' },
    { round: 2, doors: ['empty', 'big_prize', 'trap'], hostOpensSlot: 0, narrator: 'lie', expect: 'challenge_win' },
    { round: 3, doors: ['trap', 'big_prize', 'empty'], hostOpensSlot: 0, narrator: 'lie_hard', expect: 'cashout' }
  ]
};

/* 旁白语料最低条数要求（阶段 2/4/5）。 */
var KINDS = ['intro', 'truth', 'lie', 'lie_hard', 'challenge_win', 'challenge_fail', 'special', 'flavor'];
var KIND_MIN = { intro: 1, truth: 4, lie: 4, lie_hard: 4, challenge_win: 3, challenge_fail: 3, special: 4, flavor: 1 };
var SPECIAL_TRIGGERS = ['switch3', 'challenge2', 'empty3', 'challenge'];
var PAIR_MODES = ['truth', 'lie', 'lie_hard'];

function fail(msg) {
  console.error('[build-data] 校验失败：' + msg);
  process.exit(1);
}

function readJson(name) {
  var file = path.join(DATA_DIR, name);
  var raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    fail('读不到 ' + file + ' —— ' + e.message);
  }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(file + ' 不是合法 JSON —— ' + e.message);
  }
}

function stableStringify(value) {
  /* JSON.stringify 保序；这里只统一换行为 LF，避免平台差异导致产物不一致。 */
  return JSON.stringify(value, null, 2).replace(/\r\n/g, '\n');
}

/* ------------------------------------------------------------------ 载入源文件 */
var itemsDoc = readJson('items.json');
var config = readJson('config.json');
var narratorDoc = readJson('narrator.json');
var seedDemo = readJson('seed_demo.json');
var shopDoc = readJson('shop.json');

if (!itemsDoc || !Array.isArray(itemsDoc.items)) fail('items.json 顶层需要 { source, items: [...] }');
var itemList = itemsDoc.items;

/* ------------------------------------------------------- 校验 1：物品表逐项一致 */
if (itemList.length !== EXPECT_ORDER.length) {
  fail('物品数量应为 ' + EXPECT_ORDER.length + '，实际 ' + itemList.length);
}
var required = ['id', 'name', 'coins', 'patience', 'suspicion', 'weight', 'minRound', 'kind', 'desc', 'icon'];
var seen = {};
itemList.forEach(function (it, idx) {
  required.forEach(function (k) {
    if (it[k] == null) fail('物品 #' + idx + ' 缺字段 ' + k);
  });
  if (it.id !== EXPECT_ORDER[idx]) fail('物品顺序/ id 不符：第 ' + (idx + 1) + ' 项应为 ' + EXPECT_ORDER[idx] + '，实际 ' + it.id);
  if (seen[it.id]) fail('物品 id 重复：' + it.id);
  seen[it.id] = true;
  var exp = EXPECT_ITEMS[it.id];
  ['coins', 'patience', 'suspicion'].forEach(function (k) {
    if (Number(it[k]) !== exp[k]) {
      fail(it.id + '.' + k + ' 应为 ' + exp[k] + '（阶段 2 物品表），实际 ' + it[k]);
    }
  });
  if (it.kind !== KIND_BY_ID[it.id]) {
    fail(it.id + '.kind 应为 ' + KIND_BY_ID[it.id] + '（引擎 hostPick 依赖），实际 ' + it.kind);
  }
  if (KIND_VALUES.indexOf(it.kind) < 0) fail(it.id + '.kind 非法：' + it.kind);
  if (!(Number(it.weight) > 0)) fail(it.id + '.weight 必须是正数');
  if (!(Number(it.minRound) >= 1)) fail(it.id + '.minRound 必须 ≥ 1');
  if (it.lateWeight != null && !(Number(it.lateWeight) > 0)) fail(it.id + '.lateWeight 必须是正数');
});
if (Number(EXPECT_ITEMS.bomb && itemList[3].minRound) < 2) fail('炸弹 minRound 必须 ≥ 2（第 1 轮不放炸弹）');

/* --------------------------------------------------- 校验 2：config 关键字段存在 */
function need(pathStr, val) {
  if (val == null) fail('config 缺字段 ' + pathStr);
  return val;
}
var initial = need('initial', config.initial);
if (initial.coins !== 100 || initial.suspicion !== 2 || initial.patience !== 3) {
  fail('initial 必须是 {coins:100, suspicion:2, patience:3}，实际 ' + JSON.stringify(initial));
}
var sus = need('suspicion', config.suspicion);
if (sus.cost !== 1 || sus.winCoins !== 20 || sus.loseCoins !== 20 || sus.losePatience !== 1 || sus.grudgeLieBonus !== 0.2) {
  fail('suspicion 数值与《开工清单》阶段 2 不一致：' + JSON.stringify(sus));
}
if (sus.rewardMode !== 'coins' && sus.rewardMode !== 'hint') fail("suspicion.rewardMode 只能是 'coins' | 'hint'");
var timings = need('timings', config.timings);
var EXPECT_TIMINGS = { introMs: 800, narratorMs: 2000, hostOpenMs: 600, revealMs: 900, revealDoubledExtraMs: 400, resetMs: 1000 };
Object.keys(EXPECT_TIMINGS).forEach(function (k) {
  if (Number(timings[k]) !== EXPECT_TIMINGS[k]) fail('timings.' + k + ' 应为 ' + EXPECT_TIMINGS[k] + '，实际 ' + timings[k]);
});
var poolCfg = need('pool', config.pool);
if (!Array.isArray(poolCfg.noBombRounds) || poolCfg.noBombRounds.indexOf(1) < 0) fail('pool.noBombRounds 必须包含 1（第 1 轮不放炸弹）');
if (Number(poolCfg.boostRound) !== 4) fail('pool.boostRound 应为 4（第 4 轮起提高炸弹/陷阱权重）');

/* 评级：引擎 js/game.js 用 Array.isArray(config.ratings) 判断，必须是数组。 */
var ratings = need('ratings', config.ratings);
if (!Array.isArray(ratings) || ratings.length < 4) fail('ratings 必须是至少 4 档的数组（0/100/200/300）');
if (ratings[0].min !== 0 || ratings[3].min !== 300) fail('ratings 档位应从 0 起、300+ 收尾');
var master = need('cashoutMaster', config.cashoutMaster);
if (Number(master.minRound) < 1 || Number(master.minCoins) < 0 || !master.title) {
  fail('cashoutMaster 需要 {minRound, minCoins, title}，实际 ' + JSON.stringify(master));
}
var roundHints = need('roundHints', config.roundHints);
[1, 2, 3].forEach(function (r) {
  if (!roundHints[r] && !roundHints[String(r)]) fail('roundHints 缺第 ' + r + ' 轮提示');
});
var maxChars = Number((config.lies || {}).maxChars || 28);
var linesPerRound = Number((config.lies || {}).linesPerRound || 2);
if (linesPerRound !== 2) fail('lies.linesPerRound 应为 2（引擎每轮播 2 句）');

/* --------------------------- 校验 2b：economy + 商店商品表（设计契约 §2.1/§2.2/§2.3） */
var eco = need('economy', config.economy);
if (Number(eco.switchCost) !== EXPECT_ECONOMY.switchCost) {
  fail('economy.switchCost 应为 ' + EXPECT_ECONOMY.switchCost + '（契约 §2.1），实际 ' + eco.switchCost);
}
if (stableStringify(eco.shopOpenStates) !== stableStringify(EXPECT_ECONOMY.shopOpenStates)) {
  fail('economy.shopOpenStates 应为 ' + JSON.stringify(EXPECT_ECONOMY.shopOpenStates) + '，实际 ' + JSON.stringify(eco.shopOpenStates));
}
if (eco.spentStat !== true) fail('economy.spentStat 应为 true（结算页要统计商店花费）');

if (!shopDoc || !Array.isArray(shopDoc.shop)) fail('shop.json 顶层需要 { source, shop: [...] }');
var shopList = shopDoc.shop;
if (shopList.length !== EXPECT_SHOP.length) fail('商品数量应为 ' + EXPECT_SHOP.length + '，实际 ' + shopList.length);
shopList.forEach(function (sp, idx) {
  var exp = EXPECT_SHOP[idx];
  if (!sp || typeof sp !== 'object') fail('商品 #' + (idx + 1) + ' 不是对象');
  if (sp.id !== exp.id) fail('商品顺序/ id 不符：第 ' + (idx + 1) + ' 项应为 ' + exp.id + '，实际 ' + sp.id);
  if (sp.name !== exp.name) fail(sp.id + '.name 应为 ' + exp.name + '，实际 ' + sp.name);
  if (Number(sp.price) !== exp.price) fail(sp.id + '.price 应为 ' + exp.price + '（契约 §2.2），实际 ' + sp.price);
  var spCap = (sp.cap == null) ? null : Number(sp.cap);
  if (spCap !== exp.cap) {
    fail(sp.id + '.cap 应为 ' + (exp.cap === null ? '不限（null）' : exp.cap) + '（契约 §2.2），实际 ' + sp.cap);
  }
  if (sp.kind !== exp.kind) fail(sp.id + '.kind 应为 ' + exp.kind + '（bag=进背包 / instant=购买即结算），实际 ' + sp.kind);
  if (SHOP_KINDS.indexOf(sp.kind) < 0) fail(sp.id + '.kind 非法：' + sp.kind);
  if (sp.icon !== exp.icon) fail(sp.id + '.icon 应为 ' + exp.icon + '（对应 ui.js 的 ic-' + exp.icon + ' 符号），实际 ' + sp.icon);
  if (SHOP_ICONS.indexOf(sp.icon) < 0) fail(sp.id + '.icon 不在 ui 符号白名单：' + sp.icon);
  if (!sp.desc) fail(sp.id + ' 缺 desc（每件一句、≤' + SHOP_DESC_MAX + ' 字、要说清买了怎么用）');
  if (String(sp.desc).length > SHOP_DESC_MAX) fail(sp.id + '.desc 超过 ' + SHOP_DESC_MAX + ' 字：' + String(sp.desc).length + ' 字');
  /* 神秘盒必须复用 config.mystery 的结果表，商品条目不得自带 outcomes。 */
  if (sp.outcomes) fail(sp.id + ' 不得自带 outcomes —— 神秘盒复用 config.mystery（契约 §2.2）');
  /* 商店独占商品不得混进门的物品池；与物品池同名的商品（换门券等）天然复用同一份定义。 */
  if (SHOP_ONLY_IDS.indexOf(sp.id) >= 0 && seen[sp.id]) {
    fail('商店独占商品 ' + sp.id + ' 不得出现在物品池 items.json（门的 9 种牌面保持不动）');
  }
});
if (shopList[5].kind !== 'instant' || Number(shopList[5].patienceCap) !== EXPECT_PATIENCE_CAP) {
  fail('patience_charm 应为 instant 且 patienceCap=' + EXPECT_PATIENCE_CAP + '（耐心资源天花板，与单局限购 cap=2 解耦）');
}
if (shopList[4].kind !== 'instant' || shopList[4].cap != null) fail('mystery_box 必须是 instant 且不限购（cap=null）');
var mystery = need('mystery', config.mystery);
if (!Array.isArray(mystery.outcomes) || !mystery.outcomes.length) fail('config.mystery.outcomes 不能为空（神秘盒复用）');
mystery.outcomes.forEach(function (o, i) {
  if (!(Number(o.weight) > 0)) fail('config.mystery.outcomes[' + i + '].weight 必须是正数');
});

/* 归一化商品条目：固定键序 + 派生布尔，供引擎与 ui 直接读（unlimited=不限购 / immediate=购买即结算）。 */
var shop = shopList.map(function (sp) {
  var entry = {
    id: sp.id,
    name: sp.name,
    price: Number(sp.price),
    cap: (sp.cap == null) ? null : Number(sp.cap),
    kind: sp.kind,
    icon: sp.icon,
    desc: sp.desc,
    unlimited: sp.cap == null,
    immediate: sp.kind === 'instant'
  };
  if (Number(sp.patienceCap) > 0) entry.patienceCap = Number(sp.patienceCap);
  return entry;
});

/* --------------------------------------------------- 校验 3：旁白语料 + 彩蛋覆盖 */
if (!narratorDoc || !Array.isArray(narratorDoc.lines)) fail('narrator.json 顶层需要 { source, lines: [...] }');
var lines = narratorDoc.lines;
var counts = {};
var ids = {};
var byId = {};
lines.forEach(function (l, i) {
  if (!l.id || !l.text || !l.kind) fail('旁白 #' + i + ' 缺 id/text/kind');
  if (ids[l.id]) fail('旁白 id 重复：' + l.id);
  ids[l.id] = true;
  byId[l.id] = l;
  if (KINDS.indexOf(l.kind) < 0) fail('旁白 ' + l.id + ' 的 kind 非法：' + l.kind);
  if (l.text.length > maxChars) fail('旁白 ' + l.id + ' 超过 ' + maxChars + ' 字：' + l.text.length + ' 字');
  if (l.kind === 'lie' || l.kind === 'lie_hard') {
    if (l.truthful !== false) fail('旁白 ' + l.id + ' 是谎话，truthful 必须为 false');
  } else if (l.truthful !== true && l.truthful !== false) {
    fail('旁白 ' + l.id + ' 缺 truthful 布尔字段');
  }
  counts[l.kind] = (counts[l.kind] || 0) + 1;
});
Object.keys(KIND_MIN).forEach(function (k) {
  if ((counts[k] || 0) < KIND_MIN[k]) fail('旁白 kind『' + k + '』至少 ' + KIND_MIN[k] + ' 条，实际 ' + (counts[k] || 0));
});
var triggers = lines.filter(function (l) { return l.kind === 'special'; }).map(function (l) { return l.trigger; });
SPECIAL_TRIGGERS.forEach(function (t) {
  if (triggers.indexOf(t) < 0) fail('缺少彩蛋旁白 trigger=' + t);
});
lines.forEach(function (l) {
  if (l.kind === 'special' && SPECIAL_TRIGGERS.indexOf(l.trigger) < 0) fail('彩蛋 ' + l.id + ' 的 trigger 非法：' + l.trigger);
});

/* 每轮 2 句：配对表必须指向真实存在的 id，且第二句的 kind 与模式一致。 */
var pairs = (narratorDoc && narratorDoc.pairs) || null;
if (!pairs) fail('narrator.json 缺 pairs（每轮 2 句的配对表）');
PAIR_MODES.forEach(function (mode) {
  var list = pairs[mode];
  if (!Array.isArray(list) || !list.length) fail('pairs.' + mode + ' 至少要有一组配对');
  list.forEach(function (pair, pi) {
    if (!Array.isArray(pair) || pair.length !== linesPerRound) {
      fail('pairs.' + mode + ' 第 ' + (pi + 1) + ' 组必须正好 ' + linesPerRound + ' 句');
    }
    pair.forEach(function (id) {
      if (!byId[id]) fail('pairs.' + mode + ' 引用了不存在的旁白 id：' + id);
    });
    /* 引擎用 narratorLines[0] 交给 resolveChallenge，所以判定句必须落在第 1 句。 */
    if (byId[pair[0]].kind !== mode) {
      fail('pairs.' + mode + ' 第 ' + (pi + 1) + ' 组第一句 kind 应为 ' + mode + '，实际 ' + byId[pair[0]].kind);
    }
    if (mode === 'truth' && byId[pair[0]].truthful !== true) fail('pairs.truth 第一句不该是谎话：' + pair[0]);
    if (mode !== 'truth' && byId[pair[0]].truthful !== false) fail('pairs.' + mode + ' 第一句必须是谎话：' + pair[0]);
    if (mode === 'truth' && byId[pair[1]].truthful !== true) fail('pairs.truth 第二句不该是谎话：' + pair[1]);
    if (mode !== 'truth' && byId[pair[1]].truthful !== false) fail('pairs.' + mode + ' 第二句也必须是谎话：' + pair[1]);
  });
});

/* ------------------------------------------- 校验 4：演示剧本与阶段 4 逐字一致 */
if (stableStringify(seedDemo) !== stableStringify(EXPECT_SEED)) {
  fail('seed_demo.json 与《开工清单》阶段 4 不一致\n期望：' + stableStringify(EXPECT_SEED) + '\n实际：' + stableStringify(seedDemo));
}

/* --------------------------------------------------------------- 生成 js/data.js */
var items = {};
itemList.forEach(function (it) { items[it.id] = it; });
var aliasCount = Object.keys(ITEM_ALIASES).length;

var out = [];
out.push('/* ============================================================================');
out.push(' * js/data.js —— 内容层生成产物（《三扇门：别信旁白》阶段 2）');
out.push(' * 本文件由 tools/build-data.js 生成，勿手改。');
out.push(' * 数据来源：' + GENERATED_FROM.join('、'));
out.push(' * 改数值请改 data/*.json，然后重新执行：node tools/build-data.js');
out.push(' * 零构建：经典脚本挂 globalThis.GameData，file:// 双击可用，浏览器侧禁止 fetch JSON。');
out.push(' * ========================================================================== */');
out.push('(function (root) {');
out.push("  'use strict';");
out.push('');
out.push('  var meta = ' + stableStringify({
  name: config.title + '（' + config.stage + '）',
  stage: config.stage,
  version: config.version,
  generatedFrom: GENERATED_FROM,
  generator: 'tools/build-data.js',
  demoSeed: seedDemo.seed,
  itemCount: itemList.length,
  itemAliasCount: aliasCount,
  narratorCount: lines.length
}).split('\n').join('\n  ') + ';');
out.push('');
out.push('  var itemList = ' + stableStringify(itemList).split('\n').join('\n  ') + ';');
out.push('');
out.push('  var items = {};');
out.push('  for (var i = 0; i < itemList.length; i++) items[itemList[i].id] = itemList[i];');
out.push('  /* 兼容别名：与主条目共享同一份对象（不占物品名额、不进 itemList）。 */');
out.push('  var itemAliases = ' + stableStringify(ITEM_ALIASES) + ';');
out.push('  for (var alias = null, aliasKeys = Object.keys(itemAliases), ai = 0; ai < aliasKeys.length; ai++) {');
out.push('    alias = aliasKeys[ai];');
out.push('    if (!items[alias] && items[itemAliases[alias]]) items[alias] = items[itemAliases[alias]];');
out.push('  }');
out.push('');
out.push('  var config = ' + stableStringify(config).split('\n').join('\n  ') + ';');
out.push('');
out.push('  var narrator = ' + stableStringify(narratorDoc).split('\n').join('\n  ') + ';');
out.push('');
out.push('  var seedDemo = ' + stableStringify(seedDemo).split('\n').join('\n  ') + ';');
out.push('');
out.push('  /**');
out.push('   * 第 round 轮的可抽取门池：[{ id, weight }]。');
out.push('   * - round < item.minRound 的物品不出现；');
out.push('   * - round 命中 config.pool.noBombRounds（第 1 轮）时排除 bomb；');
out.push('   * - round >= config.pool.boostRound（第 4 轮）时改用 lateWeight，炸弹/陷阱变多。');
out.push('   * 返回全新对象，调用方改它不会污染 GameData。');
out.push('   */');
out.push('  function poolForRound(round) {');
out.push('    var r = Math.round(Number(round));');
out.push('    if (!isFinite(r) || r < 1) r = 1;');
out.push('    var boostAt = (config.pool && config.pool.boostRound) || 4;');
out.push('    var noBomb = (config.pool && config.pool.noBombRounds) || [];');
out.push('    var list = [];');
out.push('    for (var i = 0; i < itemList.length; i++) {');
out.push('      var it = itemList[i];');
out.push('      if (r < it.minRound) continue;');
out.push('      if (it.id === \'bomb\' && noBomb.indexOf(r) >= 0) continue;');
out.push('      var w = (r >= boostAt && it.lateWeight != null) ? it.lateWeight : it.weight;');
out.push('      w = Number(w) || 0;');
out.push('      if (w > 0) list.push({ id: it.id, weight: w });');
out.push('    }');
out.push('    return list;');
out.push('  }');
out.push('');
out.push('  function itemById(id) { return (id && items[id]) || null; }');
out.push('');
out.push('  /* 商店商品表（docs/设计契约_商店与美术.md §2.2）：cap=null 表示不限购，');
out.push('     unlimited / immediate 为派生布尔，价格与单局上限由契约冻结。 */');
out.push('  var shop = ' + stableStringify(shop).split('\n').join('\n  ') + ';');
out.push('');
out.push('  /** 按 id 取商品定义，未知 id 返回 null（引擎 buy/useItem 与 ui 渲染共用）。 */');
out.push('  function shopById(id) {');
out.push('    for (var i = 0; i < shop.length; i++) if (shop[i].id === id) return shop[i];');
out.push('    return null;');
out.push('  }');
out.push('');
out.push('  /**');
out.push('   * 结算评级：高轮次收手（config.cashoutMaster）优先，其次按 config.ratings 金币档位。');
out.push('   * 确定性纯函数，不改任何状态。');
out.push('   */');
out.push('  function ratingFor(coins, round, opts) {');
out.push('    opts = opts || {};');
out.push('    var cn = Number(coins);');
out.push('    if (!isFinite(cn)) cn = 0;');
out.push('    var rd = Math.round(Number(round));');
out.push('    if (!isFinite(rd) || rd < 1) rd = 1;');
out.push('    var m = config.cashoutMaster || null;');
out.push('    if (opts.cashout && m && rd >= (m.minRound || 1) && cn >= (m.minCoins || 0)) {');
out.push("      return { id: 'cashout', title: m.title, desc: m.desc, by: 'cashout', coins: cn, round: rd };");
out.push('    }');
out.push('    var bands = Array.isArray(config.ratings) ? config.ratings : (config.ratingsTiers || []);');
out.push('    for (var i = 0; i < bands.length; i++) {');
out.push('      var t = bands[i];');
out.push('      var min = (t.min == null) ? 0 : t.min;');
out.push('      var max = (t.max == null) ? Infinity : t.max;');
out.push('      if (cn >= min && cn <= max) {');
out.push("        return { id: t.id, title: t.title, desc: t.desc, by: 'coins', coins: cn, round: rd };");
out.push('      }');
out.push('    }');
out.push("    return { id: 'unknown', title: '无名赌徒', desc: '', by: 'fallback', coins: cn, round: rd };");
out.push('  }');
out.push('');
out.push('  root.GameData = {');
out.push('    meta: meta,');
out.push('    items: items,');
out.push('    itemList: itemList,');
out.push('    itemAliases: itemAliases,');
out.push('    itemById: itemById,');
out.push('    poolForRound: poolForRound,');
out.push('    ratingFor: ratingFor,');
out.push('    shop: shop,');
out.push('    shopById: shopById,');
out.push('    config: config,');
out.push('    narrator: narrator,');
out.push('    seedDemo: seedDemo');
out.push('  };');
out.push('');
out.push('  /* 兼容别名：测试与 ui.js 会按 ITEMS / GAME_DATA 探测内容层。 */');
out.push('  root.ITEMS = itemList;');
out.push('  root.GAME_DATA = root.GameData;');
out.push('})(typeof globalThis !== \'undefined\' ? globalThis : this);');
out.push('');

var code = out.join('\n');

/* ------------------------------------- 构建期自检：把产物丢进 vm 跑一遍关键契约 */
var sandbox = {};
try {
  vm.runInNewContext(code, sandbox, { filename: 'js/data.js' });
} catch (e) {
  fail('生成产物无法执行：' + e.stack);
}
var GameData = sandbox.GameData;
if (!GameData) fail('产物没有挂上 globalThis.GameData');
if (GameData.itemList.length !== 9) fail('GameData.itemList 应为 9 项');
if (Object.keys(GameData.items).length !== 9 + aliasCount) {
  fail('GameData.items 应为 9 种主条目 + ' + aliasCount + ' 个别名，实际 ' + Object.keys(GameData.items).length);
}
if (GameData.itemList[0] !== GameData.items.big_prize) fail('items 与 itemList 未共享同一批对象引用');
if (GameData.items.shutup_card !== GameData.items.mute_card) fail('别名 shutup_card 应指向 mute_card 的同一对象');
if (!Array.isArray(sandbox.ITEMS) || sandbox.GAME_DATA !== GameData) fail('兼容导出 ITEMS / GAME_DATA 未生效');

var r1 = GameData.poolForRound(1).map(function (e) { return e.id; });
if (r1.indexOf('bomb') >= 0) fail('第 1 轮门池出现了 bomb：' + r1.join(','));
var r2 = GameData.poolForRound(2);
var r4 = GameData.poolForRound(4);
function wOf(pool, id) {
  for (var i = 0; i < pool.length; i++) if (pool[i].id === id) return pool[i].weight;
  return 0;
}
if (wOf(r2, 'bomb') <= 0) fail('第 2 轮门池应包含 bomb');
if (wOf(r4, 'bomb') <= wOf(r2, 'bomb')) fail('第 4 轮 bomb 权重未提高：' + wOf(r2, 'bomb') + ' -> ' + wOf(r4, 'bomb'));
if (wOf(r4, 'trap') <= wOf(r2, 'trap')) fail('第 4 轮 trap 权重未提高：' + wOf(r2, 'trap') + ' -> ' + wOf(r4, 'trap'));
if (wOf(r4, 'big_prize') !== wOf(r2, 'big_prize')) fail('第 4 轮不应改动 big_prize 权重');
var mut = GameData.poolForRound(2);
mut[0].weight = 9999;
if (GameData.poolForRound(2)[0].weight === 9999) fail('poolForRound 返回了会被外部污染的引用');
if (GameData.ratingFor(50, 2).title !== '被旁白 PUA') fail('ratingFor(50) 应为「被旁白 PUA」');
if (GameData.ratingFor(150, 2).title !== '普通赌徒') fail('ratingFor(150) 应为「普通赌徒」');
if (GameData.ratingFor(250, 2).title !== '欧皇候选') fail('ratingFor(250) 应为「欧皇候选」');
if (GameData.ratingFor(500, 2).title !== '反杀旁白') fail('ratingFor(500) 应为「反杀旁白」');
if (GameData.ratingFor(250, 4, { cashout: true }).title !== '见好就收大师') fail('第 4 轮 250 金币收手应为「见好就收大师」');
if (GameData.ratingFor(150, 4, { cashout: true }).title !== '普通赌徒') fail('未达 minCoins 的收手不应给「见好就收大师」');

/* 商店契约（设计契约 §2.1/§2.2）：价格、上限、派生布尔、economy 都必须真进了产物。 */
if (!Array.isArray(GameData.shop) || GameData.shop.length !== 6) fail('GameData.shop 应为 6 件商品');
var shopPrices = { switch_ticket: 25, mute_card: 20, double_coins: 40, fuse: 35, mystery_box: 15, patience_charm: 60 };
Object.keys(shopPrices).forEach(function (sid) {
  var sp = GameData.shopById(sid);
  if (!sp) fail('shopById(' + sid + ') 取不到商品');
  if (sp.price !== shopPrices[sid]) fail(sid + '.price 应为 ' + shopPrices[sid] + '，产物里是 ' + sp.price);
});
if (GameData.shopById('switch_ticket').cap !== 3 || GameData.shopById('switch_ticket').unlimited !== false) {
  fail('换门券单局上限应为 3');
}
if (GameData.shopById('mute_card').cap !== 2 || GameData.shopById('double_coins').cap !== 2 || GameData.shopById('fuse').cap !== 2) {
  fail('闭嘴卡 / 双倍金币 / 保险丝的单局上限应为 2');
}
if (GameData.shopById('mystery_box').cap !== null || GameData.shopById('mystery_box').unlimited !== true) {
  fail('神秘盒应不限购（cap=null / unlimited=true）');
}
if (GameData.shopById('mystery_box').immediate !== true) fail('神秘盒应为即时商品（immediate=true）');
if (GameData.shopById('patience_charm').immediate !== true) fail('续命符应为即时商品（immediate=true）');
if (GameData.shopById('patience_charm').cap !== 2 || GameData.shopById('patience_charm').patienceCap !== 5) {
  fail('续命符：单局限购 2、耐心天花板 5');
}
if (GameData.shopById('switch_ticket').immediate !== false) fail('背包商品 immediate 应为 false');
if (GameData.shopById('nope') !== null) fail('shopById 未知 id 应返回 null');
GameData.shop.forEach(function (sp) {
  if (['bag', 'instant'].indexOf(sp.kind) < 0) fail(sp.id + '.kind 非法：' + sp.kind);
  if (!sp.desc || String(sp.desc).length > SHOP_DESC_MAX) fail(sp.id + '.desc 缺失或超过 ' + SHOP_DESC_MAX + ' 字');
  if (SHOP_ICONS.indexOf(sp.icon) < 0) fail(sp.id + '.icon 非法：' + sp.icon);
});
if (GameData.config.economy.switchCost !== 15) fail('GameData.config.economy.switchCost 应为 15');
if (stableStringify(GameData.config.economy.shopOpenStates) !== stableStringify(['DECIDE', 'SETTLE_ROUND'])) {
  fail('GameData.config.economy.shopOpenStates 应为 [DECIDE, SETTLE_ROUND]');
}
if (GameData.config.economy.spentStat !== true) fail('GameData.config.economy.spentStat 应为 true');
/* 商店数据不得混进物品池：itemList 仍必须 9 项、items 仍必须 9 主条目 + 别名。 */
if (GameData.items.fuse || GameData.items.patience_charm) fail('商店独占商品 fuse / patience_charm 不得进入物品池 items');
if (GameData.itemList.length !== 9) fail('商店改动不得影响物品池数量（itemList 应仍为 9）');

/* ------------------------------------------------------------------- 写文件 */
if (process.argv.indexOf('--check') >= 0) {
  var current = '';
  try { current = fs.readFileSync(OUT_FILE, 'utf8'); } catch (e) { /* 缺失即视为不一致 */ }
  /* 换行归一化后再比：生成物本身固定 LF（见上文「只统一换行为 LF」），
     但检出到磁盘时 Windows 的 core.autocrlf / gitattributes 可能把它变成 CRLF，
     那是同一份内容的表示差异，不该判为「产物漂移」。真漂移（数值/文案变了）仍会被抓到。 */
  var lf = function (s) { return String(s).replace(/\r\n/g, '\n'); };
  if (lf(current) !== lf(code)) {
    console.error('[build-data] --check 失败：js/data.js 与 data/*.json 不一致（需重新执行 node tools/build-data.js）');
    process.exit(1);
  }
  console.log('[build-data] --check 通过：js/data.js 与 data/*.json 一致（' + Buffer.byteLength(code, 'utf8') + ' 字节）');
  process.exit(0);
}

fs.writeFileSync(OUT_FILE, code, 'utf8');
console.log('[build-data] 已生成 js/data.js：' + Buffer.byteLength(code, 'utf8') + ' 字节，'
  + itemList.length + ' 种物品（+ ' + aliasCount + ' 别名） / ' + shop.length + ' 件商品 / '
  + lines.length + ' 条旁白 / 演示剧本 ' + seedDemo.rounds.length + ' 轮');
console.log('[build-data] 来源：' + GENERATED_FROM.join('、'));

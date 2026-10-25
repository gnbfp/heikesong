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
  'data/personas.json',
  'data/achievements.json',
  'data/config.json',
  'data/narrator.json',
  'data/seed_demo.json'
];

/* 《开工清单》阶段 2 物品表 —— 逐项硬编码作为构建期防线，防手改源文件写错数值。 */
var EXPECT_ITEMS = {
  big_prize: { coins: 100, patience: 0, suspicion: 0 },
  small_prize: { coins: 30, patience: 0, suspicion: 1 },
  empty: { coins: 0, patience: 0, suspicion: 1 },
  bomb: { coins: -50, patience: -1, suspicion: 0 },
  trap: { coins: -30, patience: 0, suspicion: -1 },
  switch_ticket: { coins: 0, patience: 0, suspicion: 0 },
  mute_card: { coins: 0, patience: 0, suspicion: 0 },
  double_coins: { coins: 0, patience: 0, suspicion: 0 },
  mystery_box: { coins: 0, patience: 0, suspicion: 0 },
  jackpot: { coins: 150, patience: 0, suspicion: 0 },
  landmine: { coins: -40, patience: -1, suspicion: 0 },
  quicksand: { coins: -20, patience: 0, suspicion: -1 }
};
/* 顺序即物品池 itemList 的下标：前 9 项是《开工清单》阶段 2 的冻结表，
   末尾 3 项是工作流 B（数据与随机性）按契约 §4 B2 追加的大奖 / 危险 / 陷阱各 1 件。 */
var EXPECT_ORDER = [
  'big_prize', 'small_prize', 'empty', 'bomb', 'trap',
  'switch_ticket', 'mute_card', 'double_coins', 'mystery_box',
  'jackpot', 'landmine', 'quicksand'
];
/* 工作流 B：物品表数量下限（原 9 件 + 新增 3 件）。 */
var MIN_ITEMS = 12;

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
  mystery_box: 'item',
  jackpot: 'prize',
  landmine: 'hazard',
  quicksand: 'hazard'
};
var KIND_VALUES = ['prize', 'no-prize', 'hazard', 'item'];
/* js/effects.js:155-157 只识别这三种 special，未知值会被引擎静默忽略 —— 构建期直接拦住。 */
var SPECIAL_VALUES = ['gain_item', 'double', 'mystery'];

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
/* 契约 §2.1/§2.2：连击奖励上限与步长、怀疑值资源上限。 */
var EXPECT_SUSPICION_MAX = 3;
var EXPECT_COMBO = { step: 10, cap: 20 };
/* 契约 §2.2 要求更新的两条物品 desc：写清「怀疑值 +1」且不超过 22 字。 */
var SUSPICION_DESC_IDS = ['empty', 'small_prize'];
var ITEM_DESC_MAX = 22;

/* 契约 v3 §4.1 结局表 —— id / priority / title / lineKind 逐字硬编码；
   narrator.json 的 endings 以 lineKind 为键，每键至少 2 条赛后点评。 */
var EXPECT_ENDINGS = [
  { id: 'all_in', priority: 100, title: '全识破', lineKind: 'ending_all_in' },
  { id: 'comeback', priority: 90, title: '绝地翻盘', lineKind: 'ending_comeback' },
  { id: 'iron_patience', priority: 80, title: '稳如老狗', lineKind: 'ending_iron' },
  { id: 'master', priority: 70, title: '见好就收大师', lineKind: 'ending_master' },
  { id: 'pua', priority: 60, title: '被旁白 PUA', lineKind: 'ending_pua' },
  { id: 'euro', priority: 50, title: '欧皇候选', lineKind: 'ending_euro' },
  { id: 'anti', priority: 40, title: '反杀旁白', lineKind: 'ending_anti' },
  { id: 'normal', priority: 0, title: '普通赌徒', lineKind: 'ending_normal' }
];
var ENDING_LINE_MIN = 2;
var ENDING_DESC_MAX = 40;
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

/* 旁白语料最低条数要求（契约 v3 §3 扩容；F3 要求总语料 60+ 条）。 */
var KINDS = ['intro', 'truth', 'lie', 'lie_hard', 'challenge_win', 'challenge_fail', 'special', 'flavor'];
var KIND_MIN = { intro: 3, truth: 8, lie: 8, lie_hard: 8, challenge_win: 5, challenge_fail: 5, special: 8, flavor: 4 };
var SPECIAL_TRIGGERS = ['switch3', 'challenge2', 'empty3', 'challenge'];
var PAIR_MODES = ['truth', 'lie', 'lie_hard'];
/* 契约 v3 §1.1：claimable 行 + 三种 claimType（每种至少 4 条，且三种 kind 都覆盖）。 */
var CLAIM_TYPES = ['slot_kind', 'big_prize_in', 'picked_kind'];
var CLAIM_TYPE_MIN = 4;
var CLAIM_TEXT_RULES = {
  slot_kind: { re: /[1-9]\s*号门/, label: '必须含「N 号门」' },
  big_prize_in: { re: /大奖/, label: '必须含「大奖」' },
  picked_kind: { re: /(你选|你手里)/, label: '必须含「你选 / 你手里」' }
};
var NARRATOR_TOTAL_MIN = 60;

/* 契约 v4 §3.1 旁白人格 —— id/name/icon/desc/lieRateDelta 逐字硬编码为构建期防线。 */
var EXPECT_PERSONAS = [
  { id: 'sarcastic', name: '毒舌旁白', icon: '😏', desc: '阴阳怪气，句句带刺。', lieRateDelta: 0 },
  { id: 'gentle', name: '温柔旁白', icon: '🌸', desc: '轻声细语，但也不一定说真话。', lieRateDelta: -0.05 },
  { id: 'crazy', name: '癫狂旁白', icon: '🤪', desc: '神经兮兮，语速都比别人快。', lieRateDelta: 0.05 }
];
var PERSONA_DESC_MAX = 22;
var PERSONA_IDS = ['sarcastic', 'gentle', 'crazy'];
/* 人格子池：开场 / 串场 / 结算，键名由契约 §3.3 冻结。 */
var PERSONA_POOL_KEYS = ['intro', 'flavor', 'settle'];
var PERSONA_POOL_MIN = 1;
var EXPECT_PERSONALITY_DEFAULT = 'sarcastic';
var EXPECT_LIE_RATE_DELTA_CAP = 0.1;
var EXPECT_ACHIEVEMENTS_STORAGE_KEY = 'three_doors_achievements_v1';

/* 契约 v4 §3.2 成就表 —— 恰 10 条，id/name/icon/check.type/threshold 冻结（desc 文案自拟 ≤40 字）。 */
var EXPECT_ACHIEVEMENTS = [
  { id: 'first_cashout', name: '见好就收', icon: '💰', type: 'cashouts', threshold: 1 },
  { id: 'rounds5', name: '五关斩将', icon: '🖐️', type: 'rounds', threshold: 5 },
  { id: 'coins300', name: '三百门客', icon: '🪙', type: 'coins', threshold: 300 },
  { id: 'combo3', name: '三连问', icon: '🔍', type: 'challengeWins', threshold: 3 },
  { id: 'codex24', name: '全知者', icon: '📚', type: 'codexLines', threshold: 24 },
  { id: 'endings4', name: '剧作人', icon: '🎬', type: 'endings', threshold: 4 },
  { id: 'all_in', name: '梭哈', icon: '🎲', type: 'doubles', threshold: 3 },
  { id: 'comeback', name: '绝地反击', icon: '🔥', type: 'comeback', threshold: 200 },
  { id: 'clean_run', name: '火眼金睛', icon: '👁️', type: 'clean', threshold: 1 },
  { id: 'persona3', name: '千人千面', icon: '🎭', type: 'personas', threshold: 3 }
];
var ACHIEVEMENT_TYPES = ['rounds', 'coins', 'cashouts', 'challengeWins', 'codexLines', 'endings', 'doubles', 'comeback', 'personas', 'clean'];
var ACHIEVEMENT_DESC_MAX = 40;

/* 契约 v4 §3.3 结算点评池：≥12 条、按 result 挑选（win/lose/cashout/bust 每种 ≥2 条）。 */
var SETTLE_MIN = 12;
var SETTLE_RESULTS = ['win', 'lose', 'cashout', 'bust'];
var SETTLE_RESULT_MIN = 2;

/* 「只增不改」防线：契约 v3 冻结的 60 条台词 id（连顺序），v4 只允许在其后追加。 */
var LEGACY_LINE_IDS = [
  't01', 't02', 't03', 't04', 't05', 't06', 't07', 't08', 't09',
  'l01', 'l02', 'l03', 'l04', 'l05', 'l06', 'l07', 'l08', 'l09',
  'h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07', 'h08', 'h09',
  'cw01', 'cw02', 'cw03', 'cw04', 'cw05', 'cw06',
  'cf01', 'cf02', 'cf03', 'cf04', 'cf05', 'cf06',
  'in01', 'in02', 'in03', 'in04',
  'fl01', 'fl02', 'fl03', 'fl04', 'fl05', 'fl06', 'fl07', 'fl08',
  's01', 's02', 's03', 's04', 's05', 's06', 's07', 's08', 's09'
];

/* 当前校验目标：让每条 FAIL 都写清「哪个文件、哪个键」，便于负向测试与 Lead 定位。 */
var CUR_FILE = '';

function fail(msg) {
  console.error('[build-data] 校验失败' + (CUR_FILE ? '（' + CUR_FILE + '）' : '') + '：' + msg);
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
var personasDoc = readJson('personas.json');
var achievementsDoc = readJson('achievements.json');

if (!itemsDoc || !Array.isArray(itemsDoc.items)) fail('items.json 顶层需要 { source, items: [...] }');
var itemList = itemsDoc.items;

function itemsById(id) {
  for (var i = 0; i < itemList.length; i++) if (itemList[i].id === id) return itemList[i];
  return null;
}

/* ------------------------------------------------------- 校验 1：物品表逐项一致 */
CUR_FILE = 'data/items.json';
/* 工作流 B（契约 §4 B2/B6）：物品表由 9 件扩到 12 件，数量校验改为「下限 + 与冻结顺序一致」，
   前 9 件仍逐位比对 EXPECT_ORDER / EXPECT_ITEMS / KIND_BY_ID 三道硬编码防线。 */
if (itemList.length < MIN_ITEMS) {
  fail('物品数量至少应为 ' + MIN_ITEMS + ' 件（契约 §4 B2：9 件 + 大奖/危险/陷阱各 1 件），实际 ' + itemList.length);
}
if (itemList.length !== EXPECT_ORDER.length) {
  fail('物品数量应为 ' + EXPECT_ORDER.length + ' 件（EXPECT_ORDER 已冻结顺序），实际 ' + itemList.length);
}
var required = ['id', 'name', 'coins', 'patience', 'suspicion', 'weight', 'minRound', 'kind', 'desc', 'icon'];
var seen = {};
itemList.forEach(function (it, idx) {
  required.forEach(function (k) {
    if (it[k] == null) fail('物品 #' + idx + ' 缺字段 ' + k);
  });
  if (it.id !== EXPECT_ORDER[idx]) fail('物品顺序/ id 不符：第 ' + (idx + 1) + ' 项应为 ' + EXPECT_ORDER[idx] + '，实际 ' + it.id);
  if (seen[it.id]) fail('物品 id 重复：' + it.id);
  if (ITEM_ALIASES[it.id]) fail(it.id + ' 与兼容别名冲突（见 ITEM_ALIASES）');
  seen[it.id] = true;
  if (KIND_VALUES.indexOf(it.kind) < 0) fail(it.id + '.kind 非法：' + it.kind);
  if (KIND_BY_ID[it.id] && it.kind !== KIND_BY_ID[it.id]) {
    fail(it.id + '.kind 应为 ' + KIND_BY_ID[it.id] + '（引擎 hostPick 依赖），实际 ' + it.kind);
  }
  if (!String(it.name).length) fail(it.id + '.name 不能为空');
  /* 契约 §4 B2：desc 必须写清数值效果且整表 ≤ ITEM_DESC_MAX 字（原先只查 empty/small_prize）。 */
  if (!String(it.desc).length) fail(it.id + '.desc 不能为空');
  if (String(it.desc).length > ITEM_DESC_MAX) {
    fail(it.id + '.desc 超过 ' + ITEM_DESC_MAX + ' 字：实际 ' + String(it.desc).length + ' 字（' + String(it.desc) + '）');
  }
  if (it.special != null && SPECIAL_VALUES.indexOf(it.special) < 0) {
    fail(it.id + '.special 非法：' + it.special + '（只认 ' + SPECIAL_VALUES.join(' / ') + '，见 js/effects.js）');
  }
  var exp = EXPECT_ITEMS[it.id];
  if (exp) {
    ['coins', 'patience', 'suspicion'].forEach(function (k) {
      if (Number(it[k]) !== exp[k]) {
        fail(it.id + '.' + k + ' 应为 ' + exp[k] + '（阶段 2 物品表），实际 ' + it[k]);
      }
    });
  }
  if (!(Number(it.weight) > 0)) fail(it.id + '.weight 必须是正数');
  if (!(Number(it.minRound) >= 1)) fail(it.id + '.minRound 必须 ≥ 1');
  if (it.lateWeight != null && !(Number(it.lateWeight) > 0)) fail(it.id + '.lateWeight 必须是正数');
});
/* 危险类物品第 1 轮不得出现：js/data.js 的 poolForRound 只按 config.pool.noBombRounds 排除 id 为
   bomb 的物品，所以新增危险类必须自带 minRound ≥ 2（landmine 即因此设 2）。 */
['bomb', 'landmine'].forEach(function (hid) {
  var hit = itemsById(hid);
  if (hit && Number(hit.minRound) < 2) fail(hid + '.minRound 必须 ≥ 2（第 1 轮不放危险类物品）');
});
/* 契约 §2.2：空门 / 小奖各 +1 怀疑值，desc 必须写清且保持 ≤22 字。 */
SUSPICION_DESC_IDS.forEach(function (id) {
  var it = itemsById(id);
  if (String(it.desc).indexOf('怀疑值') < 0) fail(it.id + '.desc 要说清「怀疑值 +1」（契约 §2.2）');
  if (String(it.desc).length > ITEM_DESC_MAX) fail(it.id + '.desc 超过 ' + ITEM_DESC_MAX + ' 字：' + String(it.desc).length + ' 字');
});

/* --------------------------------------- 校验 1b：旁白人格（契约 v4 §3.1，恰 3 条） */
if (!personasDoc || !Array.isArray(personasDoc.personas)) fail('personas.json 顶层需要 { source, personas: [...] }');
var personaList = personasDoc.personas;
if (personaList.length !== EXPECT_PERSONAS.length) {
  fail('人格数量应正好 ' + EXPECT_PERSONAS.length + ' 条，实际 ' + personaList.length);
}
personaList.forEach(function (p, i) {
  var exp = EXPECT_PERSONAS[i];
  if (!p || typeof p !== 'object') fail('人格 #' + (i + 1) + ' 不是对象');
  if (p.id !== exp.id) fail('人格顺序/ id 不符：第 ' + (i + 1) + ' 项应为 ' + exp.id + '，实际 ' + p.id);
  if (p.name !== exp.name) fail(p.id + '.name 应为 ' + exp.name + '，实际 ' + p.name);
  if (p.icon !== exp.icon) fail(p.id + '.icon 应为 ' + exp.icon + '，实际 ' + p.icon);
  if (!p.desc) fail(p.id + ' 缺 desc（≤' + PERSONA_DESC_MAX + ' 字）');
  if (String(p.desc).length > PERSONA_DESC_MAX) fail(p.id + '.desc 超过 ' + PERSONA_DESC_MAX + ' 字：' + String(p.desc).length + ' 字');
  if (Number(p.lieRateDelta) !== exp.lieRateDelta) fail(p.id + '.lieRateDelta 应为 ' + exp.lieRateDelta + '，实际 ' + p.lieRateDelta);
  if (Math.abs(Number(p.lieRateDelta)) > EXPECT_LIE_RATE_DELTA_CAP) {
    fail(p.id + '.lieRateDelta 超过 config.personalities.lieRateDeltaCap=' + EXPECT_LIE_RATE_DELTA_CAP);
  }
});

/* ------------------------------------- 校验 1c：成就表（契约 v4 §3.2，恰 10 条） */
if (!achievementsDoc || !Array.isArray(achievementsDoc.achievements)) {
  fail('achievements.json 顶层需要 { source, achievements: [...] }');
}
var achievementList = achievementsDoc.achievements;
if (achievementList.length !== EXPECT_ACHIEVEMENTS.length) {
  fail('成就数量应正好 ' + EXPECT_ACHIEVEMENTS.length + ' 条，实际 ' + achievementList.length);
}
var seenAch = {};
achievementList.forEach(function (a, i) {
  var exp = EXPECT_ACHIEVEMENTS[i];
  if (!a || typeof a !== 'object') fail('成就 #' + (i + 1) + ' 不是对象');
  if (a.id !== exp.id) fail('成就顺序/ id 不符：第 ' + (i + 1) + ' 项应为 ' + exp.id + '，实际 ' + a.id);
  if (seenAch[a.id]) fail('成就 id 重复：' + a.id);
  seenAch[a.id] = true;
  if (a.name !== exp.name) fail(a.id + '.name 应为 ' + exp.name + '，实际 ' + a.name);
  if (a.icon !== exp.icon) fail(a.id + '.icon 应为 ' + exp.icon + '，实际 ' + a.icon);
  if (!a.desc) fail(a.id + ' 缺 desc（≤' + ACHIEVEMENT_DESC_MAX + ' 字）');
  if (String(a.desc).length > ACHIEVEMENT_DESC_MAX) {
    fail(a.id + '.desc 超过 ' + ACHIEVEMENT_DESC_MAX + ' 字：' + String(a.desc).length + ' 字');
  }
  var chk = a.check;
  if (!chk || typeof chk !== 'object') fail(a.id + ' 缺 check { type, threshold }');
  if (ACHIEVEMENT_TYPES.indexOf(chk.type) < 0) fail(a.id + '.check.type 不在白名单：' + chk.type);
  if (!(Number(chk.threshold) > 0)) fail(a.id + '.check.threshold 必须 > 0，实际 ' + chk.threshold);
  if (Math.round(Number(chk.threshold)) !== Number(chk.threshold)) fail(a.id + '.check.threshold 必须是整数');
});

/* --------------------------------------------------- 校验 2：config 关键字段存在 */
CUR_FILE = 'data/config.json';
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
/* 契约 v3 §2.1/§2.2：怀疑值资源上限 3；连击奖励 = winCoins + min(streak-1,2)*step。 */
if (Number(sus.max) !== EXPECT_SUSPICION_MAX) {
  fail('suspicion.max 应为 ' + EXPECT_SUSPICION_MAX + '（契约 §2.2 怀疑值资源上限），实际 ' + sus.max);
}
if (Number(sus.comboStep) !== EXPECT_COMBO.step || Number(sus.comboCap) !== EXPECT_COMBO.cap) {
  fail('suspicion.comboStep/comboCap 应为 ' + EXPECT_COMBO.step + '/' + EXPECT_COMBO.cap + '（契约 §2.1 连击 20/30/40），实际 ' +
    sus.comboStep + '/' + sus.comboCap);
}
var timings = need('timings', config.timings);
var EXPECT_TIMINGS = { introMs: 800, narratorMs: 2000, hostOpenMs: 600, revealMs: 900, revealDoubledExtraMs: 400, resetMs: 1000 };
Object.keys(EXPECT_TIMINGS).forEach(function (k) {
  if (Number(timings[k]) !== EXPECT_TIMINGS[k]) fail('timings.' + k + ' 应为 ' + EXPECT_TIMINGS[k] + '，实际 ' + timings[k]);
});
var poolCfg = need('pool', config.pool);
if (!Array.isArray(poolCfg.noBombRounds) || poolCfg.noBombRounds.indexOf(1) < 0) fail('pool.noBombRounds 必须包含 1（第 1 轮不放炸弹）');
if (Number(poolCfg.boostRound) !== 4) fail('pool.boostRound 应为 4（第 4 轮起提高炸弹/陷阱权重）');

/* 契约 v5 §2.1/§2.2：门数 3–6，权重表的键必须都落在 min–max 内且非负。 */
var doorCfg = need('doorCount', config.doorCount);
if (Number(doorCfg.min) < 3 || Number(doorCfg.max) > 6) {
  fail('doorCount.min/max 必须落在 3–6 之间（引擎 clampDoorCount 只认这个区间），实际 ' +
    doorCfg.min + '–' + doorCfg.max);
}
if (!(Number(doorCfg.min) <= Number(doorCfg.max))) {
  fail('doorCount.min 不能大于 doorCount.max，实际 ' + doorCfg.min + '–' + doorCfg.max);
}
if (!doorCfg.weights || typeof doorCfg.weights !== 'object' || Array.isArray(doorCfg.weights)) {
  fail('doorCount.weights 必须是 { "3": 权重, ... } 形式的对象');
}
var doorKeys = Object.keys(doorCfg.weights);
if (!doorKeys.length) fail('doorCount.weights 不能为空');
var doorWeightSum = 0;
doorKeys.forEach(function (k) {
  var n = Number(k);
  if (!(n >= Number(doorCfg.min) && n <= Number(doorCfg.max))) {
    fail('doorCount.weights 的键 ' + k + ' 必须落在 ' + doorCfg.min + '–' + doorCfg.max + ' 之间');
  }
  var w = Number(doorCfg.weights[k]);
  if (!(w >= 0)) fail('doorCount.weights.' + k + ' 必须是非负数，实际 ' + doorCfg.weights[k]);
  doorWeightSum += w;
});
if (!(doorWeightSum > 0)) fail('doorCount.weights 权重之和必须为正数（否则永远抽不出门数）');
[3, 4, 5, 6].forEach(function (n) {
  if (doorCfg.weights[n] == null && doorCfg.weights[String(n)] == null) {
    fail('doorCount.weights 缺 ' + n + ' 门权重（契约 §2.2 要求 3–6 全覆盖）');
  }
});

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

/* 契约 v4 §3.4：人格默认值、撒谎率增量上限、成就存档键。 */
var persCfg = need('personalities', config.personalities);
if (PERSONA_IDS.indexOf(persCfg.default) < 0) {
  fail('config.personalities.default 必须是 ' + PERSONA_IDS.join(' | ') + '，实际 ' + persCfg.default);
}
if (Number(persCfg.lieRateDeltaCap) !== EXPECT_LIE_RATE_DELTA_CAP) {
  fail('config.personalities.lieRateDeltaCap 应为 ' + EXPECT_LIE_RATE_DELTA_CAP + '，实际 ' + persCfg.lieRateDeltaCap);
}
var achCfg = need('achievements', config.achievements);
if (achCfg.storageKey !== EXPECT_ACHIEVEMENTS_STORAGE_KEY) {
  fail('config.achievements.storageKey 应为 ' + EXPECT_ACHIEVEMENTS_STORAGE_KEY + '，实际 ' + achCfg.storageKey);
}

/* ------------------------- 校验 2a：结局表 config.endings（契约 v3 §4.1） */
var endingsCfg = need('endings', config.endings);
if (typeof endingsCfg !== 'object' || Array.isArray(endingsCfg)) {
  fail('config.endings 必须是对象 {id: {priority,title,desc,lineKind}}（契约 §4.1）');
}
var endingIds = Object.keys(endingsCfg);
if (endingIds.length !== EXPECT_ENDINGS.length) {
  fail('config.endings 应正好 ' + EXPECT_ENDINGS.length + ' 项，实际 ' + endingIds.length + '：' + endingIds.join('/'));
}
EXPECT_ENDINGS.forEach(function (exp) {
  var e = endingsCfg[exp.id];
  if (!e) fail('config.endings 缺 ' + exp.id);
  if (Number(e.priority) !== exp.priority) fail('config.endings.' + exp.id + '.priority 应为 ' + exp.priority + '，实际 ' + e.priority);
  if (e.title !== exp.title) fail('config.endings.' + exp.id + '.title 应为 ' + exp.title + '，实际 ' + e.title);
  if (e.lineKind !== exp.lineKind) fail('config.endings.' + exp.id + '.lineKind 应为 ' + exp.lineKind + '，实际 ' + e.lineKind);
  if (!e.desc) fail('config.endings.' + exp.id + ' 缺 desc');
  if (String(e.desc).length > ENDING_DESC_MAX) {
    fail('config.endings.' + exp.id + '.desc 超过 ' + ENDING_DESC_MAX + ' 字：' + String(e.desc).length + ' 字');
  }
});
/* priority 必须唯一，computeEndingId 才能按优先级排序取第一个命中。 */
var seenPriority = {};
EXPECT_ENDINGS.forEach(function (exp) {
  if (seenPriority[exp.priority]) fail('config.endings 优先级重复：' + exp.priority);
  seenPriority[exp.priority] = true;
});

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
/* F3：语料总量 60+ 条（endings 单独存放，不计入 lines）。 */
if (lines.length < NARRATOR_TOTAL_MIN) {
  fail('旁白 lines 至少 ' + NARRATOR_TOTAL_MIN + ' 条（F3 语料扩容），实际 ' + lines.length);
}
/* 契约 v4 §3.3「只增不改」：60 条既有台词必须原样保留且顺序不变（新增只能追加到末尾）。 */
LEGACY_LINE_IDS.forEach(function (id, i) {
  if (!lines[i] || lines[i].id !== id) {
    fail('既有 60 条旁白被改动 / 删除 / 重排：第 ' + (i + 1) + ' 条应为 ' + id +
      '，实际 ' + (lines[i] ? lines[i].id : '（不存在）'));
  }
});
var triggers = lines.filter(function (l) { return l.kind === 'special'; }).map(function (l) { return l.trigger; });
SPECIAL_TRIGGERS.forEach(function (t) {
  if (triggers.indexOf(t) < 0) fail('缺少彩蛋旁白 trigger=' + t);
});
lines.forEach(function (l) {
  if (l.kind === 'special' && SPECIAL_TRIGGERS.indexOf(l.trigger) < 0) fail('彩蛋 ' + l.id + ' 的 trigger 非法：' + l.trigger);
});

/* --------- 校验 3b：claimable 线索（契约 v3 §1.1 六条硬约束的静态可查部分） */
var claimableCount = 0;
var claimByType = {};
var claimKinds = [];
lines.forEach(function (l) {
  if (l.claimable !== true) {
    if (l.claimType) fail('旁白 ' + l.id + ' 有 claimType 却没标 claimable');
    return;
  }
  claimableCount++;
  if (CLAIM_TYPES.indexOf(l.claimType) < 0) fail('旁白 ' + l.id + ' 的 claimType 非法：' + l.claimType);
  if (l.kind !== 'truth' && l.kind !== 'lie' && l.kind !== 'lie_hard') {
    fail('旁白 ' + l.id + ' 是 ' + l.kind + '，只有 truth/lie/lie_hard 能挂线索');
  }
  var rule = CLAIM_TEXT_RULES[l.claimType];
  if (rule && !rule.re.test(String(l.text))) fail('旁白 ' + l.id + '（' + l.claimType + '）文案' + rule.label + '：' + l.text);
  claimByType[l.claimType] = (claimByType[l.claimType] || 0) + 1;
  if (claimKinds.indexOf(l.kind) < 0) claimKinds.push(l.kind);
});
CLAIM_TYPES.forEach(function (t) {
  if ((claimByType[t] || 0) < CLAIM_TYPE_MIN) {
    fail('claimType『' + t + '』至少 ' + CLAIM_TYPE_MIN + ' 条 claimable 旁白，实际 ' + (claimByType[t] || 0));
  }
});
['truth', 'lie', 'lie_hard'].forEach(function (k) {
  if (claimKinds.indexOf(k) < 0) fail('claimable 旁白必须覆盖 ' + k + ' 三种 kind 之一缺失');
});

/* --------- 校验 3c：结局赛后点评 narrator.endings（契约 v3 §4.1） */
var endingLines = narratorDoc.endings;
if (!endingLines || typeof endingLines !== 'object' || Array.isArray(endingLines)) {
  fail('narrator.json 需要 { endings: { [lineKind]: [line, ...] } }');
}
var endingLineTotal = 0;
var endingLineIds = {};
EXPECT_ENDINGS.forEach(function (exp) {
  var elist = endingLines[exp.lineKind];
  if (!Array.isArray(elist) || elist.length < ENDING_LINE_MIN) {
    fail('narrator.endings.' + exp.lineKind + ' 至少 ' + ENDING_LINE_MIN + ' 条（config.endings.' + exp.id + ' 的赛后点评）');
  }
  elist.forEach(function (l, i) {
    if (!l || !l.id || !l.text) fail('narrator.endings.' + exp.lineKind + '#' + i + ' 缺 id/text');
    if (endingLineIds[l.id]) fail('结局旁白 id 重复：' + l.id);
    endingLineIds[l.id] = true;
    if (l.kind !== 'ending') fail('结局旁白 ' + l.id + ' 的 kind 应为 ending，实际 ' + l.kind);
    if (String(l.text).length > maxChars) fail('结局旁白 ' + l.id + ' 超过 ' + maxChars + ' 字：' + String(l.text).length + ' 字');
    endingLineTotal++;
  });
});
Object.keys(endingLines).forEach(function (k) {
  var known = EXPECT_ENDINGS.some(function (exp) { return exp.lineKind === k; });
  if (!known) fail('narrator.endings 出现未知 lineKind：' + k);
});

/* --------- 校验 3d：结算点评池 narrator.settle（契约 v4 §3.3，≥12 条、按 result 分桶） */
var settle = narratorDoc.settle;
if (!Array.isArray(settle) || settle.length < SETTLE_MIN) {
  fail('narrator.settle 至少 ' + SETTLE_MIN + ' 条结算点评，实际 ' + (Array.isArray(settle) ? settle.length : '（缺失）'));
}
var settleIds = {};
var settleByResult = {};
settle.forEach(function (l, i) {
  if (!l || typeof l !== 'object') fail('narrator.settle#' + i + ' 不是对象');
  if (!l.id || !l.text) fail('narrator.settle#' + i + ' 缺 id/text');
  if (settleIds[l.id]) fail('结算点评 id 重复：' + l.id);
  settleIds[l.id] = true;
  if (l.kind !== 'settle') fail('结算点评 ' + l.id + ' 的 kind 应为 settle，实际 ' + l.kind);
  if (String(l.text).length > maxChars) fail('结算点评 ' + l.id + ' 超过 ' + maxChars + ' 字：' + String(l.text).length + ' 字');
  if (SETTLE_RESULTS.indexOf(l.result) < 0) fail('结算点评 ' + l.id + ' 的 result 非法：' + l.result);
  settleByResult[l.result] = (settleByResult[l.result] || 0) + 1;
});
SETTLE_RESULTS.forEach(function (r) {
  if ((settleByResult[r] || 0) < SETTLE_RESULT_MIN) {
    fail('结算点评 result『' + r + '』至少 ' + SETTLE_RESULT_MIN + ' 条，实际 ' + (settleByResult[r] || 0));
  }
});

/* --------- 校验 3e：人格子池 narrator.personas（契约 v4 §3.3 / §3.6） */
var personaPools = narratorDoc.personas;
if (!personaPools || typeof personaPools !== 'object' || Array.isArray(personaPools)) {
  fail('narrator.json 需要 { personas: { [personaId]: { intro: [], flavor: [], settle: [] } } }');
}
var poolKeys = Object.keys(personaPools);
if (poolKeys.length !== PERSONA_IDS.length) {
  fail('narrator.personas 应覆盖 ' + PERSONA_IDS.length + ' 种人格，实际 ' + poolKeys.length + '：' + poolKeys.join('/'));
}
PERSONA_IDS.forEach(function (pid) {
  var pool = personaPools[pid];
  if (!pool || typeof pool !== 'object') fail('narrator.personas 缺人格 ' + pid);
  PERSONA_POOL_KEYS.forEach(function (key) {
    var list = pool[key];
    if (!Array.isArray(list) || list.length < PERSONA_POOL_MIN) {
      fail('narrator.personas.' + pid + '.' + key + ' 至少 ' + PERSONA_POOL_MIN + ' 条');
    }
    list.forEach(function (id) {
      if (key === 'settle') {
        if (!settleIds[id]) fail('narrator.personas.' + pid + '.settle 引用了不存在的结算点评 id：' + id);
        return;
      }
      var def = byId[id];
      if (!def) fail('narrator.personas.' + pid + '.' + key + ' 引用了不存在的旁白 id：' + id);
      if (def.kind !== key) fail('narrator.personas.' + pid + '.' + key + ' 的 ' + id + ' kind 应为 ' + key + '，实际 ' + def.kind);
    });
  });
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
  narratorCount: lines.length,
  claimableCount: claimableCount,
  endingLineCount: endingLineTotal,
  endingCount: EXPECT_ENDINGS.length,
  personaCount: personaList.length,
  achievementCount: achievementList.length,
  settleCount: settle.length
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
out.push('  /* 旁白人格（契约 v4 §3.1）：lieRateDelta 叠加在撒谎率上，最终仍夹在 [base, cap]。 */');
out.push('  var personas = ' + stableStringify(personaList).split('\n').join('\n  ') + ';');
out.push('');
out.push('  /** 按 id 取人格定义，未知 id 返回 null（引擎 / ui 渲染共用）。 */');
out.push('  function personasById(id) {');
out.push('    for (var i = 0; i < personas.length; i++) if (personas[i].id === id) return personas[i];');
out.push('    return null;');
out.push('  }');
out.push('');
out.push('  /* 成就表（契约 v4 §3.2）：恰 10 条，check.type 白名单与阈值由构建期校验。 */');
out.push('  var achievements = ' + stableStringify(achievementList).split('\n').join('\n  ') + ';');
out.push('');
out.push('  /** 按 id 取成就定义，未知 id 返回 null（引擎判定 / ui 成就墙共用）。 */');
out.push('  function achievementsById(id) {');
out.push('    for (var i = 0; i < achievements.length; i++) if (achievements[i].id === id) return achievements[i];');
out.push('    return null;');
out.push('  }');
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
out.push('    personas: personas,');
out.push('    personasById: personasById,');
out.push('    achievements: achievements,');
out.push('    achievementsById: achievementsById,');
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
CUR_FILE = 'js/data.js（生成产物）';
var sandbox = {};
try {
  vm.runInNewContext(code, sandbox, { filename: 'js/data.js' });
} catch (e) {
  fail('生成产物无法执行：' + e.stack);
}
var GameData = sandbox.GameData;
if (!GameData) fail('产物没有挂上 globalThis.GameData');
if (GameData.itemList.length !== EXPECT_ORDER.length) fail('GameData.itemList 应为 ' + EXPECT_ORDER.length + ' 项');
if (GameData.itemList.length < MIN_ITEMS) fail('GameData.itemList 至少应为 ' + MIN_ITEMS + ' 项（契约 §4 B2）');
if (Object.keys(GameData.items).length !== EXPECT_ORDER.length + aliasCount) {
  fail('GameData.items 应为 ' + EXPECT_ORDER.length + ' 种主条目 + ' + aliasCount + ' 个别名，实际 ' + Object.keys(GameData.items).length);
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

/* 工作流 B：新增 3 件物品必须真进产物与门池，且各自遵守 minRound / kind / lateWeight。 */
['jackpot', 'landmine', 'quicksand'].forEach(function (nid) {
  var ni = GameData.items[nid];
  if (!ni) fail('新增物品 ' + nid + ' 未进入产物 items');
  if (ni.kind !== KIND_BY_ID[nid]) fail(nid + '.kind 产物里是 ' + ni.kind + '，应为 ' + KIND_BY_ID[nid]);
  if (!(Number(ni.weight) > 0)) fail(nid + '.weight 产物里不是正数');
  if (!(Number(ni.minRound) >= 1)) fail(nid + '.minRound 产物里不是 ≥ 1');
});
var r1Ids = GameData.poolForRound(1).map(function (e) { return e.id; });
['bomb', 'landmine', 'quicksand'].forEach(function (hid) {
  if (r1Ids.indexOf(hid) >= 0) fail('第 1 轮门池不应出现危险类物品 ' + hid + '（minRound ≥ 2）');
});
if (wOf(r2, 'jackpot') > 0) fail('第 2 轮门池不应出现 jackpot（minRound=3）');
if (wOf(GameData.poolForRound(3), 'jackpot') <= 0) fail('第 3 轮门池应包含 jackpot（minRound=3）');
if (wOf(r2, 'landmine') <= 0) fail('第 2 轮门池应包含 landmine（minRound=2）');
if (wOf(r2, 'quicksand') <= 0) fail('第 2 轮门池应包含 quicksand（minRound=2）');
if (wOf(r4, 'landmine') <= wOf(r2, 'landmine')) fail('第 4 轮 landmine 权重未提高：' + wOf(r2, 'landmine') + ' -> ' + wOf(r4, 'landmine'));
if (wOf(r4, 'quicksand') <= wOf(r2, 'quicksand')) fail('第 4 轮 quicksand 权重未提高：' + wOf(r2, 'quicksand') + ' -> ' + wOf(r4, 'quicksand'));
if (GameData.poolForRound(4).length !== GameData.poolForRound(3).length) fail('第 4 轮只应改权重，不应改门池条目数（第 3 轮起物品已全量入池）');
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
/* 契约 v5 §2.1：门数配置必须真进产物，引擎 doorCountFor 才抽得到 4–6 门。 */
if (!GameData.config.doorCount || !GameData.config.doorCount.weights) fail('GameData.config.doorCount 未进入产物');
if (Number(GameData.config.doorCount.min) !== Number(doorCfg.min) || Number(GameData.config.doorCount.max) !== Number(doorCfg.max)) {
  fail('产物里的 doorCount.min/max 与 config.json 源不一致');
}
if (Number(GameData.config.doorCount.weights['4']) !== Number(doorCfg.weights['4'])) {
  fail('产物里的 doorCount.weights.4 与 config.json 源不一致');
}
/* 契约 §4 B4：第 5/6 轮门数提示必须进产物且非空（不剧透真话/撒谎）。 */
[5, 6].forEach(function (r) {
  var h = GameData.config.roundHints && (GameData.config.roundHints[r] || GameData.config.roundHints[String(r)]);
  if (!h) fail('产物里的 roundHints 缺第 ' + r + ' 轮提示');
});
/* 商店数据不得混进物品池：itemList 仍必须与 EXPECT_ORDER 等长、items 仍必须 12 主条目 + 别名。 */
if (GameData.items.fuse || GameData.items.patience_charm) fail('商店独占商品 fuse / patience_charm 不得进入物品池 items');
if (GameData.itemList.length !== EXPECT_ORDER.length) fail('商店改动不得影响物品池数量（itemList 应仍为 ' + EXPECT_ORDER.length + '）');

/* 契约 v3：怀疑值上限 / 空门小奖怀疑值 / 结局表 / 线索语料都必须真进了产物。 */
if (GameData.config.suspicion.max !== 3) fail('GameData.config.suspicion.max 应为 3');
if (GameData.config.suspicion.comboStep !== 10 || GameData.config.suspicion.comboCap !== 20) {
  fail('GameData.config.suspicion.comboStep/comboCap 应为 10/20');
}
if (GameData.items.empty.suspicion !== 1 || GameData.items.small_prize.suspicion !== 1) {
  fail('空门 / 小奖的 suspicion 应为 1（契约 §2.2）');
}
if (!GameData.config.endings || Object.keys(GameData.config.endings).length !== EXPECT_ENDINGS.length) {
  fail('GameData.config.endings 应含 ' + EXPECT_ENDINGS.length + ' 个结局');
}
if (GameData.config.endings.normal.priority !== 0 || GameData.config.endings.all_in.priority !== 100) {
  fail('config.endings 优先级应 normal=0 / all_in=100');
}
if (GameData.config.endings.all_in.lineKind !== 'ending_all_in') fail('config.endings.all_in.lineKind 应为 ending_all_in');
EXPECT_ENDINGS.forEach(function (exp) {
  var elist = (GameData.narrator.endings || {})[exp.lineKind];
  if (!Array.isArray(elist) || elist.length < ENDING_LINE_MIN) {
    fail('产物里 narrator.endings.' + exp.lineKind + ' 至少 ' + ENDING_LINE_MIN + ' 条');
  }
  elist.forEach(function (l) {
    if (l.kind !== 'ending' || !l.text || l.text.length > maxChars) fail('结局旁白 ' + l.id + ' 不合法');
  });
});
if (GameData.narrator.lines.length < NARRATOR_TOTAL_MIN) fail('产物里旁白 lines 应 ≥ ' + NARRATOR_TOTAL_MIN + ' 条');
var claimableInOut = GameData.narrator.lines.filter(function (l) { return l.claimable === true; });
if (claimableInOut.length < CLAIM_TYPES.length * CLAIM_TYPE_MIN) {
  fail('产物里 claimable 旁白应 ≥ ' + (CLAIM_TYPES.length * CLAIM_TYPE_MIN) + ' 条，实际 ' + claimableInOut.length);
}
CLAIM_TYPES.forEach(function (t) {
  var n = claimableInOut.filter(function (l) { return l.claimType === t; }).length;
  if (n < CLAIM_TYPE_MIN) fail('产物里 claimType『' + t + '』应 ≥ ' + CLAIM_TYPE_MIN + ' 条，实际 ' + n);
});

/* 契约 v4 §3：人格 / 成就 / 结算点评 / 人格子池都必须真进了产物。 */
if (!Array.isArray(GameData.personas) || GameData.personas.length !== EXPECT_PERSONAS.length) {
  fail('GameData.personas 应为 ' + EXPECT_PERSONAS.length + ' 条');
}
EXPECT_PERSONAS.forEach(function (exp) {
  var p = GameData.personasById(exp.id);
  if (!p) fail('personasById(' + exp.id + ') 取不到人格');
  if (p.name !== exp.name || Number(p.lieRateDelta) !== exp.lieRateDelta) fail('产物里 ' + exp.id + ' 的名称 / 撒谎率增量不对');
  if (!p.icon || !p.desc) fail('产物里 ' + exp.id + ' 缺 icon/desc');
});
if (GameData.personasById('nope') !== null) fail('personasById 未知 id 应返回 null');
if (GameData.config.personalities.default !== EXPECT_PERSONALITY_DEFAULT) {
  fail('config.personalities.default 应为 ' + EXPECT_PERSONALITY_DEFAULT);
}
if (Number(GameData.config.personalities.lieRateDeltaCap) !== EXPECT_LIE_RATE_DELTA_CAP) {
  fail('config.personalities.lieRateDeltaCap 应为 ' + EXPECT_LIE_RATE_DELTA_CAP);
}
if (GameData.config.achievements.storageKey !== EXPECT_ACHIEVEMENTS_STORAGE_KEY) {
  fail('config.achievements.storageKey 应为 ' + EXPECT_ACHIEVEMENTS_STORAGE_KEY);
}
if (!Array.isArray(GameData.achievements) || GameData.achievements.length !== EXPECT_ACHIEVEMENTS.length) {
  fail('GameData.achievements 应为 ' + EXPECT_ACHIEVEMENTS.length + ' 条');
}
EXPECT_ACHIEVEMENTS.forEach(function (exp) {
  var a = GameData.achievementsById(exp.id);
  if (!a) fail('achievementsById(' + exp.id + ') 取不到成就');
  if (!a.check || a.check.type !== exp.type || Number(a.check.threshold) !== exp.threshold) {
    fail('产物里 ' + exp.id + ' 的 check 应为 ' + exp.type + '/' + exp.threshold);
  }
  if (!a.name || !a.icon || !a.desc) fail('产物里 ' + exp.id + ' 缺 name/icon/desc');
});
if (GameData.achievementsById('nope') !== null) fail('achievementsById 未知 id 应返回 null');
ACHIEVEMENT_TYPES.forEach(function (t) {
  var n = GameData.achievements.filter(function (a) { return a.check.type === t; }).length;
  if (n !== 1) fail('成就 check.type『' + t + '』应恰好 1 条，实际 ' + n);
});
var settleOut = GameData.narrator.settle;
if (!Array.isArray(settleOut) || settleOut.length < SETTLE_MIN) {
  fail('产物里 narrator.settle 应 ≥ ' + SETTLE_MIN + ' 条');
}
settleOut.forEach(function (l) {
  if (l.kind !== 'settle' || !l.text || l.text.length > maxChars) fail('产物里结算点评 ' + l.id + ' 不合法');
  if (SETTLE_RESULTS.indexOf(l.result) < 0) fail('产物里结算点评 ' + l.id + ' 的 result 非法：' + l.result);
});
SETTLE_RESULTS.forEach(function (r) {
  var n = settleOut.filter(function (l) { return l.result === r; }).length;
  if (n < SETTLE_RESULT_MIN) fail('产物里结算点评 result『' + r + '』应 ≥ ' + SETTLE_RESULT_MIN + ' 条，实际 ' + n);
});
PERSONA_IDS.forEach(function (pid) {
  var pool = (GameData.narrator.personas || {})[pid];
  if (!pool) fail('产物里 narrator.personas 缺人格 ' + pid);
  PERSONA_POOL_KEYS.forEach(function (key) {
    if (!Array.isArray(pool[key]) || !pool[key].length) fail('产物里 narrator.personas.' + pid + '.' + key + ' 为空');
  });
});
/* 只增不改：产物里前 60 条仍是契约 v3 冻结的台词。 */
LEGACY_LINE_IDS.forEach(function (id, i) {
  if (!GameData.narrator.lines[i] || GameData.narrator.lines[i].id !== id) {
    fail('产物里第 ' + (i + 1) + ' 条旁白应为 ' + id);
  }
});

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
  + lines.length + ' 条旁白（' + claimableCount + ' 条带线索） + ' + endingLineTotal + ' 条结局点评 / '
  + EXPECT_ENDINGS.length + ' 种结局 / ' + personaList.length + ' 种人格 / ' + settle.length + ' 条结算点评 / '
  + achievementList.length + ' 个成就 / 演示剧本 ' + seedDemo.rounds.length + ' 轮');
console.log('[build-data] 来源：' + GENERATED_FROM.join('、'));

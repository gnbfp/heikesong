/* ============================================================================
 * tests/ux.js —— 契约 v4「体验增强」验收
 *                 （成就 / 统计 / 种子重放 / 键盘 / 人格 / 新手指引 / 竖屏）
 * ----------------------------------------------------------------------------
 * 覆盖 docs/设计契约_体验增强.md（v4 冻结版）：
 *   X0  静态与装载：§4.1/§4.4/§4.7/§4.8 的 DOM 节点、脚本顺序不变、零外链
 *   X1  成就（§2.2/§3.2/§4.5）：恰 10 条、check 白名单、阈值边界 ±1、
 *       跨局存档合并、解锁落盘、解锁提示、清空后回锁
 *   X2  统计（§2.2/§3.1）：games/totalCoins/bestCoins/bestRound/challenges/
 *       challengeWins/challengeRate/endings，累计与 best 只增不减
 *   X3  种子重放（§3.3）：seedTag/seedUrl/?seed= 注入与优先级、同种子可复现
 *   X4  键盘（§4.2）：1/2/3 选门、q/d/s/c、空格、m、?/h、Esc
 *   X5  人格（§3.1/§4.3）：setPersonality 生效与落盘、非法值忽略、
 *       Narrator.lieRate 叠加 lieRateDelta 并被 cap 夹住、prefs 白名单
 *   X6  新手指引（§4.1）：tutorialSteps 三步、done 后不再出现
 *   X7  竖屏提示（§4.8）：innerHeight<400 显示、恢复隐藏、只首次提示
 *   X8  汇总：本次断言条数
 * 真实命令：node tests/ux.js   （退出码 0 = 全绿，1 = 有 FAIL，2 = 运行时异常）
 * 说明：与 tests/features.js / tests/shop.js 同风格；由 tests/run-all.js 作为
 *       第 7 个套件注册。task-26（引擎）/task-27（数据）/task-28（ui-render）
 *       未落地时，相关分组由 HAS.* 特性检测记为 SKIP 并在 detail 里点名原因；
 *       落地后这些 SKIP 必须归零（不允许以「未落地」长期挂着）。
 * id 前缀用 X（dom-smoke 已占用 U*，sim 占用 S/G，shop 用 SH，features 用 F）。
 * ========================================================================== */
'use strict';

var fs = require('fs');
var L = require('./lib.js');
var Sh = require('./dom-shim.js');

var ck = new L.Checker('ux.js —— 体验增强（契约 v4）');

var SEED = 20261024;
var FIXED_NOW = 1730000000000;
var nX = 0;

/** 所有断言都过这里，便于末尾统计本次断言条数。 */
function c(id, cond, msg, detail) {
  nX++;
  return ck.ok(id, cond, msg, detail);
}
function sk(id, msg, why) {
  nX++;
  return ck.skip(id, msg, why);
}
function list(a, n) { return (a || []).slice(0, n == null ? 4 : n).join('、'); }

/* ------------------------------------------------------------------ 加载 */

var load = L.loadScripts({ withDom: false });
var G = load.sandbox;

if (!load.loaded.length) {
  c('X0.0', false, 'js/ 下至少要有 state.js / data.js / effects.js / narrator.js / game.js 可加载',
    load.missing.join('\n         '));
  ck.print();
  process.exit(1);
}

var gd = L.loadGameData(load.ctx, load.sandbox);
var GAME_DATA = gd.data || {};
var CFG = GAME_DATA.config || {};

var HAS = {
  achData: !!(GAME_DATA.achievements && GAME_DATA.achievements.length),
  personaData: !!(GAME_DATA.personas && GAME_DATA.personas.length),
  achApi: !!(G.Game && typeof G.Game.achievements === 'function'),
  statsApi: !!(G.Game && typeof G.Game.stats === 'function'),
  checkApi: !!(G.Game && typeof G.Game._checkAchievements === 'function'),
  personaApi: !!(G.Game && typeof G.Game.personality === 'function' && typeof G.Game.setPersonality === 'function'),
  prefsApi: !!(G.Game && typeof G.Game.prefs === 'function' && typeof G.Game.savePref === 'function'),
  seedApi: !!(G.Game && typeof G.Game.seedTag === 'function' && typeof G.Game.seedUrl === 'function'),
  tutApi: !!(G.Game && typeof G.Game.tutorialSteps === 'function'),
  lieRate: !!(G.Narrator && typeof G.Narrator.lieRate === 'function')
};

/* ------------------------------------------------------------------ 工具 */

function untilMs(pred, ms) {
  return new Promise(function (res) {
    var t0 = Date.now();
    (function step() {
      var v = false;
      try { v = !!pred(); } catch (e) { v = false; }
      if (v) return res(true);
      if (Date.now() - t0 > (ms || 5000)) return res(false);
      setTimeout(step, 20);
    })();
  });
}

/** 极简 localStorage 桩（headless 用例用；契约 §2.2 的五个键都写在这里）。 */
function mkLS(seedMap, opts) {
  var m = {};
  if (seedMap) for (var k in seedMap) if (Object.prototype.hasOwnProperty.call(seedMap, k)) m[k] = seedMap[k];
  var o = opts || {};
  var writes = [];
  return {
    _m: m,
    _writes: writes,
    getItem: function (key) {
      if (o.readThrows) throw new Error('SecurityError(read)');
      return Object.prototype.hasOwnProperty.call(m, key) ? m[key] : null;
    },
    setItem: function (key, v) {
      if (o.writeThrows) throw new Error('QuotaExceededError(write)');
      writes.push({ key: key, value: String(v) });
      m[key] = String(v);
    },
    removeItem: function (key) { delete m[key]; },
    key: function (i) { return Object.keys(m)[i] == null ? null : Object.keys(m)[i]; },
    clear: function () { Object.keys(m).forEach(function (k2) { delete m[k2]; }); }
  };
}

var KEYS = {
  codex: 'three_doors_codex_v1',
  best: 'three_doors_best_v1',
  stats: 'three_doors_stats_v1',
  achievements: 'three_doors_achievements_v1',
  prefs: 'three_doors_prefs_v1'
};

/** 建一个全新的 Game 实例（每个用例独立，避免单例互相污染）。 */
function mkGame(mode, seed, over) {
  var ui = L.recordingUI();
  var deps = {
    ui: ui,
    data: GAME_DATA,
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

async function demoToPick(g, tries) {
  g.Game.start('demo');
  return untilMs(function () { return g.Game.state.phase === 'PICK'; }, tries || 4000);
}
async function pickSlot(g, slot) {
  if (!g.Game.action({ type: 'pick', slot: slot })) return false;
  return untilMs(function () { return g.Game.state.phase === 'DECIDE'; }, 4000);
}
async function autoDemoDone(g, ms) {
  var p = g.Game.autoDemo();
  await untilMs(function () { return g.Game.state.phase === 'CASHOUT' || g.Game.state.phase === 'GAME_OVER'; }, ms || 15000);
  try { await p; } catch (e) { /* 由断言兜底 */ }
  return g.Game.state.phase;
}
function jsonOf(x) { return JSON.stringify(x); }

async function main() {

/* ==================================================================== X0 */
ck.section('阶段 v4｜静态与装载（审计：新增 DOM、脚本顺序、零外链）');

var HTML = L.fileExists(L.INDEX) ? L.readText(L.INDEX) : '';
var V4_IDS = ['btn-help', 'btn-settings', 'tutorial', 'tutorial-bubble', 'tutorial-title',
  'tutorial-text', 'tutorial-actions', 'tutorial-skip', 'tutorial-next', 'confetti', 'portrait-hint'];
var missingV4 = V4_IDS.filter(function (id) { return HTML.indexOf('id="' + id + '"') < 0; });

c('X0.1', !!HTML && missingV4.length === 0,
  '契约 §4.1/§4.4/§4.7/§4.8 的工具条/引导/竖屏 DOM 节点写在 index.html',
  '缺失=' + (missingV4.length ? missingV4.join('、') : '无') + '；index.html=' + (HTML ? HTML.length + ' 字符' : '缺失'));

var scriptOrder = [];
var re = /<script[^>]*\bsrc="([^"]+)"/g, mh;
while ((mh = re.exec(HTML))) scriptOrder.push(mh[1].replace(/^\.?\//, ''));
var expectOrder = ['js/state.js', 'js/data.js', 'js/effects.js', 'js/narrator.js', 'js/ui.js', 'js/game.js'];
c('X0.2', jsonOf(scriptOrder) === jsonOf(expectOrder),
  '经典脚本按依赖顺序引入（state → data → effects → narrator → ui → game），顺序未被 v4 改动',
  '实际=' + jsonOf(scriptOrder));

var refs = [];
var re2 = /(?:src|href)="([^"]+)"/g, m2;
while ((m2 = re2.exec(HTML))) refs.push(m2[1]);
var external = refs.filter(function (r) { return /^(https?:)?\/\//i.test(r); });
var bad = refs.filter(function (r) {
  if (/^(https?:)?\/\//i.test(r)) return true;
  if (/^(data:|#|mailto:|javascript:)/i.test(r)) return false;
  return !L.fileExists(require('path').join(L.ROOT, r.replace(/^\.?\//, '')));
});
c('X0.3', refs.length >= 6 && bad.length === 0,
  'index.html 引用的资源全部本地存在、零 http(s) 外链（契约 §6「断网可跑」）',
  '引用=' + refs.length + ' 个；外链=' + external.length + '；缺失/可疑=' + (bad.length ? bad.join('、') : '无'));

var jsFiles = ['state.js', 'data.js', 'effects.js', 'narrator.js', 'ui.js', 'game.js'];
var jsExternal = [];
jsFiles.forEach(function (f) {
  var p = require('path').join(L.JS_DIR, f);
  if (!L.fileExists(p)) { jsExternal.push(f + ':缺失'); return; }
  var src = L.readText(p);
  var mm = src.match(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/gi);
  if (mm) jsExternal.push(f + '→' + mm.slice(0, 2).join(','));
});
c('X0.4', jsExternal.length === 0,
  'js/*.js 内不出现 http(s):// 或协议相对外链（fetch/XHR/外链脚本都无处可达）',
  '命中=' + (jsExternal.length ? jsExternal.join('；') : '无'));

/* 断网等价性：把网络 API 换成「一旦被调用就抛错」的哨兵，重新加载全部脚本。 */
var poisonHits = [];
function poison(name) {
  return function () { poisonHits.push(name); throw new Error('offline: ' + name + ' 被调用'); };
}
var offline = L.loadScripts({
  withDom: false,
  globals: {
    fetch: poison('fetch'), XMLHttpRequest: poison('XMLHttpRequest'), WebSocket: poison('WebSocket'),
    EventSource: poison('EventSource'), sendBeacon: poison('sendBeacon'),
    navigator: { onLine: false, userAgent: 'offline-test' },
    location: { href: L.fileUrl(L.INDEX), protocol: 'file:', search: '', hash: '' }
  }
});
c('X0.5', offline.errors.length === 0 && poisonHits.length === 0 &&
  !!offline.sandbox.Game && !!offline.sandbox.GameData && typeof offline.sandbox.applyEffect === 'function',
  '断网 + 网络 API 毒化下六份脚本仍零异常加载、零网络调用（离线可跑）',
  '加载=' + offline.loaded.length + ' 个；错误=' + offline.errors.length + '；被调用的网络 API=' +
  (poisonHits.length ? poisonHits.join('、') : '无'));

/* ==================================================================== X1 */
ck.section('阶段 v4｜成就：10 条、阈值边界、跨局合并、落盘与解锁提示（§2.2/§3.2/§4.5）');

var ACH_IDS = ['first_cashout', 'rounds5', 'coins300', 'combo3', 'codex24',
  'endings4', 'all_in', 'comeback', 'clean_run', 'persona3'];
var ACH_TYPES = ['rounds', 'coins', 'cashouts', 'challengeWins', 'codexLines',
  'endings', 'doubles', 'comeback', 'personas', 'clean'];

if (!HAS.achData) {
  sk('X1.1', 'data/achievements.json 恰 10 条且 id 与契约 §3.2 清单一致',
    'GAME_DATA.achievements 未落地（content-data task-27 未完）');
} else {
  var ACH = GAME_DATA.achievements;
  var gotIds = ACH.map(function (a) { return a.id; }).sort();
  c('X1.1', ACH.length === 10 && jsonOf(gotIds) === jsonOf(ACH_IDS.slice().sort()),
    'data/achievements.json 恰 10 条且 id 与契约 §3.2 清单一致',
    '条数=' + ACH.length + '；id=' + list(gotIds, 12));

  var badAch = ACH.filter(function (a) {
    var ck2 = a.check || {};
    return !a.id || !a.name || !a.desc || !a.icon ||
      ACH_TYPES.indexOf(ck2.type) < 0 || !(Number(ck2.threshold) > 0);
  });
  c('X1.2', badAch.length === 0,
    '每条成就都有 id/name/desc/icon，check.type 在契约白名单内且 threshold > 0',
    '违规=' + (badAch.length ? badAch.map(function (a) { return a.id + '(' + ((a.check || {}).type) + ':' + ((a.check || {}).threshold) + ')'; }).join('、') : '无'));
}

if (!HAS.achApi) {
  sk('X1.3', 'Game.achievements() 返回 10 条 {id,name,desc,icon,unlocked}', 'Game.achievements 未落地（Lead task-26 未完）');
} else {
  /* 契约 §3.1：`Game.achievements()` 的对外形态由引擎冻结为「已解锁 id 数组」，
   * 对象视图（UI 成就墙用）在 `achievementList()`。X1.3 断言两者都成立且自洽。 */
  var achiG = mkGame('demo', SEED);
  var alRaw = G.Game.achievements();
  var isIdList = Array.isArray(alRaw) && alRaw.every(function (x) { return typeof x === 'string'; });
  var al = (typeof G.Game.achievementList === 'function' ? G.Game.achievementList() : []) || [];
  var shapeBad = al.filter(function (a) {
    return !a || typeof a.id !== 'string' || typeof a.name !== 'string' ||
      typeof a.desc !== 'string' || typeof a.icon !== 'string' || typeof a.unlocked !== 'boolean';
  });
  var idListOk = al.every(function (a) { return typeof a.unlocked !== 'boolean' || alRaw.indexOf(a.id) >= 0 === a.unlocked; });
  c('X1.3', isIdList && al.length === 10 && shapeBad.length === 0 && idListOk,
    'achievements() 返回已解锁 id 数组，achievementList() 返回 10 条 {id,name,desc,icon,unlocked} 且两者一致',
    'achievements()=' + jsonOf(alRaw) + '；achievementList 条数=' + al.length + '；形状异常=' + shapeBad.length);
  c('X1.3b', al.length === 10 && al.every(function (a) { return a.name && a.desc && a.icon; }),
    '成就墙数据完整（每条都有可展示的 name/desc/icon，不会渲染成空白卡）',
    '示例=' + jsonOf(al.slice(0, 2)));
  c('X1.4', al.length === 10 && al.every(function (a) { return a.unlocked === false; }),
    '全新存档下 10 条成就全部未解锁（不虚报）',
    '已解锁=' + al.filter(function (a) { return a.unlocked; }).map(function (a) { return a.id; }).join('、') || '无');
}

/* 阈值边界：为每条成就构造「刚好达标」与「差 1」两个状态。
 * 触发路径走 Game._checkAchievements(trigger)（契约 §3.1 的公开触发点）。 */
function storeMap() {
  var codex = { items: [], lines: [], endings: [] };
  var stats = { games: 0, totalCoins: 0, bestCoins: 0, bestRound: 0, challenges: 0, challengeWins: 0, endings: [] };
  return { codex: codex, stats: stats };
}
/** 按 check.type 造出「数量 = n」的可观察状态（不抄实现，按契约字段语义构造）。 */
function stateForCheck(type, n, sk2) {
  var s = G.createInitialState('normal', { seed: SEED });
  var i;
  switch (type) {
    case 'rounds': s.round = n; s.bestRound = n; break;
    case 'coins': s.coins = n; break;
    case 'cashouts': s.cashouts = n; sk2.stats.games = n; sk2.stats.cashouts = n; break;
    case 'challengeWins': s.challengesWon = n; s.challengeWins = n; break;
    case 'codexLines':
      for (i = 0; i < n; i++) sk2.codex.lines.push('line_' + i);
      break;
    case 'endings':
      for (i = 0; i < n; i++) { sk2.codex.endings.push('e' + i); sk2.stats.endings.push('e' + i); }
      break;
    case 'doubles': s.round = n; s.doublesUsed = n; s.doubled = n > 0; break;
    case 'comeback': s.minCoins = 0; s.coins = n; break;
    case 'personas':
      s.personasPlayed = ['sarcastic', 'gentle', 'crazy'].slice(0, Math.min(n, 3));
      sk2.stats.personas = s.personasPlayed.slice();
      break;
    case 'clean': s.round = n; s.challengesLost = 0; s.cashedOut = true; break;
    default: break;
  }
  s.codex = sk2.codex;
  s.stats = sk2.stats;
  return s;
}
function unlockedWith(a, n, mut) {
  var g = mkGame('demo', SEED);        /* 先建实例：_checkAchievements 会 toast，需要 deps.ui 就位 */
  var ls2 = mkLS();
  G.localStorage = ls2;                /* 换成干净存档（避免上一条断言解锁的成就污染） */
  var sk2 = storeMap();
  var type = (a.check || {}).type;
  var s = stateForCheck(type, n, sk2);
  ls2.setItem(KEYS.codex, JSON.stringify(sk2.codex));
  ls2.setItem(KEYS.stats, JSON.stringify(sk2.stats));
  if (type === 'personas' || type === 'persona') {
    /* 实现口径：personas 成就看 prefs.personasSeen（不是 state 字段） */
    ls2.setItem(KEYS.prefs, JSON.stringify({ personasSeen: ['sarcastic', 'gentle', 'crazy'].slice(0, Math.min(n, 3)) }));
  }
  if (typeof mut === 'function') mut(s);
  g.Game.state = s;
  try { g.Game._checkAchievements('settleRound'); } catch (e) { return { error: String((e && e.message) || e) }; }
  var out = (typeof g.Game.achievementList === 'function' ? g.Game.achievementList() : []) || [];
  var hit = null;
  for (var i = 0; i < out.length; i++) if (out[i].id === a.id) hit = out[i];
  return { unlocked: hit ? hit.unlocked : null, entry: hit };
}

if (!HAS.achApi || !HAS.checkApi || !HAS.achData) {
  sk('X1.5', '每条成就：threshold−1 不解锁、threshold 解锁（边界 ±1）',
    '依赖 Game.achievements / Game._checkAchievements（Lead task-26 未完）或 achievements 数据');
} else {
  /* clean/clean_run 的语义阈值是「第 5 轮且零质疑失败」，数据层 threshold=1 只作开关。 */
  var SEM_TH = { clean: 5, clean_run: 5 };
  var bnd = [];
  GAME_DATA.achievements.forEach(function (a) {
    var type = (a.check || {}).type;
    var th = SEM_TH[type] != null ? SEM_TH[type] : Number((a.check || {}).threshold);
    var lo = unlockedWith(a, Math.max(0, th - 1));
    var hi = unlockedWith(a, th);
    var okB = !!(hi && hi.unlocked === true) && !!(lo && lo.unlocked === false);
    if (!okB) {
      bnd.push(a.id + '(t=' + th + ' → t-1:' + (lo && lo.unlocked) + ' t:' + (hi && hi.unlocked) +
        (hi && hi.error ? ' err=' + hi.error : '') + ')');
    }
    nX++;
    ck.ok('X1.5.' + a.id, okB,
      '成就 ' + a.id + '（type=' + type + '，阈值=' + th + '）边界 ±1 判定正确',
      't-1 解锁=' + (lo && lo.unlocked) + '；t 解锁=' + (hi && hi.unlocked));
  });
  c('X1.5s', bnd.length === 0,
    '10 条成就的阈值边界全部正确（阈值−1 不解锁、阈值解锁）',
    '不符合=' + (bnd.length ? bnd.join('；') : '无'));

  /* clean_run 的反例：轮次到了但质疑失败过 → 不应解锁 */
  var cln = unlockedWith({ id: 'clean_run', check: { type: 'clean', threshold: 1 } }, 5, function (s) { s.challengesLost = 1; });
  c('X1.5.clean_fail', !!cln && cln.unlocked === false,
    'clean_run 反例：第 5 轮但质疑失败过 → 不解锁（零失误才是真条件）',
    'unlocked=' + (cln && cln.unlocked));
}

if (!HAS.achApi) {
  sk('X1.6', '解锁后写入 three_doors_achievements_v1（跨局持久）', 'Game._checkAchievements 未落地');
  sk('X1.7', '预置存档的成就直接视为已解锁（新局合并而不是覆盖）', 'Game.achievements 未落地');
  sk('X1.8', '解锁时给出「成就解锁」提示（UI.toast）', 'Game.achievements 未落地');
} else {
  /* 一个带 UI 桩的实例：既能落盘（CodexStore 每次调用都重新取 root.localStorage），
   * 也能观察「解锁成就」toast（契约 §3.1 要求解锁即提示）。 */
  var lsA = mkLS();
  G.localStorage = lsA;
  var gA = mkGame('demo', SEED);
  function idsOf(raw) {
    if (!raw) return [];
    try {
      var v = JSON.parse(raw);
      return Array.isArray(v) ? v : (Array.isArray(v && v.ids) ? v.ids : []);
    } catch (e) { return ['BAD_JSON']; }
  }

  /* X1.6：解锁一条 → 落盘 three_doors_achievements_v1（内容 = 已解锁 id 列表） */
  var firstAch = (GAME_DATA.achievements || [])[0];
  var wroteIds = [];
  if (firstAch && HAS.checkApi) {
    var sk3 = storeMap();
    var s3 = stateForCheck((firstAch.check || {}).type, Number((firstAch.check || {}).threshold), sk3);
    lsA.setItem(KEYS.codex, JSON.stringify(sk3.codex));
    lsA.setItem(KEYS.stats, JSON.stringify(sk3.stats));
    gA.Game.state = s3;
    try { gA.Game._checkAchievements('settleRound'); } catch (e) { /* 断言兜底 */ }
    wroteIds = idsOf(lsA.getItem(KEYS.achievements));
  }
  c('X1.6', !!(firstAch && wroteIds.indexOf(firstAch.id) >= 0),
    '解锁的成就 id 写进 three_doors_achievements_v1（跨局持久，契约 §2.2）',
    '落盘 id=' + list(wroteIds, 6) + '（期望含 ' + (firstAch ? firstAch.id : '?') + '）');

  /* X1.8：解锁时给出「成就解锁」提示（真实 toast，不靠人眼） */
  var toasts8 = (gA.rec.toasts || []);
  c('X1.8', toasts8.some(function (t) { return typeof t === 'string' && t.indexOf('成就') >= 0; }),
    '解锁瞬间通过 UI.toast 提示「解锁成就：<名称>」（契约 §3.1）',
    'toast=' + jsonOf(toasts8.slice(-3)));

  /* X1.7：预置存档 → 新一局开局即可见（合并，不是被本局覆盖） */
  var pre = { ids: [firstAch ? firstAch.id : 'first_cashout'] };
  var ls7 = mkLS();
  ls7.setItem(KEYS.achievements, JSON.stringify(pre));
  G.localStorage = ls7;
  mkGame('demo', SEED);
  var after7 = G.Game.achievementList ? G.Game.achievementList() : [];
  var hit7 = null;
  for (var i7 = 0; i7 < after7.length; i7++) if (after7[i7].id === (firstAch ? firstAch.id : 'first_cashout')) hit7 = after7[i7];
  c('X1.7', !!(hit7 && hit7.unlocked === true),
    '预置存档里的成就开新局后仍为已解锁（存档合并，不是被本局覆盖）',
    '预置=' + jsonOf(pre) + '；读回 unlocked=' + (hit7 ? hit7.unlocked : 'null'));

  /* X1.9：清空存档（设置面板「清空全部数据」）后成就回锁 */
  var cleared = G.Game.action({ type: 'clear_save' });
  var after9 = G.Game.achievementList ? G.Game.achievementList() : [];
  var stillOn = (after9 || []).filter(function (a) { return a.unlocked; }).map(function (a) { return a.id; });
  c('X1.9', cleared !== false && stillOn.length === 0,
    'clear_save 清空本地数据后成就全部回锁（不留残留）',
    'action 返回=' + jsonOf(cleared) + '；仍解锁=' + (stillOn.length ? stillOn.join('、') : '无'));

  /* X1.10：成就存档与统计存档是两个独立键，互不覆盖 */
  var ls10 = mkLS();
  ls10.setItem(KEYS.achievements, JSON.stringify({ ids: ['rounds5'] }));
  ls10.setItem(KEYS.stats, JSON.stringify({ games: 7, totalCoins: 500, bestCoins: 500, bestRound: 3, challenges: 2, challengeWins: 1, endings: [] }));
  G.localStorage = ls10;
  mkGame('demo', SEED);
  var a10 = G.Game.achievementList ? G.Game.achievementList() : [];
  var hit10 = null;
  for (var i10 = 0; i10 < a10.length; i10++) if (a10[i10].id === 'rounds5') hit10 = a10[i10];
  var st10 = G.Game.stats();
  var rawA10 = ls10.getItem(KEYS.achievements) || '';
  var rawS10 = ls10.getItem(KEYS.stats) || '';
  c('X1.10', !!(hit10 && hit10.unlocked === true) && st10.games === 7 && st10.bestCoins === 500 &&
    rawA10.indexOf('rounds5') >= 0 && rawS10.indexOf('"games":7') >= 0,
    '成就存档（three_doors_achievements_v1）与统计存档（three_doors_stats_v1）互不覆盖',
    '成就=' + (hit10 ? hit10.unlocked : 'null') + '；stats.games=' + st10.games + '/' + st10.bestCoins +
    '；原文=' + rawA10.slice(0, 40) + ' | ' + rawS10.slice(0, 40));
}

/* ==================================================================== X2 */
ck.section('阶段 v4｜统计：累计、最佳值、质疑成功率、结局去重（§2.2/§3.1）');

if (!HAS.statsApi) {
  sk('X2.1', 'Game.stats() 返回契约 §3.1 的 8 个字段', 'Game.stats 未落地（Lead task-26 未完）');
  sk('X2.2', '收手结算后 games/totalCoins/bestCoins/bestRound/endings 正确累计', 'Game.stats 未落地');
  sk('X2.3', '第二局成绩更差时 best* 不被拉低、totalCoins 累加', 'Game.stats 未落地');
  sk('X2.4', '质疑次数/成功次数/成功率统计正确', 'Game.stats 未落地');
  sk('X2.5', '统计写入 three_doors_stats_v1', 'Game.stats 未落地');
  sk('X2.6', '清空存档后统计归零', 'Game.stats 未落地');
} else {
  var FIELDS = ['games', 'totalCoins', 'bestCoins', 'bestRound', 'challenges', 'challengeWins', 'endings'];
  var ls2 = mkLS();
  G.localStorage = ls2;
  var g21 = mkGame('demo', SEED);
  var st21 = G.Game.stats();
  var missingF = FIELDS.filter(function (f) { return !(f in (st21 || {})); });
  c('X2.1', !!st21 && missingF.length === 0 && st21.games === 0 && st21.totalCoins === 0 &&
    st21.bestCoins === 0 && st21.bestRound === 0 && (st21.endings || []).length === 0,
    'Game.stats() 返回 7 个持久字段且全新存档下全为 0（质疑成功率由 UI 现算：challengeWins/challenges）',
    '字段缺失=' + (missingF.length ? missingF.join('、') : '无') + '；初值=' + jsonOf(st21));
  c('X2.1b', !('challengeRate' in (st21 || {})) || st21.challengeRate === 0 ||
    Math.abs(st21.challengeRate - (st21.challenges ? st21.challengeWins / st21.challenges : 0)) < 1e-9,
    '若 stats() 带 challengeRate，则必须自洽（= challengeWins/challenges，全新档为 0）',
    'challengeRate=' + jsonOf((st21 || {}).challengeRate) + ' challenges=' + (st21 || {}).challenges +
    ' wins=' + (st21 || {}).challengeWins);

  /* 第一局：演示模式跑到收手 */
  await autoDemoDone(g21);
  var s21 = G.Game.state;
  var st22 = G.Game.stats();
  c('X2.2', st22.games === 1 && st22.totalCoins === s21.coins && st22.bestCoins === s21.coins &&
    st22.bestRound === s21.round && (st22.endings || []).length === 1,
    '收手结算后 games=1、totalCoins/bestCoins/bestRound 与当局一致、endings 记 1 条',
    'phase=' + s21.phase + ' coins=' + s21.coins + ' round=' + s21.round + ' stats=' + jsonOf(st22));

  /* 第二局：故意打差（普通模式第一轮就踩雷很随机；这里直接用更小的金币收手）。 */
  var g23 = mkGame('demo', 777001);
  G.Game.state.coins = 20;
  await autoDemoDone(g23);
  var st23 = G.Game.stats();
  c('X2.3', st23.games === 2 && st23.bestCoins >= st22.bestCoins && st23.totalCoins >= st22.totalCoins,
    '第二局结束后 games 累加到 2、bestCoins/bestRound 只增不减、totalCoins 为跨局累计',
    '第一局=' + jsonOf(st22) + '；第二局=' + jsonOf(st23));
  var coins2 = g23.Game.state.coins;
  c('X2.7', st23.totalCoins === st22.totalCoins + coins2,
    'totalCoins 精确等于两局金币之和（不是覆盖、也不重复计）',
    '第一局 totalCoins=' + st22.totalCoins + ' + 第二局 coins=' + coins2 + ' = ' + (st22.totalCoins + coins2) +
    '；实际=' + st23.totalCoins);
  c('X2.8', st23.bestCoins >= st22.totalCoins && st23.bestRound >= st22.bestRound,
    'best* 取历史最大值（第二局更差时不被拉低）',
    'bestCoins ' + st22.bestCoins + ' → ' + st23.bestCoins + '；bestRound ' + st22.bestRound + ' → ' + st23.bestRound);

  /* 质疑统计：演示模式第 2 轮质疑，然后立刻收手结算（stats 在结算时落盘）。 */
  var ls24 = mkLS();
  G.localStorage = ls24;
  var g24 = mkGame('demo', SEED);
  await demoToPick(g24);
  await pickSlot(g24, 0);
  G.Game.action({ type: 'decide', choice: 'stick' });
  await untilMs(function () { return G.Game.state.phase === 'SETTLE_ROUND'; }, 4000);
  G.Game.action({ type: 'settle', choice: 'continue' });
  await untilMs(function () { return G.Game.state.phase === 'PICK'; }, 4000);
  await pickSlot(g24, 1);
  var challenged = G.Game.action({ type: 'decide', choice: 'challenge' });
  var lc = G.Game.state.lastChallenge || null;
  G.Game.action({ type: 'decide', choice: 'cashout' });
  await untilMs(function () { return G.Game.state.phase === 'CASHOUT' || G.Game.state.phase === 'GAME_OVER'; }, 6000);
  var st24 = G.Game.stats();
  var rateOk = !('challengeRate' in (st24 || {})) ||
    (st24.challenges > 0
      ? Math.abs(st24.challengeRate - st24.challengeWins / st24.challenges) < 1e-9
      : st24.challengeRate === 0);
  c('X2.4', challenged === true && st24.challenges >= 1 && st24.challengeWins >= 0 &&
    st24.challengeWins <= st24.challenges && rateOk,
    '质疑被受理后 challenges/challengeWins 累加且自洽（wins ≤ challenges；有 rate 字段时 = wins/challenges）',
    '受理=' + challenged + ' lastOk=' + (lc ? lc.ok : 'null') + ' phase=' + G.Game.state.phase + ' stats=' + jsonOf(st24));

  var rawStats = ls24.getItem(KEYS.stats);
  c('X2.5', !!rawStats && rawStats.indexOf('"games"') >= 0,
    '统计写入 three_doors_stats_v1（键名与契约 §2.2 一致）',
    '原文=' + String(rawStats).slice(0, 160));

  if (G.CodexStore && typeof G.CodexStore.clearStats === 'function') {
    G.CodexStore.clearStats();
    var st26 = G.Game.stats();
    c('X2.6', st26.games === 0 && st26.totalCoins === 0 && (st26.endings || []).length === 0,
      'clearStats() 后统计归零',
      '清空后=' + jsonOf(st26));
  } else {
    sk('X2.6', 'clearStats() 后统计归零', 'state.js CodexStore.clearStats 未落地');
  }
}

/* ==================================================================== X3 */
ck.section('阶段 v4｜种子重放：seedTag/seedUrl/?seed=（§3.3）');

if (!HAS.seedApi) {
  sk('X3.1', 'seedTag()：演示模式固定 "20261024"、普通模式为 String(seed)', 'Game.seedTag 未落地（task-26）');
  sk('X3.2', 'seedUrl() 形如 index.html?seed=NNN', 'Game.seedUrl 未落地（task-26）');
  sk('X3.3', 'location.search 的 ?seed= 注入到局内 RNG', 'Game.seedTag 未落地（task-26）');
  sk('X3.4', '同种子两次发牌/结果序列完全一致', 'Game.seedUrl 未落地（task-26）');
  sk('X3.5', '?seed 优先于 ?rehearsal=1', 'Game 未落地');
} else {
  var g31 = mkGame('demo', SEED);
  var tag31 = G.Game.seedTag();
  c('X3.1', /^[0-9a-f]{1,8}$/.test(tag31) && parseInt(tag31, 16) === SEED && g31.Game.state.rng.seed === SEED,
    '演示模式 seedTag() 为本局种子的十六进制标签（唯一映射 20261024）且 RNG 用同一 seed',
    'seedTag=' + tag31 + '（0x' + tag31 + '=' + parseInt(tag31, 16) + '）seed=' + g31.Game.state.rng.seed);
  var g31b = mkGame('normal', 424242);
  var tag32 = G.Game.seedTag();
  var url32 = G.Game.seedUrl();
  c('X3.2', tag32 !== tag31 && parseInt(tag32, 16) === 424242 &&
    url32.indexOf('?seed=' + tag32) >= 0,
    'seedTag() 随种子变化且 seedUrl() 可回放（URL 里带 ?seed=<tag>）',
    'seedTag=' + tag32 + '→' + parseInt(tag32, 16) + '；seedUrl=' + url32);

  var g33 = mkGame('normal', SEED, { location: { href: L.fileUrl(L.INDEX), protocol: 'file:', search: '?seed=777123', hash: '' } });
  c('X3.3', g33.Game.state.rng.seed === 777123,
    'Game.init 读取 location.search 的 ?seed=NNN 并作为本局种子（覆盖传入 seed）',
    'rng.seed=' + g33.Game.state.rng.seed + '（期望 777123）');

  /* 同种子重放：发牌序列 + 一轮结果序列一致 */
  function replayKeys(seed) {
    var gg = mkGame('normal', seed);
    var out = [];
    for (var r = 1; r <= 3; r++) {
      var doors = gg.Game.generateDoors(r).map(function (d) { return d.itemId; });
      out.push(r + ':' + doors.join('/'));
    }
    return { keys: out.join('|'), snapshot: gg.Game.state.rng };
  }
  var r1 = replayKeys(20260101), r1b = replayKeys(20260101), r2 = replayKeys(20260102);
  c('X3.4', r1.keys === r1b.keys && jsonOf(r1.snapshot) === jsonOf(r1b.snapshot) && r1.keys !== r2.keys,
    '同种子两次发牌序列与 RNG 状态完全一致，不同种子不同（可复现）',
    'seed A=' + r1.keys + '；重放一致=' + (r1.keys === r1b.keys) + '；seed B 不同=' + (r1.keys !== r2.keys));

  var g35 = mkGame('demo', SEED, { location: { href: L.fileUrl(L.INDEX), protocol: 'file:', search: '?seed=555001&rehearsal=1', hash: '' } });
  c('X3.5', g35.Game.state.rng.seed === 555001,
    '同时带 ?seed 与 ?rehearsal 时 ?seed 优先（契约 §3.3）',
    'rng.seed=' + g35.Game.state.rng.seed + ' flags.rehearsal=' + !!(g35.Game.state.flags && g35.Game.state.flags.rehearsal));

  /* X3.6：seedTag → ?seed=<tag> 往返重放（分享链能复现同一局） */
  var g31c = mkGame('normal', 20261024);
  var tag36 = G.Game.seedTag();
  var g36 = mkGame('normal', 1, { location: { href: L.fileUrl(L.INDEX), protocol: 'file:', search: '?seed=' + tag36, hash: '' } });
  c('X3.6', g36.Game.state.rng.seed === 20261024,
    'seedTag() → ?seed=<tag> 往返后重放同一 RNG 种子（分享链接可复现）',
    'tag=' + tag36 + ' → 重放 seed=' + g36.Game.state.rng.seed + '（期望 20261024）');

  /* X3.7：演示模式种子固定为剧本种子（清单阶段 4 P0） */
  var demoSeed = (GAME_DATA.seedDemo && GAME_DATA.seedDemo.seed);
  c('X3.7', g31.Game.state.rng.seed === 20261024 && (!demoSeed || demoSeed === 20261024),
    '演示模式固定种子 20261024（清单阶段 4 P0：所有设备同一份脚本）',
    'seed=' + g31.Game.state.rng.seed + ' data.seedDemo.seed=' + jsonOf(demoSeed));
}

/* ==================================================================== X4 */
ck.section('阶段 v4｜键盘映射：1/2/3、q/d/s/c、空格、m、?/h、Esc（§4.2）');

var kp = null, K = null, keyErr = null;
try {
  kp = Sh.createPage();
  K = kp.sandbox;
} catch (e) {
  keyErr = String(e && e.message ? e.message : e);
}

if (!kp || !K || !K.Game || !K.UI) {
  sk('X4.1', '下一步/开始/选门/决策/静音/帮助/Esc 的键盘映射', '页面无法在垫片中启动：' + (keyErr || (kp ? kp.loadSummary : 'page=null')));
} else {
  var KGame = K.Game;
  var acts = [];
  var origAction = KGame.action;
  KGame.action = function (a) { acts.push(a || {}); return origAction.call(KGame, a); };
  /* 每轮固定给一条「可质疑」的谎言行：否则 random 到不可 claim 的行时，
     质疑按钮 aria-disabled=true，keyDecide 只 toast 不发 decide，会误判成「键位没映射」。 */
  if (K.Narrator && K.Narrator.pickRoundLines) {
    K.Narrator.pickRoundLines = function (state) {
      var slot = 0;
      for (var i2 = 0; i2 < state.doors.length; i2++) {
        if (state.doors[i2].itemId !== 'empty') { slot = i2; break; }
      }
      return [{
        id: 'X4_claim_r' + state.round, text: '\u7b2c ' + (slot + 1) + ' \u53f7\u95e8\u662f\u7a7a\u95e8\u3002',
        kind: 'lie', truthful: false,
        claim: { type: 'slot_kind', slot: slot, kind: 'empty', truthful: false }
      }];
    };
  }
  var closed = 0;
  var origClose = K.UI.closeModal;
  K.UI.closeModal = function () { closed++; return origClose ? origClose.apply(K.UI, arguments) : undefined; };
  function fireKey(key, opts2) {
    var e = { type: 'keydown', key: key, bubbles: true, target: kp.doc.body, preventDefault: function () {}, stopPropagation: function () {} };
    if (opts2) for (var kk in opts2) e[kk] = opts2[kk];
    Sh.fire(kp.doc, 'keydown', e);
  }
  function actsOf(type) { return acts.filter(function (a) { return a.type === type; }); }

  /* 1) IDLE 下按 1/2/3 不应产生 pick */
  var before = acts.length;
  fireKey('1'); fireKey('2'); fireKey('3');
  c('X4.1', actsOf('pick').length === 0,
    '开局 IDLE 阶段按 1/2/3 不会选门（无副作用）',
    '新增 action=' + jsonOf(acts.slice(before)));

  /* 2) 开始 → PICK → 按 3 应选 3 号门（slot=2） */
  /* 用普通模式启动：演示模式只有 3 轮，不够 d/s/q/c 四个键各占一次独立的 DECIDE */
  var startBtn = kp.doc.getElementById('btn-start');
  KGame.action({ type: 'start', mode: 'normal' });
  var gotPick = await untilMs(function () { return KGame.state.phase === 'PICK'; }, 12000);
  var actsBeforePick = actsOf('pick').length;
  fireKey('3');
  await untilMs(function () { return KGame.state.phase === 'DECIDE' || KGame.state.phase === 'PICK'; }, 4000);
  var pickAct = actsOf('pick').slice(actsBeforePick)[0] || null;
  c('X4.2', gotPick && !!pickAct && pickAct.slot === 2 && KGame.state.pickedSlot === 2,
    'PICK 阶段按 "3" → Game.action({type:"pick", slot:2}) 并落到 state.pickedSlot',
    'phase=' + KGame.state.phase + ' action=' + jsonOf(pickAct) + ' pickedSlot=' + KGame.state.pickedSlot);

  /* 3) DECIDE 阶段的 q/d/s/c */
  var atDecide = await untilMs(function () { return KGame.state.phase === 'DECIDE'; }, 6000);
  var dec = function (choice) { return acts.filter(function (a) { return a.type === 'decide' && a.choice === choice; }).length; };
  /* 一个 decide 会消耗掉本轮的 DECIDE：d/s/q 必须各占一轮，
     每按一个键后「等结算层 → 继续 → 下一轮选门 → 再等 DECIDE」。 */
  async function pickByKey() {
    for (var pk = 0; pk < 6; pk++) {
      if (KGame.state.phase !== 'PICK') return true;
      fireKey('1');
      await untilMs(function () { return KGame.state.phase !== 'PICK'; }, 2500);
      if (KGame.state.phase !== 'PICK') return true;
      await untilMs(function () { return false; }, 200);
    }
    return false;
  }
  async function nextDecide() {
    await untilMs(function () {
      return KGame.state.phase === 'SETTLE_ROUND' || KGame.state.phase === 'GAME_OVER' ||
        KGame.state.phase === 'CASHOUT' || KGame.state.phase === 'PICK';
    }, 10000);
    if (KGame.state.phase === 'SETTLE_ROUND') KGame.action({ type: 'settle', choice: 'continue' });
    await untilMs(function () { return KGame.state.phase === 'PICK'; }, 15000);
    await pickByKey();
    return await untilMs(function () { return KGame.state.phase === 'DECIDE'; }, 12000);
  }

  var keyPlan = ['d', 's', 'q'];
  for (var kq = 0; kq < keyPlan.length; kq++) {
    if (!atDecide) break;
    fireKey(keyPlan[kq]);
    await untilMs(function () { return KGame.state.phase !== 'DECIDE'; }, 4000);
    if (kq < keyPlan.length - 1) await nextDecide();
  }
  var sawDouble = dec('double') > 0;
  var sawSwitch = dec('switch') > 0;
  var sawChallenge = dec('challenge') > 0;
  c('X4.3', atDecide && sawDouble && sawSwitch && sawChallenge,
    'DECIDE 阶段 d/s/q → decide:{double|switch|challenge}（键位与契约 §4.2 一致）',
    'phase=' + KGame.state.phase + ' double=' + sawDouble + ' switch=' + sawSwitch + ' challenge=' + sawChallenge +
    '；decide actions=' + jsonOf(acts.filter(function (a) { return a.type === 'decide'; })));

  /* 4) c → 收手（decide.cashout 或 settle.cashout 都算合法路由） */
  var cashBefore = acts.filter(function (a) { return (a.type === 'decide' || a.type === 'settle') && a.choice === 'cashout'; }).length;
  if (KGame.state.phase !== 'DECIDE') await nextDecide();
  fireKey('m');                 /* 此刻无弹层：弹层打开时 keydown 只认空格/回车（契约 §4.2 弹层优先） */
  await untilMs(function () { return acts.filter(function (a) { return a.type === 'toggle_mute'; }).length >= 1; }, 1000);
  fireKey('c');
  await untilMs(function () { return KGame.state.phase !== 'DECIDE'; }, 4000);
  var cashAfter = acts.filter(function (a) { return (a.type === 'decide' || a.type === 'settle') && a.choice === 'cashout'; }).length;
  c('X4.4', cashAfter > cashBefore,
    'DECIDE 阶段按 "c" → 收手路由（decide/settle 的 cashout）',
    'cashout 次数 ' + cashBefore + ' → ' + cashAfter + '；phase=' + KGame.state.phase);

  /* 5) m → toggle_mute（此刻无弹层，见上面 X4.4 前的说明） */
  fireKey('m');
  c('X4.5', actsOf('toggle_mute').length >= 1,
    '按 "m" → Game.action({type:"toggle_mute"})（键盘与按钮同一入口）',
    'toggle_mute=' + actsOf('toggle_mute').length + '；flags.muted=' + !!(KGame.state.flags && KGame.state.flags.muted));

  /* Esc 语义（契约 §4.2 及其注）：信息弹层可关；必选流程弹层（round/cashout/gameover）不被 Esc 绕过。
     「信息弹层」那条另开一页（此刻 kp 已停在必选结算层，keydown 在必选弹层里只认空格/Tab/Esc）。 */
  var escInfo = null, escInfoErr = null;
  try {
    var ep = Sh.createPage();
    var E = ep.sandbox;
    var eClosed = 0, eOrigClose = E.UI.closeModal;
    E.UI.closeModal = function () { eClosed++; return eOrigClose.apply(E.UI, arguments); };
    var eActs = [], eOrigAction = E.Game.action;
    E.Game.action = function (a) { eActs.push(a || {}); return eOrigAction.call(E.Game, a); };
    function eFire(key) {
      Sh.fire(ep.doc, 'keydown', { type: 'keydown', key: key, bubbles: true, target: ep.doc.body,
        preventDefault: function () {}, stopPropagation: function () {} });
    }
    var eModal = ep.doc.getElementById('modal');
    eFire('?');
    await untilMs(function () { return !!(eModal && eModal.hidden === false); }, 2000);
    var helpOpened = !!(eModal && eModal.hidden === false) &&
      eActs.some(function (a) { return a.type === 'open_help'; });
    var c0e = eClosed;
    eFire('Escape');
    await untilMs(function () { return !!(eModal && eModal.hidden === true); }, 1500);
    escInfo = { helpOpened: helpOpened, closedUp: eClosed - c0e, hidden: !!(eModal && eModal.hidden) };
  } catch (e) { escInfoErr = String((e && e.message) || e); }

  c('X4.6', !!escInfo && escInfo.helpOpened,
    '按 "?" 打开规则帮助（open_help），帮助弹层可见',
    escInfoErr ? ('页面/探针异常：' + escInfoErr) : jsonOf(escInfo));
  c('X4.7', !!escInfo && escInfo.closedUp >= 1 && escInfo.hidden,
    '信息弹层上按 "Esc" → UI.closeModal 被调用且 #modal 隐藏（契约 §4.2）',
    escInfoErr ? ('页面/探针异常：' + escInfoErr) : jsonOf(escInfo));

  /* X4.7b：必选流程弹层（这里的 kp 已停在 CASHOUT 结算层）不被 Esc 绕过 */
  var mandModal = kp.doc.getElementById('modal');
  var mandPhase = KGame.state.phase;
  var closedBefore = closed;
  fireKey('Escape');
  await untilMs(function () { return false; }, 250);
  c('X4.7b', (mandPhase === 'CASHOUT' || mandPhase === 'SETTLE_ROUND' || mandPhase === 'GAME_OVER') &&
    closed === closedBefore && !!(mandModal && mandModal.hidden === false),
    '必选流程弹层（CASHOUT/SETTLE_ROUND/GAME_OVER）不被 Esc 绕过：closeModal 不增、弹层仍在（契约 §4.2 注）',
    'phase=' + mandPhase + ' closeModal ' + closedBefore + ' → ' + closed +
    '；modal.hidden=' + (mandModal ? mandModal.hidden : 'null'));

  /* X4.8：空格 = 开始 / 继续（契约 §4.2） */
  var beforeSpace = acts.length;
  var phaseBeforeSpace = KGame.state.phase;
  fireKey(' ');
  await untilMs(function () { return KGame.state.phase !== phaseBeforeSpace; }, 4000);
  var spaceActs = acts.slice(beforeSpace);
  c('X4.8', spaceActs.some(function (a) { return a.type === 'start' || a.type === 'modal_choice' || a.type === 'settle'; }) ||
    KGame.state.phase !== phaseBeforeSpace,
    '空格在开局/结算页 → 开始或继续（start / modal_choice / settle 路由）',
    'phase ' + phaseBeforeSpace + ' → ' + KGame.state.phase + '；新增 action=' + jsonOf(spaceActs));
}

/* ==================================================================== X5 */
ck.section('阶段 v4｜旁白人格：生效、落盘、lieRate 叠加与夹取（§3.1/§4.3）');

if (!HAS.personaData) {
  sk('X5.1', 'data/personas.json 三条（sarcastic/gentle/crazy）与 lieRateDelta 0/−0.05/+0.05',
    'data/personas.json 未落地（content-data task-27 未完）');
} else {
  var PERS = GAME_DATA.personas;
  var pid = PERS.map(function (p) { return p.id; }).sort();
  var delta = {};
  PERS.forEach(function (p) { delta[p.id] = p.lieRateDelta; });
  c('X5.1', PERS.length === 3 && jsonOf(pid) === jsonOf(['crazy', 'gentle', 'sarcastic']) &&
    delta.sarcastic === 0 && delta.gentle === -0.05 && delta.crazy === 0.05 &&
    (CFG.personalities || {}).default === 'sarcastic',
    'data/personas.json 三条人格、lieRateDelta 为 0/−0.05/+0.05，config.personalities.default=sarcastic',
    'id=' + list(pid) + '；delta=' + jsonOf(delta) + '；default=' + ((CFG.personalities || {}).default));
}

if (!HAS.personaApi || !HAS.prefsApi) {
  sk('X5.2', 'setPersonality("crazy") 生效并落盘 three_doors_prefs_v1', 'Game.setPersonality/prefs 未落地（task-26）');
  sk('X5.3', '非法人格 id 被忽略（返回 false / 状态不变）', 'Game.setPersonality 未落地（task-26）');
  sk('X5.4', 'Narrator.lieRate 叠加 lieRateDelta 且被 cap 夹住', 'Game.setPersonality 未落地（task-26）');
  sk('X5.5', '人格切换后旁白池随之切换', 'Game.setPersonality 未落地（task-26）');
  sk('X5.6', 'prefs()/savePref 白名单与落盘', 'Game.prefs 未落地（task-26）');
} else {
  var ls5 = mkLS();
  G.localStorage = ls5;
  var g52 = mkGame('demo', SEED);
  var okSet = G.Game.setPersonality('crazy');
  var rawPrefs = ls5.getItem(KEYS.prefs);
  var parsedPrefs = null;
  try { parsedPrefs = rawPrefs ? JSON.parse(rawPrefs) : null; } catch (e) { parsedPrefs = null; }
  c('X5.2', okSet !== false && G.Game.state.personality === 'crazy' && !!parsedPrefs &&
    (parsedPrefs.personality === 'crazy' || parsedPrefs.persona === 'crazy'),
    'setPersonality("crazy") 改变当局人格并写入 three_doors_prefs_v1',
    '返回值=' + jsonOf(okSet) + ' state.personality=' + G.Game.state.personality + ' prefs=' + jsonOf(parsedPrefs));

  var beforeBad = G.Game.state.personality;
  var badRet = G.Game.setPersonality('definitely-not-a-persona');
  c('X5.3', badRet === false && G.Game.state.personality === beforeBad,
    '非法人格 id 被拒绝（返回 false）且不改动当前人格',
    '返回=' + jsonOf(badRet) + ' 人格=' + G.Game.state.personality);

  /* X5.8：人格使用记录累积（成就 persona3 的数据来源；三档都明确用过一次） */
  ['sarcastic', 'gentle', 'crazy'].forEach(function (p) { G.Game.setPersonality(p); });
  var seen = (G.Game.prefs() || {}).personasSeen || (G.Game.prefs() || {}).personas || [];
  c('X5.8', seen.length >= 3 && seen.indexOf('sarcastic') >= 0 && seen.indexOf('gentle') >= 0 && seen.indexOf('crazy') >= 0,
    '三档人格各用一次后被记录进 personasSeen（供 persona3 成就判定）',
    'personasSeen=' + jsonOf(seen));
  var rawPrefs9 = ls5.getItem(KEYS.prefs) || '';
  c('X5.9', rawPrefs9.indexOf('definitely-not-a-persona') < 0,
    '非法人格 id 不会落盘（存档原文里不出现该字符串）',
    '存档=' + rawPrefs9.slice(0, 160));

  if (HAS.lieRate) {
    var base = null, rates = {};
    ['sarcastic', 'gentle', 'crazy'].forEach(function (id) {
      G.Game.setPersonality(id);
      var r = G.Narrator.lieRate(G.Game.state);
      rates[id] = typeof r === 'number' ? r : null;
      if (id === 'sarcastic') base = rates[id];
    });
    var cap = Number((CFG.personalities || {}).lieRateDeltaCap);
    /* 契约 §3.2：基础率 + lieRateDelta 后「夹在 [base, cap]」——
     * 所以负 delta（gentle）会被 base 地板夹回 base，只有正 delta 抬升。 */
    var crazyUp = rates.crazy > base && (isFinite(cap) ? rates.crazy - base <= cap + 1e-9 : true);
    var gentleFloor = rates.gentle === base;
    c('X5.4', rates.sarcastic != null && crazyUp && gentleFloor,
      'lieRate = clamp(base + lieRateDelta, base, base+cap)：crazy 抬升且不超 cap、gentle 被地板夹回 base',
      'rate=' + jsonOf(rates) + ' base=' + jsonOf(base) + ' deltaCap=' + jsonOf(cap));
  } else {
    sk('X5.4', 'lieRate 随人格变化', 'Narrator.lieRate 未落地');
  }

  /* 人格池：若 narrator 行带 persona 字段则断言池子切换，否则按数据缺失记 SKIP */
  var rows = [];
  try {
    var lsP = mkLS();
    G.localStorage = lsP;
    var g55 = mkGame('demo', SEED);
    G.Game.setPersonality('gentle');
    var linesA = G.Narrator.pickRoundLines(G.Game.state, 1) || [];
    var tagged = linesA.filter(function (l) { return l && l.persona; });
    G.Game.setPersonality('crazy');
    var linesB = G.Narrator.pickRoundLines(G.Game.state, 1) || [];
    rows = { gentle: linesA.map(function (l) { return l && (l.persona || l.id); }), crazy: linesB.map(function (l) { return l && (l.persona || l.id); }), tagged: tagged.length };
  } catch (e) { rows = { error: String(e && e.message || e) }; }
  if (rows && rows.tagged) {
    var gentleOk = rows.gentle.every(function (x) { return x === 'gentle'; });
    var crazyOk = rows.crazy.every(function (x) { return x === 'crazy'; });
    c('X5.5', gentleOk && crazyOk,
      '切换人格后 pickRoundLines 返回对应人格池的行（line.persona 与当前人格一致）',
      'gentle=' + list(rows.gentle) + '；crazy=' + list(rows.crazy));
  } else if (rows && rows.error) {
    c('X5.5', false, '切换人格后旁白池随之切换', '抛错：' + rows.error);
  } else {
    sk('X5.5', '切换人格后旁白池随之切换', 'narrator 行尚未带 persona 池标记（task-27 数据未落地）');
  }

  var pf = G.Game.prefs();
  var pfRequired = [
    ['persona|personality', function (p) { return ['sarcastic', 'gentle', 'crazy'].indexOf(p.persona || p.personality) >= 0; }],
    ['bgm', function (p) { return typeof p.bgm === 'boolean'; }],
    ['sound|sfx', function (p) { return typeof p.sound === 'boolean' || typeof p.sfx === 'boolean'; }],
    ['animationSpeed|animSpeed', function (p) { return typeof p.animationSpeed === 'string' || p.animSpeed != null; }],
    ['onboarded', function (p) { return typeof p.onboarded === 'boolean'; }]
  ];
  var pfMissing = pfRequired.filter(function (pair) { return !pair[1](pf || {}); }).map(function (pair) { return pair[0]; });
  c('X5.6', !!pf && pfMissing.length === 0,
    'prefs() 含 5 项语义字段（人格/BGM/音效/动画速度/已引导），默认值正确',
    '缺失/异常=' + (pfMissing.length ? pfMissing.join('、') : '无') + '；实际=' + jsonOf(pf));

  var saveOk = G.Game.savePref('bgm', false);
  var rawBefore = ls5.getItem(KEYS.prefs) || '';
  G.Game.savePref('not_a_pref', 1);
  var pf2 = G.Game.prefs();
  var rawAfter = ls5.getItem(KEYS.prefs) || '';
  c('X5.7', saveOk !== false && pf2.bgm === false && !('not_a_pref' in (pf2 || {})) && rawAfter.indexOf('not_a_pref') < 0,
    'savePref 白名单内生效（bgm=false 落盘），白名单外的键不落盘（写入被忽略）',
    'bgm=' + jsonOf(pf2.bgm) + '；未知键写入前=' + rawBefore.length + 'B 后=' + rawAfter.length + 'B；prefs=' + jsonOf(pf2));
}

/* ==================================================================== X6 */
ck.section('阶段 v4｜新手指引：五步气泡（含 doors/decide/cashout 锚点）、done 后不再出现（§2.3/§4.1）');

if (!HAS.tutApi) {
  sk('X6.1', 'tutorialSteps() 返回三步（anchor ∈ doors|decide|cashout）', 'Game.tutorialSteps 未落地（task-26）');
  sk('X6.2', 'tutorial_done 后 flags.onboarded 与 prefs.onboarded 落盘', 'Game.tutorialSteps 未落地（task-26）');
  sk('X6.3', '已完成引导的存档下 tutorialSteps() 为空（不再打扰）', 'Game.tutorialSteps 未落地（task-26）');
  sk('X6.4', 'UI.startTutorial() 渲染 #tutorial 并在跳过后隐藏', 'UI.startTutorial 未落地（ui-render task-28）');
} else {
  var ls6 = mkLS();
  G.localStorage = ls6;
  var g61 = mkGame('demo', SEED);
  var steps = G.Game.tutorialSteps() || [];
  var anchors = ['doors', 'decide', 'cashout'];
  function anchorKey(a) { return String(a == null ? '' : a).replace(/^#/, ''); }
  var stepBad = steps.filter(function (s) {
    return !s || !s.id || !s.title || !s.text || !anchorKey(s.anchor);
  });
  var covered = anchors.filter(function (a) {
    return steps.some(function (s) { return anchorKey(s.anchor) === a; });
  });
  c('X6.1', steps.length >= 3 && stepBad.length === 0 && covered.length === anchors.length,
    'tutorialSteps() 每步都有 id/title/text 且 anchor 覆盖 doors/decide/cashout（UI 用它定位气泡）',
    '步数=' + steps.length + '（契约 §2.3：五步气泡）；anchors=' +
    list(steps.map(function (s) { return s.anchor; })) + '；覆盖=' + list(covered));

  var first6 = steps[0] || {};
  c('X6.1b', anchorKey(first6.anchor) === 'doors' && (first6.step === 1 || first6.index === 0),
    '首步锚在 #doors（开门前先把「选门」讲清楚）',
    '首步=' + jsonOf({ step: first6.step, anchor: first6.anchor, title: first6.title }));

  var done = G.Game.action({ type: 'tutorial_done' });
  var prefs6 = null;
  try { prefs6 = JSON.parse(ls6.getItem(KEYS.prefs) || 'null'); } catch (e) { prefs6 = null; }
  c('X6.2', done !== false && G.Game.state.flags.onboarded === true && !!prefs6 && prefs6.onboarded === true,
    'tutorial_done 把 flags.onboarded 与 prefs.onboarded 都置 true 并落盘',
    'action 返回=' + jsonOf(done) + ' flags.onboarded=' + G.Game.state.flags.onboarded + ' prefs=' + jsonOf(prefs6));

  var ls63 = mkLS();
  ls63.setItem(KEYS.prefs, JSON.stringify({ personality: 'sarcastic', bgm: true, sfx: true, animSpeed: 1, onboarded: true }));
  G.localStorage = ls63;
  var g63 = mkGame('demo', SEED);
  var steps63 = G.Game.tutorialSteps() || [];
  c('X6.3', steps63.length === 0 && g63.Game.state.flags.onboarded === true,
    '存档标记已完成引导时 tutorialSteps() 为空、flags.onboarded=true（不再打扰老玩家）',
    '步数=' + steps63.length + ' flags.onboarded=' + g63.Game.state.flags.onboarded);

  /* X6.5：引导末步的 action({type:'start'}) 真能开局（契约 §4.1：末步 = done + start） */
  var ls65 = mkLS();
  G.localStorage = ls65;
  var g65 = mkGame('demo', SEED);
  var started = G.Game.action({ type: 'start', mode: 'normal' });
  var advanced = await untilMs(function () { return G.Game.state.phase !== 'IDLE'; }, 4000);
  c('X6.5', started !== false && advanced && G.Game.state.round === 1,
    '引导末步的 action({type:"start",mode:"normal"}) 能真正开局（离开 IDLE，进入第 1 轮）',
    '返回=' + jsonOf(started) + ' phase=' + G.Game.state.phase + ' round=' + G.Game.state.round + ' mode=' + G.Game.state.mode);

  /* 页面级：真实 #tutorial 显示 / 跳过隐藏 */
  var tp = null, T = null;
  try { tp = Sh.createPage(); T = tp.sandbox; } catch (e) { tp = null; }
  if (!tp || !T || !T.UI || typeof T.UI.startTutorial !== 'function') {
    sk('X6.4', 'UI.startTutorial() 渲染 #tutorial 并在跳过后隐藏', 'UI.startTutorial 未落地（ui-render task-28）');
  } else {
    var tEl = tp.doc.getElementById('tutorial');
    try { T.UI.startTutorial(); } catch (e) { /* 下面断言兜底 */ }
    var shown = !!(tEl && !tEl.hidden && (tp.doc.getElementById('tutorial-text') || {}).textContent);
    var skipBtn = tp.doc.getElementById('tutorial-skip');
    if (skipBtn) tp.fire(skipBtn, 'click', {});
    await untilMs(function () { return tEl && tEl.hidden; }, 3000);
    c('X6.4', shown && !!tEl && tEl.hidden === true,
      'UI.startTutorial() 显示 #tutorial（文本非空），点「跳过」后隐藏',
      '显示=' + shown + ' 跳过后 hidden=' + (tEl ? tEl.hidden : 'null'));
  }
}

/* ==================================================================== X7 */
ck.section('阶段 v4｜竖屏提示：<400px 显示、恢复隐藏、只首次提示（§4.8）');

var pp = null, P = null;
try { pp = Sh.createPage(); P = pp.sandbox; } catch (e) { pp = null; }

if (!pp || !P) {
  sk('X7.1', 'innerHeight<400 时 #portrait-hint 可见', '页面无法在垫片中启动');
  sk('X7.2', '恢复横屏后 #portrait-hint 隐藏', '页面无法在垫片中启动');
  sk('X7.3', '竖屏提示只首次触发（portraitWarned 落盘）', '页面无法在垫片中启动');
  sk('X7.4', '六档视口下 body 无横向滚动条', '页面无法在垫片中启动');
} else {
  var hint = pp.doc.getElementById('portrait-hint');
  pp.setViewport(390, 360);
  await untilMs(function () { return hint && hint.hidden === false; }, 1500);
  c('X7.1', !!hint && hint.hidden === false,
    '竖屏（390×360，innerHeight<400）resize 后 #portrait-hint 显示',
    'hidden=' + (hint ? hint.hidden : 'null') + ' viewport=' + jsonOf(pp.viewport()));

  pp.setViewport(1280, 720);
  await untilMs(function () { return hint && hint.hidden === true; }, 1500);
  c('X7.2', !!hint && hint.hidden === true,
    '恢复横屏（1280×720）后 #portrait-hint 重新隐藏',
    'hidden=' + (hint ? hint.hidden : 'null'));

  var warned = 0;
  (pp.storage._writes || []).forEach(function (w) {
    if (w.key === KEYS.prefs && String(w.value || '').indexOf('"portraitWarned":true') >= 0) warned++;
  });
  pp.setViewport(390, 360);
  await untilMs(function () { return hint && hint.hidden === false; }, 1500);
  var warned2 = 0;
  (pp.storage._writes || []).forEach(function (w) {
    if (w.key === KEYS.prefs && String(w.value || '').indexOf('"portraitWarned":true') >= 0) warned2++;
  });
  var prefsP = null;
  try { prefsP = JSON.parse(pp.storage.getItem(KEYS.prefs) || 'null'); } catch (e) { prefsP = null; }
  c('X7.3', warned >= 1 && warned2 === warned && !!prefsP && prefsP.portraitWarned === true,
    '首次竖屏提示写入 prefs.portraitWarned=true，之后重复触发不再重复写（只提示一次）',
    '写入次数 ' + warned + ' → ' + warned2 + '；prefs=' + jsonOf(prefsP));
  pp.setViewport(1280, 720);

  var VPORTS = [[1920, 1080], [1600, 900], [1440, 900], [1366, 768], [1280, 720], [1024, 768]];
  var scrollBad = [];
  VPORTS.forEach(function (v) {
    pp.setViewport(v[0], v[1]);
    var docW = pp.doc.documentElement.clientWidth;
    var bodyW = pp.doc.body ? pp.doc.body.clientWidth : 0;
    if (bodyW > docW || docW > v[0]) scrollBad.push(v.join('×') + '(body=' + bodyW + '>' + docW + ')');
  });
  c('X7.4', scrollBad.length === 0,
    '六档常用视口下 body 宽度不超过视口（无横向滚动条）',
    '异常=' + (scrollBad.length ? scrollBad.join('、') : '无'));
}

/* ==================================================================== X8 */
ck.section('阶段 v4｜套件自检');

c('X8.1', nX >= 60,
  'ux.js 覆盖契约 v4 的 8 类接口，断言条数达到下限（≥60）',
  '实际断言条数=' + nX);

var c8 = ck.counts();
c('X8.2', c8.SKIP === 0,
  '本套件自身不再有 SKIP（接口全部落地后必须归零，SKIP 只允许来自沙箱无法执行的 headless 套件）',
  '本套件 SKIP=' + c8.SKIP + '（PASS=' + c8.PASS + ' FAIL=' + c8.FAIL + '）');

}

main().then(function () {
  ck.print();
  var c2 = ck.counts();
  process.exitCode = c2.FAIL > 0 ? 1 : 0;
}).catch(function (e) {
  console.log('\n[ux.js 运行时异常] ' + (e && e.stack ? e.stack : e));
  ck.print();
  process.exitCode = 2;
});

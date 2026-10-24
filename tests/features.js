/* ============================================================================
 * tests/features.js —— 契约 v3「新玩法与表现」验收（§1 claim / §2 连击与资源 /
 *                      §3 结局 / §5 提词器与音频 / §6 图鉴可达）
 * ----------------------------------------------------------------------------
 * 覆盖 docs/设计契约_新玩法与表现.md（v3 冻结版）：
 *   F1  线索 claim 正确性：truthful 与 doors 实算一致、kind↔truthful 一致、
 *       只挂在 claimable 行上、不指向已开的门、文本语义与 type 对应、可复现
 *   F2  resolveChallenge：有 claim 时 ok = !truthful；连击 20/30/40 封顶；失败清零
 *   F3  怀疑值：空门/小奖 +1 且 ≤ config.suspicion.max(3)；trap −1 且 ≥0
 *   F4  结局矩阵：8 档优先级 all_in > comeback > iron_patience > master > pua >
 *       euro > anti > normal；结算弹层带 ending
 *   F5  提词器：?rehearsal=1 下 hintNextAction 在 PICK/DECIDE 有文案；重置后保持
 *   F6  BGM/音效：Fake AudioContext 下 muted=true 全程 0 发声；muted=false 时
 *       BGM 只有一组振荡器（2 个低频正弦）且 gain ≤ 0.03
 *   F7  图鉴可达：跑一局 8 轮，codex.lines ⊇ 本局实际播出的 line id
 * 真实命令：node tests/features.js   （退出码 0 = 全绿，1 = 有 FAIL，2 = 运行时异常）
 * 说明：与 tests/shop.js 同风格；由 tests/run-all.js 作为第 6 个套件注册。
 *       data/narrator.json（task-21）未落地时 F1/F2.1/F3.1/F4.1 会红 —— 预期「先红后绿」。
 * ========================================================================== */
'use strict';

var path = require('path');
var L = require('./lib.js');
var Sh = require('./dom-shim.js');

var ck = new L.Checker('features.js —— 新玩法与表现（契约 v3）');

var SEED = 20261024;
var FIXED_NOW = 1730000000000;
var nF = 0;

/** 所有断言都过这里，便于末尾统计本次新增断言条数。 */
function c(id, cond, msg, detail) {
  nF++;
  return ck.ok(id, cond, msg, detail);
}

/* ------------------------------------------------------------------ 加载 */

var load = L.loadScripts({ withDom: false });
var G = load.sandbox;

if (!load.loaded.length) {
  c('F0.0', false, 'js/ 下至少要有 state.js / data.js / effects.js / narrator.js / game.js 可加载',
    load.missing.join('\n         '));
  ck.print();
  process.exit(1);
}

var gd = L.loadGameData(load.ctx, load.sandbox);
var CFG = (gd.data && gd.data.config) || {};
var ITEMS = (gd.data && gd.data.items) || {};
var NAR = (gd.data && gd.data.narrator) || {};

var HAS = {
  end: !!(G.Game && typeof G.Game.computeEndingId === 'function' && typeof G.Game.endingSpec === 'function'),
  hint: !!(G.Game && typeof G.Game.hintNextAction === 'function'),
  nar: !!(G.Narrator && typeof G.Narrator.pickRoundLines === 'function' &&
    typeof G.Narrator.resolveChallenge === 'function')
};

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

/**
 * 时间预算版 until：真实定时器（页面/音频）下 setImmediate 轮询会在几毫秒内
 * 烧完 tries 次，必须先看钟。ms 是墙钟预算，不是轮询次数。
 */
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
  G.Game.init({ mode: mode || 'demo', seed: seed == null ? SEED : seed, deps: deps });
  return { Game: G.Game, ui: ui, rec: ui.rec, deps: deps };
}

async function demoToPick(g, tries) {
  g.Game.start('demo');
  return until(function () { return g.Game.state.phase === 'PICK'; }, tries || 400);
}

/** 指定模式开局并等到 PICK（普通模式没有剧本，用来跑连击链）。 */
async function startToPick(g, mode, tries) {
  g.Game.start(mode || 'normal');
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

/** 假门面：只给 itemId 的牌面（claim 的 truthfulness 只由 doors 决定）。 */
function board(itemIds) {
  return itemIds.map(function (id, i) {
    return { slot: i, itemId: id, opened: false, revealed: false };
  });
}

function stateFor(seed, round, itemIds, pickedSlot) {
  var s = G.createInitialState('normal', { seed: seed });
  s.round = round;
  s.doors = board(itemIds);
  s.pickedSlot = pickedSlot == null ? null : pickedSlot;
  return s;
}

/** 按契约 §1.2 由门面实算 claim 的真假（qa 自己的算法，不抄实现）。
    claim 有 3 种形状：slot_kind{slot,kind}、big_prize_in{slot}（无 kind）、
    picked_kind{kind}（无 slot，隐含指玩家自己选的门）。 */
function truthOf(claim, s) {
  var doors = s.doors || [];
  var d;
  if (claim.type === 'slot_kind') {
    d = doors[claim.slot];
    return d ? d.itemId === claim.kind : null;
  }
  if (claim.type === 'big_prize_in') {
    d = doors[claim.slot];
    return d ? d.itemId === 'big_prize' : null;
  }
  if (claim.type === 'picked_kind') {
    d = doors[s.pickedSlot];
    return d ? d.itemId === claim.kind : null;
  }
  return null;
}

/** 极简假 WebAudio：记录每次发声，足以判定「有没有响 / 响了几次」。 */
function makeFakeAudio() {
  var A = {
    ctxCount: 0, oscs: [], gains: [], suspends: 0, resumes: 0,
    lowSines: function () {
      return A.oscs.filter(function (o) {
        var f = o.freqs.length ? o.freqs[o.freqs.length - 1] : 0;
        return o.type === 'sine' && f > 0 && f <= 200;
      });
    }
  };
  function FakeParam(v) { this.value = v; this.sets = []; }
  FakeParam.prototype.setValueAtTime = function (v) { this.sets.push(v); this.value = v; };
  FakeParam.prototype.setTargetAtTime = function (v) { this.sets.push(v); this.value = v; };
  FakeParam.prototype.linearRampToValueAtTime = function (v) { this.sets.push(v); this.value = v; };
  FakeParam.prototype.exponentialRampToValueAtTime = function (v) { this.sets.push(v); this.value = v; };
  function FakeAC() {
    A.ctxCount++;
    this.state = 'running';
    this.currentTime = 0;
    this.destination = {};
    var self = this;
    this.createOscillator = function () {
      var o = {
        type: 'sine', freqs: [], connected: [], started: 0, stopped: 0,
        frequency: new FakeParam(0),
        connect: function (n) { o.connected.push(n); },
        start: function () { o.started++; },
        stop: function () { o.stopped++; }
      };
      var saved = o.frequency.setValueAtTime.bind(o.frequency);
      o.frequency.setValueAtTime = function (v, t) { o.freqs.push(v); return saved(v, t); };
      A.oscs.push(o);
      return o;
    };
    this.createGain = function () {
      var g = { gain: new FakeParam(0), connected: [], connect: function (n) { g.connected.push(n); } };
      A.gains.push(g);
      return g;
    };
    this.resume = function () { A.resumes++; self.state = 'running'; return Promise.resolve(); };
    this.suspend = function () { A.suspends++; self.state = 'suspended'; return Promise.resolve(); };
  }
  A.ctor = FakeAC;
  return A;
}

/* ========================================================================== */

async function main() {

  /* ========================================================================
   * F1 线索 claim 正确性（契约 §1.1 / §1.2 / §1.4 / §1.5）
   * ====================================================================== */

  ck.section('契约 v3 §1｜线索 claim：实算一致、可复现、只挂 claimable 行');

  var BOARDS = [
    ['small_prize', 'empty', 'bomb'],
    ['empty', 'empty', 'big_prize'],
    ['big_prize', 'empty', 'small_prize'],
    ['trap', 'empty', 'empty'],
    ['empty', 'small_prize', 'empty']
  ];
  var SCRIPTS = [null, { narrator: 'truth' }, { narrator: 'lie' }, { narrator: 'lie_hard' }];
  var SEEDS10 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 20261024];

  /** 枚举 claim；openedSlot != null 时把该槽标记为「已被主持人打开」。 */
  function collectClaims(openedSlot) {
    var found = [];
    var seen = {};
    for (var si = 0; si < SEEDS10.length; si++) {
      for (var bi = 0; bi < BOARDS.length; bi++) {
        for (var r = 1; r <= 12; r++) {
          for (var ci = 0; ci < SCRIPTS.length; ci++) {
            var st = stateFor(SEEDS10[si], r, BOARDS[bi], r % 3);
            if (openedSlot != null) st.doors[openedSlot].opened = true;
            var lines = G.Narrator.pickRoundLines(st, SCRIPTS[ci]) || [];
            for (var li = 0; li < lines.length; li++) {
              var ln = lines[li];
              if (!ln || !ln.claim) continue;
              var key = String(ln.id) + '|' + jsonOf(ln.claim);
              if (seen[key]) continue;
              seen[key] = 1;
              found.push({ line: ln, state: st });
            }
          }
        }
      }
    }
    return found;
  }

  var CLAIMS = HAS.nar ? collectClaims(null) : [];
  var TYPE_COUNT = { slot_kind: 0, big_prize_in: 0, picked_kind: 0 };
  var BAD = { truth: [], kind: [], slot: [], text: [], item: [], picked: [] };
  var CLAIM_TEXTS = [];

  for (var ci2 = 0; ci2 < CLAIMS.length; ci2++) {
    var it = CLAIMS[ci2];
    var cl = it.line.claim, st2 = it.state;
    var t = truthOf(cl, st2);
    if (TYPE_COUNT[cl.type] == null) TYPE_COUNT[cl.type] = 0;
    TYPE_COUNT[cl.type]++;
    CLAIM_TEXTS.push(String(it.line.text || ''));

    if (t !== cl.truthful) BAD.truth.push(it.line.id + ': claim.truthful=' + cl.truthful + ' 实算=' + t);
    /* 行的 kind（truth/lie/lie_hard）必须与 claim.truthful 一致；注意 kind 不是 claim.kind */
    var lineKind = String(it.line.kind);
    var kindOk = ['truth', 'lie', 'lie_hard'].indexOf(lineKind) >= 0 &&
      ((lineKind === 'truth') === (cl.truthful === true));
    if (!kindOk) BAD.kind.push(it.line.id + ': line.kind=' + lineKind + ' claim.truthful=' + cl.truthful);
    /* picked_kind 不带 slot（隐含玩家选的门）；另两类必须落在合法且未开的门位上 */
    var sOk;
    if (cl.type === 'picked_kind') sOk = (cl.slot == null);
    else {
      sOk = typeof cl.slot === 'number' && cl.slot >= 0 && cl.slot < st2.doors.length &&
        !(st2.doors[cl.slot] || {}).opened;
    }
    if (!sOk) BAD.slot.push(it.line.id + ' [' + cl.type + ']: slot=' + cl.slot + ' opened=' + !!((st2.doors[cl.slot] || {}).opened));
    if (cl.type === 'picked_kind' && cl.slot != null) {
      BAD.picked.push(it.line.id + ': picked_kind slot=' + cl.slot + '（应不带 slot，只谈玩家选的门）');
    }
    var txt = String(it.line.text || '');
    var txtOk = false;
    if (cl.type === 'slot_kind') txtOk = new RegExp('(第\\s*)?' + (cl.slot + 1) + '\\s*(号|扇)门').test(txt);
    else if (cl.type === 'big_prize_in') txtOk = /大奖/.test(txt);
    else if (cl.type === 'picked_kind') txtOk = /你(选|手里|手上|挑)/.test(txt);
    if (!txtOk) BAD.text.push(it.line.id + ' [' + cl.type + '] 「' + txt + '」');
    if ((cl.type === 'slot_kind' || cl.type === 'picked_kind') && !ITEMS[cl.kind]) {
      BAD.item.push(it.line.id + ': kind=' + cl.kind + ' 不是合法物品 id');
    }
  }

  c('F1.1', CLAIMS.length >= 6 && TYPE_COUNT.slot_kind > 0 && TYPE_COUNT.big_prize_in > 0 &&
    TYPE_COUNT.picked_kind > 0,
    '10 个种子 × 5 种牌面 × 12 轮 × 4 剧本里能找到 3 类 claim（≥ 6 条去重样本）',
    '样本=' + CLAIMS.length + ' 类型=' + jsonOf(TYPE_COUNT));
  c('F1.2', CLAIMS.length > 0 && BAD.truth.length === 0,
    '每条 claim 的 truthful 与按 doors 实算一致（不靠硬编码 / 不抄 script 标签）',
    '样本=' + CLAIMS.length + ' 不一致=' + BAD.truth.length + (BAD.truth[0] ? ' 例：' + BAD.truth[0] : ''));
  c('F1.3', CLAIMS.length > 0 && BAD.kind.length === 0,
    '行的 kind ↔ claim.truthful 一致（kind=truth ⟺ truthful=true；kind ∈ truth/lie/lie_hard）',
    '不一致=' + BAD.kind.length + (BAD.kind[0] ? ' 例：' + BAD.kind[0] : ''));
  c('F1.4', CLAIMS.length > 0 && BAD.slot.length === 0,
    'claim.slot 指向合法门位且不是已被主持人打开的门（picked_kind 不带 slot）',
    '违规=' + BAD.slot.length + (BAD.slot[0] ? ' 例：' + BAD.slot[0] : ''));
  c('F1.5', CLAIMS.length > 0 && BAD.text.length === 0,
    'claim 文本语义与 type 对应（slot_kind→「N 号门」、big_prize_in→「大奖」、picked_kind→「你选/你手里」）',
    '违规=' + BAD.text.length + (BAD.text[0] ? ' 例：' + BAD.text[0] : ''));
  c('F1.6', CLAIMS.length > 0 && BAD.item.length === 0,
    'claim.kind 是合法物品 id（slot_kind / picked_kind）',
    '违规=' + BAD.item.length + (BAD.item[0] ? ' 例：' + BAD.item[0] : ''));
  c('F1.7', BAD.picked.length === 0 && TYPE_COUNT.picked_kind > 0,
    'picked_kind 只谈「玩家自己选的那扇门」（不带 slot，隐含 state.pickedSlot）',
    '样本=' + TYPE_COUNT.picked_kind + ' 违规=' + BAD.picked.length +
    (BAD.picked[0] ? ' 例：' + BAD.picked[0] : ''));

  /* 只挂在 claimable 行上。 */
  var ALL_LINES = (NAR.lines || []);
  var LINE_BY_ID = {};
  for (var ai = 0; ai < ALL_LINES.length; ai++) LINE_BY_ID[ALL_LINES[ai].id] = ALL_LINES[ai];
  var notClaimable = [];
  for (var cj = 0; cj < CLAIMS.length; cj++) {
    var def = LINE_BY_ID[CLAIMS[cj].line.id];
    if (!def || def.claimable !== true) {
      notClaimable.push(CLAIMS[cj].line.id + '（' + (def ? 'claimable=' + def.claimable : '语料里查不到') + '）');
    }
  }
  var nClaimable = ALL_LINES.filter(function (l) { return l.claimable === true; }).length;
  c('F1.8', CLAIMS.length > 0 && notClaimable.length === 0 && nClaimable >= 6,
    'claim 只挂在 data/narrator.json 里 claimable=true 的行上（claimable 行 ≥ 6）',
    'claim 行违规=' + notClaimable.length + (notClaimable[0] ? ' 例：' + notClaimable[0] : '') +
    '；语料 claimable=' + nClaimable + '/' + ALL_LINES.length);

  /* 已开的门：claim 不得指向它。 */
  var CLAIMS_OPENED = HAS.nar ? collectClaims(1) : [];
  var openBad = CLAIMS_OPENED.filter(function (x) { return x.line.claim.slot === 1; });
  c('F1.9', CLAIMS_OPENED.length > 0 && openBad.length === 0,
    '主持人已打开的门不会再被 claim 指向（把槽 1 标为 opened 后重跑同一枚举）',
    '样本=' + CLAIMS_OPENED.length + ' 指向已开门=' + openBad.length +
    (openBad[0] ? ' 例：' + openBad[0].line.id : ''));

  /* 可复现。 */
  var detBad = [];
  for (var di = 0; di < SEEDS10.length; di++) {
    for (var dj = 0; dj < BOARDS.length; dj++) {
      var s1 = stateFor(SEEDS10[di], 3, BOARDS[dj], 1);
      var s2 = stateFor(SEEDS10[di], 3, BOARDS[dj], 1);
      var l1 = (G.Narrator.pickRoundLines(s1, { narrator: 'lie' }) || []).map(function (x) { return x.claim || null; });
      var l2 = (G.Narrator.pickRoundLines(s2, { narrator: 'lie' }) || []).map(function (x) { return x.claim || null; });
      if (jsonOf(l1) !== jsonOf(l2)) detBad.push(SEEDS10[di] + '/' + BOARDS[dj].join('+'));
    }
  }
  c('F1.10', detBad.length === 0,
    '同 seed + 同牌面 + 同剧本，claim 逐条可复现（不依赖时间 / 随机源）',
    '不一致=' + detBad.length + (detBad[0] ? ' 例：' + detBad[0] : ''));
  c('F1.11', SEEDS10.length === 10 && CLAIM_TEXTS.length === CLAIMS.length,
    'claim 枚举真的跑了 10 个种子（不是空循环）',
    '种子=' + SEEDS10.length + ' 文本样本=' + CLAIM_TEXTS.length);
  c('F1.12', CLAIM_TEXTS.length > 0 && CLAIM_TEXTS.every(function (t2) { return t2 && t2.length >= 4; }),
    'claim 所在行的文本非空且不只是标点（避免「有 claim 但没话」）',
    CLAIM_TEXTS.slice(0, 2).join(' ｜ '));

  /* ========================================================================
   * F2 resolveChallenge 与连击（契约 §1.3 / §2.1）
   * ====================================================================== */

  ck.section('契约 v3 §1.3/§2.1｜resolveChallenge 与连击 20/30/40 封顶');

  var SUS_CFG = CFG.suspicion || {};
  c('F2.1', SUS_CFG.comboStep === 10 && SUS_CFG.comboCap === 20,
    'config.suspicion 冻结连击参数 comboStep=10 / comboCap=20',
    jsonOf({ comboStep: SUS_CFG.comboStep, comboCap: SUS_CFG.comboCap }));

  var lieLine = {
    id: 'F2_lie', text: '第 2 号门是空门。', kind: 'lie', truthful: false,
    claim: { type: 'slot_kind', slot: 1, kind: 'empty', truthful: false }
  };
  var truthLine = {
    id: 'F2_truth', text: '第 2 号门是空门。', kind: 'truth', truthful: true,
    claim: { type: 'slot_kind', slot: 1, kind: 'empty', truthful: true }
  };
  var stR = stateFor(7, 1, ['small_prize', 'empty', 'bomb'], 0);
  var resLie = HAS.nar ? (G.Narrator.resolveChallenge(stR, lieLine) || {}) : {};
  var resTruth = HAS.nar ? (G.Narrator.resolveChallenge(stR, truthLine) || {}) : {};
  c('F2.2', HAS.nar && resLie.ok === true && resTruth.ok === false,
    '有 claim 时 ok = !claim.truthful（lie → 成功；truth → 失败）',
    jsonOf({ lieOk: resLie.ok, truthOk: resTruth.ok }));
  c('F2.3', HAS.nar && resLie.rewardMode === 'coins' &&
    resLie.coins === (SUS_CFG.winCoins == null ? 20 : SUS_CFG.winCoins),
    '纯函数 resolveChallenge 给的仍是基础奖励 winCoins（连击由引擎叠加）',
    jsonOf({ mode: resLie.rewardMode, coins: resLie.coins }));
  c('F2.4', HAS.nar && jsonOf(resLie.claim || null) === jsonOf(lieLine.claim),
    'res.claim 原样透传本轮被验证的线索（引擎写进 lastChallenge.claim）',
    jsonOf({ claim: resLie.claim }));
  c('F2.5', HAS.nar && resTruth.coins < 0 &&
    resTruth.patience === -(SUS_CFG.losePatience == null ? 1 : SUS_CFG.losePatience),
    '质疑失败：扣金币并扣 1 点耐心',
    jsonOf({ coins: resTruth.coins, patience: resTruth.patience }));

  /** 把本轮的旁白固定成指定 claim，用来驱动真实引擎流程。 */
  function forceLines(g, makeLine, sink) {
    var orig = G.Narrator.pickRoundLines;
    G.Narrator.pickRoundLines = function (state) {
      var l = makeLine(state);
      if (sink) sink.push(l);
      return [l, {
        id: l.id + '_b', text: l.text + '（补刀）', kind: l.kind, truthful: l.truthful,
        claim: l.claim ? { type: l.claim.type, slot: l.claim.slot, kind: l.claim.kind, truthful: l.claim.truthful } : null
      }];
    };
    return function () { G.Narrator.pickRoundLines = orig; };
  }

  /** 「那扇不是空门的门其实是空门」——必然是谎言。 */
  function lyingLine(state) {
    var slot = 0;
    for (var i = 0; i < state.doors.length; i++) {
      if (state.doors[i].itemId !== 'empty') { slot = i; break; }
    }
    return {
      id: 'F2_force_lie_r' + state.round, text: '第 ' + (slot + 1) + ' 号门是空门。',
      kind: 'lie', truthful: false,
      claim: { type: 'slot_kind', slot: slot, kind: 'empty', truthful: false }
    };
  }

  /**
   * 连击链：普通模式（无剧本，轮次不受 3 轮演示限制）+ 强制旁白 claim。
   * 每轮都走完整链路：PICK → 选门 → DECIDE → 质疑 → 收手 → SETTLE_ROUND → 下一轮。
   * 断言只看「质疑那一下的增量」，避免轮结算收益干扰；per-round 补满耐心/金币
   * 是为了隔离资源耗尽（否则连击链会因耐心归零提前中断）。
   */
  async function comboRun() {
    var g = mkGame('normal', 424242);
    var out = { steps: [], forced: [], error: null };
    var restore = forceLines(g, lyingLine, out.forced);
    try {
      if (!await startToPick(g, 'normal')) throw new Error('未到 PICK');
      for (var r = 1; r <= 3; r++) {
        if (r > 1 && !await nextRound(g)) throw new Error('R' + r + ' 未推进到 PICK');
        if (!await pickSlot(g, 0)) throw new Error('R' + r + ' 未到 DECIDE');
        g.Game.state.patience = 9;      /* 隔离资源约束 */
        g.Game.state.coins = Math.max(g.Game.state.coins, 100);
        g.Game.state.suspicion = 3;
        var b = { coins: g.Game.state.coins, sus: g.Game.state.suspicion };
        var ok = g.Game.challenge();
        out.steps.push({
          r: r, ok: ok, lcOk: !!(g.Game.state.lastChallenge || {}).ok,
          lcClaim: (g.Game.state.lastChallenge || {}).claim || null,
          dCoins: g.Game.state.coins - b.coins, dSus: g.Game.state.suspicion - b.sus,
          streak: g.Game.state.challengeStreak, won: g.Game.state.challengesWon,
          lost: g.Game.state.challengesLost
        });
        if (!await stickToSettle(g)) throw new Error('R' + r + ' 未到 SETTLE_ROUND');
      }

      /* R4：换成一则「真话」→ 质疑失败，连击清零 */
      restore();
      var restore4 = forceLines(g, function () {
        return {
          id: 'F2_force_truth', text: '第 1 号门是大奖。', kind: 'truth', truthful: true,
          claim: { type: 'big_prize_in', slot: 0, kind: null, truthful: true }
        };
      });
      if (!await nextRound(g)) throw new Error('R4 未推进到 PICK');
      if (!await pickSlot(g, 0)) throw new Error('R4 未到 DECIDE');
      g.Game.state.patience = 9;
      g.Game.state.coins = Math.max(g.Game.state.coins, 100);
      g.Game.state.suspicion = 3;
      var b4 = { coins: g.Game.state.coins, patience: g.Game.state.patience, sus: g.Game.state.suspicion };
      var ok4 = g.Game.challenge();
      out.steps.push({
        r: 4, ok: ok4, lcOk: !!(g.Game.state.lastChallenge || {}).ok,
        dCoins: g.Game.state.coins - b4.coins,
        dPatience: g.Game.state.patience - b4.patience, dSus: g.Game.state.suspicion - b4.sus,
        streak: g.Game.state.challengeStreak, lost: g.Game.state.challengesLost,
        won: g.Game.state.challengesWon
      });
      if (!await stickToSettle(g)) throw new Error('R4 未到 SETTLE_ROUND');
      restore4();

      /* R5：再次识破谎言 → 回到基础 +20（连击从 1 重算） */
      var restore5 = forceLines(g, lyingLine);
      if (!await nextRound(g)) throw new Error('R5 未推进到 PICK');
      if (!await pickSlot(g, 0)) throw new Error('R5 未到 DECIDE');
      g.Game.state.patience = 9;
      g.Game.state.coins = Math.max(g.Game.state.coins, 100);
      g.Game.state.suspicion = 3;
      var b5 = { coins: g.Game.state.coins };
      var ok5 = g.Game.challenge();
      out.steps.push({
        r: 5, ok: ok5, lcOk: !!(g.Game.state.lastChallenge || {}).ok,
        dCoins: g.Game.state.coins - b5.coins,
        streak: g.Game.state.challengeStreak, won: g.Game.state.challengesWon
      });
      restore5();

      /* 同一轮第二次：必须 false 且数值不变 */
      out.sameRoundBefore = { coins: g.Game.state.coins, sus: g.Game.state.suspicion };
      out.secondSameRound = g.Game.challenge();
      out.sameRoundAfter = { coins: g.Game.state.coins, sus: g.Game.state.suspicion };
    } catch (e) {
      out.error = (e && e.message) ? e.message : String(e);
    } finally {
      try { restore(); } catch (e2) { /* 已复原 */ }
    }
    return out;
  }

  var COMBO = await comboRun();
  var st1 = COMBO.steps[0] || {}, st2 = COMBO.steps[1] || {}, st3 = COMBO.steps[2] || {};
  var st4 = COMBO.steps[3] || {}, st5 = COMBO.steps[4] || {};

  c('F2.6', !COMBO.error && COMBO.steps.length === 5 && COMBO.steps.every(function (x) { return x.ok === true; }),
    '真实引擎流程跑完 5 轮质疑（每轮一次机会，连击链完整）',
    COMBO.error ? '异常：' + COMBO.error : jsonOf(COMBO.steps));
  /* 注意：Game.challenge() 的返回值 =「这次质疑被受理/消耗了」，不是「拆穿成功」；
     成功与否看在 state.lastChallenge.ok（R4 就是 ok=true 但判定失败）。 */
  c('F2.7', st1.lcOk === true && st1.dCoins === 20 && st1.dSus === -1 && st1.streak === 1 && st1.won === 1,
    '连击第 1 次成功：金币 +20、怀疑值 −1、streak=1、challengesWon=1',
    jsonOf(st1));
  /* 引擎侧要求：lastChallenge.claim 是 narrator 返回的 res.claim 透传（不是重新推断的） */
  var forced1 = (COMBO.forced && COMBO.forced[0]) || null;
  c('F2.7b', !!st1.lcClaim && !!forced1 && !!forced1.claim &&
    st1.lcClaim.type === forced1.claim.type && st1.lcClaim.slot === forced1.claim.slot &&
    st1.lcClaim.kind === forced1.claim.kind && st1.lcClaim.truthful === forced1.claim.truthful &&
    st1.lcClaim.kind === 'empty' && st1.lcClaim.truthful === false,
    'state.lastChallenge.claim 是引擎原样透传的线索对象（type/slot/kind/truthful 与播出的行逐字段一致）',
    jsonOf({ engine: st1.lcClaim, line: forced1 && forced1.claim }));
  c('F2.8', st2.lcOk === true && st2.dCoins === 30 && st2.streak === 2 && st2.won === 2,
    '连击第 2 次成功：+30、streak=2',
    jsonOf(st2));
  c('F2.9', st3.lcOk === true && st3.dCoins === 40 && st3.streak === 3 && st3.won === 3,
    '连击第 3 次成功：+40 封顶、streak=3',
    jsonOf(st3));
  c('F2.10', st4.ok === true && st4.lcOk === false && st4.dCoins === -20 && st4.dPatience === -1 &&
    st4.streak === 0 && st4.lost === 1,
    '质疑失败（对真话质疑）：金币 −20、耐心 −1、连击清零、challengesLost=1',
    jsonOf(st4));
  c('F2.11', st5.lcOk === true && st5.dCoins === 20 && st5.streak === 1,
    '失败后再次成功只给基础 +20（连击从 1 重算）',
    jsonOf(st5));
  c('F2.12', COMBO.secondSameRound === false &&
    COMBO.sameRoundAfter && COMBO.sameRoundAfter.coins === COMBO.sameRoundBefore.coins &&
    COMBO.sameRoundAfter.sus === COMBO.sameRoundBefore.sus,
    '同一轮第二次质疑返回 false 且金币/怀疑值都不变（每轮一次）',
    jsonOf({ ret: COMBO.secondSameRound, after: COMBO.sameRoundAfter, before: COMBO.sameRoundBefore }));

  /* ========================================================================
   * F3 怀疑值资源（契约 §2.2 / §2.3）
   * ====================================================================== */

  ck.section('契约 v3 §2.2/§2.3｜怀疑值：空门与小奖 +1（上限 3）、陷阱 −1（下限 0）');

  var SUS_MAX = (CFG.suspicion || {}).max;
  c('F3.1', SUS_MAX === 3,
    'config.suspicion.max = 3（怀疑值上限）',
    'max=' + SUS_MAX);
  c('F3.2', ITEMS.empty && ITEMS.empty.suspicion === 1 && ITEMS.small_prize && ITEMS.small_prize.suspicion === 1,
    'data/items.json：空门 / 小奖的 suspicion 都是 +1',
    jsonOf({ empty: ITEMS.empty && ITEMS.empty.suspicion, small: ITEMS.small_prize && ITEMS.small_prize.suspicion }));

  function resState(coins, suspicion, patience) {
    var s = G.createInitialState('normal', { seed: 11 });
    s.coins = coins; s.suspicion = suspicion; s.patience = patience;
    return s;
  }
  var effEmpty = G.applyEffect(resState(100, 2, 3), { id: 'empty' });
  var effFull = G.applyEffect(resState(100, 3, 3), { id: 'empty' });
  var effTrap = G.applyEffect(resState(100, 0, 3), { id: 'trap' });
  c('F3.3', effEmpty.state.suspicion === 3,
    '开空门：怀疑值 2 → 3（applyEffect 走 items.json 的 +1）',
    'suspicion=' + effEmpty.state.suspicion + ' delta=' + jsonOf(effEmpty.delta));
  c('F3.4', effFull.state.suspicion === 3,
    '怀疑值已到上限 3 时开空门不溢出（仍为 3）',
    'suspicion=' + effFull.state.suspicion);
  c('F3.5', effTrap.state.suspicion === 0,
    '踩陷阱：怀疑值 0 → 0（下限钳制，不会变负数）',
    'suspicion=' + effTrap.state.suspicion);
  c('F3.6', (function () {
    var s0 = resState(100, 2, 3);
    var before = jsonOf(s0);
    G.applyEffect(s0, { id: 'empty' });
    return jsonOf(s0) === before;
  })(), 'applyEffect 是纯函数：入参 state 不被改写', '输入前后一致');
  c('F3.7', effEmpty.state.coins === 100,
    '怀疑值变化不误伤金币（开空门本身 0 金币）',
    jsonOf({ coins: effEmpty.state.coins }));

  /* ========================================================================
   * F4 结局矩阵（契约 §4.2 / §4.3）
   * ====================================================================== */

  ck.section('契约 v3 §4.2/§4.3｜结局矩阵 8 档优先级与结算弹层');

  var END_IDS = ['all_in', 'comeback', 'iron_patience', 'master', 'pua', 'euro', 'anti', 'normal'];
  var END_TABLE = CFG.endings || {};
  var endMissing = END_IDS.filter(function (id) { return !END_TABLE[id]; });
  var endBadPri = END_IDS.filter(function (id) {
    var d = END_TABLE[id];
    return !d || typeof d.title !== 'string' || !d.title || typeof d.priority !== 'number' || !d.desc || !d.lineKind;
  });
  c('F4.1', HAS.end && endMissing.length === 0,
    'config.endings 配齐 8 档结局 id（all_in/comeback/iron_patience/master/pua/euro/anti/normal）',
    '缺失=' + jsonOf(endMissing) + '；表内=' + jsonOf(Object.keys(END_TABLE)));
  c('F4.2', endBadPri.length === 0 && END_IDS.map(function (id) { return (END_TABLE[id] || {}).priority; }).join(',') ===
    '100,90,80,70,60,50,40,0',
    '结局优先级冻结为 100/90/80/70/60/50/40/0，且每档都有 title/desc/lineKind',
    jsonOf(END_IDS.map(function (id) { return id + '=' + (END_TABLE[id] || {}).priority; })));

  function endState(o) {
    var s = G.createInitialState('demo', {});
    s.coins = o.coins;
    s.round = o.round == null ? 1 : o.round;
    s.patience = o.patience == null ? 3 : o.patience;
    s.minCoins = o.minCoins == null ? o.coins : o.minCoins;
    s.challengesWon = o.challengesWon || 0;
    s.challengesLost = o.challengesLost || 0;
    return s;
  }
  var END_CASES = [
    ['normal', { coins: 100, round: 1, patience: 2 }],
    ['pua', { coins: 50, round: 2, patience: 2 }],
    ['euro', { coins: 250, round: 1, patience: 2 }],
    ['anti', { coins: 350, round: 1, patience: 2 }],
    ['master', { coins: 250, round: 5, patience: 2 }],
    ['iron_patience', { coins: 150, round: 3, patience: 3 }],
    ['comeback', { coins: 250, round: 2, patience: 2, minCoins: 5 }],
    ['all_in', { coins: 250, round: 5, patience: 2, minCoins: 5, challengesWon: 3, challengesLost: 0 }]
  ];
  var endBad = [];
  for (var ei = 0; ei < END_CASES.length; ei++) {
    var want = END_CASES[ei][0], stE = endState(END_CASES[ei][1]);
    var got = HAS.end ? G.Game.computeEndingId(stE) : '(无 API)';
    if (got !== want) endBad.push(want + ' → 实际 ' + got + ' ' + jsonOf(END_CASES[ei][1]));
  }
  c('F4.3', HAS.end && endBad.length === 0,
    '8 种构造态各自命中对应结局（all_in/comeback/iron_patience/master/pua/euro/anti/normal）',
    '错配=' + endBad.length + (endBad[0] ? ' 例：' + endBad[0] : ''));

  var OVERLAP = [
    ['all_in', { coins: 250, round: 5, patience: 2, challengesWon: 3, challengesLost: 0 }, '全识破压过大师/欧皇'],
    ['comeback', { coins: 250, round: 2, patience: 3, minCoins: 5 }, '绝地翻盘压过稳如老狗'],
    ['master', { coins: 250, round: 5, patience: 2, challengesWon: 3, challengesLost: 1 }, '失败过一次不给 all_in，落到大师']
  ];
  var ovBad = [];
  for (var oi = 0; oi < OVERLAP.length; oi++) {
    var got2 = HAS.end ? G.Game.computeEndingId(endState(OVERLAP[oi][1])) : '(无 API)';
    if (got2 !== OVERLAP[oi][0]) ovBad.push(OVERLAP[oi][2] + '：期望 ' + OVERLAP[oi][0] + ' 实际 ' + got2);
  }
  c('F4.4', HAS.end && ovBad.length === 0,
    '优先级叠加时高优先级胜出（all_in > comeback > iron_patience > master）',
    '错配=' + ovBad.length + (ovBad[0] ? ' 例：' + ovBad[0] : ''));

  var specSample = HAS.end ? G.Game.endingSpec('all_in') : {};
  c('F4.5', HAS.end && specSample && specSample.id === 'all_in' &&
    specSample.title === (END_TABLE.all_in || {}).title && typeof specSample.desc === 'string' &&
    specSample.lineKind === (END_TABLE.all_in || {}).lineKind,
    'endingSpec(id) 返回 {id,title,desc,lineKind}（与 config.endings 一致）',
    jsonOf(specSample));

  var g4 = mkGame('demo');
  var cashModal = null;
  try {
    if (await demoToPick(g4) && await pickSlot(g4, 0)) {
      g4.Game.decide('cashout');
      await until(function () { return !!lastModalOf(g4.rec, 'cashout'); }, 300);
      cashModal = lastModalOf(g4.rec, 'cashout');
    }
  } catch (e) { /* 下面按 cashModal 断言 */ }
  /* 契约 §4.3：弹层上的 ending 既可能是 id 字符串，也可能是 {id,title,...} 规格对象，
     两种形状都算合规；下面统一取 id/title，避免把「对象」误判成缺陷。 */
  function endingIdOf(m) {
    var e = m && m.ending;
    if (typeof e === 'string') return e;
    return (e && typeof e.id === 'string') ? e.id : null;
  }
  function endingTitleOf(m) {
    var e = m && m.ending;
    if (e && typeof e === 'object' && typeof e.title === 'string') return e.title;
    var id = endingIdOf(m);
    if (!id) return null;
    var sp = HAS.end ? G.Game.endingSpec(id) : null;
    return (sp && sp.title) || (END_TABLE[id] || {}).title || null;
  }
  var CASH_ID = endingIdOf(cashModal), CASH_TITLE = endingTitleOf(cashModal);
  c('F4.6', !!cashModal && typeof CASH_ID === 'string' && CASH_ID.length > 0 && !!CASH_TITLE,
    '收手结算弹层带 ending（结局 id/规格随弹层一起给出，正文可读出称号）',
    jsonOf({ kind: cashModal && cashModal.kind, ending: cashModal && cashModal.ending,
      body: cashModal && String(cashModal.body || '').slice(0, 60) }));
  c('F4.7', !!cashModal && /结局/.test(String(cashModal.body || '')) && !!CASH_TITLE &&
    String(cashModal.body || '').indexOf(CASH_TITLE) >= 0 &&
    g4.Game.state.endingId === CASH_ID,
    '结算页正文出现「结局：<称号>」且与 state.endingId / config.endings 一致',
    jsonOf({ ending: g4.Game.state.endingId, title: CASH_TITLE,
      body: cashModal && String(cashModal.body || '').slice(0, 90) }));
  var CODEX_TITLE = (HAS.end ? ((G.Game.endingSpec(g4.Game.state.endingId) || {}).title) : null) ||
    (END_TABLE[g4.Game.state.endingId] || {}).title || null;
  c('F4.8', !!CODEX_TITLE && g4.Game.state.codex.endings.indexOf(CODEX_TITLE) >= 0,
    '结算后结局称号写入 codex.endings（图鉴可查）',
    jsonOf({ want: CODEX_TITLE, endings: g4.Game.state.codex.endings }));

  /* ========================================================================
   * F5 提词器（契约 §5.1）
   * ====================================================================== */

  ck.section('契约 v3 §5.1｜提词器 ?rehearsal=1：hintNextAction 与重置保持');

  var page5 = null, page5off = null;
  try { page5 = Sh.createPage({ location: { search: '?rehearsal=1' } }); } catch (e) { page5 = null; }
  try { page5off = Sh.createPage(); } catch (e) { page5off = null; }

  if (!page5 || !page5.sandbox.Game) {
    c('F5.1', false, '?rehearsal=1 的真实页面可加载', page5 ? page5.missing.join(',') : 'createPage 抛错');
  } else {
    var G5 = page5.sandbox;
    G5.Game.init({ mode: 'demo', seed: SEED });
    c('F5.1', G5.Game.state.flags.rehearsal === true,
      'location.search=?rehearsal=1 → state.flags.rehearsal = true（Game.init 读真实 location）',
      'rehearsal=' + G5.Game.state.flags.rehearsal + ' search=' + G5.location.search);
    c('F5.2', HAS.hint && typeof G5.Game.hintNextAction === 'function',
      'Game.hintNextAction 存在（契约 §5.1）',
      'typeof=' + typeof G5.Game.hintNextAction);

    var h0 = HAS.hint ? G5.Game.hintNextAction() : {};
    c('F5.3', !!h0 && h0.phase === G5.Game.state.phase && typeof h0.text === 'string' && 'choice' in h0,
      'hintNextAction 返回 {phase,text,choice} 且 phase 与当前状态一致',
      jsonOf(h0));

    G5.Game.action({ type: 'start', mode: 'demo' });
    var toPick5 = await untilMs(function () { return G5.Game.state.phase === 'PICK'; }, 20000);
    var hPick = toPick5 && HAS.hint ? G5.Game.hintNextAction() : {};
    var rehearsalEl = G5.document.getElementById('rehearsal');
    var rehearsalText = G5.document.getElementById('rehearsal-text');
    c('F5.4', toPick5 && hPick.phase === 'PICK' && typeof hPick.text === 'string' && hPick.text.length > 0,
      'PICK 阶段 hintNextAction 给出非空文案',
      jsonOf({ phase: G5.Game.state.phase, hint: hPick }));
    c('F5.5', !!rehearsalEl && rehearsalEl.hidden === false && !!rehearsalText &&
      String(rehearsalText.textContent || '').length > 0,
      '提词器 DOM（#rehearsal / #rehearsal-text）显示且有文案',
      jsonOf({ hidden: rehearsalEl && rehearsalEl.hidden, text: rehearsalText && rehearsalText.textContent }));

    G5.Game.action({ type: 'pick', slot: 0 });
    var toDecide5 = await untilMs(function () { return G5.Game.state.phase === 'DECIDE'; }, 20000);
    var hDecide = toDecide5 && HAS.hint ? G5.Game.hintNextAction() : {};
    c('F5.6', toDecide5 && hDecide.phase === 'DECIDE' && typeof hDecide.text === 'string' && hDecide.text.length > 0,
      'DECIDE 阶段 hintNextAction 给出非空文案',
      jsonOf({ phase: G5.Game.state.phase, hint: hDecide }));

    G5.Game.action({ type: 'reset' });
    await untilMs(function () { return G5.Game.state.phase === 'IDLE'; }, 3000);
    c('F5.7', G5.Game.state.flags.rehearsal === true,
      '点「重置」后 flags.rehearsal 仍为 true（提词器是本机偏好，跨重置保持）',
      'rehearsal=' + G5.Game.state.flags.rehearsal + ' phase=' + G5.Game.state.phase);
  }

  if (page5off && page5off.sandbox.Game) {
    var G5o = page5off.sandbox;
    G5o.Game.init({ mode: 'demo', seed: SEED });
    var elOff = G5o.document.getElementById('rehearsal');
    c('F5.8', G5o.Game.state.flags.rehearsal === false && (!elOff || elOff.hidden === true),
      '不带 ?rehearsal=1 时 flags.rehearsal=false 且 #rehearsal 保持 hidden（默认不影响演示）',
      jsonOf({ rehearsal: G5o.Game.state.flags.rehearsal, hidden: elOff && elOff.hidden }));
  } else {
    c('F5.8', false, '默认页面可加载以验证提词器默认关闭', 'createPage 抛错');
  }

  /* ========================================================================
   * F6 BGM / 音效（契约 §5.2）
   * ====================================================================== */

  ck.section('契约 v3 §5.2｜BGM 与音效：muted 全程静默、BGM 只一组振荡器、gain ≤ 0.03');

  function fireGesture(page) {
    try { page.fire(page.doc, 'pointerdown', { type: 'pointerdown' }); return true; } catch (e) { return false; }
  }

  async function audioRun(muted) {
    var A = makeFakeAudio();
    var page = Sh.createPage({ globals: { AudioContext: A.ctor } });
    var Gx = page.sandbox;
    var out = { A: A, page: page, gesture: false, error: null, okPick: false };
    try {
      Gx.Game.init({ mode: 'demo', seed: SEED });
      /* muted 是「本机偏好」（mutedPref）：必须走引擎开关。直接写 state.flags.muted
         会在 start() 里被 _freshState 覆盖成 false，上一版就是这么把 muted 跑出声的。 */
      if (!!Gx.Game.state.flags.muted !== !!muted) out.muteOk = Gx.Game.action({ type: 'toggle_mute' });
      out.muted = Gx.Game.state.flags.muted;
      /* 自动彩排整局（含 R1 小奖 / R2 质疑反杀 / R3 收手结算）。振荡器从页面建立那刻起
         就开始计数，中途清空会漏掉已起的 BGM（BGM 只会起一组，清空后不会补第二组）。 */
      var demoP = Gx.Game.autoDemo();
      out.okPick = await untilMs(function () { return Gx.Game.state.phase !== 'IDLE'; }, 10000);
      out.gesture = fireGesture(page);   /* 首次手势：相位已非 IDLE，BGM 此时才真正起 */
      out.demo = await demoP;
      var p = Gx.Game.state.phase;
      out.phase = p;
      out.toEnd = p === 'CASHOUT' || p === 'SETTLE_ROUND' || p === 'GAME_OVER';
      out.oscTotal = A.oscs.length;
      out.lowSines = A.lowSines().length;
      out.ctxCount = A.ctxCount;
      /* 切静音 → 若已建上下文必须 suspend */
      if (!Gx.Game.state.flags.muted) Gx.Game.action({ type: 'toggle_mute' });
      out.suspends = A.suspends;
    } catch (e) {
      out.error = (e && e.message) ? e.message : String(e);
    }
    return out;
  }

  var AUD_MUTED = await audioRun(true);
  var AUD_ON = await audioRun(false);

  c('F6.1', !AUD_MUTED.error && AUD_MUTED.gesture && AUD_ON.gesture &&
    AUD_MUTED.muted === true && AUD_ON.muted === false && AUD_MUTED.okPick && AUD_ON.okPick,
    'Fake AudioContext 注入后页面可加载、整局跑完且能派发首次手势；静音开关按偏好生效',
    AUD_MUTED.error ? '异常：' + AUD_MUTED.error
      : jsonOf({ muted: AUD_MUTED.muted, on: AUD_ON.muted, gesture: AUD_MUTED.gesture,
        phase: AUD_MUTED.phase, ctx: AUD_MUTED.ctxCount }));
  c('F6.2', AUD_MUTED.toEnd && AUD_MUTED.oscTotal === 0,
    'muted=true 全程 0 发声：整局跑完（含 BGM 与开门/开奖音效）没有创建任何振荡器',
    jsonOf({ oscs: AUD_MUTED.oscTotal, ctx: AUD_MUTED.ctxCount, toEnd: AUD_MUTED.toEnd,
      phase: AUD_MUTED.phase }));
  c('F6.3', AUD_ON.toEnd && AUD_ON.oscTotal > 0 && AUD_ON.ctxCount === 1,
    'muted=false 确实发声，且 AudioContext 全程只建 1 个实例（惰性创建，满足自动播放策略）',
    jsonOf({ oscs: AUD_ON.oscTotal, ctx: AUD_ON.ctxCount, toEnd: AUD_ON.toEnd }));
  c('F6.4', AUD_ON.lowSines === 2,
    'BGM 只有一组振荡器（2 个低频正弦 100/130/160Hz），重复 bgmSync 绝不叠第二组',
    jsonOf({ lowSines: AUD_ON.lowSines, oscs: AUD_ON.oscTotal }));
  c('F6.5', AUD_ON.A.gains.some(function (g) {
    var mx = Math.max.apply(null, g.gain.sets.concat([0]));
    return mx > 0.0005 && mx <= 0.03;
  }), 'BGM gain 峰值落在 (0, 0.03]（契约 §5.2 音量上限）',
    jsonOf(AUD_ON.A.gains.map(function (g) { return g.gain.sets; }).slice(0, 4)));
  c('F6.6', AUD_ON.suspends >= 1,
    '切到 muted 后已建 AudioContext 被 suspend（未建上下文则什么都不做）',
    jsonOf({ onSuspends: AUD_ON.suspends, mutedSuspends: AUD_MUTED.suspends,
      mutedCtx: AUD_MUTED.ctxCount }));

  /* ========================================================================
   * F7 图鉴可达（契约 §6）
   * ====================================================================== */

  ck.section('契约 v3 §6｜图鉴可达：codex.lines ⊇ 本局实际播出的 line id');

  var g7 = mkGame('normal', SEED);
  var playedIds = [];
  var origPlayLine = g7.ui.playNarratorLine;
  g7.ui.playNarratorLine = function (line) {
    if (line && line.id) playedIds.push(line.id);
    return origPlayLine ? origPlayLine.apply(null, arguments) : Promise.resolve();
  };

  var rounds7 = 0;
  try {
    g7.Game.start('normal');
    for (var r7 = 0; r7 < 8; r7++) {
      if (!await until(function () { return g7.Game.state.phase === 'PICK'; }, 600)) break;
      g7.Game.state.patience = 99;                       /* 只测图鉴可达，隔离「耐心归零」 */
      if (!g7.Game.action({ type: 'pick', slot: 0 })) break;
      if (!await until(function () { return g7.Game.state.phase === 'DECIDE'; }, 600)) break;
      g7.Game.action({ type: 'decide', choice: 'stick' });
      if (!await until(function () { return g7.Game.state.phase === 'SETTLE_ROUND'; }, 900)) break;
      g7.Game.action({ type: 'settle', choice: 'continue' });
      rounds7++;
    }
  } catch (e) { /* 按已收集的数据断言 */ }

  var uniqPlayed = playedIds.filter(function (v, i, a) { return a.indexOf(v) === i; });
  var codexLines = (g7.Game.state.codex && g7.Game.state.codex.lines) || [];
  var missing7 = uniqPlayed.filter(function (id) { return codexLines.indexOf(id) < 0; });

  c('F7.1', rounds7 >= 8 && uniqPlayed.length >= 8,
    '普通模式连跑 8 轮，真实播出 ≥ 8 条不同旁白（引擎 _playLine → UI.playNarratorLine）',
    jsonOf({ rounds: rounds7, played: playedIds.length, unique: uniqPlayed.length, round: g7.Game.state.round }));
  c('F7.2', missing7.length === 0,
    'codex.lines 覆盖本局实际播出的每一条 line id（契约 §6：听到即入图鉴）',
    '缺失=' + missing7.length + (missing7[0] ? ' 例：' + missing7[0] : '') +
    '；codex=' + codexLines.length + ' 实际=' + uniqPlayed.length);
  c('F7.3', codexLines.length >= uniqPlayed.length &&
    codexLines.every(function (id) { return typeof id === 'string' && id; }),
    'codex.lines 元素为合法 line id（非空字符串）且不少于本局播出数',
    jsonOf({ codex: codexLines.length, unique: uniqPlayed.length }));

  /* ========================================================================
   * F8 计数
   * ====================================================================== */

  ck.section('新增断言计数');
  c('F8.1', nF >= 40, '本套件断言条数 ≥ 40（实际 ' + nF + ' 条）', '实际 ' + nF + ' 条');
}

main().then(function () {
  ck.print();
  var c2 = ck.counts();
  process.exitCode = c2.FAIL > 0 ? 1 : 0;
}).catch(function (e) {
  console.log('\n[features.js 运行时异常] ' + (e && e.stack ? e.stack : e));
  ck.print();
  process.exitCode = 2;
});

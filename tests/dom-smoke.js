/* ============================================================================
 * tests/dom-smoke.js —— Node DOM 垫片冒烟（浏览器不可用时的端到端替代证据）
 * ----------------------------------------------------------------------------
 * 覆盖《开工清单》：
 *   阶段 0 P0 零构建：真实 index.html + 真实 js/*.js 在 vm 里直接跑起来
 *   阶段 1 P0 渲染：3 扇门、HUD 100/2/3、点击→主持人开门→决策→开奖→结算
 *   阶段 2 P0 反馈：怀疑值不足置灰不误触、已加倍不可叠加、HUD 刷新与抖动
 *   阶段 5 P1 图鉴存档键真实落盘
 *   阶段 6 P0 全部资源本地（script/link 全为本地相对路径且加载成功）
 * 真实命令：node tests/dom-smoke.js
 * 说明：本沙箱无头 Edge 必然 FATAL:mojo，故浏览器 E2E 见 headless-check.js
 *       （浏览器可用时）；本套件是等价的 Node 侧真实执行证据。
 * ========================================================================== */
'use strict';

var L = require('./lib.js');
var Sh = require('./dom-shim.js');

var ck = new L.Checker('dom-smoke.js —— 真实 index.html + 真实 js/*.js（Node DOM 垫片）');

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function until(fn, ms) {
  return new Promise(function (res) {
    var t0 = Date.now();
    (function step() {
      var v = false;
      try { v = !!fn(); } catch (e) { v = false; }
      if (v) return res(true);
      if (Date.now() - t0 > ms) return res(false);
      setTimeout(step, 25);
    })();
  });
}

var page, DOC, UI, Game, SANDBOX;

function q(s) { return DOC.querySelector(s); }
function qa(s) { return DOC.querySelectorAll(s); }
function byId(id) { return DOC.getElementById(id); }
function hudText(id) { var e = byId(id); return e ? (e.querySelector('.hud-value') || {}).textContent : null; }
function snap() { return SANDBOX.cloneState(Game.state); }

(async function main() {

ck.section('阶段 0/1 P0｜真实页面在 Node 垫片中启动并渲染');

try {
  page = Sh.createPage();
} catch (e) {
  ck.fail('U0.1', 'index.html 可被解析并加载 js/*.js', '抛出：' + (e && e.message ? e.message : String(e)));
}

if (!page || !page.sandbox.Game || !page.sandbox.UI) {
  ck.fail('U0.1', 'index.html 可被解析并加载 js/*.js', '加载结果：' + (page ? page.loadSummary : 'page=null') +
    '；缺失/抛错文件：' + (page ? page.missing.join(', ') : '-'));
  ck.print();
  process.exit(1);
}

DOC = page.doc;
SANDBOX = page.sandbox;
UI = SANDBOX.UI;
Game = SANDBOX.Game;

ck.ok('U0.1', page.missing.length === 0 && !!SANDBOX.GameData && typeof SANDBOX.applyEffect === 'function' && !!SANDBOX.Narrator,
  '真实 js/*.js 全部加载成功且导出齐全（Game / UI / GameData / applyEffect / Narrator）',
  '加载=' + page.loadSummary + (page.errors.length ? '；错误=' + page.errors.join(' | ') : ''));

/* 等待首帧渲染（ui.js 在脚本加载末尾自己 boot） */
await until(function () { return byId('doors') && qa('#doors .door').length > 0; }, 3000);

ck.ok('U0.2', Game.state.phase === 'IDLE', '启动后状态机停在 IDLE（等待开始按钮）', 'phase=' + Game.state.phase);

var doors0 = qa('#doors .door');
ck.eq('U0.3', doors0.length, 3, '#doors 内真实渲染出 3 扇门（class="door"）');
ck.eq('U0.4', doors0.map(function (d) { return d.getAttribute('data-slot'); }).join(','), '0,1,2',
  '三扇门带 data-slot=0,1,2');

ck.eq('U0.5', hudText('hud-coins'), '100', '#hud 金币初值 100（DOM 文本）');
ck.eq('U0.6', hudText('hud-suspicion'), '2', '#hud 怀疑值初值 2（DOM 文本）');
ck.eq('U0.7', hudText('hud-patience'), '3', '#hud 耐心初值 3（DOM 文本）');

ck.ok('U0.8', byId('boot') && byId('boot').hidden === false, 'IDLE 时 #boot 开始遮罩可见');
ck.ok('U0.9', byId('decide') && byId('decide').hidden === true, 'IDLE 时 #decide 决策区隐藏');
ck.ok('U0.10', !!byId('btn-start'), '#btn-start 开始按钮存在');

var before = JSON.stringify(snap());
UI.render(Game.state);
UI.render(Game.state);
ck.ok('U0.11', before === JSON.stringify(snap()),
  'UI.render(state) 连调两次不改状态（渲染只读 GameState，清单阶段 0 P0）');

ck.section('阶段 1 P0｜开始 → PICK → 长按偷看 → 点击 → 主持人开门 → 决策');

Game.action({ type: 'start', mode: 'demo' });
ck.ok('U1.1', page.body.getAttribute('data-state') !== null && page.body.getAttribute('data-state') !== 'IDLE',
  'body[data-state] 随状态机同步（实测 ' + page.body.getAttribute('data-state') + '）');

var toPick = await until(function () { return Game.state.phase === 'PICK'; }, 15000);
ck.ok('U1.2', toPick, '演示剧本第 1 轮进入 PICK（真实计时，含旁白/入场动画）', 'phase=' + Game.state.phase);
ck.ok('U1.3', byId('boot').hidden === true, '离开 IDLE 后 #boot 隐藏');
ck.eq('U1.4', qa('#doors .door.is-live').length, 3, 'PICK 时 3 扇门都是 .is-live（可点）');
ck.ok('U1.5', /长按/.test(byId('stage-hint').textContent), '提示条说明长按偷看（#stage-hint 含「长按」）',
  byId('stage-hint').textContent.trim());

var d0 = q('#doors .door[data-slot="0"]');
page.fire(d0, 'pointerdown', { button: 0 });
await sleep(460);
page.fire(d0, 'pointerup', {});
ck.ok('U1.6', Game.state.peekUsed === true && Game.state.doors[0].peeked === true && d0.classList.contains('peeked'),
  '长按 400ms 触发偷看：state.peekUsed=true、doors[0].peeked=true、.door 获得 .peeked', 'peekUsed=' + Game.state.peekUsed);
ck.ok('U1.7', !/大奖|小奖|空门|炸弹/.test(d0.innerHTML),
  '偷看不泄漏物品名（阶段 2 P0「偷看只给提示不给答案」）', d0.innerHTML.replace(/\s+/g, ' ').slice(0, 100));

page.fire(d0, 'pointerdown', { button: 0 });
page.fire(d0, 'pointerup', {});
page.fire(d0, 'click', {});
ck.ok('U1.8', Game.state.phase === 'HOST_OPEN', '点击门 → HOST_OPEN', 'phase=' + Game.state.phase);
ck.eq('U1.9', qa('#doors .door.is-live').length, 0, 'HOST_OPEN 起门锁定（无 .is-live，防重复选择）');

var toDecide = await until(function () { return Game.state.phase === 'DECIDE'; }, 8000);
ck.ok('U1.10', toDecide, '主持人开门动画结束进入 DECIDE（真实计时）', 'phase=' + Game.state.phase);
ck.ok('U1.11', byId('decide').hidden === false, 'DECIDE 时 #decide 可见');
ck.eq('U1.12', qa('#decide .decide-btn').length, 5, '决策区 5 个按钮（坚持/换门/质疑/加倍/收手）');
ck.ok('U1.13', Game.state.hostOpenedSlot !== null && Game.state.hostOpenedSlot !== Game.state.pickedSlot,
  '主持人开的门不是玩家所选', 'picked=' + Game.state.pickedSlot + ' hostOpened=' + Game.state.hostOpenedSlot +
  ' 门面=[' + Game.state.doors.map(function (d) { return d.itemId; }).join(',') + '] 横幅=' +
  String(byId('round-banner') ? byId('round-banner').textContent : '').trim());

ck.section('阶段 2 P0｜决策按钮状态：怀疑值不足 / 已加倍');

var cb = q('.decide-btn[data-choice="challenge"]');
var realSus = Game.state.suspicion;
Game.state.suspicion = 0;
UI.render(Game.state);
ck.ok('U2.1', cb.getAttribute('aria-disabled') === 'true' && cb.disabled === false,
  '怀疑值不足时「质疑旁白」置灰但仍可点（给出提示而非静默失效）',
  'aria-disabled=' + cb.getAttribute('aria-disabled') + ' disabled=' + cb.disabled);
ck.ok('U2.2', /怀疑值不足/.test(cb.getAttribute('data-hint') || ''), '置灰按钮带「怀疑值不足」提示文案',
  cb.getAttribute('data-hint'));
ck.ok('U2.3', byId('stage-hint').classList.contains('is-warn'), '提示条进入 .is-warn 警示态');
var coinsBefore = Game.state.coins;
page.fire(cb, 'click', {});
ck.ok('U2.4', Game.state.coins === coinsBefore && Game.state.phase === 'DECIDE',
  '置灰状态下点击不触发任何结算（金币不变、仍在 DECIDE）', 'coins=' + Game.state.coins + ' phase=' + Game.state.phase);
Game.state.suspicion = realSus;
UI.render(Game.state);
ck.ok('U2.5', cb.getAttribute('aria-disabled') === 'false', '怀疑值恢复后按钮可用');

var db = q('.decide-btn[data-choice="double"]');
Game.state.doubled = true;
UI.render(Game.state);
ck.eq('U2.6', db.textContent.trim(), '已加倍', '已加倍时按钮文案变「已加倍」');
ck.ok('U2.7', db.disabled === true, '已加倍时按钮禁用（不可叠加，阶段 3 P1）');
Game.state.doubled = false;
UI.render(Game.state);
ck.ok('U2.8', db.textContent.trim() === '加倍下注' && db.disabled === false, '取消加倍后恢复「加倍下注」且可用');

ck.section('阶段 1/6 P0｜旁白逐字播放、跳过、超时截断、动画瞬时');

var pN = UI.playNarratorLine({ id: 'u-l1', text: '这是一句用来测试逐字播放的旁白。' }, 0);
var rN = await Promise.race([pN.then(function () { return 'resolved'; }), sleep(6000).then(function () { return 'timeout'; })]);
ck.ok('U3.1', rN === 'resolved', '旁白按阅读速度自动播完并 resolve（不需要外部跳过）', rN);
ck.ok('U3.2', byId('narrator-skip').hidden === true, '播完后「跳过」按钮隐藏');

var pN2 = UI.playNarratorLine({ id: 'u-l2', text: '再播一句长的旁白，然后在播放途中调用 UI.skip()。' }, 1);
await sleep(60);
UI.skip();
var rN2 = await Promise.race([pN2.then(function () { return 'resolved'; }), sleep(1200).then(function () { return 'timeout'; })]);
ck.ok('U3.3', rN2 === 'resolved' && UI.isAnimating() === false, 'UI.skip() 立刻结束旁白且无残留动画', rN2);
ck.eq('U3.4', byId('narrator-text').textContent, '再播一句长的旁白，然后在播放途中调用 UI.skip()。',
  '跳过后旁白条显示完整文本');

var tLong = Date.now();
await UI.playNarratorLine({ id: 'u-l3', text: '旁'.repeat(200) }, 2);
var dtLong = Date.now() - tLong;
var shown = byId('narrator-text').textContent;
/* 2026-10-25 起：旁白按阅读速度播放（默认 9 字/秒 + 句末停留 1.2s），不再「一闪而过」。
   200 字会被截断为 61 字 → 预期约 8s；这里只保证「够慢可读、不失控、可跳过」。 */
ck.ok('U3.5', dtLong >= 3000 && dtLong <= 12000, '单句长旁白按阅读速度播放（实测 ' + dtLong + 'ms，3–12s 可读区间）');
ck.ok('U3.6', shown.length <= 62 && /…$/.test(shown), '超长旁白自动截断为 ' + shown.length + ' 字并以 … 结尾',
  shown.slice(-8));

var pR = UI.playReveal({ slot: 0, itemId: 'small_prize', delta: { coins: 30 }, multiplier: 2 });
await sleep(80);
UI.skip();
var rR = await Promise.race([pR.then(function () { return 'resolved'; }), sleep(1500).then(function () { return 'timeout'; })]);
ck.ok('U3.7', rR === 'resolved', 'UI.skip() 立刻结束开奖动画（结算数值不受动画影响）', rR);

Game.state.flags.skipAnim = true;
var tSkip = Date.now();
await UI.playHostOpen(1, 'empty');
await UI.playReveal({ slot: 0, itemId: 'big_prize', delta: { coins: 100 }, multiplier: 1 });
var dtSkip = Date.now() - tSkip;
ck.ok('U3.8', dtSkip < 120 && UI.isAnimating() === false,
  'flags.skipAnim=true 时动画瞬时返回（阶段 6 P0「可跳过」，实测 ' + dtSkip + 'ms）');

ck.section('阶段 1/2 P0｜开奖结算正确、HUD 刷新、弹层与继续');

var logBefore = Game.state.log.length;
var coinsPre = Game.state.coins;
var pickedId = Game.state.doors[Game.state.pickedSlot].itemId;
/* 用真实 applyEffect 在克隆态上算「恰好一次」的期望增量（applyEffect 是纯函数，取返回的 delta） */
var probe = SANDBOX.cloneState(Game.state);
var effRet = SANDBOX.applyEffect(probe, pickedId, { multiplier: 1 });
var expectDelta = (effRet && effRet.delta ? effRet.delta.coins : 0);

Game.action({ type: 'decide', choice: 'stick' });
var reached = await until(function () { return /REVEAL|SETTLE_ROUND/.test(Game.state.phase); }, 6000);
ck.ok('U4.1', reached, 'decide stick → 进入开奖/结算（phase=' + Game.state.phase + '）');
ck.eq('U4.2', qa('#doors .door.is-revealed').length, 1, '开奖后恰好 1 扇门带 .is-revealed');

UI.skip();
var settled = await until(function () { return Game.state.phase === 'SETTLE_ROUND' && byId('modal').hidden === false; }, 6000);
ck.ok('U4.3', settled, '本轮结算弹层真的打开（#modal 可见，phase=' + Game.state.phase + '）');
ck.eq('U4.4', qa('#modal-actions button').length, 2, '结算弹层 2 个按钮（继续 / 收手）');
ck.ok('U4.5', /号门/.test(byId('modal-body').textContent), '结算正文点明开了几号门',
  byId('modal-body').textContent.replace(/\s+/g, ' ').slice(0, 120));

ck.eq('U4.6', Game.state.log.length - logBefore, 1, '本轮恰好追加 1 条 log');
ck.ok('U4.7', Game.state.coins - coinsPre === expectDelta,
  '金币按真实 applyEffect 恰好结算一次（' + pickedId + ' 期望 ' + (expectDelta >= 0 ? '+' : '') + expectDelta +
  '，实测 ' + (Game.state.coins - coinsPre >= 0 ? '+' : '') + (Game.state.coins - coinsPre) + '）',
  'applyEffect 返回 delta=' + JSON.stringify(effRet && effRet.delta));
ck.eq('U4.8', hudText('hud-coins'), String(Game.state.coins), 'HUD 金币文本与 state.coins 一致（开奖后立即刷新）');

var contBtn = q('#modal-actions button[data-choice="continue"]');
page.fire(contBtn, 'click', {});
ck.ok('U4.9', byId('modal').hidden === true, '点「继续」后弹层关闭');
ck.eq('U4.10', Game.state.round, 2, '轮次推进到第 2 轮');
ck.ok('U4.11', await until(function () { return Game.state.phase === 'PICK'; }, 15000), '第 2 轮再次进入 PICK',
  'phase=' + Game.state.phase);

ck.section('阶段 6 P0｜连续快速点击 50 次：只结算一次');

var d2 = q('#doors .door[data-slot="2"]');
var log2 = Game.state.log.length;
for (var i = 0; i < 50; i++) page.fire(d2, 'click', {});
ck.ok('U5.1', Game.state.pickedSlot === 2 && Game.state.phase === 'HOST_OPEN',
  '50 次连点只生效一次选择（pickedSlot=2, phase=HOST_OPEN）',
  'phase=' + Game.state.phase + ' pickedSlot=' + Game.state.pickedSlot);
await until(function () { return Game.state.phase === 'DECIDE'; }, 8000);
var coins3 = Game.state.coins;
var id2 = Game.state.doors[2].itemId;
var probe2 = SANDBOX.cloneState(Game.state);
var effRet2 = SANDBOX.applyEffect(probe2, id2, { multiplier: 1 });
var expect2 = (effRet2 && effRet2.delta ? effRet2.delta.coins : 0);
var stick = q('.decide-btn[data-choice="stick"]');
for (var j = 0; j < 50; j++) page.fire(stick, 'click', {});
await until(function () { return /REVEAL|SETTLE_ROUND/.test(Game.state.phase); }, 6000);
UI.skip();
await until(function () { return Game.state.phase === 'SETTLE_ROUND'; }, 6000);
ck.eq('U5.2', Game.state.log.length - log2, 1, '50 次连点决策只产生 1 条结算 log');
ck.ok('U5.3', Game.state.coins - coins3 === expect2,
  '50 次连点只结算一次金币（' + id2 + ' 期望 ' + expect2 + '，实测 ' + (Game.state.coins - coins3) + '）');

ck.section('阶段 1 P0｜toast / banner / 弹层 / HUD 抖动反馈');

UI.toast('测试提示');
ck.ok('U6.1', byId('toast').hidden === false && /测试提示/.test(byId('toast').textContent), 'UI.toast 可见并显示文案');
UI.banner('第 1 轮测试', 300);
ck.ok('U6.2', byId('round-banner').hidden === false, 'UI.banner 可见（轮次横幅）');

UI.openModal({ kind: 'cashout', title: '本局结算', body: '<p class="big">最终金币：<b>130</b></p>',
  actions: [{ label: '再来一局', choice: 'restart', primary: true }] });
ck.ok('U6.3', byId('modal').className.indexOf('kind-cashout') >= 0, 'openModal 会给 #modal 加 kind-* 类',
  byId('modal').className);
ck.ok('U6.4', /最终金币/.test(byId('modal-body').innerHTML), 'openModal 渲染 HTML 正文');
UI.closeModal();
ck.ok('U6.5', byId('modal').hidden === true, 'closeModal 关闭弹层');

var hudCoins = byId('hud-coins');
Game.state.coins += 30;
UI.render(Game.state);
ck.eq('U6.6', hudCoins.querySelector('.hud-value').textContent, String(Game.state.coins),
  'HUD 数字随状态重新渲染（DOM == state.coins）');
UI.flash('coins', 30, Game.state);
ck.ok('U6.7', hudCoins.classList.contains('flash-up'), 'UI.flash(+30) 给 HUD 加 .flash-up 抖动');
var floats = hudCoins.querySelectorAll('.float-delta');
var last = floats[floats.length - 1];
ck.ok('U6.8', last && last.textContent === '+30', '抖动浮字显示 +30', last ? last.textContent : 'none');
UI.flash('coins', -50, Game.state);
var f2 = hudCoins.querySelectorAll('.float-delta');
ck.ok('U6.9', hudCoins.classList.contains('flash-down') && /−50/.test(f2[f2.length - 1].textContent),
  'UI.flash(−50) 加 .flash-down 且浮字显示 −50', f2[f2.length - 1].textContent);
UI.flash('suspicion', 1, Game.state);
UI.flash('patience', -1, Game.state);
ck.ok('U6.10', byId('hud-suspicion').classList.contains('flash-up') && byId('hud-patience').classList.contains('flash-down'),
  '三个资源都能各自抖动反馈（阶段 2 P0）');

ck.section('阶段 5 P1｜图鉴存档在真实 localStorage 下落盘（DOM 侧）');

var lsMap = page.storage._map;
var lsKeys = Object.keys(lsMap);
ck.ok('U7.1', lsKeys.indexOf('three_doors_codex_v1') >= 0 || lsKeys.indexOf('three_doors_best_v1') >= 0,
  '整局跑完后存档键真实写入 localStorage（阶段 5 P1 键名）', '实存键=[' + lsKeys.join(', ') + ']');
var codexRaw = lsMap['three_doors_codex_v1'];
var codexOk = false;
try { var cj = JSON.parse(codexRaw); codexOk = cj && (cj.items || cj.lines || cj.endings); } catch (e) { codexOk = false; }
ck.ok('U7.2', !!codexOk, 'three_doors_codex_v1 是可 JSON.parse 的图鉴对象',
  String(codexRaw).slice(0, 140));

ck.section('阶段 6 P0｜页面资源全部本地（script/link 逐个加载成功）');

var html = L.readText(L.INDEX);
var refs = [], m, re = /(?:src|href)\s*=\s*"([^"]+)"/gi;
while ((m = re.exec(html))) refs.push(m[1]);
var remote = refs.filter(function (r) { return /^(https?:)?\/\//i.test(r); });
var absent = refs.filter(function (r) {
  if (/^(https?:)?\/\//i.test(r) || r.charAt(0) === '#' || /^mailto:/i.test(r)) return false;
  return !L.fileExists(require('path').join(L.ROOT, r.replace(/[?#].*$/, '')));
});
ck.ok('U8.1', remote.length === 0 && absent.length === 0 && refs.length >= 7,
  'index.html 引用 ' + refs.length + ' 个资源全部为本地相对路径且文件存在（' + refs.join(' ') + '）',
  '远程=' + remote.join(',') + ' 缺失=' + absent.join(','));
ck.ok('U8.2', page.has('js/ui.js') && page.has('js/game.js') && page.has('js/state.js') && page.has('js/data.js') &&
  page.has('js/effects.js') && page.has('js/narrator.js'),
  '6 个脚本都以经典脚本方式在页面上下文里执行成功（无 ES module / 无构建）');

ck.section('阶段 3/4 P0｜商店 DOM 契约（#btn-shop / #shop-grid / .shop-card / .is-poor / #bag）');

var shopBtn = byId('btn-shop');
ck.ok('U10.1', !!shopBtn && shopBtn.textContent.trim() === '商店' && shopBtn.getAttribute('class').indexOf('ctrl-shop') >= 0,
  '#btn-shop 存在、文案「商店」且带 .ctrl-shop',
  shopBtn ? ('class="' + shopBtn.getAttribute('class') + '" text="' + shopBtn.textContent.trim() + '"') : 'none');

/* 决策/结算阶段可用；其它阶段结构性禁用（契约 §3.1） */
var realPhase = Game.state.phase;
ck.ok('U10.2', (realPhase === 'DECIDE' || realPhase === 'SETTLE_ROUND') && shopBtn.disabled === false &&
  shopBtn.getAttribute('aria-disabled') === 'false',
  'DECIDE/SETTLE_ROUND 阶段 #btn-shop 可用（当前 phase=' + realPhase + '）',
  'disabled=' + shopBtn.disabled + ' aria=' + shopBtn.getAttribute('aria-disabled'));

var fakePick = SANDBOX.cloneState(Game.state);
fakePick.phase = 'PICK';
UI.render(fakePick);
ck.ok('U10.3', shopBtn.disabled === true && shopBtn.getAttribute('aria-disabled') === 'true',
  'PICK 阶段 #btn-shop 结构性禁用（disabled + aria-disabled=true）',
  'disabled=' + shopBtn.disabled + ' aria=' + shopBtn.getAttribute('aria-disabled'));
UI.render(Game.state);

var bagNow = byId('bag');
ck.ok('U10.4', !!bagNow && bagNow.hidden === false && byId('bag-list') !== null,
  '非 IDLE/ROUND_INTRO 阶段 #bag 可见且含 #bag-list',
  'hidden=' + (bagNow && bagNow.hidden));
var fakeIdle = SANDBOX.cloneState(Game.state);
fakeIdle.phase = 'IDLE';
UI.render(fakeIdle);
ck.ok('U10.5', byId('bag').hidden === true, 'IDLE 阶段 #bag 隐藏（契约 §3.1）', 'hidden=' + byId('bag').hidden);
UI.render(Game.state);

/* 点 #btn-shop 走真实事件链：UI.emit → Game.action({type:'shop'}) → #shop-grid */
page.fire(shopBtn, 'click', {});
var grid = byId('shop-grid');
var cards = grid ? qa('#shop-grid .shop-card') : [];
ck.ok('U10.6', byId('modal').hidden === false && byId('modal').className.indexOf('kind-shop') >= 0 && !!grid,
  '点 #btn-shop 真的打开商店弹层（#modal.kind-shop + #shop-grid）',
  'modal=' + byId('modal').className + ' grid=' + !!grid);
ck.eq('U10.7', cards.length, 6, '商店弹层渲染 6 件商品 .shop-card');
var itemAttrs = cards.map(function (el) { return el.getAttribute('data-item'); }).join(',');
ck.ok('U10.8', itemAttrs === 'switch_ticket,mute_card,double_coins,fuse,mystery_box,patience_charm',
  '6 个 .shop-card[data-item] 的 id 与契约 §2.2 顺序一致（' + itemAttrs + '）');
var buyBtns = qa('#shop-grid .shop-buy');
ck.ok('U10.9', buyBtns.length === 6 && buyBtns.every(function (b) { return !!b.getAttribute('data-item'); }),
  '每张卡都有一个 .shop-buy[data-item] 购买按钮');

/* 买不起 → .is-poor + 按钮禁用（UI 不依赖人眼判断） */
Game.state.coins = 10;
UI.render(Game.state);
UI.openModal(Game.shopSpec());
var poorCards = qa('#shop-grid .shop-card.is-poor');
var poorBtnsOk = poorCards.every(function (c) { return c.querySelector('.shop-buy').disabled === true; });
var richCab = q('#shop-grid .shop-card[data-item="switch_ticket"]');
ck.ok('U10.10', poorCards.length === 6 && poorBtnsOk && richCab.className.indexOf('is-poor') >= 0,
  '金币 10 时 6 张卡全部 .is-poor 且 .shop-buy 禁用（' + poorCards.length + ' 张）',
  'poor=' + poorCards.length + ' 全部按钮禁用=' + poorBtnsOk);

/* 买得起 → 真实点击购买：金币减少 + HUD 刷新 + 背包出现道具 */
Game.state.coins = 100;
UI.render(Game.state);
UI.openModal(Game.shopSpec());
var buySwitch = q('#shop-grid .shop-buy[data-item="switch_ticket"]');
ck.ok('U10.11', !!buySwitch && buySwitch.disabled === false, '金币 100 时换门券按钮可点（未禁用）');
page.fire(buySwitch, 'click', {});
ck.eq('U10.12', Game.state.coins, 75, '点 .shop-buy 真实购买：金币 100→75（UI.emit → modal_choice:"buy:switch_ticket"）');
ck.eq('U10.13', hudText('hud-coins'), '75', '购买后 HUD 金币立即刷新为 75');
var bagSlots = qa('#bag-list .bag-slot');
ck.ok('U10.14', bagSlots.length === 1 && /换门券/.test(bagSlots[0].textContent || ''),
  '背包 #bag-list 出现 1 个 .bag-slot 且写明「换门券」',
  bagSlots.length ? bagSlots[0].textContent.replace(/\s+/g, ' ').slice(0, 60) : '0 个');
ck.ok('U10.15', Game.state.spentCoins === 25 && Game.state.shopBuys === 1 &&
  Game._itemCount('switch_ticket') === 1 && Object.keys(Game.state.shopBought || {}).length === 0,
  '购买计入 spentCoins=25 / shopBuys=1，换门券进背包（_itemCount=1）；shopBought 只统计即时商品（神秘盒/续命符）故为空',
  JSON.stringify({ spent: Game.state.spentCoins, buys: Game.state.shopBuys,
    bagCount: Game._itemCount('switch_ticket'), shopBought: Game.state.shopBought }));

ck.section('阶段 6 P0｜六档分辨率：DOM 完整性 + CSS 流式/不溢出静态自证');

var VIEWPORTS = [[1280, 720], [1920, 1080], [1366, 768], [1366, 657], [2560, 1440], [667, 375]];
var vpBad = [];
VIEWPORTS.forEach(function (v) {
  var w = v[0], h = v[1];
  var got = page.setViewport(w, h);
  UI.render(Game.state);
  var problems = [];
  if (got.width !== w || got.height !== h) problems.push('视口桩未生效');
  if (SANDBOX.innerWidth !== w || SANDBOX.innerHeight !== h) problems.push('window.innerWidth/Height 不符');
  var wantDoors = (Game.state.doors || []).length;   /* 契约 v6：门数可变 3–6，别再写死 3 */
  if (qa('#doors .door').length !== wantDoors) {
    problems.push('#doors 渲染 ' + qa('#doors .door').length + ' 扇，state.doors 是 ' + wantDoors + ' 扇');
  }
  ['topbar', 'stage', 'narrator', 'hud', 'doors'].forEach(function (id) {
    var el = byId(id);
    if (!el) problems.push('缺少 #' + id);
    else if (el.hidden === true) problems.push('#' + id + ' 被隐藏');
  });
  if (!byId('btn-shop')) problems.push('缺少 #btn-shop');
  if (!q('#decide .decide-btn[data-choice="cashout"]')) problems.push('缺少收手按钮');
  if (problems.length) vpBad.push(w + '×' + h + ': ' + problems.join('/'));
});
ck.ok('U10.16', vpBad.length === 0,
  '六档分辨率（' + VIEWPORTS.map(function (v) { return v.join('×'); }).join(' / ') + '）下门（数量与 state.doors 一致）/顶栏/舞台/旁白/HUD/决策/商店按钮全部在位且未被隐藏',
  vpBad.join(' | ') || '全部在位');
ck.ok('U10.17', SANDBOX.innerWidth === 667 && SANDBOX.innerHeight === 375,
  '视口桩真的可切换（最后一次 667×375 已生效，innerWidth=' + SANDBOX.innerWidth + '）');
page.setViewport(1280, 720);
UI.render(Game.state);

/* 像素级 scrollHeight<=innerHeight 需要 CSS 引擎（本沙箱无浏览器），这里做静态自证 + 反模式扫描。 */
var cssTxt = L.readText(require('path').join(L.ROOT, 'style.css'));
var cssProblems = [];
if (!/overflow\s*:\s*hidden/.test(cssTxt)) cssProblems.push('缺少 overflow:hidden');
if (!/height\s*:\s*100dvh/.test(cssTxt)) cssProblems.push('缺少 height:100dvh');
if (!/height\s*:\s*100vh/.test(cssTxt)) cssProblems.push('缺少 height:100vh 兜底');
if (!/min-height\s*:\s*0/.test(cssTxt)) cssProblems.push('缺少 min-height:0（flex 轨道可收缩）');
var fixHeights = [];
cssTxt.replace(/\/\*[\s\S]*?\*\//g, '').replace(/([^{}]+)\{([^{}]*)\}/g, function (_, sel, body) {
  var s = sel.trim();
  if (!/(^|[,\s])(html|body|#topbar|#stage|#narrator|#hud|#decide|#bag|\.doors)([,\s{]|$)/.test(s + ' ')) return '';
  var m2 = /(?:^|[;\s])height\s*:\s*(\d+)px/.exec(body);
  if (m2 && Number(m2[1]) > 200) fixHeights.push(s.split('\n').pop().trim() + ' height:' + m2[1] + 'px');
  return '';
});
if (fixHeights.length) cssProblems.push('主框架固定高度 ' + fixHeights.join('; '));
ck.ok('U10.18', cssProblems.length === 0,
  'style.css 静态自证：html/body overflow:hidden + 外壳 height:100dvh(100vh 兜底) + 轨道 min-height:0，且主框架无固定 px 高度',
  cssProblems.join(' | ') || ('style.css ' + cssTxt.length + ' 字节；像素级 scrollHeight 需真实浏览器'));
ck.ok('U10.19', /clamp\(/.test(cssTxt) && (cssTxt.match(/clamp\(/g) || []).length >= 30,
  'style.css 用 clamp() 流式尺寸适配六档（实测 ' + (cssTxt.match(/clamp\(/g) || []).length + ' 处 clamp()）');

/* ---------- 契约 §3.1 / §3.3 的结构与属性（dom-smoke 被契约点名要断言的部分） ---------- */
var bagSlot = q('#bag-list .bag-slot[data-item="switch_ticket"]');
ck.ok('U10.20', !!bagSlot && bagSlot.getAttribute('data-count') === '1' &&
  !!bagSlot.querySelector('.bag-icon') && !!bagSlot.querySelector('.bag-name') && !!bagSlot.querySelector('.bag-count') &&
  bagSlot.querySelector('.bag-name').textContent === '换门券' && bagSlot.querySelector('.bag-count').textContent === '×1' &&
  byId('bag-empty').hidden === true,
  '契约 §3.1：.bag-slot 带 data-item/data-count 且内含 .bag-icon/.bag-name(换门券)/.bag-count(×1)；有道具时 #bag-empty 隐藏',
  bagSlot ? ('data-item=' + bagSlot.getAttribute('data-item') + ' data-count=' + bagSlot.getAttribute('data-count')) : 'none');

var decideState = SANDBOX.cloneState(Game.state);
decideState.phase = 'DECIDE';
UI.render(decideState);
var slotDecide = q('#bag-list .bag-slot[data-item="switch_ticket"]');
var bagUsable = !!slotDecide && slotDecide.disabled === false && slotDecide.getAttribute('aria-disabled') === 'false';
UI.render(Game.state);
var pickState = SANDBOX.cloneState(Game.state);
pickState.phase = 'PICK';
UI.render(pickState);
var slotPick = q('#bag-list .bag-slot[data-item="switch_ticket"]');
var bagLocked = !!slotPick && slotPick.disabled === true && slotPick.getAttribute('aria-disabled') === 'true';
UI.render(Game.state);
ck.ok('U10.21', bagUsable && bagLocked,
  '契约 §3.4：.bag-slot 只在 DECIDE 阶段可点（DECIDE 可点=' + bagUsable + '，PICK 禁用=' + bagLocked + '）');

var emptyBagState = SANDBOX.cloneState(Game.state);
emptyBagState.phase = 'DECIDE';
emptyBagState.items = [];
UI.render(emptyBagState);
var bagEmptyOk = byId('bag-empty').hidden === false && qa('#bag-list .bag-slot').length === 0 &&
  byId('bag').getAttribute('class').indexOf('is-empty') >= 0;
UI.render(Game.state);
ck.ok('U10.22', bagEmptyOk, '契约 §3.1：空背包显示 #bag-empty 且 #bag-list 无 .bag-slot');

Game.state.coins = 100;
UI.render(Game.state);
UI.openModal(Game.shopSpec());
var cardKids = ['shop-icon', 'shop-name', 'shop-price', 'shop-desc', 'shop-owned'];
var missKids = [];
qa('#shop-grid .shop-card').forEach(function (c) {
  cardKids.forEach(function (k) { if (!c.querySelector('.' + k)) missKids.push(c.getAttribute('data-item') + ' 缺 .' + k); });
});
ck.ok('U10.23', missKids.length === 0,
  '契约 §3.3：每张 .shop-card 都含 .shop-icon/.shop-name/.shop-price/.shop-desc/.shop-owned',
  missKids.join('; ') || '6 张卡全部齐全');

var ownSwitch = q('#shop-grid .shop-card[data-item="switch_ticket"] .shop-owned');
var ownMystery = q('#shop-grid .shop-card[data-item="mystery_box"] .shop-owned');
ck.ok('U10.24', !!ownSwitch && /已有\s*×1\/3/.test(ownSwitch.textContent) &&
  !!ownMystery && /已买\s*×0/.test(ownMystery.textContent),
  '契约 §3.3：cap 是数字时写「已有 ×n/cap」、cap===null（不限购）写「已买 ×n」',
  (ownSwitch ? ownSwitch.textContent.trim() : '?') + ' | ' + (ownMystery ? ownMystery.textContent.trim() : '?'));

/* 买满上限 → .is-capped + 按钮禁用 + 文案「已满」 */
var capStateItems = SANDBOX.cloneState(Game.state);
capStateItems.items = [{ id: 'switch_ticket', count: 3 }];
Game.state.items = capStateItems.items;
UI.render(Game.state);
UI.openModal(Game.shopSpec());
var cappedCard = q('#shop-grid .shop-card[data-item="switch_ticket"]');
var cappedOk = !!cappedCard && cappedCard.getAttribute('class').indexOf('is-capped') >= 0 &&
  cappedCard.querySelector('.shop-buy').disabled === true &&
  cappedCard.querySelector('.shop-buy').textContent.trim() === '已满' &&
  /已有\s*×3\/3/.test(cappedCard.querySelector('.shop-owned').textContent);
ck.ok('U10.25', cappedOk, '契约 §3.3：买满上限的卡加 .is-capped、按钮 disabled 且文案「已满」',
  cappedCard ? (cappedCard.getAttribute('class') + ' | ' + cappedCard.querySelector('.shop-buy').textContent.trim() + ' | ' + cappedCard.querySelector('.shop-owned').textContent.trim()) : 'none');

UI.openModal({ kind: 'shop', title: '道具商店', body: '测试空货架', coins: 100, items: [], actions: [{ label: '关闭', choice: 'close' }] });
ck.ok('U10.26', byId('modal').hidden === false && qa('#shop-grid .shop-card').length === 0 &&
  !!q('.shop-empty') && /货架暂时是空的/.test(q('.shop-empty').textContent),
  '契约 §3.3：items 为空时渲染 .shop-empty「货架暂时是空的。」', 'empty=' + (q('.shop-empty') ? q('.shop-empty').textContent.trim() : 'none'));
Game.state.items = [];
UI.closeModal();

/* ============================ U11 对比度（脚本实算 WCAG，不拍脑袋） ============================ */
ck.section('阶段 4.5 P0｜对比度脚本实算（WCAG 相对亮度，含 .shop-price / .bag-name）');

var CSSX = (function () {
  var txt = L.readText(require('path').join(L.ROOT, 'style.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  var rootVars = {}, rules = [];
  var rm = /:root\s*\{([^{}]*)\}/.exec(txt);
  if (rm) rm[1].split(';').forEach(function (d) {
    var i = d.indexOf(':'); if (i > 0) rootVars[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  });
  var re = /([^{}]+)\{([^{}]*)\}/g, mm;
  while ((mm = re.exec(txt))) rules.push({ sel: mm[1].trim().replace(/\s+/g, ' '), body: mm[2] });

  function varOf(v) {
    var s = String(v == null ? '' : v);
    for (var k = 0; k < 4 && /var\(/.test(s); k++) s = s.replace(/var\(\s*(--[\w-]+)[^)]*\)/g, function (_, n) {
      return rootVars[n] != null ? rootVars[n] : '';
    });
    return s.trim();
  }
  function rgbOf(str) {
    var s = varOf(str);
    var m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
    m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 };
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(s);
    if (m) {
      var a = m[4] === undefined ? 1 : (/%$/.test(m[4]) ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
      return { r: +m[1], g: +m[2], b: +m[3], a: a };
    }
    return null;
  }
  function decls(sel) {
    var out = {};
    rules.forEach(function (r) {
      var list = r.sel.split(',').map(function (x) { return x.trim(); });
      if (list.indexOf(sel) < 0) return;
      r.body.split(';').forEach(function (d) {
        var i = d.indexOf(':'); if (i < 0) return;
        out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
      });
    });
    return out;
  }
  function over(fg, bg) {
    var a = fg.a == null ? 1 : fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }
  function lum(c) {
    function f(v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function ratio(a, b) {
    var l1 = lum(a), l2 = lum(b), hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }
  /* 逐层叠出最亮/最暗两种可能的背景（CSS 里靠前的 background 层在上） */
  function bgs(sel) {
    var d = decls(sel), decl = d['background-color'] || d['background'];
    if (!decl) return null;
    var layers = decl.split(/,(?![^()]*\))/).map(function (p) {
      var cols = p.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)/g) || [];
      return cols.length ? [cols[0], cols[cols.length - 1]] : [];
    }).filter(function (a) { return a.length; });
    if (!layers.length) return null;
    var base = rgbOf('var(--bg-0)') || { r: 5, g: 7, b: 13, a: 1 };
    return [0, 1].map(function (idx) {
      var col = base;
      for (var i = layers.length - 1; i >= 0; i--) {
        var st = layers[i], c = rgbOf(st[Math.min(idx, st.length - 1)]);
        if (c) col = over(c, col);
      }
      return col;
    });
  }
  function evx(expr, vw, vh) {
    return String(expr).split(/([+-])/).reduce(function (acc, tok) {
      var t = tok.trim(); if (t === '' || t === '+') return acc;
      if (t === '-') { acc.sign = -1; return acc; }
      var m = /^([\d.]+)\s*(vh|vw|px|rem|em)?$/.exec(t);
      if (!m) return acc;
      var v = parseFloat(m[1]);
      var unit = m[2] || 'px';
      var px = unit === 'vh' ? v * vh / 100 : unit === 'vw' ? v * vw / 100 : v;
      acc.sum += acc.sign * px; acc.sign = 1; return acc;
    }, { sum: 0, sign: 1 }).sum;
  }
  function fontSizePx(sel, vw, vh) {
    var d = decls(sel), fs = varOf(d['font-size']);
    if (!fs) return null;
    var m = /clamp\(\s*([\d.]+)px\s*,\s*([^,]+?)\s*,\s*([\d.]+)px\s*\)/.exec(fs);
    if (m) return Math.max(parseFloat(m[1]), Math.min(parseFloat(m[3]), evx(m[2], vw, vh)));
    m = /^([\d.]+)px$/.exec(fs);
    return m ? parseFloat(m[1]) : null;
  }
  function weight(sel) {
    var w = String(decls(sel)['font-weight'] || '400').trim();
    return w === 'bold' ? 700 : (w === 'normal' ? 400 : parseFloat(w) || 400);
  }
  function opacityOf(sel) {
    var o = decls(sel)['opacity'];
    return o == null ? 1 : (parseFloat(o) || 1);
  }
  return { decls: decls, rgbOf: rgbOf, bgs: bgs, over: over, ratio: ratio, fontSizePx: fontSizePx, weight: weight, opacityOf: opacityOf,
    base: rgbOf('var(--bg-0)') || { r: 5, g: 7, b: 13, a: 1 } };
})();

/* 每一对：文字选择器 / 背景容器选择器 / 说明（阈值按 WCAG：正文 4.5:1，大字 3:1） */
var PAIRS = [
  ['.narrator-text', '#narrator', '旁白正文'],
  ['.hud-label', '.hud-item', 'HUD 标签'],
  ['#hud-coins .hud-value', '.hud-item', '金币数字（金色）'],
  ['#hud-suspicion .hud-value', '.hud-item', '怀疑值数字（青色）'],
  ['#hud-patience .hud-value', '.hud-item', '耐心数字（绿色）'],
  ['.hud-item.is-low .hud-value', '.hud-item', '资源告急（红色）'],
  ['.shop-name', '.shop-card', '商店商品名'],
  ['.shop-price', '.shop-card', '商店价格（契约点名要算）'],
  ['.shop-desc', '.shop-card', '商店说明'],
  ['.shop-owned', '.shop-card', '商店已购数'],
  ['.shop-card.is-poor .shop-price', '.shop-card', '买不起时的价格（卡片 opacity .74）'],
  ['.bag-name', '.bag-slot', '背包道具名（契约点名要算）'],
  ['.bag-count', '.bag-slot', '背包数量'],
  ['.shop-buy', '.shop-buy', '购买按钮文字（金色渐变底）'],
  ['.shop-buy:disabled', '.shop-buy:disabled', '禁用购买按钮']
];
var cRows = [], cBad = [], cNoParse = [];
PAIRS.forEach(function (p) {
  var fgSel = p[0], bgSel = p[1];
  var fg = CSSX.rgbOf(CSSX.decls(fgSel)['color']);
  var fgSrc = CSSX.decls(fgSel)['color'];
  if (!fg && /bag-name/.test(fgSel)) { fg = CSSX.rgbOf(CSSX.decls('.bag-slot')['color']); fgSrc = '.bag-slot 的 color=' + CSSX.decls('.bag-slot')['color'] + '（.bag-name 自身未声明，继承）'; }
  var bgs = CSSX.bgs(bgSel);
  if (!fg || !bgs) { cNoParse.push(p[2] + '（fg=' + fgSrc + ' bg=' + (bgs && bgs.length) + '）'); return; }
  var opa = CSSX.opacityOf(fgSel.split(' ')[0]);
  var ratioMin = 99;
  bgs.forEach(function (bg) {
    var f = fg, b = bg;
    if (opa < 1) { f = CSSX.over({ r: f.r, g: f.g, b: f.b, a: opa }, CSSX.base); b = CSSX.over({ r: b.r, g: b.g, b: b.b, a: opa }, CSSX.base); }
    ratioMin = Math.min(ratioMin, CSSX.ratio(f, b));
  });
  var px = CSSX.fontSizePx(fgSel, 667, 375);
  var wt = CSSX.weight(fgSel);
  var large = px != null && (px >= 24 || (px >= 18.66 && wt >= 700));
  var need = large ? 3 : 4.5;
  var okP = ratioMin >= need - 1e-9;
  cRows.push({ pair: p[2], fg: fgSel, bg: bgSel, ratio: ratioMin, need: need, px: px, wt: wt, ok: okP });
  if (!okP) cBad.push(p[2] + '（' + fgSel + ' on ' + bgSel + '）仅 ' + ratioMin.toFixed(2) + ':1，契约要求 ≥' + need + ':1');
});
ck.ok('U11.1', PAIRS.length >= 15 && cBad.length === 0,
  'style.css 关键文字对底色 WCAG 对比度全部达标（' + PAIRS.length + ' 对由脚本实算：正文 ≥4.5:1、大字 ≥3:1；含契约点名的 .shop-price / .bag-name）',
  cRows.map(function (r) { return (r.ok ? 'PASS' : 'FAIL') + ' ' + r.pair + ' ' + r.ratio.toFixed(2) + ':1/需' + r.need + (r.px ? '(' + r.px.toFixed(1) + 'px,w' + r.wt + ')' : ''); }).join(' | ') +
  (cBad.length ? ' || 不达标：' + cBad.join('; ') : ''));
ck.ok('U11.2', cNoParse.length === 0,
  '每对都成功从 style.css 解析出真实颜色并算出比值（无「拍脑袋」常量；' + PAIRS.length + ' 对全部可解析）',
  cNoParse.length ? '无法解析：' + cNoParse.join('; ') : ('全部 ' + PAIRS.length + ' 对可解析，最差 ' + cRows.map(function (r) { return r.ratio; }).sort(function (a, b) { return a - b; })[0].toFixed(2) + ':1'));
var worst = cRows.slice().sort(function (a, b) { return a.ratio - b.ratio; })[0];
ck.ok('U11.3', worst && worst.ratio >= 4.5,
  '最差一对也 ≥4.5:1（' + (worst ? worst.pair + ' ' + worst.ratio.toFixed(2) + ':1' : '') + '）');
/* 回归守卫：此对曾实测 3.26:1（卡片级 opacity:.74 + --danger）低于 4.5:1，
   已由 ui-render 改为 #ff9b9b 修掉；本项专门守住它，不再只靠 U11.1 汇总行。 */
var poorRow = cRows.filter(function (r) { return r.fg === '.shop-card.is-poor .shop-price'; })[0];
ck.ok('U11.4', !!poorRow && poorRow.need === 4.5 && poorRow.ratio >= 4.5,
  '「买不起」态价格（.shop-card.is-poor{opacity:.74}）专项对照度 ≥4.5:1：实测 ' +
  (poorRow ? poorRow.ratio.toFixed(2) : '?') + ':1（修复前 3.26:1，ui-render 已换成 #ff9b9b）',
  poorRow ? ('ratio=' + poorRow.ratio.toFixed(2) + ' need=' + poorRow.need + ' color=' + CSSX.decls('.shop-card.is-poor .shop-price')['color']) : 'none');

ck.print();
process.exit(ck.counts().FAIL > 0 ? 1 : 0);

})().catch(function (e) {
  ck.fail('U9.0', 'dom-smoke 主流程不抛异常（垫片/页面脚本无未捕获异常）',
    (e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : String(e)));
  ck.print();
  process.exit(1);
});

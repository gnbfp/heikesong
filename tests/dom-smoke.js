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
var rN = await Promise.race([pN.then(function () { return 'resolved'; }), sleep(2500).then(function () { return 'timeout'; })]);
ck.ok('U3.1', rN === 'resolved', '旁白自动播完并 resolve（不需要外部跳过）', rN);
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
ck.ok('U3.5', dtLong < 2000, '单句 200 字旁白 ≤2 秒读完（阶段 6 P0 实测 ' + dtLong + 'ms）');
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

ck.print();
process.exit(ck.counts().FAIL > 0 ? 1 : 0);

})().catch(function (e) {
  ck.fail('U9.0', 'dom-smoke 主流程不抛异常（垫片/页面脚本无未捕获异常）',
    (e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : String(e)));
  ck.print();
  process.exit(1);
});

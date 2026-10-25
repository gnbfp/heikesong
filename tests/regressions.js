'use strict';

var L = require('./lib.js');
var Sh = require('./dom-shim.js');
var ck = new L.Checker('regressions.js —— 2026-10-25 六项缺陷回归');

async function flush() { for (var i = 0; i < 40; i++) await Promise.resolve(); }
function game(search) {
  var location = { href: 'https://example.invalid/index.html' + (search || ''), search: search || '', hash: '' };
  var load = L.loadScripts({ globals: { location: location } });
  if (load.errors.length) throw new Error(load.errors.join('\n'));
  var g = load.sandbox.Game;
  var ui = L.recordingUI();
  g.init({ deps: { ui: ui, location: location, setTimeout: L.immediateTimeout, clearTimeout: function () {}, now: function () { return 20261025; } } });
  return { g: g, ui: ui, root: load.sandbox };
}
async function pick(g, slot, mode) {
  g.start(mode || 'demo'); await flush();
  g.action({ type: 'pick', slot: slot }); await flush();
}

(async function () {
  ck.section('过期回调与表现层取消');
  var a = game(), release, calls = 0;
  a.ui.playNarratorLine = function () {
    return ++calls === 1 ? new Promise(function (r) { release = r; }) : Promise.resolve();
  };
  a.g.state.phase = 'REVEAL'; a.g.state.round = 3; a.g.state.emptyStreak = 2;
  a.g.state.doors = [{ slot: 0, itemId: 'empty', revealed: true }, { slot: 1, itemId: 'small_prize' }, { slot: 2, itemId: 'big_prize' }];
  a.g.state.pickedSlot = 0;
  a.g.settleRound();
  a.g.deps.setTimeout = function () { return 1; };
  a.g.reset(); release(); await flush();
  ck.eq('R1.1', a.ui.rec.modals.length, 0, '重置后旧彩蛋 Promise 不得打开上一局弹层');
  ck.eq('R1.2', a.g.state.phase, 'IDLE', '旧结算回调不改变新局状态');

  var b = game(), oldReveal, newReveal, revealCount = 0;
  b.ui.playReveal = function () { return new Promise(function (r) { if (++revealCount === 1) oldReveal = r; else newReveal = r; }); };
  await pick(b.g, 0); b.g.action({ type: 'decide', choice: 'stick' });
  await pick(b.g, 0); b.g.action({ type: 'decide', choice: 'stick' });
  oldReveal(); await flush();
  ck.eq('R1.3', b.g.state.log.length, 0, '新局也在 REVEAL 时，旧开奖回调不能提前结算新局');
  newReveal(); await flush();
  ck.eq('R1.4', b.g.state.log.length, 1, '本局开奖结束才结算，且只结算一次');

  ck.section('实际资源增量与模式');
  var c = game(); await pick(c.g, 0);
  c.g.action({ type: 'decide', choice: 'double' });
  c.g.action({ type: 'decide', choice: 'stick' }); await flush();
  ck.eq('R2.1', c.g.state.roundResult.delta.coins, 60, '加倍小奖记录实际 +60 金币');
  ck.ok('R2.2', /金币 \+60/.test(c.ui.rec.modals[c.ui.rec.modals.length - 1].body), '结算文字使用实际 +60，而不是物品基础 +30');
  ck.eq('R2.3', c.g.state.roundResult.delta.suspicion, 1, '怀疑值上限夹紧后记录实际 +1，而非理论 +2');
  var d = game(); await pick(d.g, 2);
  d.g.state.coins = 20;
  d.g.action({ type: 'decide', choice: 'double' });
  d.g.action({ type: 'decide', choice: 'stick' }); await flush();
  ck.eq('R2.4', d.g.state.roundResult.delta.coins, -20, '金币不足时记录实际扣除 -20');
  ck.ok('R2.5', /金币 -20/.test(d.ui.rec.modals[d.ui.rec.modals.length - 1].body), '炸弹结算显示实际损失');
  var m = game(); await pick(m.g, 0, 'normal');
  m.g.action({ type: 'decide', choice: 'cashout' });
  m.g.action({ type: 'modal_choice', choice: 'restart' }); await flush();
  ck.eq('R3.1', m.g.state.mode, 'normal', '普通模式再来一局仍为普通模式');
  var demo = game(); await pick(demo.g, 0);
  demo.g.action({ type: 'decide', choice: 'cashout' });
  demo.g.action({ type: 'modal_choice', choice: 'restart' }); await flush();
  ck.eq('R3.2', demo.g.state.mode, 'demo', '演示模式重玩仍为演示模式');

  ck.section('分享链接的种子与强制门数往返');
  var seeds = [0, 1, 16, 32, 256, 20261024, 4294967295];
  for (var n = 0; n < seeds.length; n++) {
    var source = game('?seed=' + seeds[n]); source.g.start('normal'); await flush();
    var url = source.g.seedUrl();
    var target = game(url.slice(url.indexOf('?'))); target.g.start('normal'); await flush();
    ck.eq('R4.' + n, target.g.state.rng.seed, seeds[n], '种子 ' + seeds[n] + ' 分享后保持同一数值');
    ck.deepEq('R4.board.' + n, target.g.state.doors, source.g.state.doors, '种子 ' + seeds[n] + ' 分享后门面一致');
  }
  var wide = game('?seed=16&doors=6'); wide.g.start('normal'); await flush();
  var wideUrl = wide.g.seedUrl();
  var replay = game(wideUrl.slice(wideUrl.indexOf('?'))); replay.g.start('normal'); await flush();
  ck.eq('R4.wide', replay.g.state.doors.length, 6, '复制链接保留强制 6 门选项');
  ck.deepEq('R4.wide-board', replay.g.state.doors, wide.g.state.doors, '6 门链接重放同一门面');

  ck.section('真实页面脚本的多门与输入通道');
  var copied = null;
  var page = Sh.createPage({ globals: { navigator: { clipboard: { writeText: function (value) { copied = value; return Promise.resolve(); } } } } });
  var g = page.sandbox.Game, ui = page.sandbox.UI, doc = page.doc;
  page.fire(doc.getElementById('tutorial-skip'), 'click', {});
  async function startDoors(count) {
    g.init({ mode: 'normal', doors: count, deps: { setTimeout: L.immediateTimeout, clearTimeout: clearTimeout, now: function () { return 16; } } });
    g.start('normal'); g.state.flags.skipAnim = true; ui.skip(); await flush();
  }
  var expectedCols = { 3: '3', 4: '2', 5: '3', 6: '3' };
  for (var count = 3; count <= 6; count++) {
    await startDoors(count);
    ck.eq('R5.count.' + count, doc.querySelectorAll('#doors .door').length, count, count + ' 门局渲染全部门卡');
    ck.eq('R5.badge.' + count, doc.getElementById('doors-count').textContent, count + ' 扇门', count + ' 门徽标与状态一致');
    ck.eq('R5.grid.' + count, doc.getElementById('doors').getAttribute('data-cols'), expectedCols[count], count + ' 门遵循 v5 A2 布局');
    ck.eq('R6.none.' + count, doc.querySelectorAll('.door.is-picked').length, 0, count + ' 门局未选择时不高亮任何门');
  }
  for (var key = 1; key <= 6; key++) {
    await startDoors(6);
    Sh.fire(doc, 'keydown', { key: String(key), target: doc.body });
    ck.eq('R5.key.' + key, g.state.pickedSlot, key - 1, '键盘 ' + key + ' 选择对应门');
  }
  await startDoors(6);
  page.fire(doc.querySelector('.door[data-slot="5"]'), 'click', {});
  ck.eq('R5.click6', g.state.pickedSlot, 5, '鼠标可直接选择第 6 扇门');
  await startDoors(3);
  ck.eq('R5.shrink', doc.querySelectorAll('.door').length, 3, '6 门切回 3 门时移除多余门卡');
  ck.ok('R6.aria', !/已选择/.test(doc.querySelector('.door').getAttribute('aria-label')), '未选门时无障碍标签也不谎报已选择');
  g.action({ type: 'pick', slot: 0 }); await flush();
  g.action({ type: 'decide', choice: 'stick' }); await flush();
  page.fire(doc.querySelector('.seed-copy'), 'click', {}); await flush();
  ck.eq('R4.clipboard', copied, g.seedUrl(), '复制种子按钮写入可重放链接，而不是有歧义的裸标签');

  g.state.flags.skipAnim = false;
  var held = ui.playNarratorLine({ text: '上一局正在播放的旁白' });
  ck.ok('R1.anim-active', ui.isAnimating(), '建立真正挂起的 UI 动画');
  g.deps.setTimeout = function () { return 1; };   // 暂停新局，单独检查旧动画是否取消
  g.reset(); await held; await flush();
  ck.ok('R1.anim-cancel', !ui.isAnimating(), '重置取消旧 UI 动画并释放 Promise');
  ck.ok('R1.modal-clear', doc.getElementById('modal').hidden, '重置关闭上一局弹窗');
  ck.ok('R1.hold-clear', doc.querySelectorAll('.anim-hold').length === 0, '重置清除旧门卡动画锁');
  g._clearTimers(); ui.cancel();

  ck.print();
  process.exit(ck.counts().FAIL ? 1 : 0);
})().catch(function (e) { console.error(e.stack || e); process.exit(1); });

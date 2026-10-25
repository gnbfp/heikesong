/* ============================================================================
 * tests/mutation-proof.js —— 「假绿」变异自证（不碰真实仓库，全部在临时副本里做）
 * ----------------------------------------------------------------------------
 * 真实命令：node tests/mutation-proof.js
 *          node tests/mutation-proof.js --fast     # 跳过 run-all，只跑 build-data --check + sim.js
 *
 * 为什么要有这个脚本：只有「改坏东西会变红」才是真证据。
 *   变异 ① 改 data/items.json 一个数值、不重建 js/data.js
 *        → 期望 tools/build-data.js --check 退出码 ≠ 0，且 tests/run-all.js 退出码 ≠ 0（汇总表 build-data 行 FAIL）
 *   变异 ② 让 js/game.js 跳过「剧本门位合法性校验」（主持人的硬不变量）
 *        → 期望 tests/sim.js 退出码 ≠ 0，且输出里出现 [FAIL] G8.1b（剧本碰撞用例）
 *   两次变异后都复原，并复跑证明重新变绿。
 *
 * 设计约束：真实仓库（tests/ 之外）只读。所有变异都发生在 os.tmpdir() 下的整仓副本里，
 * 因此不会覆盖任何人的并行编辑。退出码 0 = 两次变异都复现出预期的红、且复原后都变绿。
 * ========================================================================== */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var child_process = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var FAST = process.argv.indexOf('--fast') >= 0;
var results = [];

function runNode(args, cwd, timeoutMs) {
  var outFile = path.join(os.tmpdir(), 'doors-mut-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.out');
  var fd = fs.openSync(outFile, 'w');
  var r = null;
  try {
    r = child_process.spawnSync(process.execPath, args, {
      cwd: cwd, stdio: ['ignore', fd, fd], timeout: timeoutMs || 300000, windowsHide: true
    });
  } finally {
    try { fs.closeSync(fd); } catch (e) {}
  }
  var out = '';
  try { out = fs.readFileSync(outFile, 'utf8'); } catch (e) {}
  try { fs.unlinkSync(outFile); } catch (e) {}
  return {
    code: r ? r.status : null,
    out: out,
    err: r && r.error ? String(r.error.message || r.error) : null
  };
}

function lineOf(out, pattern) {
  var lines = String(out || '').split(/\r?\n/), re = new RegExp(pattern);
  for (var i = 0; i < lines.length; i++) if (re.test(lines[i])) return lines[i].trim();
  return '(未找到匹配行：' + pattern + ')';
}

function record(name, ok, detail) {
  results.push({ name: name, ok: ok, detail: detail });
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + name + ' —— ' + detail);
}

function makeCopy() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doors-mut-'));
  var copy = path.join(dir, 'repo');
  fs.cpSync(ROOT, copy, {
    recursive: true,
    filter: function (src) {
      var base = path.basename(src);
      return base !== '.git' && base !== 'node_modules';
    }
  });
  return copy;
}

console.log('变异自证（临时副本内进行，真实仓库只读）');
console.log('仓库 = ' + ROOT);
console.log('模式 = ' + (FAST ? '--fast（跳过 run-all，只跑 build-data --check + sim.js）' : '完整（含 run-all）'));

var copy = makeCopy();
console.log('副本 = ' + copy + '\n');

var itemsPath = path.join(copy, 'data', 'items.json');
var gamePath = path.join(copy, 'js', 'game.js');
var itemsOrig = fs.readFileSync(itemsPath, 'utf8');
var gameOrig = fs.readFileSync(gamePath, 'utf8');

/* ---------------- 基线：副本必须先全绿，否则变异证明无意义 ---------------- */
console.log('— 基线（未变异）—');
var baseCheck = runNode([path.join(copy, 'tools', 'build-data.js'), '--check'], copy);
record('基线 build-data --check 退出码 = 0', baseCheck.code === 0,
  'exit=' + baseCheck.code + '｜' + lineOf(baseCheck.out, '--check'));
var baseSim = runNode([path.join(copy, 'tests', 'sim.js')], copy);
record('基线 sim.js 退出码 = 0', baseSim.code === 0, 'exit=' + baseSim.code + '｜' + lineOf(baseSim.out, '小结：'));

/* ---------------- 变异 ①a：data/items.json 一个数值漂移，不重建 js/data.js ---------------- */
console.log('\n— 变异 ①a：改 data/items.json 的数值（weight 8 → 9）、不重建 js/data.js —');
var t1 = itemsOrig.replace(/"weight": 8/, '"weight": 9');
var mutated1 = t1 !== itemsOrig;
fs.writeFileSync(itemsPath, t1, 'utf8');
var jsonOk1 = false;
try { jsonOk1 = !!JSON.parse(fs.readFileSync(itemsPath, 'utf8')).items; } catch (e) { jsonOk1 = false; }
record('变异 ①a 已生效且 items.json 仍是合法 JSON', mutated1 && jsonOk1,
  '首个 "weight": 8 → 9；JSON.parse 通过=' + jsonOk1);

var check1 = runNode([path.join(copy, 'tools', 'build-data.js'), '--check'], copy);
record('变异 ①a build-data --check 退出码 ≠ 0', check1.code !== 0,
  'exit=' + check1.code + '｜' + lineOf(check1.out, '校验失败|--check'));
if (!FAST) {
  var all1 = runNode([path.join(copy, 'tests', 'run-all.js')], copy);
  /* 取汇总表那一行（行首即套件名），避免误取上方 `# build-data ... exit=1` 的日志行 */
  var row1 = lineOf(all1.out, '^build-data --check（data');
  var final1 = lineOf(all1.out, '^最终结果');
  var tableOk1 = /FAIL/.test(row1) && /FAIL/.test(final1);
  record('变异 ①a run-all.js 退出码 ≠ 0 且汇总表 build-data 行 FAIL', all1.code !== 0 && tableOk1,
    'exit=' + all1.code + '｜' + row1 + '｜' + final1);
}

/* ---------------- 复原 ①a ---------------- */
fs.writeFileSync(itemsPath, itemsOrig, 'utf8');
var check1b = runNode([path.join(copy, 'tools', 'build-data.js'), '--check'], copy);
record('复原 ①a 后 build-data --check 重新变绿', check1b.code === 0,
  'exit=' + check1b.code + '｜' + lineOf(check1b.out, '--check'));
if (!FAST) {
  var all1b = runNode([path.join(copy, 'tests', 'run-all.js')], copy);
  record('复原 ①a 后 run-all.js 重新变绿', all1b.code === 0,
    'exit=' + all1b.code + '｜' + lineOf(all1b.out, '^合计') + '｜' + lineOf(all1b.out, '^最终结果'));
}

/* ---------------- 变异 ①b：纯产物漂移（改自由文案，绕过语义校验，直击 --check 的比对逻辑） ------------- */
console.log('\n— 变异 ①b：只改 data/items.json 的自由文案（数值/效果均不动）、不重建 js/data.js —');
var t1b = itemsOrig.replace('金币 +30、怀疑值 +1。甜头也上头。', '金币 +30、怀疑值 +1。甜头也上头。（漂移）');
var mutated1b = t1b !== itemsOrig;
fs.writeFileSync(itemsPath, t1b, 'utf8');
record('变异 ①b 已生效（仅改 desc 文案）', mutated1b, '锚点替换=' + mutated1b);
var check1c = runNode([path.join(copy, 'tools', 'build-data.js'), '--check'], copy);
record('变异 ①b build-data --check 报「产物与 data/*.json 不一致」且退出码 ≠ 0',
  check1c.code !== 0 && /不一致|失败/.test(check1c.out),
  'exit=' + check1c.code + '｜' + lineOf(check1c.out, '不一致|失败'));
fs.writeFileSync(itemsPath, itemsOrig, 'utf8');
var check1d = runNode([path.join(copy, 'tools', 'build-data.js'), '--check'], copy);
record('复原 ①b 后 build-data --check 重新变绿', check1d.code === 0,
  'exit=' + check1d.code + '｜' + lineOf(check1d.out, '--check'));

/* ---------------- 变异 ②：跳过剧本门位合法性校验（主持人硬不变量） ---------------- */
console.log('\n— 变异 ②：让 js/game.js 跳过剧本门位校验（hostScriptFallback 分支） —');
var anchor2 = 'if (hostSlot != null && (hostSlot === slot || !s.doors[hostSlot] || s.doors[hostSlot].opened';
var t2 = gameOrig.replace(anchor2, 'if (false && (hostSlot === slot || !s.doors[hostSlot] || s.doors[hostSlot].opened');
var mutated2 = t2 !== gameOrig;
fs.writeFileSync(gamePath, t2, 'utf8');
record('变异 ② 已生效（校验分支被短路为 false）', mutated2, '锚点替换=' + mutated2);

var sim2 = runNode([path.join(copy, 'tests', 'sim.js')], copy);
var found2 = /\[FAIL\]\s+G8\.1b/.test(sim2.out);
record('变异 ② sim.js 退出码 ≠ 0 且出现 [FAIL] G8.1b', sim2.code !== 0 && found2,
  'exit=' + sim2.code + '｜' + lineOf(sim2.out, 'G8\\.1b') + '｜' + lineOf(sim2.out, '小结：'));

/* ---------------- 复原 ② ---------------- */
fs.writeFileSync(gamePath, gameOrig, 'utf8');
var sim2b = runNode([path.join(copy, 'tests', 'sim.js')], copy);
record('复原 ② 后 sim.js 重新变绿', sim2b.code === 0,
  'exit=' + sim2b.code + '｜' + lineOf(sim2b.out, '小结：'));

/* ---------------- 变异 ③：商店 DOM 契约（ui.js 不再标 .is-poor） ---------------- */
console.log('\n— 变异 ③：让 js/ui.js 不再按 affordable 标 .is-poor（商店 DOM 契约回归） —');
var uiPath = path.join(copy, 'js', 'ui.js');
var uiOrig = fs.readFileSync(uiPath, 'utf8');
var anchor3 = 'var poor = it.affordable === false;';
var t3 = uiOrig.replace(anchor3, 'var poor = false; /* MUTANT：故意不标 .is-poor */');
var mutated3 = t3 !== uiOrig;
fs.writeFileSync(uiPath, t3, 'utf8');
record('变异 ③ 已生效（renderShop 不再产生 .is-poor）', mutated3, '锚点替换=' + mutated3);

var dom3 = runNode([path.join(copy, 'tests', 'dom-smoke.js')], copy);
var found3 = /\[FAIL\]\s+U10\.10/.test(dom3.out);
record('变异 ③ dom-smoke.js 退出码 ≠ 0 且出现 [FAIL] U10.10（买不起置灰）', dom3.code !== 0 && found3,
  'exit=' + dom3.code + '｜' + lineOf(dom3.out, 'U10\\.10') + '｜' + lineOf(dom3.out, '小结：'));

/* ---------------- 复原 ③ ---------------- */
fs.writeFileSync(uiPath, uiOrig, 'utf8');
var dom3b = runNode([path.join(copy, 'tests', 'dom-smoke.js')], copy);
record('复原 ③ 后 dom-smoke.js 重新变绿', dom3b.code === 0,
  'exit=' + dom3b.code + '｜' + lineOf(dom3b.out, '小结：'));

/* ---------------- 变异 ④：商店经济（即时商品不扣钱） ---------------- */
console.log('\n— 变异 ④：让 js/game.js 的即时商品购买不扣金币（经济结算回归） —');
var anchor4 = "{ id: 'shop_buy', label: def.name, coins: -def.price }, { multiplier: 1, source: 'shop' }";
var t4 = gameOrig.replace(anchor4, "{ id: 'shop_buy', label: def.name, coins: 0 }, { multiplier: 1, source: 'shop' }");
var mutated4 = t4 !== gameOrig && t4 !== t2;
fs.writeFileSync(gamePath, t4, 'utf8');
record('变异 ④ 已生效（即时商品扣款 0）', mutated4, '锚点替换=' + mutated4);

var shop4 = runNode([path.join(copy, 'tests', 'shop.js')], copy);
record('变异 ④ shop.js 退出码 ≠ 0（购买后金币/花销断言抓到不扣钱）', shop4.code !== 0,
  'exit=' + shop4.code + '｜' + lineOf(shop4.out, '\\[FAIL\\] SH') + '｜' + lineOf(shop4.out, '小结：'));

/* ---------------- 复原 ④ ---------------- */
fs.writeFileSync(gamePath, gameOrig, 'utf8');
var shop4b = runNode([path.join(copy, 'tests', 'shop.js')], copy);
record('复原 ④ 后 shop.js 重新变绿', shop4b.code === 0,
  'exit=' + shop4b.code + '｜' + lineOf(shop4b.out, '小结：'));

/* ---------------- 变异 ⑤：ui.js 去掉 s(换门) 键位映射 → ux.js 键盘断言变红 ---------------- */
console.log('\n— 变异 ⑤：去掉 js/ui.js 的 s → decide:switch 键位映射（契约 v4 §4.2 键盘） —');
var anchor5 = "if (low === 's') { if (keyDecide('switch')) e.preventDefault(); return; }";
var t5 = uiOrig.replace(anchor5, "/* MUTANT：s 键位被删 */");
var mutated5 = t5 !== uiOrig;
var uiPath2 = path.join(copy, 'js', 'ui.js');
fs.writeFileSync(uiPath2, t5, 'utf8');
record('变异 ⑤ 已生效（s 键位映射被删）', mutated5, '锚点替换=' + mutated5);

var ux5 = runNode([path.join(copy, 'tests', 'ux.js')], copy);
record('变异 ⑤ ux.js 退出码 ≠ 0 且点名 X4.3', ux5.code !== 0 && /\[FAIL\] X4\.3/.test(ux5.out),
  'exit=' + ux5.code + '｜' + lineOf(ux5.out, '\\[FAIL\\] X4\\.3') + '｜' + lineOf(ux5.out, '小结：'));

/* ---------------- 复原 ⑤ ---------------- */
fs.writeFileSync(uiPath2, uiOrig, 'utf8');
var ux5b = runNode([path.join(copy, 'tests', 'ux.js')], copy);
record('复原 ⑤ 后 ux.js 的 X4.3 重新变绿', /\[PASS\] X4\.3/.test(ux5b.out),
  'exit=' + ux5b.code + '｜' + lineOf(ux5b.out, '\\[PASS\\] X4\\.3'));

/* ---------------- 变异 ⑥：js/state.js 改成就存档键名 → ux.js 落盘断言变红 ---------------- */
console.log('\n— 变异 ⑥：把成就存档键名改成 three_doors_achievements_v2（跨局持久断言） —');
var statePath = path.join(copy, 'js', 'state.js');
var stateOrig = fs.readFileSync(statePath, 'utf8');
var anchor6 = "achievements: 'three_doors_achievements_v1'";
var t6 = stateOrig.replace(anchor6, "achievements: 'three_doors_achievements_v2'");
var mutated6 = t6 !== stateOrig;
fs.writeFileSync(statePath, t6, 'utf8');
record('变异 ⑥ 已生效（成就键名改成 v2）', mutated6, '锚点替换=' + mutated6);

var ux6 = runNode([path.join(copy, 'tests', 'ux.js')], copy);
record('变异 ⑥ ux.js 退出码 ≠ 0 且点名 X1.6', ux6.code !== 0 && /\[FAIL\] X1\.6/.test(ux6.out),
  'exit=' + ux6.code + '｜' + lineOf(ux6.out, '\\[FAIL\\] X1\\.6') + '｜' + lineOf(ux6.out, '小结：'));

/* ---------------- 复原 ⑥ ---------------- */
fs.writeFileSync(statePath, stateOrig, 'utf8');
var ux6b = runNode([path.join(copy, 'tests', 'ux.js')], copy);
record('复原 ⑥ 后 ux.js 的 X1.6 重新变绿', /\[PASS\] X1\.6/.test(ux6b.out),
  'exit=' + ux6b.code + '｜' + lineOf(ux6b.out, '\\[PASS\\] X1\\.6'));

/* ---------------- 变异 ⑦：门数上限 6→4 → doors.js 的 G9.4 变红 ---------------- */
console.log('\n— 变异 ⑦：把 js/game.js 的 clampDoorCount 上限 6 改成 4（?doors=6 失效） —');
var anchor7 = 'return Math.max(3, Math.min(6, n));';
var t7 = gameOrig.replace(anchor7, 'return Math.max(3, Math.min(4, n));');
fs.writeFileSync(gamePath, t7, 'utf8');
record('变异 ⑦ 已生效（门数上限改成 4）', t7 !== gameOrig, '锚点替换=' + (t7 !== gameOrig));
var d7 = runNode([path.join(copy, 'tests', 'doors.js')], copy);
record('变异 ⑦ doors.js 退出码 ≠ 0 且点名 G9.4', d7.code !== 0 && /\[FAIL\] G9\.4/.test(d7.out),
  'exit=' + d7.code + '｜' + lineOf(d7.out, '\\[FAIL\\] G9\\.4') + '｜' + lineOf(d7.out, '小结：'));
fs.writeFileSync(gamePath, gameOrig, 'utf8');
var d7b = runNode([path.join(copy, 'tests', 'doors.js')], copy);
record('复原 ⑦ 后 doors.js 的 G9.4 重新变绿', /\[PASS\] G9\.4/.test(d7b.out),
  'exit=' + d7b.code + '｜' + lineOf(d7b.out, '\\[PASS\\] G9\\.4'));

/* ---------------- 变异 ⑧：演示剧本门数优先级失效 → doors.js 的 G9.10 变红 ---------------- */
console.log('\n— 变异 ⑧：让 doorCountFor 忽略演示剧本（剧本优先失效） —');
var anchor8 = 'if (s.mode !== MODES.NORMAL && script && Array.isArray(script.doors) && script.doors.length) {';
var t8 = gameOrig.replace(anchor8, 'if (false) {');
fs.writeFileSync(gamePath, t8, 'utf8');
record('变异 ⑧ 已生效（剧本门数分支被短路）', t8 !== gameOrig, '锚点替换=' + (t8 !== gameOrig));
var d8 = runNode([path.join(copy, 'tests', 'doors.js')], copy);
record('变异 ⑧ doors.js 退出码 ≠ 0 且点名 G9.10', d8.code !== 0 && /\[FAIL\] G9\.10/.test(d8.out),
  'exit=' + d8.code + '｜' + lineOf(d8.out, '\\[FAIL\\] G9\\.10') + '｜' + lineOf(d8.out, '小结：'));
fs.writeFileSync(gamePath, gameOrig, 'utf8');
var d8b = runNode([path.join(copy, 'tests', 'doors.js')], copy);
record('复原 ⑧ 后 doors.js 的 G9.10 重新变绿', /\[PASS\] G9\.10/.test(d8b.out),
  'exit=' + d8b.code + '｜' + lineOf(d8b.out, '\\[PASS\\] G9\\.10'));

/* ---------------- 汇总 ---------------- */
var bad = results.filter(function (r) { return !r.ok; });
console.log('\n' + '='.repeat(72));
console.log('变异自证汇总：' + (results.length - bad.length) + '/' + results.length + ' 项符合预期');
results.forEach(function (r) { console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.name); });
console.log('='.repeat(72));
console.log(bad.length ? '结论：变异自证失败（存在未复现的红或未复原的绿）' : '结论：两次变异都能变红、复原后都能变绿（测试不是假绿）');
try { fs.rmSync(path.dirname(copy), { recursive: true, force: true }); } catch (e) {}
process.exit(bad.length ? 1 : 0);

/* ============================================================================
 * tests/run-all.js —— 一键跑全部检查，输出 PASS/FAIL 汇总表
 * ----------------------------------------------------------------------------
 * 真实命令：node tests/run-all.js
 * 退出码：0 = 全部 PASS（允许 SKIP）；1 = 存在 FAIL。
 * STRICT=1 时把 SKIP 视为 FAIL（用于最终验收：不允许任何未覆盖项）。
 * ========================================================================== */
'use strict';

var path = require('path');
var fs = require('fs');
var os = require('os');
var child_process = require('child_process');

var STRICT = process.env.STRICT === '1' || process.argv.indexOf('--strict') >= 0;

var SUITES = [
  { name: 'sim.js（无头逻辑：状态/RNG/结算/整局/存档）', file: 'sim.js' },
  { name: 'dom-smoke.js（Node DOM 垫片：真实页面渲染与交互）', file: 'dom-smoke.js' },
  { name: 'headless-check.js（无头 Edge file:// 端到端；浏览器不可用则 SKIP）', file: 'headless-check.js' }
];

/* 注意：本沙箱禁止匿名管道，child_process 默认 stdio:'pipe' 会 EPERM。
 * 因此把子进程输出重定向到真实文件描述符（stdio: ['ignore', fd, fd]），不建管道。 */
function runSuite(s) {
  var full = path.join(__dirname, s.file);
  var outFile = path.join(os.tmpdir(), 'doors-tests-' + s.file + '.' + process.pid + '.out');
  var out = '', code = null, err = '';
  var fd = null;
  try {
    fd = fs.openSync(outFile, 'w');
    var r = child_process.spawnSync(process.execPath, [full], {
      stdio: ['ignore', fd, fd], timeout: 300000, windowsHide: true,
      env: Object.assign({}, process.env)
    });
    code = r.status;
    if (r.error) err = String(r.error.message || r.error);
    fs.closeSync(fd);
    fd = null;
    out = fs.readFileSync(outFile, 'utf8');
  } catch (e) {
    err = String(e && e.message ? e.message : e);
    if (fd !== null) { try { fs.closeSync(fd); } catch (e2) {} }
    try { out = fs.readFileSync(outFile, 'utf8'); } catch (e2) {}
  }
  var m = out.match(/PASS=(\d+)\s+FAIL=(\d+)\s+SKIP=(\d+)/);
  return {
    name: s.name,
    file: s.file,
    code: code,
    pass: m ? Number(m[1]) : 0,
    fail: m ? Number(m[2]) : 0,
    skip: m ? Number(m[3]) : 0,
    parsed: !!m,
    output: out,
    error: err
  };
}

console.log('三扇门 · 别信旁白 —— 验收自测（' + (STRICT ? 'STRICT 模式：SKIP 视为失败' : '普通模式：SKIP 不判失败') + '）');
console.log('node = ' + process.execPath);
console.log('仓库 = ' + path.resolve(__dirname, '..'));

var rows = SUITES.map(runSuite);

/* 明细：每个套件的完整输出（便于复核，不做二次解读） */
rows.forEach(function (r) {
  console.log('\n' + '#'.repeat(72));
  console.log('# ' + r.name + '   [node tests/' + r.file + ']  exit=' + r.code);
  console.log('#'.repeat(72));
  console.log(r.output.trimEnd());
  if (r.error) console.log('[spawn error] ' + r.error);
});

/* 汇总表 */
var w = [34, 6, 6, 6, 8];
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
function padL(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }

console.log('\n' + '='.repeat(72));
console.log('汇总表');
console.log('='.repeat(72));
console.log(pad('套件', w[0]) + padL('PASS', w[1]) + padL('FAIL', w[2]) + padL('SKIP', w[3]) + padL('结果', w[4]));
console.log('-'.repeat(72));

var totP = 0, totF = 0, totS = 0, bad = 0;
rows.forEach(function (r) {
  if (!r.parsed) {
    console.log(pad(r.name, w[0]) + padL('-', w[1]) + padL('-', w[2]) + padL('-', w[3]) + padL('无法解析', w[4]));
    console.log('   → 退出码 ' + r.code + '，未产出 PASS/FAIL 汇总（脚本崩溃或被 kill）');
    bad++;
    return;
  }
  var verdict = r.fail > 0 ? 'FAIL' : (STRICT && r.skip > 0 ? 'FAIL(SKIP)' : (r.skip > 0 ? 'PASS(有SKIP)' : 'PASS'));
  if (r.fail > 0 || (STRICT && r.skip > 0)) bad++;
  totP += r.pass; totF += r.fail; totS += r.skip;
  console.log(pad(r.name, w[0]) + padL(r.pass, w[1]) + padL(r.fail, w[2]) + padL(r.skip, w[3]) + padL(verdict, w[4]));
});
console.log('-'.repeat(72));
console.log(pad('合计', w[0]) + padL(totP, w[1]) + padL(totF, w[2]) + padL(totS, w[3]) + padL(bad ? 'FAIL' : 'PASS', w[4]));
console.log('='.repeat(72));
console.log(bad ? '\n最终结果：FAIL（存在失败项或无法解析的套件）' : '\n最终结果：PASS');
if (totS > 0) console.log('注意：有 ' + totS + ' 项 SKIP（未覆盖）；最终验收请用 STRICT=1 复跑。');

process.exit(bad ? 1 : 0);

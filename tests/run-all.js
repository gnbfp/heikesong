/* ============================================================================
 * tests/run-all.js —— 一键跑全部检查，输出 PASS/FAIL 汇总表
 * ----------------------------------------------------------------------------
 * 真实命令：node tests/run-all.js
 *
 * 【默认跑的 7 个套件】
 *   1. tools/build-data.js --check   data/*.json ↔ js/data.js 产物一致性（预防「改了数据没重建」的假绿）
 *   2. tests/sim.js                  无头逻辑：状态机/RNG/结算/整局/存档/离线自包含
 *   3. tests/shop.js                 商店契约（经济/限购/道具/换门/闭嘴卡/保险丝/结算页），依赖真实 js/*
 *   4. tests/features.js             契约 v3 新玩法（claim/连击/怀疑值/8 档结局/提词器/音频/图鉴），依赖真实 js/*
 *   5. tests/ux.js                   契约 v4 体验（成就/统计/种子重放/键盘/人格/引导/竖屏/离线），依赖真实 js/*
 *   6. tests/dom-smoke.js            Node DOM 垫片：真实 index.html + js/*.js 渲染与交互
 *   7. tests/headless-check.js       无头 Edge file:// 端到端（浏览器不可用则整段 SKIP）
 *
 * 【SKIP 的含义】SKIP = 该条断言在当前环境无法执行/无意义（不是通过，也不是失败）：
 *   - headless-check.js 的 H* 在无浏览器沙箱里整段 SKIP，替代证据由 tests/dom-smoke.js 与
 *     tests/sim.js 的同类断言提供；
 *   - shop.js / sim.js 在缺 js/data.js 等产物时会把相关项标 SKIP 而不是假装通过。
 *   默认 SKIP 不算失败；STRICT=1 时 SKIP 一律判失败（见下）。
 *
 * 【退出码】0 = 全部 PASS（允许 SKIP）；1 = 存在 FAIL。
 *   任何套件自身退出码非 0 也算 FAIL（即使它打印了 PASS=/FAIL= 汇总行，
 *   以防「先打印汇总、再崩溃」造成的假绿）。
 *
 * 【STRICT=1 或 --strict 的语义】
 *   默认（非 STRICT）：SKIP 只提示不判失败 —— 适合日常开发，浏览器不可用的沙箱里也能跑完。
 *   STRICT=1：把每一项 SKIP 视为 FAIL（最终验收用：不允许任何未覆盖项）。
 *   两种模式下脚本都会在结尾「未覆盖项（SKIP）明细」区逐条点名 SKIP 的 id / 套件 / 原因，
 *   便于无人值守时一眼看出到底缺什么证据。
 *
 * 【假绿自证（按需跑，不在默认 7 个套件里）】
 *   node tests/mutation-proof.js         # 在 os.tmpdir() 的整仓副本里变异：①data/items.json 数值漂移
 *                                        #   ①b 只改 desc 文案 ②去掉 js/game.js 剧本门位校验
 *                                        #   ③js/ui.js 不再标 .is-poor ④即时商品不扣钱；
 *                                        #   期望每次变红、复原后变绿（当前 17/17 符合预期）
 *   node tests/mutation-proof.js --fast  # 同上但跳过 run-all（只跑 --check + sim/shop/dom-smoke）
 * ========================================================================== */
'use strict';

var path = require('path');
var fs = require('fs');
var os = require('os');
var child_process = require('child_process');

var STRICT = process.env.STRICT === '1' || process.argv.indexOf('--strict') >= 0;

/* mode: 'summary' = 套件自己打印 PASS=/FAIL=/SKIP= 汇总行，按行计数；
 *       'exit'    = 套件只给退出码（如 build-data --check），退出码 0 即 PASS。 */
var SUITES = [
  {
    name: 'build-data --check（data/*.json ↔ js/data.js 产物一致性）',
    file: '../tools/build-data.js', args: ['--check'], mode: 'exit',
    label: 'node tools/build-data.js --check'
  },
  {
    name: 'sim.js（无头逻辑：状态/RNG/结算/整局/存档/离线自包含）',
    file: 'sim.js', label: 'node tests/sim.js'
  },
  {
    name: 'shop.js（商店契约：经济/限购/道具/换门/闭嘴卡/保险丝/结算页）',
    file: 'shop.js', label: 'node tests/shop.js'
  },
  {
    name: 'features.js（契约 v3 新玩法：线索 claim/连击/怀疑值/结局矩阵/提词器/音频/图鉴可达）',
    file: 'features.js', label: 'node tests/features.js'
  },
  {
    name: 'ux.js（契约 v4 体验：成就判定/统计/种子重放/键盘/人格/引导/竖屏/离线）',
    file: 'ux.js', label: 'node tests/ux.js'
  },
  {
    name: 'doors.js（契约 v5 多门：?doors 3–6/主持人/换门/复现/概率）',
    file: 'doors.js', label: 'node tests/doors.js'
  },
  {
    name: 'dom-smoke.js（Node DOM 垫片：真实页面渲染与交互）',
    file: 'dom-smoke.js', label: 'node tests/dom-smoke.js'
  },
  {
    name: 'headless-check.js（无头 Edge file:// 端到端；浏览器不可用则 SKIP）',
    file: 'headless-check.js', label: 'node tests/headless-check.js'
  }
];

/* 注意：本沙箱禁止匿名管道，child_process 默认 stdio:'pipe' 会 EPERM。
 * 因此把子进程输出重定向到真实文件描述符（stdio: ['ignore', fd, fd]），不建管道。 */
function runSuite(s) {
  var full = path.isAbsolute(s.file) ? s.file : path.join(__dirname, s.file);
  var args = [full].concat(s.args || []);
  var tag = (s.file + '').replace(/[\\/.]/g, '_') + (s.args ? '_' + s.args.join('_') : '');
  var outFile = path.join(os.tmpdir(), 'doors-tests-' + tag + '.' + process.pid + '.out');
  var out = '', code = null, err = '';
  var fd = null;
  try {
    fd = fs.openSync(outFile, 'w');
    var r = child_process.spawnSync(process.execPath, args, {
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
    label: s.label || ('node tests/' + s.file),
    mode: s.mode || 'summary',
    code: code,
    pass: m ? Number(m[1]) : 0,
    fail: m ? Number(m[2]) : 0,
    skip: m ? Number(m[3]) : 0,
    parsed: !!m,
    output: out,
    error: err
  };
}

/** 从套件输出里抽出 SKIP 明细（`[SKIP] <id> <msg>` + 下一行缩进原因）。 */
function skipsOf(r) {
  var out = [];
  var lines = String(r.output || '').split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^\s*\[SKIP\]\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    var why = '';
    for (var j = i + 1; j < lines.length; j++) {
      if (/^\s*\[(PASS|FAIL|SKIP)\]/.test(lines[j]) || /^\s*--/.test(lines[j])) break;
      if (lines[j].trim()) { why = lines[j].trim(); break; }
    }
    out.push({ suite: r.name, id: m[1], msg: m[2], why: why });
  }
  return out;
}

console.log('三扇门 · 别信旁白 —— 验收自测（' + (STRICT ? 'STRICT 模式：SKIP 视为失败' : '普通模式：SKIP 不判失败') + '）');
console.log('node = ' + process.execPath);
console.log('仓库 = ' + path.resolve(__dirname, '..'));
console.log('套件数 = ' + SUITES.length + '（含 data/*.json ↔ js/data.js 产物一致性检查）');

var rows = SUITES.map(runSuite);

/* 明细：每个套件的完整输出（便于复核，不做二次解读） */
rows.forEach(function (r) {
  console.log('\n' + '#'.repeat(72));
  console.log('# ' + r.name + '   [' + r.label + ']  exit=' + r.code);
  console.log('#'.repeat(72));
  console.log(r.output.trimEnd());
  if (r.error) console.log('[spawn error] ' + r.error);
});

/* 汇总表 */
var w = [42, 6, 6, 6, 11];
/* 中文按 2 列宽计算，否则汇总表在终端里会错位 */
function dw(s) {
  s = String(s);
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    var wide = c === 0x2329 || c === 0x232a ||
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    n += wide ? 2 : 1;
  }
  return n;
}
function pad(s, n) { s = String(s); while (dw(s) < n) s += ' '; return s; }
function padL(s, n) { s = String(s); while (dw(s) < n) s = ' ' + s; return s; }

console.log('\n' + '='.repeat(72));
console.log('汇总表');
console.log('='.repeat(72));
console.log(pad('套件', w[0]) + padL('PASS', w[1]) + padL('FAIL', w[2]) + padL('SKIP', w[3]) + padL('结果', w[4]));
console.log('-'.repeat(72));

var totP = 0, totF = 0, totS = 0, bad = 0;
rows.forEach(function (r) {
  var verdict;
  if (r.mode === 'exit') {
    verdict = r.code === 0 ? 'PASS' : 'FAIL';
    if (r.code !== 0) bad++;
    console.log(pad(r.name, w[0]) + padL('-', w[1]) + padL('-', w[2]) + padL('-', w[3]) + padL(verdict, w[4]));
    if (r.code !== 0) {
      console.log('   → ' + r.label + ' 退出码 ' + r.code + '（产物与 data/*.json 不一致；修复：node tools/build-data.js）');
      console.log('   ' + r.output.trim().split(/\r?\n/).slice(-6).join('\n   '));
    }
    return;
  }
  if (!r.parsed) {
    console.log(pad(r.name, w[0]) + padL('-', w[1]) + padL('-', w[2]) + padL('-', w[3]) + padL('无法解析', w[4]));
    console.log('   → 退出码 ' + r.code + '，未产出 PASS/FAIL 汇总（脚本崩溃或被 kill）');
    bad++;
    return;
  }
  verdict = r.fail > 0 ? 'FAIL' : (r.code !== 0 ? 'FAIL(exit' + r.code + ')' : (STRICT && r.skip > 0 ? 'FAIL(SKIP)' : (r.skip > 0 ? 'PASS(有SKIP)' : 'PASS')));
  if (r.fail > 0 || r.code !== 0 || (STRICT && r.skip > 0)) bad++;
  totP += r.pass; totF += r.fail; totS += r.skip;
  console.log(pad(r.name, w[0]) + padL(r.pass, w[1]) + padL(r.fail, w[2]) + padL(r.skip, w[3]) + padL(verdict, w[4]));
});
console.log('-'.repeat(72));
console.log(pad('合计', w[0]) + padL(totP, w[1]) + padL(totF, w[2]) + padL(totS, w[3]) + padL(bad ? 'FAIL' : 'PASS', w[4]));
console.log('='.repeat(72));

/* 未覆盖项（SKIP）明细：无人值守也能一眼看出缺什么证据 */
var skips = [];
rows.forEach(function (r) { skips = skips.concat(skipsOf(r)); });
if (skips.length) {
  console.log('\n未覆盖项（SKIP）明细 ' + skips.length + ' 条：');
  skips.forEach(function (s) {
    console.log('  · [' + s.id + '] ' + s.msg + '\n      套件：' + s.suite + '\n      原因：' + (s.why || '（套件未给出原因）'));
  });
} else {
  console.log('\n未覆盖项（SKIP）：无。');
}

console.log(bad ? '\n最终结果：FAIL（存在失败项、产物漂移或无法解析的套件）' : '\n最终结果：PASS');
if (totS > 0) console.log('注意：有 ' + totS + ' 项 SKIP（未覆盖）；最终验收请用 STRICT=1 复跑（SKIP 视为 FAIL）。');
if (STRICT && totS > 0) console.log('STRICT=1：上述 ' + totS + ' 项 SKIP 已判为失败（见汇总表 FAIL(SKIP)）。');

process.exit(bad ? 1 : 0);

/* ============================================================================
 * tests/lib.js —— 无依赖测试底座（node 内置模块 only，禁止 npm install）
 * ----------------------------------------------------------------------------
 * 提供：
 *   ROOT / SCRIPT_ORDER / EDGE          —— 路径与运行时常量
 *   Checker                             —— PASS/FAIL/SKIP 收集与汇总
 *   loadScripts(opts)                   —— 用 vm 在同一个 global 上下文按序加载
 *                                          js/state.js → data → effects → narrator → game
 *   runEdge(args)                       —— 无头 Edge 跑 file:// 页面
 * 关键约定：文件缺失只记录为 SKIP/明确报错，绝不抛未捕获异常导致进程崩溃。
 * ========================================================================== */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var util = require('util');
var child_process = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var JS_DIR = path.join(ROOT, 'js');

/** 与 index.html 的 <script> 顺序严格一致（零构建：经典脚本按序加载）。 */
var SCRIPT_ORDER = ['state.js', 'data.js', 'effects.js', 'narrator.js', 'ui.js', 'game.js'];

/** index.html 实际加载的脚本（用于「顺序一致性」检查）。 */
var EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
var INDEX = path.join(ROOT, 'index.html');

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

/** index.html 里 <script src> 的顺序 */
function htmlScriptOrder() {
  if (!fileExists(INDEX)) return { ok: false, error: 'index.html 不存在: ' + INDEX, order: [] };
  var html = readText(INDEX);
  var order = [];
  var re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  var m;
  while ((m = re.exec(html)) !== null) order.push(m[1]);
  return { ok: true, order: order };
}

/* --------------------------------------------------------------- Checker */
function Checker(title) {
  this.title = title;
  this.results = [];
}
Checker.prototype._add = function (status, id, msg, detail) {
  this.results.push({ status: status, id: id, msg: msg, detail: detail == null ? '' : String(detail) });
};
Checker.prototype.ok = function (id, cond, msg, detail) {
  this._add(cond ? 'PASS' : 'FAIL', id, msg, cond ? '' : detail);
  return !!cond;
};
Checker.prototype.eq = function (id, actual, expected, msg) {
  var pass = Object.is(actual, expected) || actual === expected;
  this._add(pass ? 'PASS' : 'FAIL', id, msg,
    pass ? '' : '期望 ' + util.inspect(expected) + '，实际 ' + util.inspect(actual));
  return pass;
};
/**
 * 跨 realm 安全的深比较：vm 上下文里造出的数组/对象与本进程的原型不同，
 * util.isDeepStrictEqual 会误报，所以这里只比较结构与值（不比较原型）。
 */
function deepEqual(a, b, depth) {
  depth = depth || 0;
  if (depth > 40) return true;
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (typeof a === 'number' && typeof b === 'number') return a === b || (isNaN(a) && isNaN(b));
    return a === b;
  }
  var aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], depth + 1)) return false;
    return true;
  }
  if (a instanceof Date || b instanceof Date) return Number(a) === Number(b);
  if (typeof a === 'function' || typeof b === 'function') return a === b;
  var ka, kb;
  try { ka = Object.keys(a).sort(); kb = Object.keys(b).sort(); } catch (e) { return a === b; }
  if (ka.length !== kb.length) return false;
  for (var j = 0; j < ka.length; j++) {
    if (ka[j] !== kb[j]) return false;
    if (!deepEqual(a[ka[j]], b[kb[j]], depth + 1)) return false;
  }
  return true;
}

Checker.prototype.deepEq = function (id, actual, expected, msg) {
  var pass;
  try { pass = deepEqual(actual, expected); } catch (e) { pass = false; }
  this._add(pass ? 'PASS' : 'FAIL', id, msg,
    pass ? '' : '期望 ' + util.inspect(expected, { depth: 6 }) + '\n      实际 ' + util.inspect(actual, { depth: 6 }));
  return pass;
};
Checker.prototype.skip = function (id, msg, reason) {
  this._add('SKIP', id, msg, reason);
};
Checker.prototype.fail = function (id, msg, detail) {
  this._add('FAIL', id, msg, detail);
};
Checker.prototype.section = function (name) {
  this.results.push({ status: 'SECTION', id: '', msg: name, detail: '' });
};

Checker.prototype.counts = function () {
  var c = { PASS: 0, FAIL: 0, SKIP: 0 };
  for (var i = 0; i < this.results.length; i++) {
    var s = this.results[i].status;
    if (c[s] != null) c[s]++;
  }
  return c;
};

Checker.prototype.print = function (opts) {
  opts = opts || {};
  var self = this;
  var lines = [];
  lines.push('');
  lines.push('=== ' + this.title + ' ===');
  this.results.forEach(function (r) {
    if (r.status === 'SECTION') { lines.push(''); lines.push('-- ' + r.msg); return; }
    var mark = r.status === 'PASS' ? '[PASS]' : (r.status === 'FAIL' ? '[FAIL]' : '[SKIP]');
    lines.push('  ' + mark + ' ' + r.id + ' ' + r.msg + (r.detail ? '\n         ' + r.detail : ''));
  });
  var c = this.counts();
  lines.push('');
  lines.push('-- 小结：PASS=' + c.PASS + ' FAIL=' + c.FAIL + ' SKIP=' + c.SKIP + ' 合计=' + this.results.filter(function (r) { return r.status !== 'SECTION'; }).length);
  var out = lines.join('\n');
  if (opts.silentPass) return out;
  console.log(out);
  return out;
};

/* ------------------------------------------------------------ vm loading */
/**
 * 在同一个 vm 上下文里按序加载经典脚本。
 * @param opts.withDom      是否注入最小 DOM 存根（默认 false —— 用于验证「无 DOM 也能加载」）
 * @param opts.files        覆盖加载清单（默认 SCRIPT_ORDER 中实际存在且存在的文件）
 * @returns {{ctx, loaded:string[], missing:string[], errors:Array, sandbox:object}}
 */
function loadScripts(opts) {
  opts = opts || {};
  var names = opts.files || SCRIPT_ORDER;
  var sandbox = {};
  var loaded = [];
  var missing = [];
  var errors = [];

  sandbox.console = {
    log: function () {}, info: function () {}, warn: function () {},
    error: function () { errors.push('console.error: ' + Array.prototype.join.call(arguments, ' ')); }
  };
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = setInterval;
  sandbox.clearInterval = clearInterval;
  sandbox.Date = Date;
  sandbox.Math = Math;
  sandbox.JSON = JSON;
  sandbox.structuredClone = typeof structuredClone === 'function' ? structuredClone : undefined;
  /* 额外注入的全局（用于「离线毒化」：把 fetch/XHR/WebSocket 换成一旦被调用就抛错的哨兵） */
  if (opts.globals) {
    for (var gname in opts.globals) {
      if (Object.prototype.hasOwnProperty.call(opts.globals, gname)) sandbox[gname] = opts.globals[gname];
    }
  }
  if (opts.withDom) sandbox.document = makeDomStub();
  if (opts.withDom) sandbox.window = sandbox;

  var ctx = vm.createContext(sandbox);
  sandbox.globalThis = sandbox;

  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var p = path.isAbsolute(name) ? name : path.join(JS_DIR, name.replace(/^js\//, ''));
    if (!fileExists(p)) { missing.push(p); continue; }
    try {
      vm.runInContext(readText(p), ctx, { filename: p });
      loaded.push(name);
    } catch (e) {
      errors.push(name + ': ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : String(e)));
    }
  }
  return { ctx: ctx, sandbox: sandbox, loaded: loaded, missing: missing, errors: errors };
}

/** 极简 DOM 存根：仅在需要时提供，不追求完整浏览器语义。 */
function makeDomStub() {
  function El(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.classList = { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } };
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.value = '';
    this.parentNode = null;
    this._listeners = {};
  }
  El.prototype.appendChild = function (c) { this.children.push(c); c.parentNode = this; return c; };
  El.prototype.removeChild = function (c) { this.children = this.children.filter(function (x) { return x !== c; }); return c; };
  El.prototype.setAttribute = function (k, v) { this.attributes[k] = String(v); };
  El.prototype.getAttribute = function (k) { return this.attributes[k] == null ? null : this.attributes[k]; };
  El.prototype.addEventListener = function (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); };
  El.prototype.removeEventListener = function () {};
  El.prototype.querySelector = function () { return null; };
  El.prototype.querySelectorAll = function () { return []; };
  El.prototype.dispatch = function (t, ev) { (this._listeners[t] || []).forEach(function (f) { f(ev || {}); }); };
  El.prototype.focus = function () {};
  El.prototype.remove = function () {};
  var byId = {};
  var doc = {
    readyState: 'complete',
    body: new El('body'),
    documentElement: new El('html'),
    createElement: function (t) { return new El(t); },
    createTextNode: function (t) { var e = new El('#text'); e.textContent = t; return e; },
    getElementById: function (id) { return byId[id] || (byId[id] = new El('div')); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function () {},
    removeEventListener: function () {},
    _byId: byId
  };
  doc.body.ownerDocument = doc;
  return doc;
}

/* -------------------------------------------------- Game.deps 测试替身 */

/** 立即执行的 setTimeout（无头跑全流程用；game.js 的 _wait 依赖它）。 */
function immediateTimeout(fn) { if (typeof fn === 'function') fn(); return 0; }

/**
 * 记录型 UI：实现 game.js 需要的 UI 接口，并把渲染 / 弹层 / 提示落进 rec，
 * 用来断言「开奖后 HUD 立刻刷新」「结算页展示金币/轮次/称号」等渲染约定。
 */
function recordingUI() {
  var rec = {
    renders: 0, lastState: null, controls: 0, modals: [], toasts: [],
    flashes: [], banners: [], lines: [], hostOpens: [], reveals: [], skipped: 0
  };
  var done = function () { return Promise.resolve(); };
  return {
    rec: rec,
    init: function () {},
    render: function (s) { rec.renders++; rec.lastState = s; },
    setControls: function () { rec.controls++; },
    flash: function (key, delta, s) { rec.flashes.push({ key: key, delta: delta, coins: s && s.coins }); },
    toast: function (m) { rec.toasts.push(m); },
    banner: function (m) { rec.banners.push(m); },
    openModal: function (o) { rec.modals.push(o); },
    closeModal: function () {},
    skip: function () { rec.skipped++; },
    playNarratorLine: function (line) { rec.lines.push(line && line.text ? line.text : line); return done(); },
    playHostOpen: function (slot, itemId) { rec.hostOpens.push({ slot: slot, itemId: itemId }); return done(); },
    playReveal: function (p) { rec.reveals.push(p); return done(); }
  };
}

/**
 * 读取 data/*.json，按 tools/build-data.js 的对外契约造一个 GameData 测试替身。
 * 仅当 js/data.js（真实产物）缺失时使用，调用点会在消息里标注「替身」，
 * 以免把替身上的通过误当成真实产物已通过。
 */
function buildTestGameData() {
  var itemsDoc = JSON.parse(readText(path.join(ROOT, 'data', 'items.json')));
  var config = JSON.parse(readText(path.join(ROOT, 'data', 'config.json')));
  var narrator = JSON.parse(readText(path.join(ROOT, 'data', 'narrator.json')));
  var seedDemo = JSON.parse(readText(path.join(ROOT, 'data', 'seed_demo.json')));
  var itemList = itemsDoc.items;
  var items = {};
  itemList.forEach(function (it) { items[it.id] = it; });
  /* 与 tools/build-data.js:64 ITEM_ALIASES 对齐：别名指向同一对象 */
  var ITEM_ALIASES = { shutup_card: 'mute_card' };
  Object.keys(ITEM_ALIASES).forEach(function (al) {
    if (!items[al] && items[ITEM_ALIASES[al]]) items[al] = items[ITEM_ALIASES[al]];
  });
  function poolForRound(round) {
    var r = Math.round(Number(round));
    if (!isFinite(r) || r < 1) r = 1;
    var boostAt = (config.pool && config.pool.boostRound) || 4;
    var noBomb = (config.pool && config.pool.noBombRounds) || [];
    var list = [];
    for (var i = 0; i < itemList.length; i++) {
      var it = itemList[i];
      if (r < it.minRound) continue;
      if (it.id === 'bomb' && noBomb.indexOf(r) >= 0) continue;
      var w = (r >= boostAt && it.lateWeight != null) ? it.lateWeight : it.weight;
      w = Number(w) || 0;
      if (w > 0) list.push({ id: it.id, weight: w });
    }
    return list;
  }
  function ratingFor(coins, round, opts) {
    opts = opts || {};
    var r0 = config.ratings || {};
    var cash = r0.cashout || null;
    var cn = Number(coins); if (!isFinite(cn)) cn = 0;
    var rd = Math.round(Number(round)); if (!isFinite(rd) || rd < 1) rd = 1;
    if (cash && opts.cashout && rd >= (cash.minRound || 1)) {
      return { id: 'cashout', title: cash.title, desc: cash.desc, by: 'cashout', coins: cn, round: rd };
    }
    var tiers = r0.tiers || [];
    for (var i = 0; i < tiers.length; i++) {
      var t = tiers[i];
      var min = (t.min == null) ? 0 : t.min;
      var max = (t.max == null) ? Infinity : t.max;
      if (cn >= min && cn <= max) return { id: t.id, title: t.title, desc: t.desc, by: 'coins', coins: cn, round: rd };
    }
    return { id: 'unknown', title: '无名赌徒', desc: '', by: 'fallback', coins: cn, round: rd };
  }
  return {
    _double: true,
    meta: { demoSeed: seedDemo.seed, itemCount: itemList.length, narratorCount: (narrator.lines || []).length },
    items: items, itemList: itemList,
    itemById: function (id) { return items[id] || null; },
    poolForRound: poolForRound, ratingFor: ratingFor,
    config: config, narrator: narrator, seedDemo: seedDemo
  };
}

/**
 * 取得 GameData：优先真实产物 js/data.js（在给定的 vm 上下文里执行），
 * 缺失时回落到测试替身。
 * @returns {{data:object, real:boolean, note:string}}
 */
function loadGameData(ctx, sandbox) {
  var p = path.join(JS_DIR, 'data.js');
  if (fileExists(p)) {
    try {
      vm.runInContext(readText(p), ctx, { filename: p });
      if (sandbox.GameData) return { data: sandbox.GameData, real: true, note: 'js/data.js（真实产物）' };
      return { data: buildTestGameData(), real: false, note: 'js/data.js 执行后未挂 GameData，回落测试替身' };
    } catch (e) {
      return { data: buildTestGameData(), real: false, note: 'js/data.js 执行失败（' + e.message + '），回落测试替身' };
    }
  }
  return { data: buildTestGameData(), real: false, note: 'js/data.js 缺失，使用测试替身（由 data/*.json 按契约构造）' };
}

/* ------------------------------------------------------------ Edge 无头 */
/**
 * 用无头 Edge 加载 file:// 页面并 dump DOM。
 * @returns {{ok, code, stdout, stderr, error, cmd}}
 */
function runEdge(args, opts) {
  opts = opts || {};
  var cmd = [EDGE].concat(args || []);
  try {
    var r = child_process.spawnSync(EDGE, args || [], {
      encoding: 'utf8', timeout: opts.timeout || 60000, maxBuffer: 64 * 1024 * 1024,
      windowsHide: true
    });
    return {
      ok: r.status === 0,
      code: r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      error: r.error ? String(r.error.message || r.error) : '',
      cmd: cmd.join(' ')
    };
  } catch (e) {
    return { ok: false, code: -1, stdout: '', stderr: '', error: String(e && e.message || e), cmd: cmd.join(' ') };
  }
}

function fileUrl(p) {
  return 'file:///' + String(p).replace(/\\/g, '/');
}

/** 从 Edge stderr 里提取页面 JS 报错（Chrome 会以 [INFO:CONSOLE(n)] 形式打印）。 */
function extractConsoleErrors(stderr) {
  var out = [];
  var lines = String(stderr || '').split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (/Uncaught|Unhandled|SEVERE|ERROR:CONSOLE|\[ERROR:/i.test(l)) out.push(l.trim());
  }
  return out;
}

module.exports = {
  ROOT: ROOT,
  JS_DIR: JS_DIR,
  INDEX: INDEX,
  EDGE: EDGE,
  SCRIPT_ORDER: SCRIPT_ORDER,
  fileExists: fileExists,
  readText: readText,
  htmlScriptOrder: htmlScriptOrder,
  Checker: Checker,
  loadScripts: loadScripts,
  makeDomStub: makeDomStub,
  immediateTimeout: immediateTimeout,
  recordingUI: recordingUI,
  buildTestGameData: buildTestGameData,
  loadGameData: loadGameData,
  runEdge: runEdge,
  fileUrl: fileUrl,
  extractConsoleErrors: extractConsoleErrors
};

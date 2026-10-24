/* ============================================================================
 * tests/dom-shim.js —— 零依赖 Node DOM 垫片（浏览器不可用时的替代证据）
 * ----------------------------------------------------------------------------
 * 为什么需要它：
 *   本沙箱里无头 Edge 必然 FATAL:mojo（命名管道被沙箱禁止，exit 0x5），
 *   因此「页面真的渲染出 3 扇门、HUD 初值 100/2/3、点击链路正常」这类
 *   阶段 0/1 P0 证据不能只靠静态扫描。本模块解析**真实的 index.html**，
 *   在 vm 同一上下文里按序加载**真实的 js/*.js**，再用最小 DOM 垫片驱动，
 *   从而在纯 Node 下真实执行 ui.js / game.js 的渲染与事件链路。
 * 出处：由 lead 的临时脚本 doors_ui_check.js（65/65 PASS）收编为正式用例。
 * 用法：const { createPage } = require('./dom-shim.js'); const page = createPage();
 * ========================================================================== */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var L = require('./lib.js');

var VOID = { meta: 1, link: 1, br: 1, hr: 1, img: 1, input: 1, source: 1, area: 1, base: 1, col: 1, embed: 1, param: 1, track: 1, wbr: 1 };

/* ------------------------------------------------------------------ 节点模型 */
function TNode(t) { this.nodeType = 3; this.data = String(t); this.parentNode = null; }
Object.defineProperty(TNode.prototype, 'textContent', {
  get: function () { return this.data; }, set: function (v) { this.data = String(v); }
});

function El(tag) {
  this.nodeType = 1;
  this.tagName = String(tag).toUpperCase();
  this.attributes = Object.create(null);
  this.childNodes = [];
  this.parentNode = null;
  this._cls = new Set();
  this._ev = Object.create(null);
  this._html = null;
  this.style = {};
  this.offsetWidth = 0;
}
El.prototype.setAttribute = function (k, v) { this.attributes[k] = String(v); if (k === 'class') this.className = v; };
El.prototype.getAttribute = function (k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; };
El.prototype.hasAttribute = function (k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); };
El.prototype.removeAttribute = function (k) { delete this.attributes[k]; if (k === 'class') this._cls.clear(); };
Object.defineProperty(El.prototype, 'id', { get: function () { return this.getAttribute('id') || ''; } });
Object.defineProperty(El.prototype, 'hidden', {
  get: function () { return this.hasAttribute('hidden'); },
  set: function (v) { if (v) this.attributes.hidden = ''; else delete this.attributes.hidden; }
});
Object.defineProperty(El.prototype, 'disabled', {
  get: function () { return this.hasAttribute('disabled'); },
  set: function (v) { if (v) this.attributes.disabled = ''; else delete this.attributes.disabled; }
});
Object.defineProperty(El.prototype, 'title', {
  get: function () { return this.getAttribute('title') || ''; }, set: function (v) { this.setAttribute('title', v); }
});
Object.defineProperty(El.prototype, 'tabIndex', {
  get: function () { return Number(this.getAttribute('tabindex')); }, set: function (v) { this.setAttribute('tabindex', String(v)); }
});
Object.defineProperty(El.prototype, 'type', {
  get: function () { return this.getAttribute('type') || ''; }, set: function (v) { this.setAttribute('type', v); }
});
Object.defineProperty(El.prototype, 'classList', {
  get: function () {
    var self = this;
    return {
      add: function () { [].forEach.call(arguments, function (c) { if (c) self._cls.add(c); }); self._syncClass(); },
      remove: function () { [].forEach.call(arguments, function (c) { self._cls.delete(c); }); self._syncClass(); },
      contains: function (c) { return self._cls.has(c); },
      toggle: function (c, force) {
        var on = force === undefined ? !self._cls.has(c) : !!force;
        if (on) self._cls.add(c); else self._cls.delete(c);
        self._syncClass(); return on;
      }
    };
  }
});
El.prototype._syncClass = function () { this.attributes['class'] = Array.from(this._cls).join(' '); };
Object.defineProperty(El.prototype, 'className', {
  get: function () { return Array.from(this._cls).join(' '); },
  set: function (v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); this._syncClass(); }
});
El.prototype.appendChild = function (n) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.childNodes.push(n); return n; };
El.prototype.removeChild = function (n) { var i = this.childNodes.indexOf(n); if (i >= 0) { this.childNodes.splice(i, 1); n.parentNode = null; } return n; };
El.prototype.insertBefore = function (n, ref) {
  if (n.parentNode) n.parentNode.removeChild(n);
  var i = ref ? this.childNodes.indexOf(ref) : -1;
  if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
  n.parentNode = this; return n;
};
Object.defineProperty(El.prototype, 'firstChild', { get: function () { return this.childNodes[0] || null; } });
Object.defineProperty(El.prototype, 'lastChild', { get: function () { return this.childNodes[this.childNodes.length - 1] || null; } });
Object.defineProperty(El.prototype, 'children', { get: function () { return this.childNodes.filter(function (c) { return c.nodeType === 1; }); } });
El.prototype.contains = function (n) { var p = n; while (p) { if (p === this) return true; p = p.parentNode; } return false; };
Object.defineProperty(El.prototype, 'textContent', {
  get: function () {
    if (this._html !== null) return this._html.replace(/<[^>]*>/g, '');
    return this.childNodes.map(function (c) { return c.textContent; }).join('');
  },
  set: function (v) { this.childNodes = []; this._html = null; this.appendChild(new TNode(v)); }
});
Object.defineProperty(El.prototype, 'innerHTML', {
  get: function () { return this._html !== null ? this._html : this.childNodes.map(ser).join(''); },
  set: function (v) { this.childNodes = []; this._html = String(v); }
});
El.prototype.querySelector = function (s) { return descendants(this).filter(function (e) { return matches(e, s); })[0] || null; };
El.prototype.querySelectorAll = function (s) { return descendants(this).filter(function (e) { return matches(e, s); }); };
El.prototype.matches = function (s) { return matches(this, s); };
El.prototype.closest = function (s) { var n = this; while (n && n.nodeType === 1) { if (matches(n, s)) return n; n = n.parentNode; } return null; };
El.prototype.addEventListener = function (t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); };
El.prototype.removeEventListener = function (t, fn) {
  var a = this._ev[t]; if (!a) return; var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
};
El.prototype.dispatchEvent = function (ev) { return fire(this, ev.type, ev); };
El.prototype.focus = function () { if (DOC) DOC.activeElement = this; };
El.prototype.blur = function () { if (DOC && DOC.activeElement === this) DOC.activeElement = DOC.body; };
El.prototype.getBoundingClientRect = function () { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; };
El.prototype.setPointerCapture = function () {};
El.prototype.releasePointerCapture = function () {};

function ser(n) {
  if (n.nodeType === 3) return n.data;
  if (n._html !== null) return n._html;
  var t = n.tagName.toLowerCase();
  return '<' + t + '>' + n.childNodes.map(ser).join('') + '</' + t + '>';
}
function descendants(el) {
  var out = [];
  (function walk(n) { n.childNodes.forEach(function (c) { if (c.nodeType === 1) { out.push(c); walk(c); } }); })(el);
  return out;
}
function compound(el, part) {
  part = part.replace(/:not\([^)]*\)/g, '').replace(/:focus-visible|:hover|:active|:disabled/g, '');
  if (!part) return true;
  var re = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g, m;
  while ((m = re.exec(part))) {
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    if (m[2] && !el._cls.has(m[2])) return false;
    if (m[3] && el.id !== m[3]) return false;
    if (m[4]) {
      if (!el.hasAttribute(m[4])) return false;
      if (m[5] !== undefined && el.getAttribute(m[4]) !== m[5]) return false;
    }
  }
  return true;
}
function matches(el, sel) {
  if (!sel) return false;
  return String(sel).split(',').some(function (one) {
    var parts = one.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return false;
    if (!compound(el, parts[parts.length - 1])) return false;
    var node = el.parentNode;
    for (var i = parts.length - 2; i >= 0; i--) {
      var found = false;
      while (node && node.nodeType === 1) {
        if (compound(node, parts[i])) { found = true; node = node.parentNode; break; }
        node = node.parentNode;
      }
      if (!found) return false;
    }
    return true;
  });
}
function parseAttrs(src, el) {
  var re = /([^\s=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g, m;
  while ((m = re.exec(src || ''))) {
    var v = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ''));
    if (m[1] === 'class') el.className = v; else el.attributes[m[1]] = v;
  }
}
function parseHTML(src) {
  var root = new El('root');
  var stack = [root];
  var re = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/?([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g;
  var last = 0, m;
  while ((m = re.exec(src))) {
    var txt = src.slice(last, m.index);
    if (txt.trim()) stack[stack.length - 1].appendChild(new TNode(txt));
    last = re.lastIndex;
    var raw = m[0];
    if (raw.indexOf('<!--') === 0 || /^<!DOCTYPE/i.test(raw)) continue;
    var name = m[1].toLowerCase();
    if (raw.indexOf('</') === 0) {
      for (var i = stack.length - 1; i > 0; i--) { if (stack[i].tagName === name.toUpperCase()) { stack.length = i; break; } }
      continue;
    }
    var el = new El(name);
    parseAttrs(m[2], el);
    stack[stack.length - 1].appendChild(el);
    if (!VOID[name] && !/\/>$/.test(raw)) stack.push(el);
  }
  return root;
}

/* ------------------------------------------------------------------ 事件派发 */
var DOC = null;
function fire(target, type, extra) {
  var ev = Object.assign({ type: type, target: target, button: 0, shiftKey: false, clientX: 0, clientY: 0, key: '', pointerId: 1,
    preventDefault: function () {}, stopPropagation: function () {} }, extra || {});
  var n = target;
  while (n) {
    var hs = n._ev && n._ev[type];
    if (hs) hs.slice().forEach(function (h) { h(ev); });
    n = n.parentNode;
  }
  return ev;
}

/* ------------------------------------------------------------------ localStorage 桩 */
function makeStorage() {
  var map = Object.create(null);
  return {
    _map: map,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    setItem: function (k, v) { map[k] = String(v); },
    removeItem: function (k) { delete map[k]; },
    clear: function () { Object.keys(map).forEach(function (k) { delete map[k]; }); },
    key: function (i) { var ks = Object.keys(map); return i < ks.length ? ks[i] : null; },
    get length() { return Object.keys(map).length; }
  };
}

/* ------------------------------------------------------------------ 页面加载 */
/**
 * 解析真实 index.html + 在 vm 同一上下文按序加载真实 js/*.js。
 * @returns {{doc, sandbox, fire, loaded, missing, storage, ready, ok}}
 */
function createPage(opts) {
  opts = opts || {};
  var files = opts.files || ['js/state.js', 'js/data.js', 'js/effects.js', 'js/narrator.js', 'js/ui.js', 'js/game.js'];
  var indexPath = opts.index || L.INDEX;
  if (!L.fileExists(indexPath)) throw new Error('index.html 不存在：' + indexPath);
  var html = L.readText(indexPath);
  var tree = parseHTML(html);
  var root = descendants(tree).filter(function (e) { return e.tagName === 'HTML'; })[0] || tree;
  var body = descendants(tree).filter(function (e) { return e.tagName === 'BODY'; })[0] || null;

  var doc = {
    readyState: 'complete',
    documentElement: root,
    body: body,
    activeElement: body,
    _ev: Object.create(null),
    createElement: function (t) { return new El(t); },
    createTextNode: function (t) { return new TNode(t); },
    getElementById: function (id) { return descendants(root).filter(function (e) { return e.id === id; })[0] || null; },
    querySelector: function (s) { return descendants(root).filter(function (e) { return matches(e, s); })[0] || null; },
    querySelectorAll: function (s) { return descendants(root).filter(function (e) { return matches(e, s); }); },
    addEventListener: function (t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); },
    removeEventListener: function () {},
    dispatchEvent: function (ev) { return fire(this.documentElement, ev.type, ev); }
  };
  DOC = doc;

  var storage = makeStorage();
  var sandbox = {
    document: doc, console: console,
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval,
    Date: Date, Math: Math, JSON: JSON, Promise: Promise, Error: Error, String: String, Number: Number,
    Object: Object, Array: Array, RegExp: RegExp, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
    localStorage: storage, navigator: { userAgent: 'node-dom-shim', language: 'zh-CN' },
    location: { href: L.fileUrl(indexPath), protocol: 'file:', search: '', hash: '' },
    performance: { now: function () { return Date.now(); } },
    alert: function () {}, confirm: function () { return true; }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  var loaded = {}, missing = [], errors = [];
  files.forEach(function (f) {
    var p = path.join(L.ROOT, f);
    if (!L.fileExists(p)) { missing.push(f); return; }
    try {
      vm.runInContext(L.readText(p), sandbox, { filename: f });
      loaded[f] = true;
    } catch (e) {
      missing.push(f + '(THROW)');
      errors.push(f + ': ' + (e && e.message ? e.message : String(e)));
    }
  });

  return {
    doc: doc, tree: tree, body: body, sandbox: sandbox, storage: storage,
    fire: fire, loaded: loaded, missing: missing, errors: errors,
    has: function (f) { return !!loaded[f]; },
    ok: missing.length === 0,
    loadSummary: Object.keys(loaded).join(',') + (missing.length ? ' | 缺/错: ' + missing.join(',') : '')
  };
}

exports.createPage = createPage;
exports.El = El;
exports.TNode = TNode;
exports.parseHTML = parseHTML;
exports.matches = matches;
exports.fire = fire;

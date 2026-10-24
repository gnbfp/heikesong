/* ============================================================================
 * js/ui.js —— 阶段 1「表现层」：只读渲染 + 动画 + 交互绑定
 * ----------------------------------------------------------------------------
 * 硬约束（《开工清单》阶段 0/1/6）：
 *   - 经典脚本，零构建：无 ES module、无 fetch、无外链资源，file:// 双击可跑
 *   - 所有函数挂在 globalThis.UI；不依赖 data.js / narrator.js / effects.js 是否已加载
 *   - render(state) 同步全量渲染，**只读 state，绝不改写 state**
 *   - playNarratorLine / playHostOpen / playReveal 返回 Promise；UI.skip() 令其立刻 resolve
 *   - state.flags.skipAnim === true 时，三个动画函数直接补最终外观并立刻 resolve
 *   - 所有交互统一走 Game.action({type:...})（兼容 action(obj) / action(type, payload)）
 *
 * 与 js/game.js 的分工（以 game.js 实际调用为准）：
 *   render()      —— 持久外观的唯一权威：门牌 / HUD / 按钮禁用态 / 提示文案 / 显隐
 *   动画三函数    —— 只加“瞬时”类与特效（anim-shake / anim-flip / 浮动数字 / flash），
 *                    结束时补最终外观；动画期间给门加 .anim-hold，render 检测到
 *                    .anim-hold 时不重建门面，避免打断动画
 *   peek 语义     —— game.peek 只给模糊提示（不揭晓物品），故 .peeked 只做视觉标记，
 *                    绝不显示 itemId 对应的物品名
 *   openModal     —— spec.body 为 HTML 字符串（game.js 传 HTML）；Node 则直接插入。
 *                    spec.kind ∈ 'round'|'cashout'|'gameover'（仅用于加类名）
 *   delta 兼容    —— 数值 / {coins,suspicion,patience} / {resources:{...}} 均可
 *   item 兼容     —— 优先用 payload.item，其次在 GameData.items / ITEMS / ITEM_POOL 里
 *                    按 id 查找，最后落到内置中文兜底表（data.js 未就绪也不白屏）
 * ========================================================================== */
(function (root) {
  'use strict';

  var doc = root.document;
  var UI = {};

  /* ------------------------------------------------------------------ 常量 */
  var PEEK_MS = 400;             /* 长按 ≥400ms 触发窥视 */
  var CLICK_LOCK_MS = 400;       /* 连点去抖：仅挡住同一相位内的重复触发 */
  var FLASH_MS = 700;
  var TOAST_MS = 1700;
  var BANNER_MS = 1600;

  var RES_ORDER = ['coins', 'suspicion', 'patience'];
  var RES_LABEL = { coins: '金币', suspicion: '怀疑值', patience: '耐心' };
  var PHASES = { IDLE: 1, ROUND_INTRO: 1, NARRATOR: 1, PICK: 1, HOST_OPEN: 1, DECIDE: 1, REVEAL: 1, SETTLE_ROUND: 1, CASHOUT: 1, GAME_OVER: 1 };

  /* 契约《设计契约_商店与美术》§3.1：#btn-shop 只在 DECIDE / SETTLE_ROUND 可用；
     #bag 在 IDLE / ROUND_INTRO 隐藏。两者都是纯显示规则，不改状态机。 */
  var SHOP_PHASES = { DECIDE: 1, SETTLE_ROUND: 1 };
  var BAG_HIDE_PHASES = { IDLE: 1, ROUND_INTRO: 1 };

  /* 商店 / 背包的道具 id → 图标名（契约 §2.2 的 icon 列）。 */
  var ITEM_ICON = {
    switch_ticket: 'ticket',
    mute_card: 'mute',
    double_coins: 'double',
    fuse: 'fuse',
    mystery_box: 'box',
    patience_charm: 'charm'
  };

  /* ---------------------------------------------------------------- 图标 */
  /* 零外链：图标全部是内联 SVG <symbol>，使用时用 <use href="#ic-*"> 引用。 */
  var ICON_PATHS = {
    coins: '<circle cx="12" cy="12" r="7.4"/><path d="M12 8.6v6.8M9.7 10.2h4.6M9.7 13.8h4.6"/>',
    suspicion: '<path d="M2.6 12S6.2 6.2 12 6.2 21.4 12 21.4 12 17.8 17.8 12 17.8 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.5"/>',
    patience: '<path d="M12 19.6S5.2 15.4 5.2 10.8A4 4 0 0 1 12 8.1a4 4 0 0 1 6.8 2.7c0 4.6-6.8 8.8-6.8 8.8z"/>',
    /* 契约 v4 §4.6 G7 点名要的 ic-eye / ic-heart：与怀疑值（眼）、耐心（心）同一套图形，
       单独起名是为了让 HUD 与后续页面能按语义引用，不再借 suspicion/patience 的名字。 */
    eye: '<path d="M2.6 12S6.2 6.2 12 6.2 21.4 12 21.4 12 17.8 17.8 12 17.8 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.5"/>',
    heart: '<path d="M12 19.6S5.2 15.4 5.2 10.8A4 4 0 0 1 12 8.1a4 4 0 0 1 6.8 2.7c0 4.6-6.8 8.8-6.8 8.8z"/>',
    ticket: '<path d="M3.2 8.6a2 2 0 0 0 1.8-1.8h14a2 2 0 0 0 1.8 1.8v6.8a2 2 0 0 0-1.8 1.8H5a2 2 0 0 0-1.8-1.8z"/><path d="M14.4 6.8v10.4" stroke-dasharray="2 2.2"/>',
    mute: '<path d="M4.2 9.6h2.6l3.6-3.2v11.2l-3.6-3.2H4.2z"/><path d="M15 9.6l4 4.8M19 9.6l-4 4.8"/>',
    double: '<path d="M5.4 6.8l4.8 5.2-4.8 5.2"/><path d="M12.4 6.8l4.8 5.2-4.8 5.2"/>',
    fuse: '<rect x="3.6" y="9" width="13" height="6" rx="2.2"/><path d="M16.6 12h3.4M6.6 9V6.2M11 9V6.2"/>',
    box: '<path d="M4 9.2l8-4 8 4-8 4z"/><path d="M4 9.2V16l8 4 8-4V9.2"/><path d="M12 13.2V20"/>',
    charm: '<path d="M12 3.4l2.5 5.2 5.6.8-4.1 3.9 1 5.6-5-2.8-5 2.8 1-5.6-4.1-3.9 5.6-.8z"/>'
  };
  var ICON_NAMES = ['coins', 'eye', 'heart', 'suspicion', 'patience', 'ticket', 'mute', 'double', 'fuse', 'box', 'charm'];

  /** HUD 三张卡片用哪枚图标（契约 v4 §4.6：ic-coins / ic-eye / ic-heart）。 */
  var HUD_ICON = { coins: 'coins', suspicion: 'eye', patience: 'heart' };

  /** 拼出整份 <symbol> 精灵；只插一次。 */
  function spriteMarkup() {
    var out = '<svg id="ui-icons" class="ui-icons" aria-hidden="true" focusable="false" width="0" height="0">';
    for (var i = 0; i < ICON_NAMES.length; i++) {
      var n = ICON_NAMES[i];
      out += '<symbol id="ic-' + n + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
             'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + ICON_PATHS[n] + '</symbol>';
    }
    return out + '</svg>';
  }

  /** 引用精灵里的一个图标；name 未知时返回空串（不报错、不留破图）。 */
  function iconUse(name, cls) {
    var n = str(name);
    if (ICON_NAMES.indexOf(n) < 0) return '';
    return '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
           '<use href="#ic-' + n + '" xlink:href="#ic-' + n + '"></use></svg>';
  }

  var CHOICE_LABEL = {
    stick: '坚持本门',
    switch: '换门',
    challenge: '质疑旁白',
    double: '加倍下注',
    cashout: '收手'
  };

  /** data.js 未就绪时的中文兜底（阶段 2 物品池逐字对应）。 */
  var ITEM_FALLBACK = {
    big_prize: { name: '大奖', icon: '🏆' },
    small_prize: { name: '小奖', icon: '🎁' },
    empty: { name: '空门', icon: '🕳' },
    bomb: { name: '炸弹', icon: '💣' },
    trap: { name: '陷阱', icon: '🪤' },
    switch_ticket: { name: '换门券', icon: '🎫' },
    mute_card: { name: '闭嘴卡', icon: '🤐' },
    double_coins: { name: '双倍金币', icon: '✖️' },
    mystery_box: { name: '神秘盒', icon: '❓' },
    fuse: { name: '保险丝', icon: '🧯' },
    patience_charm: { name: '续命符', icon: '🍀' }
  };

  /* -------------------------------------------------------------- 模块状态 */
  var gameRef = null;
  var bound = false;
  var dom = {};
  var lastState = null;
  var activeAnims = [];
  var speaking = false;
  var modalEpoch = 0;
  var modalActions = 0;
  var modalKind = '';
  var lastFocus = null;
  var locks = { pick: false, decide: false };
  var lockTimers = { pick: null, decide: null };
  var last = { phase: 'IDLE', pickedSlot: null, doubled: false, suspicion: 0, peekUsed: false };
  var press = { slot: null, timer: null, fired: false };
  var bagBound = false;          /* #bag-list 的委托只在第一次装上 */
  var bagSig = '';               /* 背包内容签名，避免每帧重建 DOM */
  var iconReady = false;         /* 图标精灵是否已插入（只插一次） */
  var vignetteReady = false;     /* 舞台暗角层是否已插入（只插一次） */
  var decorReady = false;        /* 幕布 / 聚光灯装饰层是否已插入（只插一次） */
  var chipReady = false;         /* 人格徽标 #persona-chip 是否已插入（只插一次） */
  var portraitReady = false;     /* 竖屏提示 #portrait-hint 是否已自建（只插一次） */
  var tut = { active: false, index: 0, steps: [], phase: null, done: false, autoTried: false };
  var prefCache = null;          /* 最近一次 render 读到的偏好（只读缓存，用于音效/BGM/动画速度开关） */

  /* ------------------------------------------------------------------ 工具 */
  function $(id) { return doc && doc.getElementById ? doc.getElementById(id) : null; }
  function on(el, type, fn, opts) { if (el && el.addEventListener) el.addEventListener(type, fn, opts || false); }
  function str(v) { return v == null ? '' : String(v); }
  function num(v, dflt) { var n = Number(v); return isFinite(n) ? n : (dflt || 0); }
  function esc(s) {
    return str(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
  function text(el, v) {
    if (!el) return;
    var s = str(v);
    if (el.textContent !== s) el.textContent = s;
  }
  function html(el, v) { if (el) el.innerHTML = str(v); }
  function toggle(el, cls, ok) {
    if (!el || !el.classList) return;
    if (ok) { if (!el.classList.contains(cls)) el.classList.add(cls); }
    else if (el.classList.contains(cls)) el.classList.remove(cls);
  }
  function logErr(where, e) { if (root.console && root.console.error) root.console.error('[ui] ' + where, e); }
  function later(ms, fn) { return root.setTimeout(fn, Math.max(0, ms | 0)); }
  function closest(node, sel) {
    while (node && node !== doc) {
      if (node.nodeType === 1) {
        if (node.matches && node.matches(sel)) return node;
        if (node.msMatchesSelector && node.msMatchesSelector(sel)) return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  /* ------------------------------------------------------- 音效层（合成） */
  /* 零音频文件：全部用 WebAudio 现场合成，断网/双击 file:// 均可发声。
     三层保险：① 惰性创建 AudioContext（首次用户手势之后，满足自动播放策略）；
     ② 全部 try/catch，无 AudioContext 的环境（Node 垫片/老浏览器）静默降级；
     ③ muted 为真时一条发声路径都不走（setControls 还会顺带 suspend 已建上下文）。 */
  var AC_CTOR = root.AudioContext || root.webkitAudioContext || null;
  var ac = null;
  var acFailed = false;
  var GESTURE = ['pointerdown', 'keydown', 'touchstart'];

  /** 已静音？只读 state.flags.muted。 */
  function audioMuted() {
    var s = liveState();
    return !!(s && s.flags && s.flags.muted);
  }

  /** 惰性创建 / 恢复 AudioContext；创建失败则永久降级为无操作。 */
  function armAudio() {
    if (!AC_CTOR || acFailed) return null;
    try {
      if (!ac) ac = new AC_CTOR();
      if (ac.state === 'suspended' && ac.resume) {
        var p = ac.resume();
        if (p && p.catch) p.catch(function () {});
      }
      return ac;
    } catch (e) {
      acFailed = true;
      ac = null;
      logErr('audioContext', e);
      return null;
    }
  }

  /** 一个音符：type 波形、at 相对现在（秒）、freq 频率、dur 时长、gain 峰值。 */
  function tone(ctx, type, at, freq, dur, gain) {
    var t0 = ctx.currentTime + at;
    var osc = ctx.createOscillator();
    var amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp);
    amp.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** 音效总线：kind ∈ 'click' | 'open' | 'win' | 'lose' | 'buy'；总时长 ≤0.3s，gain ≤0.045。 */
  function sfx(kind) {
    if (audioMuted()) return;                       /* 静音：不发一个采样 */
    if (prefCache && prefCache.sound === false) return;  /* 设置里的「音效」关：同样一条路径都不走 */
    var ctx = armAudio();
    if (!ctx) return;                               /* 无 WebAudio：静默无操作 */
    try {
      if (kind === 'win') {
        tone(ctx, 'triangle', 0, 660, 0.12, 0.045);
        tone(ctx, 'triangle', 0.1, 990, 0.16, 0.04);
      } else if (kind === 'lose') {
        tone(ctx, 'sawtooth', 0, 300, 0.13, 0.04);
        tone(ctx, 'sawtooth', 0.09, 190, 0.18, 0.035);
      } else if (kind === 'open') {
        tone(ctx, 'square', 0, 240, 0.07, 0.03);
        tone(ctx, 'square', 0.05, 340, 0.09, 0.026);
      } else if (kind === 'buy') {
        tone(ctx, 'sine', 0, 700, 0.07, 0.03);      /* 买下：两枚小金币的脆响 */
        tone(ctx, 'triangle', 0.06, 1050, 0.11, 0.028);
      } else {
        tone(ctx, 'sine', 0, 520, 0.06, 0.028);
      }
    } catch (e) { logErr('sfx ' + str(kind), e); }
  }

  /** 静音开关同步到已建上下文（幂等；未建上下文时什么都不做）。 */
  function applyMuteState(muted) {
    if (!ac) return;
    try {
      /* 已是目标状态就不重复调用（.state 缺失的老实现则每次都同步一次）。 */
      if (ac.state && muted === (ac.state === 'suspended')) return;
      var p = muted ? (ac.suspend && ac.suspend()) : (ac.resume && ac.resume());
      if (p && p.catch) p.catch(function () {});
    } catch (e) { /* 静默 */ }
  }

  /* ------------------------------------------------- BGM（契约 v3 §5.2） */
  /* 2 个低频正弦振荡器循环 + 轻微 detune，按轮次升调；gain 峰值 0.028（≤0.03）。
     停止条件：muted / IDLE / GAME_OVER / 页面隐藏（visibilitychange）。
     只在首次手势解锁之后启动；振荡器建好就复用，重复调用绝不叠加实例。
     无 AudioContext（Node 垫片 / 老浏览器）时全程静默降级。 */
  var BGM_GAIN = 0.028;
  var BGM_DETUNE = 1.005;                  /* 第二个振荡器的频率比：轻微 detune 产生拍频 */
  var bgm = { gain: null, osc: [], on: false };

  /** 轮次 → BGM 基频：第 1–2 轮 100Hz、第 3 轮 130Hz、≥4 轮 160Hz。 */
  function bgmFreq(round) {
    var r = Math.max(1, Math.round(num(round, 1)));
    if (r >= 4) return 160;
    if (r >= 3) return 130;
    return 100;
  }

  /** 参数平滑：优先 setTargetAtTime，退而线性斜坡，最后直接赋值（垫片/老实现）。 */
  function rampParam(param, value, ctx, tau) {
    if (!param) return;
    try {
      if (param.setTargetAtTime) param.setTargetAtTime(value, ctx.currentTime, tau);
      else if (param.linearRampToValueAtTime) param.linearRampToValueAtTime(value, ctx.currentTime + tau * 4);
      else param.value = value;
    } catch (e) { /* 静默 */ }
  }

  /** 建 BGM 图（2 osc → 1 gain → destination）；失败时清掉半成品并降级为无声。 */
  function bgmBuild(ctx) {
    var made = [];
    try {
      var g = ctx.createGain();
      g.connect(ctx.destination);
      var f = bgmFreq(liveState().round);
      for (var i = 0; i < 2; i++) {
        var o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(f * (i === 0 ? 1 : BGM_DETUNE), ctx.currentTime);
        o.connect(g);
        o.start();
        made.push(o);
      }
      bgm.gain = g;
      bgm.osc = made;
      rampParam(g.gain, 0.0001, ctx, 0.2);
      return true;
    } catch (e) {
      for (var k = 0; k < made.length; k++) { try { made[k].stop(); } catch (e2) { /* 静默 */ } }
      bgm.gain = null;
      bgm.osc = [];
      logErr('bgmBuild', e);
      return false;
    }
  }

  /** 起 BGM：已在播就只调音高（round 升调），绝不新建第二组振荡器。 */
  function bgmStart() {
    if (audioMuted()) return;                        /* 静音：一个振荡器都不开 */
    var ctx = armAudio();
    if (!ctx) return;
    try {
      if (!bgm.on) {
        if (!bgm.osc.length && !bgmBuild(ctx)) return;
        bgm.on = true;
      }
      var f = bgmFreq(liveState().round);
      for (var i = 0; i < bgm.osc.length; i++) {
        bgm.osc[i].frequency.setValueAtTime(f * (i === 0 ? 1 : BGM_DETUNE), ctx.currentTime);
      }
      rampParam(bgm.gain.gain, BGM_GAIN, ctx, 0.45);
    } catch (e) {
      logErr('bgmStart', e);
      bgmStop();
    }
  }

  /** 停 BGM：把 gain 拉到 0（振荡器留着，下次进来直接升回来，不重建实例）。 */
  function bgmStop() {
    if (!bgm.on) return;
    bgm.on = false;
    if (ac && bgm.gain) rampParam(bgm.gain.gain, 0.0001, ac, 0.18);
  }

  /** 按当前 state 与页面可见性同步 BGM（muted / 设置关 / IDLE / GAME_OVER / 隐藏 → 停）。 */
  function bgmSync(state) {
    var s = state || liveState();
    var phase = PHASES[str(s && s.phase)] ? str(s.phase) : 'IDLE';
    var hidden = !!(doc && doc.hidden);
    var bgmOff = !!(prefCache && prefCache.bgm === false);
    var want = !audioMuted() && !bgmOff && !hidden && phase !== 'IDLE' && phase !== 'GAME_OVER';
    if (want) bgmStart(); else bgmStop();
  }

  /* ------------------------------------------------------------ 运行时状态 */
  /** 只读取当前状态（优先 Game.state），绝不写。 */
  function liveState() { return (gameRef && gameRef.state) || lastState || {}; }

  /** 全局「跳过动画」开关：game._skipAnim 置 true 后，动画一步到位。 */
  function skipAnimOn() {
    var s = liveState();
    return !!(s && s.flags && s.flags.skipAnim);
  }

  function suspicionCost() {
    var data = root.GameData;
    var cfg = data && data.config && data.config.suspicion;
    var cost = cfg && cfg.cost != null ? num(cfg.cost, 1) : 1;
    return cost > 0 ? cost : 1;
  }

  /* -------------------------------------------------------- 物品 / 数值视图 */
  function findItem(id) {
    if (!id) return null;
    var pools = [root.ITEMS, root.ITEM_POOL, root.ITEMS_BY_ID, root.ITEM_DB];
    if (root.GameData) { pools.push(root.GameData.items, root.GameData.ITEMS); }
    if (root.DATA) { pools.push(root.DATA.items, root.DATA.ITEMS); }
    for (var i = 0; i < pools.length; i++) {
      var p = pools[i];
      if (!p) continue;
      if (Object.prototype.toString.call(p) === '[object Array]') {
        for (var j = 0; j < p.length; j++) { if (p[j] && p[j].id === id) return p[j]; }
      } else if (typeof p === 'object' && p[id]) {
        return p[id];
      }
    }
    return null;
  }

  function itemView(id, item) {
    var it = item || findItem(id) || {};
    var fb = ITEM_FALLBACK[id] || {};
    return {
      id: id || null,
      name: it.name || it.label || it.title || fb.name || (id ? str(id) : '未知'),
      icon: it.icon || it.emoji || it.symbol || fb.icon || '❔',
      raw: it
    };
  }

  function normDelta(delta) {
    var out = { coins: 0, suspicion: 0, patience: 0 };
    if (delta == null) return out;
    if (typeof delta === 'number') { out.coins = num(delta, 0); return out; }
    if (typeof delta !== 'object') return out;
    var src = (delta.resources && typeof delta.resources === 'object') ? delta.resources : delta;
    for (var i = 0; i < RES_ORDER.length; i++) {
      var k = RES_ORDER[i];
      if (src[k] != null) out[k] = num(src[k], 0);
      else if (delta[k] != null) out[k] = num(delta[k], 0);
    }
    return out;
  }

  function deltaText(d) {
    var parts = [];
    for (var i = 0; i < RES_ORDER.length; i++) {
      var k = RES_ORDER[i];
      var v = Math.round(num(d[k], 0));
      if (!v) continue;
      parts.push(RES_LABEL[k] + ' ' + (v > 0 ? '+' : '−') + Math.abs(v));
    }
    return parts.join('，');
  }

  /* -------------------------------------------------------------- DOM 缓存 */
  function cacheDom() {
    if (!doc || !doc.getElementById) return dom;
    dom.body = doc.body;
    dom.topbar = $('topbar');
    dom.roundChip = $('round-chip');
    dom.modeChip = $('mode-chip');
    dom.btnReset = $('btn-reset');
    dom.btnDemo = $('btn-demo');
    dom.btnShop = $('btn-shop');
    dom.btnHelp = $('btn-help');
    dom.btnSettings = $('btn-settings');
    dom.btnMute = $('btn-mute');
    dom.btnSkip = $('btn-skip');
    dom.controls = $('controls');
    dom.stage = $('stage');
    dom.roundBanner = $('round-banner');
    dom.doors = $('doors');
    dom.stageHint = $('stage-hint');
    dom.rehearsal = $('rehearsal');
    dom.rehearsalText = $('rehearsal-text');
    dom.tutorial = $('tutorial');
    dom.tutorialTitle = $('tutorial-title');
    dom.tutorialText = $('tutorial-text');
    dom.tutorialNext = $('tutorial-next');
    dom.tutorialSkip = $('tutorial-skip');
    dom.confetti = $('confetti');
    dom.portraitHint = $('portrait-hint');
    dom.narrator = $('narrator');
    dom.narratorText = $('narrator-text');
    dom.narratorSkip = $('narrator-skip');
    dom.hud = $('hud');
    dom.hudCoins = $('hud-coins');
    dom.hudSuspicion = $('hud-suspicion');
    dom.hudPatience = $('hud-patience');
    dom.decide = $('decide');
    dom.bag = $('bag');
    dom.bagTitle = $('bag-title');
    dom.bagList = $('bag-list');
    dom.bagEmpty = $('bag-empty');
    dom.boot = $('boot');
    dom.btnStart = $('btn-start');
    dom.btnStartNormal = $('btn-start-normal');
    dom.modal = $('modal');
    dom.modalPanel = doc.querySelector ? doc.querySelector('#modal .modal-panel') : null;
    dom.modalTitle = $('modal-title');
    dom.modalBody = $('modal-body');
    dom.modalActions = $('modal-actions');
    dom.toast = $('toast');
    dom.footer = $('footer');
    return dom;
  }
  function d() { if (!dom.body) cacheDom(); return dom; }
  function hudEl(res) {
    var D = d();
    return res === 'coins' ? D.hudCoins : (res === 'suspicion' ? D.hudSuspicion : (res === 'patience' ? D.hudPatience : null));
  }

  /* ------------------------------------------------------------ 动画调度器 */
  /**
   * 动画句柄：所有定时器登记在案，UI.skip() 一次性 finish()。
   * finish() 清定时器 → 执行 onSkip（补最终外观）→ resolve 对外 Promise。
   * 刻意不 resolve 挂起的 after()：skip 后 async 主体停在原地，不会回退外观。
   */
  function beginAnim(name, onSkip) {
    var a = {
      name: name,
      finished: false,
      timers: [],
      resolvers: [],
      onSkip: onSkip || null
    };
    a.after = function (ms) {
      if (a.finished) return new Promise(function () {});
      return new Promise(function (resolve) {
        var id = later(ms, function () { if (!a.finished) resolve(); });
        a.timers.push(id);
      });
    };
    a.promise = new Promise(function (resolve) { a.resolvers.push(resolve); });
    a.finish = function () {
      if (a.finished) return;
      a.finished = true;
      for (var i = 0; i < a.timers.length; i++) root.clearTimeout(a.timers[i]);
      a.timers.length = 0;
      if (a.onSkip) { try { a.onSkip(); } catch (e) { logErr('onSkip/' + name, e); } }
      var list = a.resolvers;
      a.resolvers = [];
      for (var j = 0; j < list.length; j++) { try { list[j](); } catch (e2) { logErr('resolve/' + name, e2); } }
      var k = activeAnims.indexOf(a);
      if (k >= 0) activeAnims.splice(k, 1);
    };
    activeAnims.push(a);
    return a;
  }

  /** 立即结束（可选按名字过滤）动画 Promise，并补上最终外观。 */
  function finishAnims(name) {
    var list = activeAnims.slice();
    for (var i = 0; i < list.length; i++) { if (!name || list[i].name === name) list[i].finish(); }
  }

  function setSpeaking(ok) {
    speaking = !!ok;
    var D = d();
    toggle(D.narrator, 'is-speaking', speaking);
    if (D.narratorSkip) D.narratorSkip.hidden = !speaking;
    if (D.narratorText && !speaking) {
      var t = str(D.narratorText.textContent);
      if (t.charAt(t.length - 1) === '▌') D.narratorText.textContent = t.slice(0, -1);
    }
  }

  /* ------------------------------------------------------------ 连点去抖锁 */
  function armLock(name, ms) {
    locks[name] = true;
    if (lockTimers[name]) root.clearTimeout(lockTimers[name]);
    lockTimers[name] = later(ms || CLICK_LOCK_MS, function () {
      locks[name] = false;
      lockTimers[name] = null;
      if (name === 'pick') refreshDoorLocks();
    });
  }
  function releaseLock(name) {
    if (lockTimers[name]) { root.clearTimeout(lockTimers[name]); lockTimers[name] = null; }
    locks[name] = false;
  }
  function canPick() { return last.phase === 'PICK' && !locks.pick; }
  function canDecide() { return last.phase === 'DECIDE' && !locks.decide; }

  /** 锁过期后只更新门牌可点样式，不整页重渲染（避免用陈旧 state）。 */
  function refreshDoorLocks() {
    var D = d();
    if (!D.doors || !D.doors.querySelectorAll) return;
    var els = D.doors.querySelectorAll('.door');
    var live = last.phase === 'PICK' && !locks.pick;
    for (var i = 0; i < els.length; i++) {
      toggle(els[i], 'is-live', live);
      toggle(els[i], 'is-locked', !live);
      if (els[i].setAttribute) {
        els[i].setAttribute('aria-disabled', live ? 'false' : 'true');
        els[i].tabIndex = live ? 0 : -1;
      }
    }
  }

  /* ------------------------------------------------------------------ 动作 */
  function emit(action) {
    var g = gameRef;
    if (!g || typeof g.action !== 'function') return false;
    try { g.action(action); return true; } catch (e) { logErr('action ' + str(action && action.type), e); return false; }
  }

  /* ------------------------------------------------------------ 门牌渲染 */
  function ensureDoors() {
    var D = d();
    var box = D.doors;
    if (!box || !doc.createElement) return [];
    var els = [];
    for (var i = 0; i < 3; i++) {
      var el = box.querySelector ? box.querySelector('.door[data-slot="' + i + '"]') : null;
      if (!el) {
        el = doc.createElement('button');
        el.type = 'button';
        el.className = 'door';
        el.setAttribute('data-slot', String(i));
        box.appendChild(el);
      }
      els.push(el);
    }
    if (box.querySelectorAll) {
      var all = box.querySelectorAll('.door');
      for (var k = all.length - 1; k >= 0; k--) {
        var sl = all[k].getAttribute('data-slot');
        if (sl !== '0' && sl !== '1' && sl !== '2') box.removeChild(all[k]);
      }
    }
    return els;
  }

  function doorEl(slot) {
    var D = d();
    if (!D.doors || !D.doors.querySelector || slot == null) return null;
    return D.doors.querySelector('.door[data-slot="' + num(slot, -1) + '"]');
  }

  function doorData(state, i) {
    var arr = state && state.doors;
    var o = (arr && arr[i]) ? arr[i] : {};
    return {
      slot: i,
      itemId: o.itemId || null,
      opened: !!o.opened,
      revealed: !!o.revealed,
      peeked: !!o.peeked
    };
  }

  function doorPicked(state, i) { return num(state && state.pickedSlot, -1) === i; }

  function faceSig(dd, state, i) {
    return [dd.itemId || '', dd.revealed ? 'R' : '', dd.opened ? 'O' : '', dd.peeked ? 'K' : '', doorPicked(state, i) ? 'P' : ''].join('|');
  }

  /** 门面：已翻开的门显示物品；被窥视过的门只显示“已窥视”标记，绝不泄露 itemId。 */
  function faceDoor(el, dd, state, i) {
    if (!el) return;
    var picked = doorPicked(state, i);
    var show = dd.revealed || dd.opened;
    var iv = show ? itemView(dd.itemId) : null;
    var icon = '？', name = '未开', tag = '';
    if (show) {
      icon = iv.icon; name = iv.name; tag = dd.revealed ? '已开奖' : '主持人打开';
    } else if (dd.peeked) {
      icon = '👁'; name = '已窥视'; tag = '本轮已窥视';
    } else if (picked) {
      tag = '已选';
    }
    html(el,
      '<span class="door-no" aria-hidden="true">' + (i + 1) + '</span>' +
      '<span class="door-face">' +
        '<span class="door-icon" aria-hidden="true">' + esc(icon) + '</span>' +
        '<span class="door-name">' + esc(name) + '</span>' +
      '</span>' +
      '<span class="door-tag">' + esc(tag) + '</span>' +
      /* 契约 v4 §4.6 G7 点名的门把手（纯装饰，绝对定位，不参与门的文字排布） */
      '<span class="door-knob" aria-hidden="true"></span>');
  }

  function doorAria(dd, state, i) {
    var parts = [(i + 1) + ' 号门'];
    if (doorPicked(state, i)) parts.push('已选择');
    if (dd.revealed) parts.push('已开奖：' + itemView(dd.itemId).name);
    else if (dd.opened) parts.push('主持人已打开：' + itemView(dd.itemId).name);
    else if (dd.peeked) parts.push('已窥视过，未打开');
    else parts.push('未打开');
    return parts.join('，');
  }

  /* -------------------------------------------------------- 决策按钮状态 */
  /**
   * hard=true  → 结构性不可用（相位不符 / REVEAL 锁定 / 已加倍），用 disabled 属性
   * hard=false → 资源不足（怀疑值不够），aria-disabled + .is-locked 置灰，
   *              仍可点击并 toast 提示文案（配合 #stage-hint 的静态提示）
   */
  function choiceState(ch, state, phase) {
    if (phase !== 'DECIDE') {
      return { on: false, hard: true, hint: phase === 'REVEAL' ? '开奖中，决策已锁定' : '' };
    }
    var sus = num(state && state.suspicion, 0);
    switch (ch) {
      case 'challenge': {
        var cost = suspicionCost();
        if (sus < cost) return { on: false, hard: false, hint: '怀疑值不足：质疑需要 ' + cost + ' 点怀疑值' };
        /* 契约 v3 §1.3：质疑=验证线索，title 固定这句（消耗点数由 #stage-hint 说明）。 */
        return { on: true, hard: false, hint: '质疑 / 验证线索' };
      }
      case 'double':
        if (state && state.doubled) return { on: false, hard: true, hint: '本轮已加倍，不能叠加' };
        return { on: true, hard: false, hint: '本轮收益与负面效果 ×2' };
      case 'switch':
        if (!state || state.pickedSlot == null) return { on: false, hard: false, hint: '还没有选门，无法换门' };
        return { on: true, hard: false, hint: '改选另一扇门' };
      case 'cashout':
        return { on: true, hard: false, hint: '见好就收，直接进结算页' };
      case 'stick':
      default:
        return { on: true, hard: false, hint: '保留当前这扇门' };
    }
  }

  function hintText(state, phase) {
    var round = Math.max(1, Math.round(num(state && state.round, 1)));
    switch (phase) {
      case 'IDLE': return '选一个模式开始：演示模式是固定剧本，普通模式完全随机。';
      case 'ROUND_INTRO': return '第 ' + round + ' 轮 —— 准备开始。';
      case 'NARRATOR': return '旁白正在说话。记住：它说的每一句都可能是谎。';
      case 'PICK': return '点击一扇门做出选择 · 长按 0.4 秒可窥视' + (state && state.peekUsed ? '（本轮已用过）' : '（每轮一次）');
      case 'HOST_OPEN': return '主持人正在打开一扇门……';
      case 'DECIDE':
        return num(state && state.suspicion, 0) < suspicionCost()
          ? '怀疑值不足，无法质疑旁白（需要 ' + suspicionCost() + ' 点）。'
          : '选一个决策。质疑旁白会消耗 ' + suspicionCost() + ' 点怀疑值。';
      case 'REVEAL': return '开奖中 —— 决策区已锁定。';
      case 'SETTLE_ROUND': return '本轮结束：可以继续下一轮，也可以收手。';
      case 'CASHOUT': return '已收手 —— 结算页。';
      case 'GAME_OVER': return '耐心耗尽，本局结束。';
      default: return '';
    }
  }

  /* ============================== 契约 v4 §4：体验增强（G1 引导 / G2 键盘 / G3 设置
     / G4+G5 成就统计 / G6 种子 / G8 竖屏）。所有 Game 新 API 都经 gameCall() 兜底：
     引擎比 UI 晚就绪、字段缺失或抛错时一律静默降级，绝不让垫片环境崩掉。 ============ */

  /** 安全调用 Game 上的新 API；不存在或抛错都返回 null（只 warn）。 */
  function gameCall(name, args) {
    var g = gameRef;
    if (!g || typeof g[name] !== 'function') return null;
    try { return g[name].apply(g, args || []); } catch (e) { logErr(name, e); return null; }
  }

  /** Game.prefs() 的兜底 + 归一化。
   *  引擎侧的键名是 sound / bgm / animationSpeed（'slow'|'normal'|'fast'），
   *  契约侧写的是 sfx / animSpeed，这里统一成 {bgm,sound,animSpeed,personality,onboarded}。 */
  function prefsOf(state) {
    var raw = gameCall('prefs');
    var s = state || liveState();
    var f = (s && s.flags) || {};
    if (!raw || typeof raw !== 'object') raw = {};
    var speed = raw.animSpeed;
    if (speed === undefined || speed === null) speed = raw.animationSpeed;
    if (speed === 'fast') speed = 1.5;
    else if (speed === 'slow') speed = 0.5;
    else if (speed === 'off') speed = 1;
    if (typeof speed !== 'number' || !isFinite(speed) || speed <= 0) speed = 1;
    var on = raw.sound === undefined ? raw.sfx : raw.sound;
    return {
      personality: str(raw.personality || raw.persona || (s && s.personality)) || 'sarcastic',
      bgm: raw.bgm === undefined ? !f.muted : raw.bgm !== false,
      sound: on === undefined ? !f.muted : on !== false,
      animSpeed: speed,
      onboarded: raw.onboarded === undefined ? !!f.onboarded : raw.onboarded === true
    };
  }

  /** 动画速度 → 时长系数（1.5× 档 ⇒ 时长 ×0.667）。 */
  function speedScale() {
    var v = prefCache ? num(prefCache.animSpeed, 1) : 1;
    if (!(v > 0)) v = 1;
    return 1 / v;
  }
  function scaled(ms) { return Math.max(80, Math.round(num(ms, 0) * speedScale())); }

  /* ---- 人格表（契约 §3 personas.json；数据层未就绪时用契约里的三个 id 兜底） ---- */
  var PERSONA_FALLBACK = [
    { id: 'sarcastic', name: '毒舌', icon: '😏', desc: '嘴上不饶人，真假照说' },
    { id: 'gentle', name: '温柔', icon: '🌸', desc: '语气软，谎话概率略低' },
    { id: 'crazy', name: '癫狂', icon: '🤪', desc: '语无伦次，谎话概率略高' }
  ];
  function personaList() {
    var d = root.GameData;
    var src = (d && (d.personas || d.PERSONAS)) || gameCall('personalities') || null;
    var out = [];
    if (src && src.length) {
      for (var i = 0; i < src.length; i++) {
        var it = src[i] || {};
        var id = str(it.id);
        if (!id) continue;
        out.push({
          id: id, name: str(it.name || it.title || id),
          icon: str(it.icon || ''), desc: str(it.desc || it.text || '')
        });
      }
    }
    return out.length ? out : PERSONA_FALLBACK.slice();
  }
  function personaOf(id) {
    var list = personaList();
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) return list[i]; }
    return list[0];
  }

  /* ------------------------------------------------- G1 新手引导（三步气泡） */
  /* 引擎的 tutorialSteps() 里 anchor 传的是 CSS 选择器（'#doors' / '#narrator' / '#decide' / '#controls'），
     契约 §4.1 写的是语义名（'doors'|'decide'|'cashout'）—— 这里两种都认。 */
  var ANCHOR_ALIAS = { doors: '#doors', decide: '#decide', narrator: '#narrator', controls: '#controls', hud: '#hud' };
  function anchorEl(anchor) {
    var D = d();
    var raw = str(anchor);
    if (!raw) return null;
    if (raw === 'cashout') {
      var list = D.decide && D.decide.querySelectorAll ? D.decide.querySelectorAll('.decide-btn') : [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].getAttribute('data-choice') === 'cashout') return list[i];
      }
      return D.decide;
    }
    var sel = ANCHOR_ALIAS[raw] || raw;
    if (sel.charAt(0) === '#') return $(sel.slice(1));
    if (doc && doc.querySelector) return doc.querySelector(sel);
    return $(sel);
  }
  function clearTutAnchor() {
    var D = d();
    if (!D.body || !D.body.querySelectorAll) return;
    var list = D.body.querySelectorAll('.is-tutorial-target');
    for (var i = 0; i < list.length; i++) list[i].classList.remove('is-tutorial-target');
  }
  function renderTutorial() {
    var D = d();
    if (!D.tutorial || !tut.active) return;
    var step = tut.steps[tut.index] || {};
    text(D.tutorialTitle, str(step.title || '新手引导'));
    text(D.tutorialText, str(step.text || ''));
    if (D.tutorialNext) text(D.tutorialNext, tut.index >= tut.steps.length - 1 ? '开始' : '下一步');
    clearTutAnchor();
    var el = anchorEl(str(step.anchor));
    if (el && el.classList) el.classList.add('is-tutorial-target');
    D.tutorial.hidden = false;
  }
  /** 收尾：跳过走 tutorial_skip（引擎会给一句「随时按 ? 看规则」提示），走完最后一步走 tutorial_done。 */
  function finishTutorial(start, skipped) {
    var D = d();
    if (!tut.active) return;
    var mode = str(lastState && lastState.mode) === 'normal' ? 'normal' : 'demo';
    tut.active = false;
    tut.done = true;
    clearTutAnchor();
    if (D.tutorial) D.tutorial.hidden = true;
    emit({ type: skipped ? 'tutorial_skip' : 'tutorial_done' });
    if (start) emit({ type: 'start', mode: mode });
  }
  /** 契约 v4 §4.1：启动引导。引擎未就绪 / 已完成过（tutorialSteps() 为空）时返回 false。 */
  UI.startTutorial = function () {
    var D = d();
    if (!D.tutorial) return false;
    var steps = gameCall('tutorialSteps');
    if (!steps || !steps.length) return false;
    tut.steps = steps;
    tut.index = 0;
    tut.active = true;
    tut.done = false;
    tut.phase = str((lastState || {}).phase) || 'IDLE';
    renderTutorial();
    return true;
  };
  function maybeAutoTutorial() {
    if (tut.active || tut.done || tut.autoTried) return;
    tut.autoTried = true;                       /* 只尝试一次：引擎未就绪就不打扰 */
    if (prefsOf().onboarded) return;
    UI.startTutorial();
  }
  /** 引导防卡死（契约 §4.1）：局终相位（结算 / 收手 / 结束）时若引导还挂着，自动收尾。 */
  var TUT_AUTO_DONE = { SETTLE_ROUND: 1, CASHOUT: 1, GAME_OVER: 1 };
  function autoDoneTutorial(state) {
    if (!tut.active) return;
    var phase = str(state && state.phase);
    if (TUT_AUTO_DONE[phase]) finishTutorial(false, true);
  }

  /* ------------------------------------------------- G2 键盘全操作（§4.2） */
  function typingTarget(t) {
    if (!t) return false;
    var tag = str(t.tagName).toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return t.isContentEditable === true;
  }
  function phaseNow() {
    return PHASES[str((lastState || {}).phase)] ? str(lastState.phase) : 'IDLE';
  }
  /** 走与鼠标点击完全相同的通道：同样的 canDecide/锁/置灰提示，只是入口换成键盘。 */
  function keyDecide(choice) {
    if (phaseNow() !== 'DECIDE' || !canDecide()) return false;
    var D = d();
    var list = D.decide && D.decide.querySelectorAll ? D.decide.querySelectorAll('.decide-btn') : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-choice') !== choice) continue;
      if (list[i].disabled || list[i].getAttribute('data-hard') === 'true') return false;
      if (list[i].getAttribute('aria-disabled') === 'true') {
        sfx('click');
        UI.toast(list[i].getAttribute('data-hint') || '该决策当前不可用');
        return true;
      }
      sfx('click');
      armLock('decide', CLICK_LOCK_MS);
      emit({ type: 'decide', choice: choice });
      return true;
    }
    return false;
  }
  function keyPick(slot) {
    if (phaseNow() !== 'PICK' || !canPick()) return false;
    var el = doorEl(slot);
    if (!el || (el.classList && el.classList.contains('is-locked'))) return false;
    sfx('click');
    armLock('pick', CLICK_LOCK_MS);
    emit({ type: 'pick', slot: slot });
    return true;
  }
  function keyModalPrimary() {
    var D = d();
    if (!D.modal || D.modal.hidden || !D.modal.querySelector) return false;
    var p = D.modal.querySelector('.modal-btn.primary');
    if (!p || p.disabled) return false;
    activateModalChoice(p);
    return true;
  }

  /* ------------------------------------------------- G3 设置弹层（§4.3） */
  /** 动画速度三档 ↔ 引擎偏好值（引擎的键是 animationSpeed，取 'slow'|'normal'|'fast'）。 */
  var SPEED_STEPS = [0.5, 1, 1.5];
  function speedToPref(v) {
    var n = num(v, 1);
    return n < 0.75 ? 'slow' : (n > 1.25 ? 'fast' : 'normal');
  }
  function switchHtml(key, label, on) {
    return '<button type="button" class="switch-btn' + (on ? ' is-on' : '') + '" data-pref="' + esc(key) +
           '" role="switch" aria-checked="' + (on ? 'true' : 'false') + '">' +
           '<span class="switch-dot" aria-hidden="true"></span>' + esc(label) + '</button>';
  }
  /** 设置弹层正文。引擎自己那份旧的 `<ul class="persona-list">` + 声音文字行会被移除，
   *  避免与契约 §4.3 的控件重复（引擎若哪天删掉旧的，这里就是无操作）。 */
  function dropLegacySettings() {
    var D = d();
    if (!D.modalBody || !D.modalBody.querySelector || !D.modalBody.removeChild) return;
    var legacy = D.modalBody.querySelector('ul.persona-list');
    if (legacy && legacy.parentNode) legacy.parentNode.removeChild(legacy);
    var ps = D.modalBody.querySelectorAll ? D.modalBody.querySelectorAll('p') : [];
    for (var i = 0; i < ps.length; i++) {
      var txt = str(ps[i].textContent);
      var isSoundLine = txt.indexOf('声音') === 0 && txt.indexOf('动画速度') >= 0;
      var isPersonaHead = txt === '旁白人格';    /* 引擎的小标题，和我 settings-label「旁白人格」重复 */
      if ((isSoundLine || isPersonaHead) && ps[i].parentNode) {
        ps[i].parentNode.removeChild(ps[i]);
      }
    }
  }
  function renderSettings() {
    var D = d();
    if (!D.modalBody || !doc.createElement) return;
    if (D.modalBody.querySelector && D.modalBody.querySelector('#settings-body')) return;
    var p = prefsOf();
    var cur = str(p.personality) || str(liveState().personality) || 'sarcastic';
    var list = personaList();
    var html = '<div class="settings-group"><div class="settings-label">旁白人格</div><div class="settings-persona-row">';
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      html += '<button type="button" class="persona-card' + (it.id === cur ? ' is-active' : '') +
              '" data-persona="' + esc(it.id) + '" aria-pressed="' + (it.id === cur ? 'true' : 'false') + '">' +
              '<span class="persona-icon" aria-hidden="true">' + esc(it.icon) + '</span>' +
              '<span class="persona-name">' + esc(it.name) + '</span>' +
              '<span class="persona-desc">' + esc(it.desc) + '</span></button>';
    }
    html += '</div></div>';
    html += '<div class="settings-group"><div class="settings-label">声音</div><div class="switch-row">' +
            switchHtml('bgm', '背景音乐', p.bgm !== false) + switchHtml('sound', '音效', p.sound !== false) +
            '</div></div>';
    var curSpeed = num(p.animSpeed, 1);
    html += '<div class="settings-group"><div class="settings-label">动画速度</div><div class="speed-row">';
    for (var k = 0; k < SPEED_STEPS.length; k++) {
      var act = Math.abs(SPEED_STEPS[k] - curSpeed) < 0.01;
      html += '<button type="button" class="speed-btn' + (act ? ' is-active' : '') + '" data-speed="' + SPEED_STEPS[k] +
              '" aria-pressed="' + (act ? 'true' : 'false') + '">' + SPEED_STEPS[k] + '×</button>';
    }
    html += '</div></div>';
    dropLegacySettings();
    var wrap = doc.createElement('div');
    wrap.setAttribute('id', 'settings-body');
    wrap.setAttribute('class', 'settings-body');
    wrap.innerHTML = html;
    D.modalBody.appendChild(wrap);
  }
  function ensurePersonaChip() {
    var D = d();
    if (D.personaChip) return D.personaChip;
    if (chipReady || !doc.createElement || !D.body) return D.personaChip || null;
    chipReady = true;
    var btn = doc.createElement('button');
    btn.setAttribute('id', 'persona-chip');
    btn.setAttribute('class', 'persona-chip');
    btn.setAttribute('type', 'button');
    btn.setAttribute('title', '旁白人格（点击打开设置）');
    D.body.appendChild(btn);
    on(btn, 'click', function () { sfx('click'); emit({ type: 'open_settings' }); });
    D.personaChip = btn;
    return btn;
  }
  function renderPersonaChip(state) {
    var el = ensurePersonaChip();
    if (!el) return;
    var s = state || liveState();
    var id = str(s.personality) || str(prefsOf(s).personality) || 'sarcastic';
    var p = personaOf(id);
    text(el, str(p.icon) + ' ' + str(p.name));
    el.hidden = str(s.phase) === 'IDLE';
  }

  /* ------------------------------------------------- G4+G5 图鉴页成就与统计（§4.4） */
  function statItem(k, v) {
    return '<div class="stat-item"><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>';
  }
  function renderCodexExtras() {
    var D = d();
    if (!D.modalBody || !doc.createElement) return;
    /* 优先 Game.achievementList()（[{id,name,icon,desc,unlocked}]）；只拿到 id 数组时退化为「全锁定，名字用 id」 */
    var ach = gameCall('achievementList');
    if (!ach || !ach.length) {
      var ids = gameCall('achievements') || [];
      ach = [];
      for (var z = 0; z < ids.length; z++) {
        if (typeof ids[z] === 'string') ach.push({ id: ids[z], name: ids[z], icon: '🏆', desc: '', unlocked: true });
      }
    }
    if (ach && ach.length && !(D.modalBody.querySelector && D.modalBody.querySelector('#codex-achievements'))) {
      var got = 0;
      var html = '<h4 class="codex-sub">成就</h4><div class="ach-grid">';
      for (var i = 0; i < ach.length; i++) {
        var a = ach[i] || {};
        var ok = a.unlocked === true;
        if (ok) got++;
        html += '<div class="ach-card' + (ok ? ' is-unlocked' : ' is-locked') + '" data-ach="' + esc(str(a.id)) + '">' +
                '<span class="ach-icon" aria-hidden="true">' + esc(str(a.icon || '🏆')) + '</span>' +
                '<span class="ach-name">' + esc(ok ? str(a.name) : '？？？') + '</span>' +
                '<span class="ach-desc">' + esc(str(a.desc)) + '</span></div>';
      }
      html += '</div>';
      var box = doc.createElement('section');
      box.setAttribute('id', 'codex-achievements');
      box.setAttribute('class', 'codex-achievements');
      box.setAttribute('data-unlocked', String(got));
      box.innerHTML = html;
      D.modalBody.appendChild(box);
    }
    var st = gameCall('stats');
    if (st && !(D.modalBody.querySelector && D.modalBody.querySelector('#codex-stats'))) {
      var rate = '—';
      if (st.challengeRate != null) rate = Math.round(num(st.challengeRate, 0) * 100) + '%';
      else if (num(st.challenges, 0) > 0) rate = Math.round(num(st.challengeWins, 0) / num(st.challenges, 1) * 100) + '%';
      var card = doc.createElement('section');
      card.setAttribute('id', 'codex-stats');
      card.setAttribute('class', 'codex-stats');
      card.innerHTML = '<h4 class="codex-sub">统计</h4><div class="stat-list">' +
        statItem('总局数', num(st.games, 0)) + statItem('最佳金币', num(st.bestCoins, 0)) +
        statItem('最佳轮次', num(st.bestRound, 0)) + statItem('质疑成功率', rate) +
        statItem('解锁结局', num(st.endings, 0)) + '</div>';
      D.modalBody.appendChild(card);
    }
  }

  /* ------------------------------------------------- G6 种子行与复制（§4.5） */
  /** 契约 v4 §4.3：结算点评行。引擎写了 state.settleLine 才出现；body 里已有同句则不重复。 */
  function settleRow(spec) {
    var kind = str(spec && spec.kind);
    if (kind !== 'round' && kind !== 'cashout' && kind !== 'gameover') return null;
    var line = str(liveState().settleLine);
    if (!line || !doc.createElement) return null;
    var D = d();
    if (D.modalBody && str(D.modalBody.textContent).indexOf(line) >= 0) return null;
    var el = doc.createElement('p');
    el.setAttribute('class', 'settle-line');
    text(el, line);
    return el;
  }
  /** 结算页的「种子：xxxx」行（契约 §4.5）。只在结算类弹层出现：
   *  round（每轮结算）/cashout（收手）/gameover（局终）；
   *  规则、设置、图鉴等弹层不出现（否则它们会平白多出一个「复制种子」按钮）。 */
  var SEED_KINDS = { round: 1, cashout: 1, gameover: 1 };
  function seedRow(spec) {
    if (!spec || !SEED_KINDS[str(spec.kind)]) return null;
    var tag = gameCall('seedTag');
    if (!tag || !doc.createElement) return null;
    if (str(spec.body).indexOf('种子') >= 0) return null;   /* 引擎已写就不重复 */
    var row = doc.createElement('div');
    row.setAttribute('class', 'seed-row');
    row.innerHTML = '<span class="seed-label">种子</span><code class="seed-tag">' + esc(tag) + '</code>' +
                    '<button type="button" class="seed-copy modal-btn" data-choice="save_seed">复制种子</button>';
    return row;
  }
  function copySeed() {
    var tag = str(gameCall('seedTag') || '');
    var done = false;
    try {
      var nav = root.navigator;
      if (nav && nav.clipboard && nav.clipboard.writeText) {
        var pr = nav.clipboard.writeText(tag);
        if (pr && pr.then) pr.then(null, function () {});
        done = true;
      }
    } catch (e) { logErr('copySeed', e); }
    UI.toast(done ? ('种子已复制：' + tag) : ('种子：' + tag + '（复制不可用，手动记一下）'));
  }

  /* ------------------------------------------------- G8 竖屏降级提示（§4.7） */
  var portraitSent = false;
  function ensurePortraitHint() {
    var D = d();
    if (D.portraitHint) return D.portraitHint;
    if (portraitReady || !doc.createElement || !D.body) return null;
    portraitReady = true;                     /* 插过一次就不再重试 */
    var el = doc.createElement('section');
    el.setAttribute('id', 'portrait-hint');
    el.setAttribute('class', 'portrait-hint');
    el.setAttribute('aria-hidden', 'true');
    el.hidden = true;
    el.textContent = '建议横屏体验';
    D.body.appendChild(el);
    D.portraitHint = el;
    return el;
  }
  function syncPortrait(state) {
    var el = ensurePortraitHint();
    if (!el) return;
    var s = state || liveState();
    var h = num(root.innerHeight, 0);
    var rehearsal = !!(s && s.flags && s.flags.rehearsal);
    var show = h > 0 && h < 400 && !rehearsal;
    el.hidden = !show;
    if (show && !portraitSent && !(s.flags && s.flags.portraitWarned)) {
      portraitSent = true;                    /* 只提示一次 */
      emit({ type: 'set_pref', key: 'portraitWarned', value: true });
    }
  }

  /** 弹层动作按钮的统一激活路径（鼠标点击与键盘空格共用，保证锁/关层语义一致）。 */
  function activateModalChoice(btn) {
    if (!btn) return;
    var choice = str(btn.getAttribute('data-choice'));
    var D = d();
    var before = modalEpoch;
    sfx('click');
    if (choice === 'save_seed') copySeed();
    emit({ type: 'modal_choice', choice: choice });
    if (modalEpoch === before && D.modal && !D.modal.hidden) UI.closeModal();
  }

  /* ================================================================== API */

  /** 缓存 DOM、绑定静态事件；game 必须提供 action(action) 方法。 */
  UI.init = function (game) {
    if (game) gameRef = game;
    var D = d();
    if (bound) {
      if (lastState) UI.render(lastState);
      return UI;
    }

    /* --- 门：点击选门 / 长按窥视（事件委托，兼容 render 动态生成的 .door） --- */
    on(D.doors, 'click', function (e) {
      var el = closest(e.target, '.door');
      if (!el || !D.doors.contains(el)) return;
      var slot = num(el.getAttribute('data-slot'), -1);
      if (press.fired && press.slot === slot) { press.fired = false; return; }   /* 长按已处理，吞掉尾随 click */
      if (!canPick()) return;
      sfx('click');
      armLock('pick', CLICK_LOCK_MS);
      emit({ type: 'pick', slot: slot });
    });

    on(D.doors, 'pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      var el = closest(e.target, '.door');
      if (!el || !canPick()) return;
      var slot = num(el.getAttribute('data-slot'), -1);
      press.slot = slot;
      press.fired = false;
      if (press.timer) root.clearTimeout(press.timer);
      press.timer = later(PEEK_MS, function () {
        press.timer = null;
        if (!canPick()) return;
        press.fired = true;
        later(900, function () { press.fired = false; });   /* 防止吞掉后续无关点击 */
        sfx('open');
        var de = doorEl(slot);
        if (de) {
          de.classList.add('is-peeking');
          later(420, function () { de.classList.remove('is-peeking'); });
        }
        emit({ type: 'peek', slot: slot });
      });
    });

    function cancelPress() {
      if (press.timer) { root.clearTimeout(press.timer); press.timer = null; }
    }
    on(D.doors, 'pointerup', cancelPress);
    on(D.doors, 'pointercancel', cancelPress);
    on(D.doors, 'pointerleave', cancelPress);
    on(D.doors, 'contextmenu', function (e) { if (e.preventDefault) e.preventDefault(); });
    on(D.doors, 'dragstart', function (e) { if (e.preventDefault) e.preventDefault(); });

    /* --- 决策按钮 --- */
    on(D.decide, 'click', function (e) {
      var btn = closest(e.target, '.decide-btn');
      if (!btn || !D.decide.contains(btn)) return;
      if (btn.disabled || btn.getAttribute('data-hard') === 'true') return;
      if (btn.getAttribute('aria-disabled') === 'true') { sfx('click'); UI.toast(btn.getAttribute('data-hint') || '该决策当前不可用'); return; }
      if (!canDecide()) return;
      sfx('click');
      armLock('decide', CLICK_LOCK_MS);
      emit({ type: 'decide', choice: btn.getAttribute('data-choice') });
    });

    /* --- 常驻全局控制 --- */
    var ctrl = [
      [D.btnReset, 'reset'],
      [D.btnDemo, 'toggle_demo'],
      [D.btnShop, 'shop'],
      [D.btnMute, 'toggle_mute'],
      [D.btnSkip, 'skip_anim']
    ];
    for (var i = 0; i < ctrl.length; i++) {
      (function (pair) {
        on(pair[0], 'click', function () {
          if (pair[0] && pair[0].disabled) return;      /* 结构性不可用：非 DECIDE/SETTLE_ROUND 的商店 */
          var act = pair[1];
          if (act === 'toggle_mute') {
            /* 先切状态再发声：静音瞬间不响，解除静音有轻点反馈 */
            emit({ type: act });
            sfx('click');
            return;
          }
          sfx('click');
          emit({ type: act });
        });
      })(ctrl[i]);
    }

    /* --- 开始 / 遮罩 --- */
    on(D.btnStart, 'click', function () { sfx('click'); emit({ type: 'start', mode: 'demo' }); });
    on(D.btnStartNormal, 'click', function () { sfx('click'); emit({ type: 'start', mode: 'normal' }); });

    /* --- 旁白跳过：先补完本句，再交给状态机（game._skipLine 还会调 UI.skip） --- */
    on(D.narratorSkip, 'click', function () {
      var list = activeAnims.slice();
      sfx('click');
      emit({ type: 'skip_line' });
      for (var k = 0; k < list.length; k++) { if (list[k].name === 'narrator') list[k].finish(); }
    });

    /* --- 弹层：商店购买（事件委托）/ 背景点击（仅无按钮的信息弹层）/ ESC / Tab 焦点环 --- */
    on(D.modal, 'click', function (e) {
      var buy = closest(e.target, '.shop-buy');
      if (buy && D.modal && D.modal.contains(buy)) {
        if (buy.disabled || buy.getAttribute('aria-disabled') === 'true') {
          sfx('click');
          UI.toast(buy.getAttribute('data-hint') || '现在买不了');
          return;
        }
        sfx('buy');
        emit({ type: 'modal_choice', choice: 'buy:' + buy.getAttribute('data-item') });
        return;
      }
      /* 契约 v4 §4.5 G6：正文里的「复制种子」 */
      var seed = closest(e.target, '.seed-copy');
      if (seed && D.modal && D.modal.contains(seed)) {
        sfx('click');
        copySeed();
        emit({ type: 'modal_choice', choice: 'save_seed' });
        return;
      }
      /* 契约 v4 §4.3 G3：人格单选 / 声音开关 / 动画速度 */
      var pcard = closest(e.target, '.persona-card');
      if (pcard && D.modal && D.modal.contains(pcard)) {
        var pid = str(pcard.getAttribute('data-persona'));
        if (pid) { sfx('click'); emit({ type: 'set_personality', id: pid }); }
        return;
      }
      var sw = closest(e.target, '.switch-btn');
      if (sw && D.modal && D.modal.contains(sw)) {
        sfx('click');
        emit({ type: 'set_pref', key: str(sw.getAttribute('data-pref')), value: sw.getAttribute('aria-checked') !== 'true' });
        return;
      }
      var sp = closest(e.target, '.speed-btn');
      if (sp && D.modal && D.modal.contains(sp)) {
        sfx('click');
        /* 契约 §2.3 写的是 apply_speed{value}，但引擎目前只认 set_pref{key:'animationSpeed'}，
           这里发引擎真正消费的那条，保证点下去立刻生效；若引擎日后补上 apply_speed，改这一处即可。 */
        emit({ type: 'set_pref', key: 'animationSpeed', value: speedToPref(sp.getAttribute('data-speed')) });
        return;
      }
      if (e.target === D.modal && modalActions === 0) UI.closeModal();
    });
    on(doc, 'keydown', function (e) {
      var key = e.key || '';
      if (key === 'Escape' || e.keyCode === 27) {
        /* 契约 v4 §4.2：Esc 关闭弹层。必选流程（本轮结算/结算页/结束页）必须点按钮，
           避免玩家按 Esc 后停在无弹层的 SETTLE_ROUND / CASHOUT / GAME_OVER 里。 */
        if (D.modal && !D.modal.hidden) {
          var mustChoose = modalKind === 'round' || modalKind === 'cashout' || modalKind === 'gameover';
          if (modalActions === 0 || !mustChoose) UI.closeModal();
        }
        return;
      }
      if (key === 'Tab' && D.modal && !D.modal.hidden) {
        var f = D.modal.querySelectorAll('button, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        var first = f[0], lastEl = f[f.length - 1];
        if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); lastEl.focus(); }
        else if (!e.shiftKey && doc.activeElement === lastEl) { e.preventDefault(); first.focus(); }
        return;
      }

      /* ---- 契约 v4 §4.2 G2：键盘全操作（与鼠标走同一条通道） ---- */
      if (typingTarget(e.target)) return;                     /* 输入框聚焦时不抢键 */
      if (D.modal && !D.modal.hidden) {                       /* 弹层打开：空格 = 主按钮 */
        if (key === ' ' || key === 'Spacebar' || key === 'Enter') {
          if (keyModalPrimary()) e.preventDefault();
        }
        return;
      }
      if (key === '1' || key === '2' || key === '3') {
        if (keyPick(num(key, 1) - 1)) e.preventDefault();
        return;
      }
      var low = str(key).toLowerCase();
      if (low === 'q') { if (keyDecide('challenge')) e.preventDefault(); return; }
      if (low === 'd') { if (keyDecide('double')) e.preventDefault(); return; }
      if (low === 's') { if (keyDecide('switch')) e.preventDefault(); return; }
      if (low === 'c') { if (keyDecide('cashout')) e.preventDefault(); return; }
      if (low === 'm') { emit({ type: 'toggle_mute' }); sfx('click'); e.preventDefault(); return; }
      if (key === '?' || low === 'h') { emit({ type: 'open_help' }); sfx('click'); e.preventDefault(); return; }
      if (key === ' ' || key === 'Spacebar') {
        if (phaseNow() === 'IDLE') { emit({ type: 'start', mode: 'demo' }); sfx('click'); e.preventDefault(); }
        return;
      }
      if (low === ',' || low === '.') { emit({ type: 'open_settings' }); sfx('click'); e.preventDefault(); }
    });

    /* --- 契约 v4 G2/G1/G8：规则与设置按钮、引导气泡、竖屏提示 --- */
    on(D.btnHelp, 'click', function () { sfx('click'); emit({ type: 'open_help' }); });
    on(D.btnSettings, 'click', function () { sfx('click'); emit({ type: 'open_settings' }); });
    on(D.tutorialSkip, 'click', function () { sfx('click'); finishTutorial(false, true); });
    on(D.tutorialNext, 'click', function () {
      sfx('click');
      if (!tut.active) return;
      if (tut.index >= tut.steps.length - 1) { finishTutorial(true); return; }
      tut.index++;
      renderTutorial();
    });
    on(root, 'resize', function () { syncPortrait(liveState()); });

    /* --- 音频手势解锁：AudioContext 必须在首次用户手势之后创建 --- */
    for (var gi = 0; gi < GESTURE.length; gi++) {
      on(doc, GESTURE[gi], function () { armAudio(); bgmSync(liveState()); }, { once: true });
    }
    /* BGM（契约 v3 §5.2）：页面切到后台就停，切回来按当前相位续上 */
    on(doc, 'visibilitychange', function () { bgmSync(liveState()); });

    bound = true;
    cacheDecideButtons();
    return UI;
  };

  function cacheDecideButtons() {
    var D = d();
    if (!D.decide || !D.decide.querySelectorAll) return [];
    var list = D.decide.querySelectorAll('.decide-btn');
    for (var i = 0; i < list.length; i++) {
      if (!list[i].__label) {
        list[i].__label = str(list[i].textContent).trim() || CHOICE_LABEL[list[i].getAttribute('data-choice')] || '';
      }
    }
    return list;
  }

  /** 同步全量渲染：只读 state。 */
  UI.render = function (state) {
    var D = d();
    var s = state || {};
    lastState = s;
    var phase = PHASES[str(s.phase)] ? str(s.phase) : 'IDLE';

    if (D.body && D.body.setAttribute) D.body.setAttribute('data-state', phase);

    /* 顶部信息 */
    text(D.roundChip, '第 ' + Math.max(1, Math.round(num(s.round, 1))) + ' 轮');
    var demo = str(s.mode) !== 'normal';
    text(D.modeChip, demo ? '演示模式' : '普通模式');
    toggle(D.modeChip, 'chip-quiet', demo);
    toggle(D.modeChip, 'chip-live', !demo);

    /* HUD 数值 */
    setHudValue(D.hudCoins, num(s.coins, 0));
    setHudValue(D.hudSuspicion, num(s.suspicion, 0));
    setHudValue(D.hudPatience, num(s.patience, 0));
    toggle(D.hudCoins, 'is-low', num(s.coins, 0) <= 0);
    toggle(D.hudSuspicion, 'is-low', num(s.suspicion, 0) < suspicionCost());
    toggle(D.hudPatience, 'is-low', num(s.patience, 0) <= 1);
    if (D.hudCoins) D.hudCoins.title = '金币：游戏内虚拟数值，非真实货币';
    if (D.hudSuspicion) D.hudSuspicion.title = '怀疑值：质疑旁白消耗 ' + suspicionCost() + ' 点';
    if (D.hudPatience) D.hudPatience.title = '耐心：归零即结束本局';
    /* HUD 卡片化（契约 §4.2③）：补内联 SVG 图标，只补一次；数字变化仍走 UI.flash */
    ensureIconSprite();
    ensureVignette();
    ensureStageDecor();      /* 契约 v4 §4.6 G7：幕布 + 聚光灯（纯装饰，缺失即自建） */
    decorateHud('coins', D.hudCoins);
    decorateHud('suspicion', D.hudSuspicion);
    decorateHud('patience', D.hudPatience);

    /* 三扇门（仅 PICK 相位可点；REVEAL/NARRATOR/HOST_OPEN/ROUND_INTRO 等一律锁定） */
    var els = ensureDoors();
    var phasePick = phase === 'PICK';
    var live = phasePick && !locks.pick;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var dd = doorData(s, i);
      var sig = faceSig(dd, s, i);
      if (el.__sig !== sig) {
        el.__sig = sig;
        if (!el.classList.contains('anim-hold')) faceDoor(el, dd, s, i);
      }
      toggle(el, 'is-picked', doorPicked(s, i));
      toggle(el, 'is-opened', dd.opened && !dd.revealed);
      toggle(el, 'is-revealed', dd.revealed);
      toggle(el, 'peeked', dd.peeked);
      toggle(el, 'is-live', live);
      toggle(el, 'is-locked', !live);
      if (el.setAttribute) {
        el.setAttribute('aria-disabled', live ? 'false' : 'true');
        el.setAttribute('aria-label', doorAria(dd, s, i));
        el.tabIndex = live ? 0 : -1;
      }
    }

    /* 舞台提示 */
    text(D.stageHint, hintText(s, phase));
    toggle(D.stageHint, 'is-warn', phase === 'REVEAL' || (phase === 'DECIDE' && num(s.suspicion, 0) < suspicionCost()));

    /* 决策区：仅 DECIDE 显示（REVEAL 期间整体不可用） */
    if (D.decide) {
      D.decide.hidden = phase !== 'DECIDE';
      toggle(D.decide, 'is-locked', phase !== 'DECIDE');
    }
    var btns = cacheDecideButtons();
    for (var b = 0; b < btns.length; b++) {
      var btn = btns[b];
      var ch = btn.getAttribute('data-choice');
      var st = choiceState(ch, s, phase);
      btn.disabled = (!st.on && st.hard === true);
      btn.setAttribute('data-hard', (!st.on && st.hard === true) ? 'true' : 'false');
      btn.setAttribute('aria-disabled', st.on ? 'false' : 'true');
      toggle(btn, 'is-locked', !st.on);
      if (st.hint) { btn.title = st.hint; btn.setAttribute('data-hint', st.hint); }
      else { btn.removeAttribute('title'); btn.removeAttribute('data-hint'); }
      text(btn, (ch === 'double' && s.doubled) ? '已加倍' : (btn.__label || CHOICE_LABEL[ch] || ''));
    }

    /* 开始遮罩：仅 IDLE 显示 */
    var idle = phase === 'IDLE';
    if (D.boot) { D.boot.hidden = !idle; toggle(D.boot, 'is-open', idle); }
    if (D.btnStart) D.btnStart.disabled = !idle;
    if (D.btnStartNormal) D.btnStartNormal.disabled = !idle;

    /* 旁白：动画进行中不抢文本 */
    toggle(D.narrator, 'is-speaking', speaking);
    if (D.narratorText && !speaking && !str(D.narratorText.textContent)) text(D.narratorText, '……');

    /* 偏好缓存（只读；音效/BGM 开关与动画速度都看它） */
    prefCache = prefsOf(s);

    /* 旁白面板的人格图标前缀（契约 v4 §4.3）：走 ::before 的 content，不占文字节点、不干扰打字机 */
    if (D.narratorText && D.narratorText.setAttribute && !speaking) {
      var pv = personaOf(str(s.personality) || str(prefCache.personality));
      D.narratorText.setAttribute('data-persona-icon', str(pv && pv.icon));
    }

    /* 背包（契约 §3.1/§3.4）：IDLE / ROUND_INTRO 隐藏，其余相位只读渲染 */
    renderBag(s, phase);

    /* 契约 v3：旁白线索摘要（§1.3）+ 演示提词器（§5.1），都只读 state */
    renderClaim(s);
    renderRehearsal(s);
    renderPersonaChip(s);     /* 契约 v4 §4.3：右下角人格徽标（只读 state，缺失即自建） */
    syncPortrait(s);          /* 契约 v4 §4.7：矮视口竖屏提示（纯浮层） */
    maybeAutoTutorial();      /* 契约 v4 §4.1：未引导过就自动开引导（引擎未就绪则不打扰） */
    autoDoneTutorial(s);      /* 契约 v4 §4.1：局终相位自动收尾，防卡死 */

    UI.setControls(s);

    /* 相位变化即释放连点锁 */
    if (phase !== 'PICK') releaseLock('pick');
    if (phase !== 'DECIDE') releaseLock('decide');
    last = {
      phase: phase,
      pickedSlot: num(s.pickedSlot, -1) >= 0 ? num(s.pickedSlot, -1) : null,
      doubled: !!s.doubled,
      suspicion: num(s.suspicion, 0),
      peekUsed: !!s.peekUsed
    };
    return UI;
  };

  function setHudValue(item, v) {
    if (!item) return;
    var el = item.querySelector ? item.querySelector('.hud-value') : null;
    text(el, Math.round(num(v, 0)));
  }

  /** HUD 高亮 / 抖动 + 浮动数字；delta 为增量，state 有则顺带刷新数值。 */
  UI.flash = function (res, delta, state) {
    var item = hudEl(res);
    if (!item) return;
    var v = Math.round(num(delta, 0));
    var cls = v > 0 ? 'flash-up' : (v < 0 ? 'flash-down' : 'flash');
    item.classList.remove('flash-up', 'flash-down', 'flash');
    void item.offsetWidth;                       /* 强制重排以重启动画 */
    item.classList.add(cls);
    if (item.__flashTimer) root.clearTimeout(item.__flashTimer);
    item.__flashTimer = later(FLASH_MS, function () { item.classList.remove('flash-up', 'flash-down', 'flash'); });

    if (v && doc.createElement) {
      var float = doc.createElement('span');
      float.className = 'float-delta ' + (v > 0 ? 'up' : 'down');
      float.setAttribute('aria-hidden', 'true');
      float.textContent = (v > 0 ? '+' : '−') + Math.abs(v);
      item.appendChild(float);
      later(950, function () { if (float.parentNode) float.parentNode.removeChild(float); });
    }
    /* 金币飞入（契约 v3 §5.3）：|Δ| ≥ 10 才飞，位置取自被选门（没有则舞台中心） */
    if (res === 'coins' && Math.abs(v) >= 10) coinFly(v);
    if (state && state[res] != null) setHudValue(item, state[res]);
  };

  /** 瞬时提示（自动消失）。 */
  UI.toast = function (msg) {
    var D = d();
    var el = D.toast;
    if (!el) return;
    el.textContent = str(msg);
    el.hidden = false;
    toggle(el, 'is-show', true);
    if (el.__timer) root.clearTimeout(el.__timer);
    el.__timer = later(TOAST_MS, function () {
      toggle(el, 'is-show', false);
      el.hidden = true;
    });
  };

  /** 舞台横幅（轮次 / 主持人 / 开奖），ms 后自动收起，不阻塞。 */
  UI.banner = function (msg, ms) {
    var D = d();
    var el = D.roundBanner;
    if (!el) return;
    el.textContent = str(msg);
    el.hidden = false;
    toggle(el, 'is-show', true);
    if (el.__timer) root.clearTimeout(el.__timer);
    el.__timer = later(num(ms, BANNER_MS) || BANNER_MS, function () {
      toggle(el, 'is-show', false);
      el.hidden = true;
    });
  };

  /** 便捷口：直接写 #stage-hint。 */
  UI.hint = function (t) { text(d().stageHint, t); };

  /* ------------------- 契约 v3 表现层：提词器 / 线索摘要 / 开奖光效 / 金币飞 / 结局行 */

  /** 系统是否要求减少动效（装饰动画总开关；拿不到 matchMedia 就当「否」）。 */
  function prefersReducedMotion() {
    try {
      return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  /** 量元素在视口中的位置；量不到（垫片 / 未布局）返回 null。 */
  function rectOf(node) {
    if (!node || typeof node.getBoundingClientRect !== 'function') return null;
    try {
      var r = node.getBoundingClientRect();
      if (!r) return null;
      if (!r.width && !r.height && !r.left && !r.top) return null;
      return r;
    } catch (e) { return null; }
  }

  /** 演示提词器（§5.1）：flags.rehearsal 为真时把引擎给的下一步动作写进 #rehearsal-text。 */
  function renderRehearsal(state) {
    var D = d();
    if (!D.rehearsal) return;
    var on = !!(state && state.flags && state.flags.rehearsal);
    D.rehearsal.hidden = !on;
    if (!on) { text(D.rehearsalText, ''); return; }
    var tip = '';
    try {
      if (gameRef && typeof gameRef.hintNextAction === 'function') {
        var h = gameRef.hintNextAction();
        tip = (h && typeof h === 'object') ? str(h.text) : str(h);
      }
    } catch (e) { logErr('hintNextAction', e); tip = ''; }
    text(D.rehearsalText, tip);
  }

  /** 线索摘要（§1.3）：claim → 一行人话。 */
  function claimText(claim) {
    if (!claim || typeof claim !== 'object') return '';
    var t = str(claim.type);
    var slot = Math.round(num(claim.slot, -1));
    var who = slot >= 0 ? (slot + 1) + ' 号门' : '某扇门';
    if (t === 'slot_kind') return who + '里是' + itemView(claim.kind).name;
    /* 「大奖在 3 号门」：与 ui.js 的主持人文案 / game.js 的「换到 3 号门」保持同一空格习惯 */
    if (t === 'big_prize_in') return '大奖在 ' + who;
    if (t === 'picked_kind') return '你选的是' + itemView(claim.kind).name;
    return '';
  }

  /** 旁白面板里的线索摘要行：DOM 由 ui.js 补（index.html 不动），隐藏时不占位。 */
  function ensureClaimLine() {
    var D = d();
    if (!D.narrator || !doc.createElement) return null;
    var el = $('narrator-claim');
    if (!el) {
      el = doc.createElement('span');
      el.setAttribute('id', 'narrator-claim');
      el.className = 'narrator-claim';
      el.setAttribute('aria-hidden', 'true');
      el.hidden = true;
      D.narrator.appendChild(el);
    }
    return el;
  }

  /** 只在「本轮已质疑过」时显示线索摘要。 */
  function renderClaim(state) {
    var el = ensureClaimLine();
    if (!el) return;
    var lc = state && state.lastChallenge;
    var t = (lc && lc.claim) ? claimText(lc.claim) : '';
    el.hidden = !t;
    text(el, t ? ('线索：' + t) : '');
  }

  /** 开奖光效（§5.3）：金晕 / 红闪，≤600ms 自动摘掉；reduced-motion 下不加动画。 */
  function revealGlow(el, outcome) {
    if (!el || !el.classList || !outcome || outcome === 'click') return;
    if (prefersReducedMotion()) return;
    var cls = outcome === 'win' ? 'is-reveal-win' : 'is-reveal-lose';
    el.classList.remove('is-reveal-win', 'is-reveal-lose');
    void el.offsetWidth;                                 /* 强制重排以重启动画 */
    el.classList.add(cls);
    var tag = el;
    later(600, function () { if (tag.classList) tag.classList.remove('is-reveal-win', 'is-reveal-lose'); });
  }

  /**
   * 金币飞入（§5.3）：|delta| ≥ 10 时从被选门（没有则舞台中心）飞向 #hud-coins。
   * 容器 position:fixed + 绝对定位子元素，不参与布局、不产生滚动条；≤400ms 后自清。
   */
  function coinFly(delta) {
    var D = d();
    if (!D.body || !D.hudCoins || !doc.createElement) return;
    if (prefersReducedMotion()) return;                  /* 减少动效：只保留最终数值 */
    var v = Math.round(num(delta, 0));
    if (!v) return;
    var picked = null;
    var doors = D.doors && D.doors.querySelectorAll ? D.doors.querySelectorAll('.door') : null;
    for (var i = 0; doors && i < doors.length; i++) {
      if (doors[i].classList && doors[i].classList.contains('is-picked')) { picked = doors[i]; break; }
    }
    var r0 = rectOf(picked) || rectOf(D.stage) || { left: 0, top: 0, width: 0, height: 0 };
    var r1 = rectOf(D.hudCoins) || { left: r0.left, top: r0.top + 120, width: 0, height: 0 };
    var sx = r0.left + r0.width / 2;
    var sy = r0.top + r0.height / 2;
    var ex = r1.left + r1.width / 2;
    var ey = r1.top + r1.height / 2;
    var layer = doc.createElement('div');
    layer.className = 'coin-fly-layer';
    layer.setAttribute('aria-hidden', 'true');
    var coin = doc.createElement('span');
    coin.className = 'coin-fly' + (v < 0 ? ' is-out' : '');
    coin.setAttribute('aria-hidden', 'true');
    coin.setAttribute('style',
      'left:' + Math.round(sx) + 'px;top:' + Math.round(sy) + 'px;' +
      '--fly-x:' + Math.round(ex - sx) + 'px;--fly-y:' + Math.round(ey - sy) + 'px');
    coin.textContent = (v > 0 ? '+' : '−') + Math.abs(v);
    layer.appendChild(coin);
    D.body.appendChild(layer);
    later(420, function () { if (layer.parentNode) layer.parentNode.removeChild(layer); });
  }

  /**
   * 结算弹层的「结局」行（§4.2）：spec.ending = {id,title,desc}。
   * game.js 的 body 里已经写了「结局：<title>」+ desc，故这里只补一枚标题徽标，
   * 且仅在 body 没提到这个 title 时才补 desc，避免同一句话出现两次。
   */
  function endingRow(spec) {
    var ending = spec && spec.ending;
    if (!ending || typeof ending !== 'object' || !doc.createElement) return null;
    var title = str(ending.title);
    var desc = str(ending.desc);
    if (!title && !desc) return null;
    var inBody = title && typeof spec.body === 'string' && spec.body.indexOf(title) >= 0;
    var row = doc.createElement('div');
    row.className = 'ending-row';
    row.setAttribute('data-ending', str(ending.id));
    row.innerHTML = '<span class="ending-kicker">结局：</span>' +
      '<span class="ending-name">' + esc(title || '——') + '</span>' +
      ((desc && !inBody) ? '<span class="ending-desc">' + esc(desc) + '</span>' : '');
    return row;
  }

  /* ------------------------------------------------- 图标精灵 / HUD 卡片化 */
  /** 把 <symbol> 精灵插进 body 一次；容器 0×0 且 position:absolute，不参与布局。 */
  function ensureIconSprite() {
    if (iconReady) return;
    var D = d();
    if (!D.body || !doc.createElement) return;
    if ($('ui-icons')) { iconReady = true; return; }
    var host = doc.createElement('div');
    host.className = 'ui-icons-host';
    host.setAttribute('aria-hidden', 'true');
    host.innerHTML = spriteMarkup();
    D.body.appendChild(host);
    iconReady = true;
  }

  /** 舞台暗角（契约 §4.2②）：index.html 没有就自建；纯装饰层，pointer-events:none。 */
  function ensureVignette() {
    if (vignetteReady) return;
    var D = d();
    if (!D.body || !doc.createElement) return;
    if ($('vignette')) { vignetteReady = true; return; }
    var v = doc.createElement('div');
    v.setAttribute('id', 'vignette');
    v.className = 'vignette';
    v.setAttribute('aria-hidden', 'true');
    D.body.appendChild(v);
    vignetteReady = true;
  }

  /** 大奖彩带（契约 v4 §4.6 G7，纯装饰）：优先用 index.html 的 #confetti ——
      在里面生成 40 枚 .confetti-piece，≤1.2s 后清空并重新隐藏；
      index.html 还没有这个容器时退回旧的 #stage 内装饰层，保证双路径都能演出。
      prefers-reduced-motion 下直接不生成（动效全停）。不读也不写 state。 */
  function confetti() {
    if (prefersReducedMotion()) return;
    var D = d();
    if (!doc.createElement) return;
    var box = $('confetti');
    var host = null;
    if (box) {
      clear(box);
      box.hidden = false;
      host = box;
    } else if (D.stage && D.stage.appendChild) {
      host = doc.createElement('div');
      host.className = 'confetti-layer';
      host.setAttribute('aria-hidden', 'true');
      D.stage.appendChild(host);
    } else {
      return;
    }
    var piece = box ? 'confetti-piece' : 'confetti';
    var count = box ? 40 : 18;      /* 契约 §4.6 要求 40 枚 */
    for (var i = 0; i < count; i++) {
      var bit = doc.createElement('i');
      bit.className = piece;
      bit.setAttribute('data-tone', String(i % 4));
      bit.setAttribute('style',
        '--dx:' + ((i * 37 % 240) - 120) + 'px;' +
        '--dy:' + (70 + (i * 53 % 140)) + 'px;' +
        '--rot:' + ((i * 71 % 540) - 270) + 'deg;' +
        'animation-delay:' + ((i % 8) * 34) + 'ms');
      host.appendChild(bit);
    }
    later(1200, function () {
      if (box) {
        clear(box);
        box.hidden = true;
      } else if (host.parentNode && host.parentNode.removeChild) {
        host.parentNode.removeChild(host);
      } else if (D.stage && D.stage.removeChild) {
        D.stage.removeChild(host);
      }
    });
  }

  /** 舞台装饰（契约 v4 §4.6 G7）：两侧幕布 .curtain + 顶部聚光灯 .spotlight。
      纯装饰层：position:absolute、pointer-events:none、不参与布局，因此不会产生滚动条；
      index.html 里没有这三个元素，由这里「缺失即自建」（与 #vignette 同一套兜底思路）。 */
  function ensureStageDecor() {
    if (decorReady) return;
    var D = d();
    var stage = D.stage;
    if (!stage || !doc.createElement || !stage.appendChild) return;
    decorReady = true;
    addDecor(stage, 'curtain curtain-l');
    addDecor(stage, 'curtain curtain-r');
    addDecor(stage, 'spotlight');
  }

  /** 往舞台里补一个装饰 div；同 class 已存在就不重复插。 */
  function addDecor(stage, cls) {
    var sel = '.' + cls.split(' ').join('.');
    if (stage.querySelector && stage.querySelector(sel)) return;
    var el = doc.createElement('div');
    el.setAttribute('class', cls);          /* 垫片里 className 直赋值不可靠，统一 setAttribute */
    el.setAttribute('aria-hidden', 'true');
    stage.appendChild(el);
  }

  /** HUD 卡片化（契约 §4.2③）：给三张卡片补一个内联 SVG 图标，只补一次。 */
  function decorateHud(res, el) {
    if (!el || !doc.createElement) return;
    if (el.querySelector && el.querySelector('.hud-icon')) return;
    var span = doc.createElement('span');
    span.className = 'hud-icon';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = iconUse(HUD_ICON[res] || res, 'hud-svg');
    if (el.insertBefore) el.insertBefore(span, el.firstChild);
    else el.appendChild(span);
  }

  /* ------------------------------------------------------------- 背包渲染 */
  /** #bag / #bag-list 缺失时自建（契约 §3.1 的结构逐字一致），不依赖 index.html。 */
  function ensureBag() {
    var D = d();
    if (!D.bag) D.bag = $('bag');
    if (!D.bag && D.body && doc.createElement) {
      var sec = doc.createElement('section');
      sec.setAttribute('id', 'bag');
      sec.className = 'bag';
      sec.setAttribute('aria-label', '背包');
      sec.hidden = true;
      sec.innerHTML = '<div id="bag-title" class="bag-title">背包</div>' +
                      '<div id="bag-list" class="bag-list"></div>' +
                      '<div id="bag-empty" class="bag-empty">背包空空如也</div>';
      D.body.appendChild(sec);
      D.bag = sec;
    }
    if (!D.bagList) D.bagList = $('bag-list');
    if (!D.bagEmpty) D.bagEmpty = $('bag-empty');
    if (!D.bagTitle) D.bagTitle = $('bag-title');
    if (!bagBound) {
      bagBound = true;
      on(D.bagList, 'click', function (e) {
        var btn = closest(e.target, '.bag-slot');
        if (!btn || !D.bagList || !D.bagList.contains(btn)) return;
        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
          sfx('click');
          UI.toast(btn.getAttribute('data-hint') || '现在不能使用道具');
          return;
        }
        sfx('click');
        emit({ type: 'use_item', id: btn.getAttribute('data-item') });
      });
    }
    return D.bag;
  }

  /** state.items → [{id,count,view}]；脏数据就地过滤，绝不写 state。 */
  function bagItems(state) {
    var arr = state && state.items;
    var out = [];
    if (!arr || !arr.length) return out;
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      if (!it) continue;
      var id = str(it.id || it.itemId);
      var c = Math.round(num(it.count, 0));
      if (!id || c <= 0) continue;
      out.push({ id: id, count: c, view: itemView(id) });
    }
    return out;
  }

  function renderBag(state, phase) {
    var D = d();
    var bag = ensureBag();
    if (!bag) return;
    var hide = !!BAG_HIDE_PHASES[phase];
    bag.hidden = hide;
    if (hide) return;

    var list = bagItems(state);
    var usable = phase === 'DECIDE';      /* 契约 §3.4：只有决策阶段能点使用 */
    var sig = phase + '|' + usable + '|';
    for (var i = 0; i < list.length; i++) sig += list[i].id + 'x' + list[i].count + ',';
    if (sig !== bagSig && D.bagList && doc.createElement) {
      bagSig = sig;
      clear(D.bagList);
      for (var j = 0; j < list.length; j++) {
        var it = list[j];
        var hint = usable ? ('使用「' + it.view.name + '」') : '只有决策阶段能使用道具';
        var btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'bag-slot';
        btn.setAttribute('data-item', it.id);
        btn.setAttribute('data-count', String(it.count));
        btn.disabled = !usable;
        btn.setAttribute('aria-disabled', usable ? 'false' : 'true');
        btn.setAttribute('data-hint', hint);
        btn.title = hint;
        btn.setAttribute('aria-label', it.view.name + ' ×' + it.count + (usable ? '，点击使用' : '，决策阶段可用'));
        btn.innerHTML =
          '<span class="bag-icon" aria-hidden="true">' + iconUse(shopIconOf(it.id), 'bag-svg') + '</span>' +
          '<span class="bag-name">' + esc(it.view.name) + '</span>' +
          '<span class="bag-count">×' + it.count + '</span>';
        D.bagList.appendChild(btn);
      }
    }
    if (D.bagEmpty) D.bagEmpty.hidden = list.length > 0;
    toggle(bag, 'is-empty', list.length === 0);
  }

  /* ------------------------------------------------------------- 商店渲染 */
  function shopIconOf(id) { return ITEM_ICON[str(id)] || ''; }

  /** 卡片里的持有量文案（契约 v2 §2.4）：
      cap 是数字 → 「已有 ×1/3」；cap 是 null（不限购）→ 「已买 ×2」，绝不拼出 ×1/null。 */
  function ownedText(owned, cap) {
    if (typeof cap === 'number') return '已有 ×' + owned + '/' + cap;
    return '已买 ×' + owned;
  }

  /** 弹层正文里的说明文字（契约 §3.3 的 spec.body，可能是 HTML）。 */
  function noteNode(body) {
    var el = doc.createElement('span');
    el.className = 'shop-note';
    if (body == null) return el;
    var s = str(body);
    /* 去掉正文里重复的金币数字（金币由 .shop-wallet 实时显示） */
    s = s.replace(/^金币\s*\d+\s*·\s*/, '');
    if (s.indexOf('<') >= 0) el.innerHTML = s;
    else el.textContent = s;
    return el;
  }

  /**
   * 商店弹层（契约 §3.3 / v2 §2.4）：#shop-grid > .shop-card[data-item]。
   * 置灰只看引擎给的 `capped === true`（不再自己算 owned>=cap —— v2 里它还涵盖
   * 「即时商品买满单局上限」「续命符在耐心已到顶时的空操作保护」两种情况）；
   * 买不起看 `affordable === false` → .is-poor。
   * 点购买 → emit({type:'modal_choice', choice:'buy:<id>'}).
   */
  function renderShop(spec) {
    var D = d();
    spec = spec || {};
    if (!D.modalBody || !doc.createElement) return;
    ensureIconSprite();
    if (spec.title != null) text(D.modalTitle, str(spec.title));

    clear(D.modalBody);
    var head = doc.createElement('div');
    head.className = 'shop-head';
    var wallet = doc.createElement('span');
    wallet.className = 'shop-wallet';
    var coins = spec.coins == null ? Math.round(num(liveState().coins, 0)) : Math.round(num(spec.coins, 0));
    wallet.innerHTML = iconUse('coins', 'shop-wallet-svg') + '<b>' + coins + '</b><i>金币</i>';
    head.appendChild(wallet);
    head.appendChild(noteNode(spec.body));
    D.modalBody.appendChild(head);

    var grid = doc.createElement('div');
    grid.setAttribute('id', 'shop-grid');
    grid.className = 'shop-grid';
    var items = (spec.items && spec.items.length) ? spec.items : [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var id = str(it.id);
      var price = Math.round(num(it.price, 0));
      var owned = Math.round(num(it.owned, 0));
      var cap = (it.cap == null) ? null : Math.round(num(it.cap, 0));   // null = 不限购（神秘盒）
      var poor = it.affordable === false;
      var capped = it.capped === true;                                  // 契约 v2：由引擎裁定
      var card = doc.createElement('div');
      card.className = 'shop-card' + (poor ? ' is-poor' : '') + (capped ? ' is-capped' : '') +
                       (it.immediate ? ' is-immediate' : '');
      card.setAttribute('data-item', id);
      if (it.kind != null) card.setAttribute('data-kind', str(it.kind));
      card.setAttribute('role', 'group');
      card.setAttribute('aria-label', str(it.name || id) + '，' + price + ' 金币');
      card.innerHTML =
        '<div class="shop-icon" aria-hidden="true">' + iconUse(str(it.icon) || shopIconOf(id) || 'box', 'shop-svg') + '</div>' +
        '<div class="shop-name">' + esc(it.name || id) + '</div>' +
        '<div class="shop-price">' + iconUse('coins', 'shop-coin') + price + '</div>' +
        '<div class="shop-desc">' + esc(it.desc || '') + '</div>' +
        '<div class="shop-owned">' + esc(ownedText(owned, cap)) + '</div>' +
        '<button type="button" class="shop-buy" data-item="' + esc(id) + '"' +
          (poor || capped ? ' disabled aria-disabled="true"' : '') +
          /* 提示语优先级：capped 优先于 poor —— 已满的卡即使有钱也买不了，
             先说「已达上限」才不会让玩家以为攒够金币就能买到。 */
          ' data-hint="' + esc(capped ? '已达上限，暂时买不了' : (poor ? ('金币不够：需要 ' + price + '，现有 ' + coins) : ('花 ' + price + ' 金币买下'))) + '"' +
          '>' + (capped ? '已满' : '购买') + '</button>';
      grid.appendChild(card);
    }
    D.modalBody.appendChild(grid);
    if (!items.length) {
      var empty = doc.createElement('div');
      empty.className = 'shop-empty';
      empty.textContent = '货架暂时是空的。';
      D.modalBody.appendChild(empty);
    }
  }

  /* --------------------------------------------------------------- 弹层 */
  function setModalBody(body) {
    var el = d().modalBody;
    if (!el) return;
    clear(el);
    if (body == null) return;
    if (typeof body === 'object' && body.nodeType === 1) { el.appendChild(body); return; }
    var s = str(body);
    if (s.indexOf('<') >= 0) el.innerHTML = s;   /* game.js 传 HTML 字符串 */
    else el.textContent = s;                     /* 纯文本（white-space:pre-line 保留换行） */
  }

  /** spec = { kind, title, body: string|Node, actions: [{label, choice, primary?}] } */
  UI.openModal = function (spec) {
    var D = d();
    if (!D.modal) return;
    spec = spec || {};
    modalEpoch++;
    lastFocus = doc.activeElement;
    text(D.modalTitle, str(spec.title));
    setModalBody(spec.body);
    /* 契约 v3 §4.2：结算页的「结局」徽标（body 里已有同句时不重复 desc） */
    var endRow = endingRow(spec);
    if (endRow && D.modalBody && D.modalBody.appendChild) {
      if (D.modalBody.insertBefore && D.modalBody.firstChild) D.modalBody.insertBefore(endRow, D.modalBody.firstChild);
      else D.modalBody.appendChild(endRow);
    }
    /* 契约 v4 §4.3：结算点评行（引擎写入 state.settleLine 时才出现） */
    var sline = settleRow(spec);
    if (sline && D.modalBody && D.modalBody.appendChild) {
      if (D.modalBody.insertBefore && D.modalBody.firstChild) D.modalBody.insertBefore(sline, D.modalBody.firstChild);
      else D.modalBody.appendChild(sline);
    }
    /* 契约 v4：设置弹层（§4.3）、图鉴页成就与统计（§4.4）、种子行（§4.5） */
    var kindV4 = str(spec.kind);
    modalKind = kindV4;
    if (kindV4 === 'settings') renderSettings();
    if (kindV4 === 'codex') renderCodexExtras();
    var srow = seedRow(spec);
    if (srow && D.modalBody && D.modalBody.appendChild) {
      if (D.modalBody.insertBefore && D.modalBody.firstChild) D.modalBody.insertBefore(srow, D.modalBody.firstChild);
      else D.modalBody.appendChild(srow);
    }
    clear(D.modalActions);
    var acts = (spec.actions && spec.actions.length) ? spec.actions : [];
    modalActions = acts.length;
    for (var i = 0; i < acts.length; i++) {
      (function (a) {
        a = a || {};
        var btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'modal-btn' + (a.primary ? ' primary' : '');
        btn.textContent = str(a.label || a.text || a.choice);
        btn.setAttribute('data-choice', str(a.choice));
        if (a.hint) btn.title = str(a.hint);
        on(btn, 'click', function (ev) {
          if (ev.preventDefault) ev.preventDefault();
          activateModalChoice(btn);       /* 与键盘空格共用（G2） */
        });
        D.modalActions.appendChild(btn);
      })(acts[i]);
    }
    var kind = str(spec.kind);
    if (kind === 'shop') renderShop(spec);          /* 契约 §3.3：商店弹层自己渲染 #shop-grid */
    D.modal.className = 'modal kind-' + str(spec.kind || 'info');
    D.modal.hidden = false;
    toggle(D.modal, 'is-open', true);
    toggle(D.body, 'has-modal', true);
    sfx(kind === 'gameover' ? 'lose' : (kind === 'cashout' ? 'win' : (kind === 'shop' ? 'open' : 'click')));
    var first = D.modalActions.querySelector ? D.modalActions.querySelector('button') : null;
    if (first && first.focus) { try { first.focus(); } catch (e) { /* noop */ } }
  };

  UI.closeModal = function () {
    var D = d();
    if (!D.modal) return;
    toggle(D.modal, 'is-open', false);
    D.modal.hidden = true;
    toggle(D.body, 'has-modal', false);
    modalActions = 0;
    modalKind = '';
    var f = lastFocus;
    lastFocus = null;
    if (f && f.focus && f.parentNode) { try { f.focus(); } catch (e) { /* noop */ } }
  };

  /* --------------------------------------------------------------- 动画 */

  function lineText(line) {
    if (line == null) return '';
    if (typeof line === 'string') return line;
    if (typeof line === 'object') return str(line.text || line.line || line.content || line.msg || line.say || '');
    return str(line);
  }

  function truncateLine(t) {
    var s = str(t).replace(/\s+/g, ' ').trim();
    if (s.length > 60) s = s.slice(0, 60) + '…';
    return s;
  }

  /** 旁白逐字播放；返回 Promise<void>。flags.skipAnim 为真时一步到位。 */
  UI.playNarratorLine = function (line, index) {
    var el = d().narratorText;
    var full = truncateLine(lineText(line));

    if (skipAnimOn()) {
      setSpeaking(false);
      if (el) el.textContent = full;
      return Promise.resolve();
    }

    var a = beginAnim('narrator', function () {
      if (el) el.textContent = full;
      setSpeaking(false);
    });
    setSpeaking(true);
    if (!el) { a.finish(); return a.promise; }

    var len = full.length;
    var interval = len ? Math.max(10, Math.round(Math.max(14, Math.min(38, Math.round(1000 / len))) * speedScale())) : 0;
    var typeMs = len * interval;
    var hold = scaled(320);

    (function type(i) {
      if (a.finished) return;
      if (i >= len) { el.textContent = full; return; }
      el.textContent = full.slice(0, i + 1) + '▌';
      a.timers.push(later(interval, function () { type(i + 1); }));
    })(0);

    a.after(typeMs + hold).then(function () { a.finish(); });
    return a.promise;
  };

  /** 主持人打开一扇门（可能是坏门——剧本会故意制造反差）；返回 Promise<void>。无门可开（slot == null）时直接返回。 */
  UI.playHostOpen = function (slot, itemId) {
    var p = (slot && typeof slot === 'object') ? slot : { slot: slot, itemId: itemId };
    if (p.slot == null || num(p.slot, -1) < 0) return Promise.resolve();

    var s = num(p.slot, 0);
    var iv = itemView(p.itemId, p.item);
    var el = doorEl(s);
    var msg = '主持人打开了 ' + (s + 1) + ' 号门：' + iv.name;

    function applyFinal() {
      if (el) {
        el.classList.remove('anim-hold', 'is-opening');
        el.classList.add('is-opened');
        faceDoor(el, { slot: s, itemId: p.itemId, opened: true, revealed: false, peeked: false }, null, s);
        el.__sig = null;
      }
      UI.banner(msg, 1800);
    }

    sfx('open');                         /* 开门轻点：跳过动画时也响（时长 0.16s，不拖节奏） */
    if (skipAnimOn()) { applyFinal(); return Promise.resolve(); }

    var a = beginAnim('hostOpen', applyFinal);
    if (el) el.classList.add('anim-hold', 'is-opening');
    UI.toast(msg);

    a.after(scaled(720)).then(function () {
      if (a.finished) return;
      if (el) { el.classList.remove('is-opening'); el.classList.add('is-opened', 'anim-hold'); }
      faceDoor(el, { slot: s, itemId: p.itemId, opened: true, revealed: false, peeked: false }, null, s);
      UI.banner(msg, 1800);
      a.after(scaled(420)).then(function () {
        if (a.finished) return;
        if (el) el.classList.remove('anim-hold');
        a.finish();
      });
    });
    return a.promise;
  };

  /** 翻门开奖 + 资源反馈；payload { slot, itemId, item, delta, multiplier, events }。 */
  UI.playReveal = function (payload) {
    var p = payload || {};
    var s = num(p.slot, 0);
    var iv = itemView(p.itemId, p.item);
    var mult = Math.max(1, num(p.multiplier, 1) || 1);
    var deltas = normDelta(p.delta);
    var el = doorEl(s);
    var line = '开出「' + iv.name + '」';
    var dt = deltaText(deltas);
    if (dt) line += '：' + dt;
    if (mult > 1) line += '（×' + mult + ' 加倍）';
    var applied = false;

    /* 开奖音效分类：净赚 → 上行两音；被坑（净亏 / 炸弹 / 陷阱）→ 下行音；其余（空门、道具）→ 中性轻点 */
    var netCoins = Math.round(num(deltas.coins, 0));
    var badItem = str(p.itemId) === 'bomb' || str(p.itemId) === 'trap';
    var outcome = netCoins > 0 ? 'win' : ((netCoins < 0 || badItem) ? 'lose' : 'click');

    function applyDeltas() {
      if (applied) return;
      applied = true;
      for (var i = 0; i < RES_ORDER.length; i++) {
        var k = RES_ORDER[i];
        if (Math.round(num(deltas[k], 0)) !== 0) UI.flash(k, deltas[k], null);
      }
    }

    function revealFace() {
      if (!el) return;
      faceDoor(el, { slot: s, itemId: p.itemId, opened: false, revealed: true, peeked: false }, null, s);
    }

    function applyFinal() {
      if (el) {
        el.classList.remove('anim-hold', 'anim-shake', 'anim-flip');
        el.classList.add('is-revealed');
        revealFace();
        el.__sig = null;
      }
      revealGlow(el, outcome);                 /* 契约 v3 §5.3：开奖金晕 / 红闪（≤600ms） */
      sfx(outcome);
      applyDeltas();
      /* 大奖时刻撒彩带（P1 装饰）：进账 ≥100 金币才算「大奖」 */
      if (outcome === 'win' && Math.round(num(deltas.coins, 0)) >= 100) confetti();
      UI.banner(line, mult > 1 ? 2100 : 1700);
      if (dt) UI.toast(line);
    }

    if (skipAnimOn()) { applyFinal(); return Promise.resolve(); }

    var a = beginAnim('reveal', applyFinal);
    if (el) el.classList.add('anim-hold', 'anim-shake');
    UI.banner(line, mult > 1 ? 2100 : 1700);

    /* 加倍时动画略长（清单阶段 3）；再乘以设置里的动画速度系数（0.5×/1×/1.5×） */
    var total = scaled(mult > 1 ? 1300 : 950);
    var t1 = Math.round(total * 0.42);
    var t2 = Math.round(total * 0.75);

    a.after(t1).then(function () {
      if (a.finished) return;
      if (el) {
        el.classList.remove('anim-shake');
        el.classList.add('anim-flip');
        el.classList.add('is-revealed');
      }
      revealFace();
      a.after(t2 - t1).then(function () {
        if (a.finished) return;
        applyDeltas();
        a.after(total - t2).then(function () {
          if (a.finished) return;
          if (el) { el.classList.remove('anim-hold', 'anim-flip'); el.__sig = null; }
          a.finish();
        });
      });
    });
    return a.promise;
  };

  /** 立刻结束所有进行中的动画 Promise（数值结算由 game 照常执行）。 */
  UI.skip = function () { finishAnims(null); };

  /** 便捷：只跳过旁白。 */
  UI.skipNarrator = function () { finishAnims('narrator'); };

  UI.isAnimating = function () { return activeAnims.length > 0; };

  /** 常驻控制的显示 / aria 状态。 */
  UI.setControls = function (state) {
    var D = d();
    var s = state || {};
    var demo = str(s.mode) !== 'normal';
    var flags = s.flags || {};
    var muted = !!flags.muted;
    var skipAnim = !!flags.skipAnim;

    if (D.btnDemo) {
      text(D.btnDemo, demo ? '演示模式' : '普通模式');
      D.btnDemo.setAttribute('aria-pressed', demo ? 'true' : 'false');
      D.btnDemo.title = '当前：' + (demo ? '演示模式（固定剧本）' : '普通模式（随机）') + ' · 点击切换';
      toggle(D.btnDemo, 'is-on', demo);
    }
    /* 商店（契约 §3.1）：只有 DECIDE / SETTLE_ROUND 可点，其余相位结构性禁用 */
    var phase = PHASES[str(s.phase)] ? str(s.phase) : 'IDLE';
    if (D.btnShop) {
      var shopOn = !!SHOP_PHASES[phase];
      D.btnShop.disabled = !shopOn;
      D.btnShop.setAttribute('aria-disabled', shopOn ? 'false' : 'true');
      D.btnShop.title = shopOn
        ? '道具商店：花金币买道具（金币会真的扣掉）'
        : '道具商店：只有决策阶段（或结算时）才能进';
      toggle(D.btnShop, 'is-on', shopOn);
    }
    if (D.btnMute) {
      text(D.btnMute, muted ? '已静音' : '静音');
      D.btnMute.setAttribute('aria-pressed', muted ? 'true' : 'false');
      D.btnMute.title = muted ? '当前已静音 · 点击开启声音' : '当前有声 · 点击静音';
      toggle(D.btnMute, 'is-on', muted);
    }
    applyMuteState(muted);      /* 幂等：上下文已建则同步 suspend/resume，未建则什么都不做 */
    if (D.btnSkip) {
      text(D.btnSkip, skipAnim ? '动画跳过：开' : '跳过动画');
      D.btnSkip.setAttribute('aria-pressed', skipAnim ? 'true' : 'false');
      D.btnSkip.title = skipAnim ? '动画已跳过（数值结算照常）· 引擎暂不支持关闭' : '跳过动画（数值结算照常）';
      toggle(D.btnSkip, 'is-on', skipAnim);
    }
    if (D.btnReset) {
      D.btnReset.title = '重置回演示起点（1 秒内回到初始状态）';
      D.btnReset.disabled = false;
    }
    bgmSync(s);                 /* 契约 v3 §5.2：静音/相位/可见性变化即时反映到 BGM */
    return UI;
  };

  /* --------------------------------------------------------------- 启动自检 */
  UI.version = 'stage4-ui/4.0';
  try { cacheDom(); } catch (e) { logErr('cacheDom', e); }

  root.UI = UI;
})(typeof globalThis !== 'undefined' ? globalThis : this);

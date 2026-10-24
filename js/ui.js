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
    mystery_box: { name: '神秘盒', icon: '❓' }
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
  var lastFocus = null;
  var locks = { pick: false, decide: false };
  var lockTimers = { pick: null, decide: null };
  var last = { phase: 'IDLE', pickedSlot: null, doubled: false, suspicion: 0, peekUsed: false };
  var press = { slot: null, timer: null, fired: false };

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

  /** 音效总线：kind ∈ 'click' | 'open' | 'win' | 'lose'；总时长 ≤0.3s，gain ≤0.045。 */
  function sfx(kind) {
    if (audioMuted()) return;                       /* 静音：不发一个采样 */
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
    dom.btnMute = $('btn-mute');
    dom.btnSkip = $('btn-skip');
    dom.controls = $('controls');
    dom.stage = $('stage');
    dom.roundBanner = $('round-banner');
    dom.doors = $('doors');
    dom.stageHint = $('stage-hint');
    dom.narrator = $('narrator');
    dom.narratorText = $('narrator-text');
    dom.narratorSkip = $('narrator-skip');
    dom.hud = $('hud');
    dom.hudCoins = $('hud-coins');
    dom.hudSuspicion = $('hud-suspicion');
    dom.hudPatience = $('hud-patience');
    dom.decide = $('decide');
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
      '<span class="door-tag">' + esc(tag) + '</span>');
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
        return { on: true, hard: false, hint: '消耗 ' + cost + ' 点怀疑值，戳穿旁白的谎' };
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
      [D.btnMute, 'toggle_mute'],
      [D.btnSkip, 'skip_anim']
    ];
    for (var i = 0; i < ctrl.length; i++) {
      (function (pair) {
        on(pair[0], 'click', function () {
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

    /* --- 弹层：背景点击（仅无按钮的信息弹层）/ ESC / Tab 焦点环 --- */
    on(D.modal, 'click', function (e) { if (e.target === D.modal && modalActions === 0) UI.closeModal(); });
    on(doc, 'keydown', function (e) {
      var key = e.key || '';
      if (key === 'Escape' || e.keyCode === 27) {
        if (D.modal && !D.modal.hidden && modalActions === 0) UI.closeModal();
        return;
      }
      if (key === 'Tab' && D.modal && !D.modal.hidden) {
        var f = D.modal.querySelectorAll('button, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        var first = f[0], lastEl = f[f.length - 1];
        if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); lastEl.focus(); }
        else if (!e.shiftKey && doc.activeElement === lastEl) { e.preventDefault(); first.focus(); }
      }
    });

    /* --- 音频手势解锁：AudioContext 必须在首次用户手势之后创建 --- */
    for (var gi = 0; gi < GESTURE.length; gi++) {
      on(doc, GESTURE[gi], function () { armAudio(); }, { once: true });
    }

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
          sfx('click');
          var before = modalEpoch;
          emit({ type: 'modal_choice', choice: btn.getAttribute('data-choice') });
          /* game 在同一次 action 里换/关了弹层就不再插手；它自己会调 closeModal */
          if (modalEpoch === before && D.modal && !D.modal.hidden) UI.closeModal();
        });
        D.modalActions.appendChild(btn);
      })(acts[i]);
    }
    D.modal.className = 'modal kind-' + str(spec.kind || 'info');
    D.modal.hidden = false;
    toggle(D.modal, 'is-open', true);
    toggle(D.body, 'has-modal', true);
    var kind = str(spec.kind);
    sfx(kind === 'gameover' ? 'lose' : (kind === 'cashout' ? 'win' : 'click'));
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
    var interval = len ? Math.max(14, Math.min(38, Math.round(1000 / len))) : 0;
    var typeMs = len * interval;
    var hold = 320;

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

    a.after(720).then(function () {
      if (a.finished) return;
      if (el) { el.classList.remove('is-opening'); el.classList.add('is-opened', 'anim-hold'); }
      faceDoor(el, { slot: s, itemId: p.itemId, opened: true, revealed: false, peeked: false }, null, s);
      UI.banner(msg, 1800);
      a.after(420).then(function () {
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
      sfx(outcome);
      applyDeltas();
      UI.banner(line, mult > 1 ? 2100 : 1700);
      if (dt) UI.toast(line);
    }

    if (skipAnimOn()) { applyFinal(); return Promise.resolve(); }

    var a = beginAnim('reveal', applyFinal);
    if (el) el.classList.add('anim-hold', 'anim-shake');
    UI.banner(line, mult > 1 ? 2100 : 1700);

    var total = mult > 1 ? 1300 : 950;      /* 加倍时动画略长（清单阶段 3） */
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
    return UI;
  };

  /* --------------------------------------------------------------- 启动自检 */
  UI.version = 'stage1-ui/1.1';
  try { cacheDom(); } catch (e) { logErr('cacheDom', e); }

  root.UI = UI;
})(typeof globalThis !== 'undefined' ? globalThis : this);

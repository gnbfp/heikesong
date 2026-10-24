/* ============================================================================
 * js/game.js —— 阶段 1「状态机主循环」（无 DOM 依赖，可在 Node 里无头跑）
 * ----------------------------------------------------------------------------
 * 冻结约定：
 *   1. 所有状态切换集中在 Game.setState(next) 一个函数里（非法切换只告警不炸）。
 *   2. 金币 / 怀疑值 / 耐心 只由 applyEffect 改动；本文件不直接做加减。
 *   3. 界面渲染只读 Game.state；动画回调里不改数值（结算在动画之前/之后各一次，
 *      由 flags.revealLocked 保证「连续快速点击 50 次不重复开奖」）。
 *   4. 动画走 UI 的 Promise 接口；Node 无头时可注入 deps.ui / deps.setTimeout。
 * 对外：window.Game = { init, start, reset, action, setState, snapshot, subscribe,
 *                       hostPick, generateDoors, autoDemo }
 * ========================================================================== */
(function (root) {
  'use strict';

  var STATES = root.STATES;
  var CHOICES = root.CHOICES;
  var MODES = root.MODES;
  var RNG = root.RNG;
  var cloneState = root.cloneState;
  var clampInt = root.clampInt;
  var createInitialState = root.createInitialState;

  /** 合法状态迁移表（同状态允许，用于 DECIDE 内的加倍/质疑刷新）。 */
  var ALLOWED = {
    IDLE: ['ROUND_INTRO'],
    ROUND_INTRO: ['NARRATOR', 'PICK', 'GAME_OVER', 'CASHOUT'],
    NARRATOR: ['PICK', 'ROUND_INTRO'],
    PICK: ['HOST_OPEN', 'IDLE'],
    HOST_OPEN: ['DECIDE'],
    DECIDE: ['REVEAL', 'CASHOUT', 'GAME_OVER'],
    REVEAL: ['SETTLE_ROUND', 'GAME_OVER', 'CASHOUT'],
    SETTLE_ROUND: ['ROUND_INTRO', 'CASHOUT', 'GAME_OVER', 'IDLE'],
    CASHOUT: ['IDLE', 'ROUND_INTRO'],
    GAME_OVER: ['IDLE', 'ROUND_INTRO']
  };

  /**
   * 轮次风险提示兜底文案（若 GameData.config.roundHints 提供则以配置为准）。
   * 注意：横幅只报风险，不得预告旁白本轮的口径——真假留给你自己判断。
   * 这里必须与 data/config.json 的 roundHints 逐字一致（评审 P0-3）。
   */
  var ROUND_HINTS = {
    1: '第 1 轮：旁白还在热身，先看清台面。',
    2: '第 2 轮：灯光暗了一点，台下有人在看。',
    3: '第 3 轮：气氛不太对，收手也算赢。',
    4: '第 4 轮起：门后可能藏着炸弹，见好就收。'
  };

  /** 用户最后一次的静音选择（默认不静音）。
   *  跨「重置 / 切换模式 / 再来一局」保持：静音是本机偏好，不是本局状态；
   *  但不落盘（不写 CodexStore / localStorage），只在本进程内记忆。 */
  var mutedPref = false;

  /** 契约 v3 §5.1：演示提词器开关（?rehearsal=1 或 #rehearsal），本进程内记忆、跨重置保持。 */
  var rehearsalPref = false;

  /** 读 URL 里的提词器开关；deps.location 可注入（测试用）。 */
  function rehearsalFromUrl(opts, deps) {
    if (opts && opts.rehearsal === true) return true;
    var loc = (deps && deps.location) || root.location || {};
    var q = String(loc.search || '');
    var h = String(loc.hash || '');
    return /(?:[?&])rehearsal=1(?:&|$)/.test(q) || h === '#rehearsal';
  }

  var DEFAULT_TIMINGS = {
    introMs: 800, narratorMs: 2000, hostOpenMs: 600,
    revealMs: 900, revealDoubledExtraMs: 400, resetMs: 1000
  };

  var DEFAULT_RATINGS = [
    { min: 0, max: 99, title: '被旁白 PUA' },
    { min: 100, max: 199, title: '普通赌徒' },
    { min: 200, max: 299, title: '欧皇候选' },
    { min: 300, max: Infinity, title: '反杀旁白' }
  ];

  /* ---------------- 商店兜底表（data/shop.json 未就绪时也能跑；数值同设计契约 §2.2） */

  var DEFAULT_ECONOMY = { switchCost: 15, shopOpenStates: ['DECIDE', 'SETTLE_ROUND'], spentStat: true };

  var SHOP_FALLBACK = [
    { id: 'switch_ticket', name: '换门券', price: 25, cap: 3, kind: 'bag', icon: 'ticket', desc: '换门时自动消耗，省下 15 金币。' },
    { id: 'mute_card', name: '闭嘴卡', price: 20, cap: 2, kind: 'bag', icon: 'mute', desc: '用掉它，本轮旁白闭嘴——但它也听不见你质疑。' },
    { id: 'double_coins', name: '双倍金币', price: 40, cap: 2, kind: 'bag', icon: 'double', desc: '本轮收益与代价一起翻倍。' },
    { id: 'fuse', name: '保险丝', price: 35, cap: 2, kind: 'bag', icon: 'fuse', desc: '本轮第一次负面结算直接归零。' },
    { id: 'mystery_box', name: '神秘盒', price: 15, cap: 3, kind: 'instant', icon: 'box', desc: '当场开，开到什么全看这一局的手气。' },
    { id: 'patience_charm', name: '续命符', price: 60, cap: 2, kind: 'instant', icon: 'charm', desc: '立刻回 1 点耐心，最多攒到 5。' }
  ];

  /* ------------------------------------------------------------ 依赖与工具 */

  function fallbackTimeout(fn) { fn(); return 0; }

  function defaultDeps() {
    return {
      ui: root.UI || null,
      data: root.GameData || null,
      applyEffect: root.applyEffect || null,
      narrator: root.Narrator || null,
      store: root.CodexStore || null,
      setTimeout: (typeof root.setTimeout === 'function') ? root.setTimeout.bind(root) : fallbackTimeout,
      clearTimeout: (typeof root.clearTimeout === 'function') ? root.clearTimeout.bind(root) : function () {},
      now: function () { return Date.now(); }
    };
  }

  /** 无头（Node / 测试）用的空实现 UI：每个动画立刻 resolve。 */
  function noopUI() {
    var done = function () { return Promise.resolve(); };
    return {
      init: function () {}, render: function () {}, flash: function () {},
      toast: function () {}, banner: function () {}, openModal: function () {},
      closeModal: function () {}, skip: function () {}, setControls: function () {},
      playNarratorLine: done, playHostOpen: done, playReveal: done
    };
  }

  function config() { return (Game.deps && Game.deps.data && Game.deps.data.config) || {}; }
  function items() { return (Game.deps && Game.deps.data && Game.deps.data.items) || {}; }
  function timings() {
    var t = config().timings || {};
    var out = {};
    for (var k in DEFAULT_TIMINGS) if (Object.prototype.hasOwnProperty.call(DEFAULT_TIMINGS, k)) out[k] = t[k];
    return out;
  }
  function itemOf(id) { return items()[id] || null; }
  function kindOf(id) {
    var it = itemOf(id);
    if (it && it.kind) return it.kind;
    if (id === 'big_prize' || id === 'small_prize') return 'prize';
    if (id === 'empty') return 'no-prize';
    return 'hazard';
  }
  function isTopPrize(id) { return id === 'big_prize'; }
  function isNoPrize(id) { return kindOf(id) === 'no-prize'; }

  /** 商店表：优先用 GameData.shop，缺数据时退化到兜底表（保证零构建下永不空窗）。 */
  function shopTable() {
    var list = Game.deps && Game.deps.data && Game.deps.data.shop;
    return (Array.isArray(list) && list.length) ? list : SHOP_FALLBACK;
  }
  function shopDef(id) {
    var list = shopTable();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }
  function economy() {
    var e = config().economy;
    return (e && typeof e === 'object') ? e : DEFAULT_ECONOMY;
  }
  /**
   * 单局限购数：数据层用 cap:null + unlimited:true 表示「不限购」（神秘盒）。
   * 返回 Infinity 表示不限购，非法值退化到 3（保险丝表兜底）。
   */
  function shopCap(def) {
    if (!def) return 3;
    if (def.unlimited === true || def.cap == null) return Infinity;
    var c = Number(def.cap);
    return isFinite(c) && c >= 0 ? c : 3;
  }
  /** 是否为「购买即结算」的即时商品（数据层 kind:'instant' 或派生 immediate:true）。 */
  function shopInstant(def) { return !!def && (def.kind === 'instant' || def.immediate === true); }
  /** 续命符的耐心天花板（与单局限购 cap 解耦）：数据层 patienceCap，缺省 5。 */
  function patienceCapOf(def) {
    var c = def && Number(def.patienceCap);
    return isFinite(c) && c > 0 ? c : 5;
  }

  /* -------------------------------------------------------------- Game 本体 */

  var Game = {
    state: null,
    deps: null,
    _emitter: null,
    _timers: [],
    _generation: 0,
    _endingModal: null,   // 结算页弹层 spec，供「看图鉴 → 关闭」后返回

    /** 初始化：解析依赖、建立初始状态、绑定 UI。 */
    init: function (opts) {
      opts = opts || {};
      Game.deps = Object.assign(defaultDeps(), opts.deps || {});
      Game._emitter = new root.Emitter();
      Game._timers = [];
      Game._generation = 0;
      rehearsalPref = rehearsalFromUrl(opts, Game.deps);
      Game.state = Game._freshState(opts.mode || MODES.DEMO, opts.seed);
      var ui = Game._ui();
      if (ui.init) { try { ui.init(Game); } catch (e) { Game._warn('ui.init', e); } }
      Game._render();
      return Game;
    },

    /** 订阅状态变化（UI 也可用，但主要给测试/调试）。 */
    subscribe: function (fn) { return Game._emitter.on(fn); },

    /** 当前状态深拷贝（用于结算页 / 断言 / 复盘）。 */
    snapshot: function () { return cloneState(Game.state); },

    /** 开局（IDLE/结算页 → 第 1 轮）。 */
    start: function (mode) {
      var m = (mode === MODES.NORMAL) ? MODES.NORMAL : MODES.DEMO;
      Game._clearTimers();
      Game._generation++;
      Game.state = Game._freshState(m);
      Game._endingModal = null;
      Game._render();
      Game.beginRound();
      return Game.state;
    },

    /** 一键重置：1 秒内回到演示起点（对应清单阶段 4 P1「全局控制」）。 */
    reset: function () {
      var gen = ++Game._generation;
      Game._clearTimers();
      Game.state = Game._freshState(MODES.DEMO);
      Game._endingModal = null;
      Game._render();
      var self = this;
      var wait = timings().resetMs;
      Game._wait(wait).then(function () {
        if (gen !== Game._generation) return;
        Game.beginRound();
      });
      return Game.state;
    },

    /* ------------------------------------------------------------ 状态切换 */

    /** 唯一的状态切换入口。 */
    setState: function (next) {
      if (!Object.prototype.hasOwnProperty.call(STATES, next)) {
        Game._warn('未知状态', next);
        return false;
      }
      var cur = Game.state.phase;
      if (next !== cur) {
        var allowed = ALLOWED[cur] || [];
        if (allowed.indexOf(next) < 0) {
          Game._warn('非法状态切换 ' + cur + ' -> ' + next);
          return false;
        }
      }
      Game.state.phase = next;
      if (typeof root.document !== 'undefined' && root.document.body) {
        root.document.body.setAttribute('data-state', next);
      }
      Game._render();
      Game._emitter.emit({ type: 'state', from: cur, to: next, state: Game.state });
      return true;
    },

    /* ---------------------------------------------------------- 玩家动作表 */

    /**
     * 统一动作入口：UI 只调 Game.action({type, ...})，不直接改 state。
     * type ∈ start | pick | peek | decide | skip_line | settle | modal_choice |
     *        reset | toggle_demo | toggle_mute | skip_anim | shop | use_item
     */
    action: function (type, payload) {
      if (type && typeof type === 'object') { payload = type; type = payload.type; }
      payload = payload || {};
      var s = Game.state;
      switch (type) {
        case 'start': return Game.start(payload.mode);
        case 'reset': return Game.reset();
        case 'toggle_demo': return Game._toggleMode();
        case 'toggle_mute': return Game._toggleMute();
        case 'skip_anim': return Game._skipAnim();
        case 'skip_line': return Game._skipLine();

        case 'pick':
          if (s.phase !== STATES.PICK) return false;
          return Game.chooseDoor(payload.slot);

        case 'peek':
          if (s.phase !== STATES.PICK) return false;
          return Game.peek(payload.slot);

        case 'decide':
          if (s.phase !== STATES.DECIDE) return false;
          return Game.decide(payload.choice);

        case 'settle':
        case 'modal_choice':
          return Game.modalChoice(payload.choice);

        case 'shop':
          return Game.openShop();

        case 'use_item':
          return Game.useItem(payload.id).ok;

        default:
          Game._warn('未知动作', type);
          return false;
      }
    },

    /* ------------------------------------------------------------ 单轮流程 */

    /** 进入本轮：发牌 → 轮次横幅 → 旁白。 */
    beginRound: function () {
      var s = Game.state;
      s.roundResult = null;
      s.pickedSlot = null;
      s.hostOpenedSlot = null;
      s.doubled = false;
      s.peekUsed = false;
      s.challengedThisRound = false;
      s.hostScriptFallback = false;
      s.narratorLines = [];
      s.lastChallenge = null;
      s.flags.revealLocked = false;
      s.itemBuffs = { fuse: false };   // 道具增益只在「使用的这一轮」有效
      /* 闭嘴卡不在这里重置：它在 DECIDE 里使用，沉默的是**下一轮**的旁白
         （本轮旁白早已念完），由 narrate() 消费后自动清空。 */
      s.doors = Game.generateDoors(s.round);
      Game.setState(STATES.ROUND_INTRO);

      var ui = Game._ui();
      if (ui.banner) Game._safe(function () { ui.banner(Game.roundHint(s.round), timings().introMs); });

      var gen = Game._generation;
      Game._wait(timings().introMs).then(function () {
        if (gen !== Game._generation) return;
        if (Game.state.phase !== STATES.ROUND_INTRO) return;
        Game.narrate();
      });
      return s;
    },

    /** 本轮风险提示。 */
    roundHint: function (round) {
      var hints = config().roundHints;
      if (hints && hints[round]) return hints[round];
      return ROUND_HINTS[round] || ('第 ' + round + ' 轮：旁白已经不装了，自己看着办。');
    },

    /** 旁白阶段：逐句播放 2 句，可点「跳过本句」。 */
    narrate: function () {
      var s = Game.state;
      var narrator = Game.deps.narrator;
      /* 闭嘴卡：本轮旁白一句话都不说（防剧透）；
         代价是这一轮也没有「旁白的话」可供质疑——见 challenge() 里的同一处判定。 */
      if (s.muteCardUsed) {
        s.narratorLines = [];
        s.muteCardUsed = false;        // 一次生效一轮，消费掉
        Game._toast('闭嘴卡生效：这一轮旁白一句话都不说。');
        Game.setState(STATES.PICK);
        return;
      }
      if (!narrator || typeof narrator.pickRoundLines !== 'function') {
        Game.setState(STATES.PICK);
        return;
      }
      s.narratorLines = narrator.pickRoundLines(s, Game.script()) || [];
      Game.setState(STATES.NARRATOR);

      var gen = Game._generation;
      var i = 0;
      var step = function () {
        if (gen !== Game._generation) return;
        if (Game.state.phase !== STATES.NARRATOR) return;
        if (i >= s.narratorLines.length) { Game.setState(STATES.PICK); return; }
        var line = s.narratorLines[i];
        i++;
        Game._unlockLine(line);
        Game._play('playNarratorLine', [line, i - 1]).then(step);
      };
      step();
    },

    /** 点门：进入 HOST_OPEN，由主持人打开一扇「非大奖且非玩家所选」的门。 */
    chooseDoor: function (slot) {
      var s = Game.state;
      if (slot == null || slot < 0 || slot >= s.doors.length) return false;
      if (s.doors[slot].opened) return false;
      s.pickedSlot = slot;
      Game.setState(STATES.HOST_OPEN);

      var script = Game.script();
      var hostSlot = (script && script.hostOpensSlot != null) ? script.hostOpensSlot : null;
      /* 剧本门位是「口味」不是「特权」：它同样必须满足主持人的硬不变量——
         不能是玩家所选的门、不能是大奖门、必须是未开的合法槽位。
         否则 R3 玩家点 1 号门时会出现「主持人打开玩家自己那扇门」的穿帮，
         并被 switchDoor 顺势送一个白拿大奖（评审 P0-1）。不合法就退化为真实 hostPick。 */
      if (hostSlot != null && (hostSlot === slot || !s.doors[hostSlot] || s.doors[hostSlot].opened
        || s.doors[hostSlot].itemId === 'big_prize')) {
        s.hostScriptFallback = true;
        hostSlot = null;
      }
      if (hostSlot == null) hostSlot = Game.hostPick(s.doors, slot);
      s.hostOpenedSlot = hostSlot;
      if (hostSlot != null) s.doors[hostSlot].opened = true;
      Game._render();

      var gen = Game._generation;
      Game._play('playHostOpen', [hostSlot, hostSlot == null ? null : s.doors[hostSlot].itemId])
        .then(function () {
          if (gen !== Game._generation) return;
          if (Game.state.phase !== STATES.HOST_OPEN) return;
          Game.setState(STATES.DECIDE);
        });
      return true;
    },

    /** 长按窥视：每轮一次，给一条模糊提示（不改数值、不影响开奖）。 */
    peek: function (slot) {
      var s = Game.state;
      if (s.peekUsed) { Game._toast('本轮已经窥视过了。'); return false; }
      if (slot == null || !s.doors[slot] || s.doors[slot].opened) return false;
      s.peekUsed = true;
      s.doors[slot].peeked = true;
      var kind = kindOf(s.doors[slot].itemId);
      var text = kind === 'prize' ? '门缝里透出金光……这扇门里有值钱的东西。'
        : kind === 'no-prize' ? '门后一片漆黑，什么都没有。'
          : '门后有东西在响，不像好东西。';
      Game._toast(text);
      Game._render();
      return true;
    },

    /**
     * 决策：stick / switch / cashout 离开 DECIDE；double / challenge 属于原地强化，留在 DECIDE。
     * （《开工清单》阶段 3「加倍后按钮显示已加倍，不可重复叠加」要求加倍后仍能继续选门，
     *   故这两个动作不迁移状态，其余三个严格遵循状态机表格的「选中其一」。）
     */
    decide: function (choice) {
      var s = Game.state;
      switch (choice) {
        case CHOICES.DOUBLE:
          if (s.doubled) { Game._toast('本轮已经加倍过了。'); return false; }
          s.doubled = true;
          s.doublesUsed = (s.doublesUsed || 0) + 1;
          Game._toast('已加倍：本轮收益与负面效果 ×2');
          Game._render();
          return true;

        case CHOICES.CHALLENGE:
          return Game.challenge();

        case CHOICES.SWITCH:
          /* 契约 §2.1：换门失败（既没券、金币也不够）时「不换门，留在 DECIDE」，
             不能被 reveal() 拖着进入开奖。 */
          if (!Game.switchDoor()) return false;
          return Game.reveal();

        case CHOICES.STICK:
          s.switchStreak = 0;
          return Game.reveal();

        case CHOICES.CASHOUT:
          return Game.cashout('decide');

        default:
          Game._warn('未知决策', choice);
          return false;
      }
    },

    /**
     * 换门：在未被主持人打开的门里换到另一扇。
     * 代价（评审：换门此前免费即恒为正收益，券也就成了废纸）：
     *   有换门券 → 消耗 1 张，不花金币；否则要花 economy.switchCost（默认 15）金币；
     *   两者都没有 → 不换门，留在 DECIDE。
     */
    switchDoor: function () {
      var s = Game.state;
      var from = s.pickedSlot;
      var cands = s.doors.filter(function (d) {
        return d.slot !== from && !d.opened && !d.revealed;
      });
      if (!cands.length) return false;
      var cost = Number(economy().switchCost);
      if (!isFinite(cost) || cost < 0) cost = DEFAULT_ECONOMY.switchCost;
      var ticket = Game._itemCount('switch_ticket');
      if (ticket > 0) {
        Game._consumeItem('switch_ticket', 1);
      } else if (s.coins >= cost) {
        Game._apply({ id: 'shop_switch', label: '换门', coins: -cost }, { multiplier: 1, source: 'shop' });
      } else {
        Game._toast('换门需要 ' + cost + ' 金币或一张换门券（现在只有 ' + s.coins + ' 金币）。');
        return false;
      }
      var next = cands[0].slot;
      /* _apply 内部会把 Game.state 换成新对象（clone + 冻结），
         所以这里必须重新取当前 state，否则改写落在旧对象上：钱扣了、横幅说换了门，结算却仍按原门。 */
      var cur = Game.state;
      cur.pickedSlot = next;
      cur.switchStreak = (cur.switchStreak || 0) + 1;
      Game._render();
      Game._toast('换到 ' + (next + 1) + ' 号门' + (ticket > 0 ? '（消耗换门券）' : '（−' + cost + ' 金币）'));
      return true;
    },

    /** 质疑旁白：每轮一次，消耗怀疑值，成功给奖励 / 失败扣金币与耐心；失败让旁白记仇。 */
    challenge: function () {
      var s = Game.state;
      var narrator = Game.deps.narrator;
      var cfg = config().suspicion || {};
      var cost = cfg.cost == null ? 1 : cfg.cost;
      /* 评审 P0-2：质疑原地不迁移状态，且判定固定用本轮第一条旁白（无随机），
         于是同一轮连点就是「每次 +20 且 100% 成功」的送分按钮（演示 R2 实测 130→150→170）。
         限制为每轮一次，并把这次机会算作已用（失败也消耗），让它重新变成资源决策。 */
      if (s.challengedThisRound) {
        Game._toast('同一轮的旁白只会被拆穿一次。');
        return false;
      }
      if (s.muteCardUsed) {
        Game._toast('旁白已经被闭嘴卡按住了，没什么可质疑的。');
        return false;
      }
      if (!narrator || typeof narrator.resolveChallenge !== 'function') {
        Game._toast('旁白不在线，质疑无效。');
        return false;
      }
      if (s.suspicion < cost) {
        Game._toast('怀疑值不足（需要 ' + cost + ' 点）。');
        return false;
      }
      s.challengedThisRound = true;
      var line = s.narratorLines[0] || null;
      var res = narrator.resolveChallenge(s, line) || {};

      /* 契约 v3 §2.1：连击奖励 —— 连续识破给递增金币（20 / 30 / 40 封顶）。 */
      var comboStep = cfg.comboStep == null ? 10 : cfg.comboStep;
      var comboCap = cfg.comboCap == null ? 20 : cfg.comboCap;
      var effect = { id: 'challenge', suspicion: -cost };
      if (res.ok) {
        var streakAfter = (s.challengeStreak || 0) + 1;
        var bonus = Math.min(streakAfter - 1, Math.floor(comboCap / comboStep)) * comboStep;
        var base = res.coins == null ? (cfg.winCoins == null ? 20 : cfg.winCoins) : res.coins;
        effect.coins = base + bonus;
        s.challengeStreak = streakAfter;
        s.challengesWon = (s.challengesWon || 0) + 1;
      } else {
        effect.coins = -(res.coins == null ? (cfg.loseCoins == null ? 20 : cfg.loseCoins) : Math.abs(res.coins));
        effect.patience = res.patience == null ? -(cfg.losePatience == null ? 1 : cfg.losePatience) : -Math.abs(res.patience);
        s.challengeStreak = 0;
        s.challengesLost = (s.challengesLost || 0) + 1;
        s.grudge = (s.grudge || 0) + 1;
      }
      var applied = Game._apply(effect, { source: 'challenge' });
      s = applied.state;
      s.lastChallenge = {
        ok: !!res.ok, text: res.text || '', hint: res.hint || null,
        claim: res.claim || null,             // 契约 v3 §1.3：本轮被验证的线索
        grudgeLevel: s.grudge, delta: applied.delta
      };
      Game._render();
      Game._flashAll(applied.delta);
      Game._toast(res.text || (res.ok ? '你抓住了旁白的破绽。' : '旁白笑了：你猜错了。'));

      if (s.patience <= 0) { Game.gameOver(); return true; }
      var special = narrator.special ? narrator.special(s, 'challenge') : null;
      if (special) Game._playLine(special);
      return true;
    },

    /* -------------------------------------------------------------- 商店 */

    /** 打开商店（仅 DECIDE / SETTLE_ROUND；商店是弹层遮罩，不是状态机状态）。 */
    openShop: function () {
      var s = Game.state;
      var states = economy().shopOpenStates || DEFAULT_ECONOMY.shopOpenStates;
      if (states.indexOf(s.phase) < 0) {
        Game._toast('商店只在决策阶段开门。');
        return false;
      }
      var spec = Game.shopSpec();
      var ui = Game._ui();
      if (ui.openModal) Game._safe(function () { ui.openModal(spec); });
      Game._emitter.emit({ type: 'shop', state: Game.state, spec: spec });
      return true;
    },

    /** 商店弹层 spec（ui 只渲染，不做业务判断）。 */
    shopSpec: function () {
      var s = Game.state;
      var list = shopTable();
      var items = list.map(function (d) {
        var cap = shopCap(d);
        var instant = shopInstant(d);
        var unlimited = (cap === Infinity);
        var owned = instant ? (((s.shopBought || {})[d.id]) || 0) : Game._itemCount(d.id);
        // 续命符：耐心已到天花板时不给买（否则花 60 金币买一次空操作）
        var patienceFull = instant && d.id === 'patience_charm' && s.patience >= patienceCapOf(d);
        return {
          id: d.id, name: d.name, price: d.price, desc: d.desc, icon: d.icon || d.id,
          kind: instant ? 'instant' : 'bag', immediate: instant, unlimited: unlimited,
          owned: owned,
          cap: cap === Infinity ? null : cap,     // null = 不限购（神秘盒）
          affordable: s.coins >= d.price,
          capped: patienceFull || owned >= cap
        };
      });
      return {
        kind: 'shop',
        title: '道具商店',
        body: '金币 ' + s.coins + ' · 花掉的金币不会回来，换来的道具当场生效或进背包。',
        coins: s.coins,
        items: items,
        actions: [{ label: '关闭', choice: 'close' }]
      };
    },

    /**
     * 买一件商品。返回 { ok, reason }；reason ∈ '' | unknown | phase | cap | insufficient。
     * 扣款走 _apply（显式 multiplier:1），避免「加倍」状态下把售价也翻倍。
     */
    buy: function (id) {
      var s = Game.state;
      var def = shopDef(id);
      if (!def) { Game._toast('没有这件商品。'); return { ok: false, reason: 'unknown' }; }
      var states = economy().shopOpenStates || DEFAULT_ECONOMY.shopOpenStates;
      if (states.indexOf(s.phase) < 0) {
        Game._toast('商店只在决策阶段开门。');
        return { ok: false, reason: 'phase' };
      }
      var instant = shopInstant(def);
      var cap = shopCap(def);
      // 背包商品看 items；即时商品（购买即结算、不进背包）看 shopBought 计数，两者都要吃单局限购
      var ownedBought = instant ? (((s.shopBought || {})[id]) || 0) : Game._itemCount(id);
      if (ownedBought >= cap) {
        Game._toast(instant
          ? (def.name + '一局最多买 ' + cap + ' 次。')
          : (def.name + '已经拿满了（最多 ' + cap + ' 个）。'));
        return { ok: false, reason: 'cap' };
      }
      if (instant && id === 'patience_charm' && s.patience >= patienceCapOf(def)) {
        Game._toast('耐心已经满了（最多 ' + patienceCapOf(def) + ' 点），这 ' + def.price + ' 金币先省着。');
        return { ok: false, reason: 'cap' };
      }
      if (s.coins < def.price) {
        Game._toast('金币不够：' + def.name + '要 ' + def.price + '，现在只有 ' + s.coins + '。');
        return { ok: false, reason: 'insufficient' };
      }

      if (instant) {
        /* 即时道具：购买当场结算（同种子可复现；扣款与结算分两步，便于测试与文案拆分）。 */
        var paid = Game._apply({ id: 'shop_buy', label: def.name, coins: -def.price }, { multiplier: 1, source: 'shop' });
        s = paid.state;
        s.spentCoins = (s.spentCoins || 0) + def.price;
        s.shopBuys = (s.shopBuys || 0) + 1;
        s.shopBought = s.shopBought || {};
        s.shopBought[id] = ownedBought + 1;
        if (id === 'patience_charm') {
          Game._apply({ id: 'patience_charm', label: def.name, patience: 1 }, { multiplier: 1, source: 'item' });
          Game._toast('续命符：耐心 +1（现在 ' + Game.state.patience + '）。');
        } else {
          Game._apply(id, { multiplier: 1, source: 'item' });
          Game._toast('神秘盒开出来了，自己看 HUD。');
        }
      } else {
        var applied = Game._apply(
          { id: 'shop_buy', label: def.name, coins: -def.price, items: [{ id: id, count: 1 }] },
          { multiplier: 1, source: 'shop' }
        );
        s = applied.state;
        s.spentCoins = (s.spentCoins || 0) + def.price;
        s.shopBuys = (s.shopBuys || 0) + 1;
        Game._toast('买到 ' + def.name + '（−' + def.price + ' 金币），去背包里用。');
      }
      Game._emitter.emit({ type: 'buy', id: id, price: def.price, state: Game.state });
      Game._render();
      return { ok: true, reason: '' };
    },

    /**
     * 用一件背包道具（仅 DECIDE）。返回 { ok, reason }；reason ∈ '' | empty | phase | noop | unknown。
     * double_coins 复用 decide(DOUBLE) 的既有语义；switch_ticket 只在换门时被动消耗。
     */
    useItem: function (id) {
      var s = Game.state;
      var def = shopDef(id);
      if (!def) return { ok: false, reason: 'unknown' };
      if (Game._itemCount(id) <= 0) return { ok: false, reason: 'empty' };
      if (s.phase !== STATES.DECIDE) return { ok: false, reason: 'phase' };

      if (id === 'switch_ticket') {
        Game._toast('换门券不用点，换门时自动消耗。');
        return { ok: false, reason: 'noop' };
      }
      if (id === 'double_coins') {
        if (s.doubled) { Game._toast('本轮已经加倍了。'); return { ok: false, reason: 'noop' }; }
        Game.decide(CHOICES.DOUBLE);
        Game._consumeItem(id, 1);
        return { ok: true, reason: '' };
      }
      if (id === 'mute_card') {
        s.muteCardUsed = true;
        Game._consumeItem(id, 1);
        Game._toast('闭嘴卡：下一轮旁白闭嘴（这一轮剩下的质疑也一并挡掉）。');
        return { ok: true, reason: '' };
      }
      if (id === 'fuse') {
        s.itemBuffs = s.itemBuffs || {};
        s.itemBuffs.fuse = true;
        Game._consumeItem(id, 1);
        Game._toast('保险丝已接好：本轮第一次负面结算归零。');
        return { ok: true, reason: '' };
      }
      Game._toast('这件道具暂时用不上。');
      return { ok: false, reason: 'noop' };
    },

    /* -------------------------------------------------------------- 开奖 */

    /** 翻门开奖：结算 → 动画 → 本轮结算页。flags.revealLocked 防止重复结算。 */
    reveal: function () {
      var s = Game.state;
      if (s.flags.revealLocked) return false;
      s.flags.revealLocked = true;

      var slot = s.pickedSlot;
      if (slot == null || !s.doors[slot]) { Game._warn('无有效选门'); return false; }
      var itemId = s.doors[slot].itemId;
      var multiplier = s.doubled ? 2 : 1;

      // 状态机只能由 game.js 迁移：内容层（applyEffect）在耐心归零时会顺手写
      // phase='GAME_OVER'，那会让下面的 setState(REVEAL) 被 ALLOWED 拒绝、
      // 动画回调也因 phase!==REVEAL 提前返回 → 结算层永不弹出。这里先把它还原，
      // 死亡判定仍由 settleRound 的 patience<=0 分支负责。
      var prevPhase = s.phase;
      var applied = Game._apply(itemId, { multiplier: multiplier, source: 'reveal' });
      s = applied.state;
      s.phase = prevPhase;
      Game.state = s;
      s.doors[slot].revealed = true;
      Game.setState(STATES.REVEAL);
      Game._flashAll(applied.delta);

      var payload = {
        slot: slot, itemId: itemId, item: itemOf(itemId),
        delta: applied.delta, multiplier: multiplier, events: applied.events
      };
      Game._play('playReveal', [payload]).then(function () {
        if (Game.state.phase !== STATES.REVEAL) return;
        Game.settleRound();
      });
      return true;
    },

    /** 本轮结算：写入 log / 图鉴，判断耐心归零或进入结算展示。 */
    settleRound: function () {
      var s = Game.state;
      var slot = s.pickedSlot;
      var itemId = s.doors[slot] ? s.doors[slot].itemId : null;
      var result = {
        round: s.round,
        pickedSlot: slot,
        hostOpenedSlot: s.hostOpenedSlot,
        itemId: itemId,
        doubled: s.doubled,
        challenged: !!(s.lastChallenge && s.lastChallenge.ok),
        coins: s.coins,
        suspicion: s.suspicion,
        patience: s.patience,
        coinsAfter: s.coins
      };
      s.roundResult = result;
      s.log.push(result);
      if (itemId) Game._unlockItem(itemId);
      // 连续空门彩蛋计数
      s.emptyStreak = (itemId === 'empty') ? (s.emptyStreak || 0) + 1 : 0;

      var narrator = Game.deps.narrator;
      var special = null;
      if (narrator && narrator.special) {
        if (s.switchStreak >= 3) special = narrator.special(s, 'switch3');
        else if (s.challengeStreak >= 2) special = narrator.special(s, 'challenge2');
        else if (s.emptyStreak >= 3) special = narrator.special(s, 'empty3');
      }

      if (s.patience <= 0) { Game.gameOver(); return result; }

      var next = function () {
        if (special) { Game._playLine(special); }
        Game.showRoundModal(result);
        Game.setState(STATES.SETTLE_ROUND);
      };
      if (special) {
        // 彩蛋旁白先播，再进结算展示
        var line = special;
        Game._play('playNarratorLine', [line, 2]).then(function () { next(); });
      } else {
        next();
      }
      return result;
    },

    /** 本轮结算弹层：继续 / 收手（两处都能收手）。 */
    showRoundModal: function (result) {
      var ui = Game._ui();
      var item = itemOf(result.itemId) || {};
      var delta = Game._deltaText(result);
      var body = '<p>你选了 <b>' + (result.pickedSlot + 1) + ' 号门</b>：' +
        (item.name || result.itemId || '什么也没有') + '</p>' +
        '<p>' + delta + '</p>' +
        (result.doubled ? '<p class="muted">已加倍：本轮收益与代价 ×2</p>' : '');
      if (ui.openModal) {
        Game._safe(function () {
          ui.openModal({
            kind: 'round',
            title: '第 ' + result.round + ' 轮结算',
            body: body,
            actions: [
              { label: '继续下一轮', choice: 'continue', primary: true },
              { label: '见好就收', choice: 'cashout' }
            ]
          });
        });
      }
    },

    /** 结算页：最终金币、闯到第几轮、称号、高光一句话。 */
    cashout: function (from) {
      var s = Game.state;
      Game._clearTimers();
      var rating = Game.rating(s);
      s.ending = { from: from || 'decide', coins: s.coins, round: s.round, title: rating.title };
      s.codex.endings = s.codex.endings || [];
      if (s.codex.endings.indexOf(rating.title) < 0) s.codex.endings.push(rating.title);
      Game.setState(STATES.CASHOUT);

      var narrator = Game.deps.narrator;
      var highlight = '';
      if (narrator && typeof narrator.highlight === 'function') {
        highlight = narrator.highlight(s, s.roundResult) || '';
      }
      /* 契约 v3 §4.2：多结局（在称号之外再给一层结局 + 旁白赛后点评）。 */
      s.endingId = Game.computeEndingId(s);
      var ending = Game.endingSpec(s.endingId);
      var endingLine = null;
      if (narrator && typeof narrator.endingLine === 'function') {
        try { endingLine = narrator.endingLine(s, s.endingId); } catch (e) { endingLine = null; }
      }
      if (s.codex.endings.indexOf(ending.title) < 0) s.codex.endings.push(ending.title);
      var body = '<p class="big">最终金币：<b>' + s.coins + '</b></p>' +
        '<p>闯到第 <b>' + s.round + '</b> 轮</p>' +
        '<p>称号：<b>' + rating.title + '</b></p>' +
        '<p>结局：<b>' + ending.title + '</b>' + (ending.desc ? '（' + ending.desc + '）' : '') + '</p>' +
        (endingLine && endingLine.text ? '<p class="muted">旁白：「' + endingLine.text + '」</p>' : '') +
        (s.spentCoins > 0
          ? '<p class="muted">你在商店花了 <b>' + s.spentCoins + '</b> 金币，买了 ' + (s.shopBuys || 0) + ' 件道具。</p>'
          : '') +
        (highlight ? '<p class="muted">' + highlight + '</p>' : '') +
        '<p class="fine">游戏内金币纯属娱乐，非真实货币。</p>';
      Game._saveCodex();
      Game._saveBest();
      var ui = Game._ui();
      Game._endingModal = {
        kind: 'cashout', title: '本局结算', body: body, ending: ending,
        actions: [
          { label: '再来一局', choice: 'restart', primary: true },
          { label: '看图鉴', choice: 'codex' }
        ]
      };
      if (ui.openModal) {
        Game._safe(function () {
          ui.openModal(Game._endingModal);
        });
      }
      Game._emitter.emit({ type: 'cashout', state: Game.state, rating: rating });
      return Game.state;
    },

    /** 耐心归零结算。 */
    gameOver: function () {
      var s = Game.state;
      Game._clearTimers();
      Game.setState(STATES.GAME_OVER);
      /* 契约 v3 §4.2：失败局同样给结局（通常是「被旁白 PUA」或兜底）。 */
      s.endingId = Game.computeEndingId(s);
      var ending = Game.endingSpec(s.endingId);
      if (s.codex.endings.indexOf(ending.title) < 0) s.codex.endings.push(ending.title);
      var body = '<p>耐心归零，旁白赢了这一局。</p>' +
        '<p>你在第 <b>' + s.round + '</b> 轮被劝退，手里还剩 <b>' + s.coins + '</b> 金币。</p>' +
        '<p>结局：<b>' + ending.title + '</b>' + (ending.desc ? '（' + ending.desc + '）' : '') + '</p>' +
        '<p class="fine">游戏内金币纯属娱乐，非真实货币。</p>';
      Game._saveCodex();
      Game._saveBest();
      var ui = Game._ui();
      Game._endingModal = {
        kind: 'gameover', title: '耐心归零', body: body, ending: ending,
        actions: [
          { label: '再来一局', choice: 'restart', primary: true },
          { label: '看图鉴', choice: 'codex' }
        ]
      };
      if (ui.openModal) {
        Game._safe(function () {
          ui.openModal(Game._endingModal);
        });
      }
      return Game.state;
    },

    /** 弹层按钮回调：continue / cashout / restart / codex / clear_codex / close。 */
    modalChoice: function (choice) {
      switch (choice) {
        case 'continue':
          if (Game.state.phase !== STATES.SETTLE_ROUND) return false;
          Game.state.round++;
          Game._closeModal();
          Game.beginRound();
          return true;
        case 'cashout':
          Game._closeModal();
          return Game.cashout('settle');
        case 'restart':
          Game._closeModal();
          Game.start(MODES.DEMO);
          return true;
        case 'codex':
          return Game.showCodex();
        case 'clear_codex':
          Game.clearCodex();
          return Game.showCodex();
        case 'close':
        case 'dismiss':
          Game._closeModal();
          if (Game._endingModal &&
              (Game.state.phase === STATES.CASHOUT || Game.state.phase === STATES.GAME_OVER)) {
            var ui = Game._ui();
            if (ui.openModal) Game._safe(function () { ui.openModal(Game._endingModal); });
          }
          return true;
        default:
          if (typeof choice === 'string' && choice.indexOf('buy:') === 0) {
            var bought = Game.buy(choice.slice(4));
            /* 买成功就重开弹层刷新金币与「已有」；买不起/到上限只 toast，弹层留着。 */
            if (bought.ok) Game.openShop();
            return bought.ok;
          }
          return false;
      }
    },

    /* ------------------------------------------------------------ 纯函数区 */

    /**
     * 发牌（阶段 1 验收：1 大奖 / 1 空门 / 1 小奖；阶段 2 起走权重池）。
     * 不变量：恰好 ≤1 个 big_prize，且至少 1 扇「非大奖」门，保证主持人永远有门可开。
     */
    generateDoors: function (round) {
      var s = Game.state;
      var rng = s.rng;
      var ids;
      var script = Game.script();
      if (script && script.doors && script.doors.length === 3) {
        ids = script.doors.slice();
      } else if (round <= 1) {
        ids = RNG.shuffle(rng, ['big_prize', 'small_prize', 'empty']);
      } else {
        ids = Game._drawPool(round, 3);
      }
      return ids.map(function (id, i) {
        return { slot: i, itemId: id, opened: false, revealed: false };
      });
    },

    /** 从权重池抽 n 个不重复物品，并修正到满足不变量。 */
    _drawPool: function (round, n) {
      var data = Game.deps.data;
      var s = Game.state;
      var picks = [];
      var guard = 0;
      while (picks.length < n && guard++ < 200) {
        var pool = (data && typeof data.poolForRound === 'function')
          ? data.poolForRound(round)
          : Game._fallbackPool(round);
        var usable = pool.filter(function (e) { return picks.indexOf(e.id) < 0; });
        if (!usable.length) break;
        var chosen = RNG.weighted(s.rng, usable, function (e) { return e.weight; });
        var id = chosen && chosen.id ? chosen.id : chosen;
        if (picks.indexOf(id) >= 0) continue;
        if (id === 'big_prize' && picks.indexOf('big_prize') >= 0) continue;
        picks.push(id);
      }
      // 不变量修正：至少一扇非大奖门
      var hasNonTop = picks.some(function (id) { return !isTopPrize(id); });
      if (!hasNonTop) picks[picks.length - 1] = 'empty';
      var hasEmptyish = picks.some(function (id) { return isNoPrize(id); });
      if (!hasEmptyish) {
        // 全是不利门时补一扇空门，避免主持人开不出「空门」
        var idx = picks.findIndex(function (id) { return kindOf(id) === 'hazard'; });
        if (idx < 0) idx = 0;
        picks[idx] = 'empty';
      }
      while (picks.length < n) picks.push('empty');
      return RNG.shuffle(s.rng, picks.slice(0, n));
    },

    _fallbackPool: function (round) {
      return [
        { id: 'big_prize', weight: 8 },
        { id: 'small_prize', weight: 30 },
        { id: 'empty', weight: 25 },
        { id: 'bomb', weight: round >= 4 ? 18 : 0 },
        { id: 'trap', weight: round >= 4 ? 16 : 8 }
      ].filter(function (e) { return e.weight > 0; });
    },

    /**
     * 主持人开门规则（冻结）：
     * 只在「未被玩家选中」的门里挑，且不开出大奖；优先空门，其次其他非大奖门。
     * 因为场上最多一扇大奖，这个集合恒非空 —— 主持人永远有门可开。
     */
    hostPick: function (doors, pickedSlot) {
      var cands = (doors || []).filter(function (d) {
        return d.slot !== pickedSlot && !isTopPrize(d.itemId);
      });
      if (!cands.length) {
        cands = (doors || []).filter(function (d) { return d.slot !== pickedSlot; });
      }
      if (!cands.length) return null;
      var rank = function (d) {
        var k = kindOf(d.itemId);
        if (k === 'no-prize') return 0;
        if (k === 'hazard') return 1;
        return 2;
      };
      var best = cands.slice().sort(function (a, b) { return rank(a) - rank(b); });
      return best[0].slot;
    },

    /* ------------------------------------------- 契约 v3：结局与提词器 */

    /**
     * 契约 v3 §4.2：结局判定（纯函数，qa 直接调）。
     * 按 config.endings[id].priority 从高到低取第一个满足条件的；未配置时用内置优先级。
     */
    computeEndingId: function (state) {
      var s = state || Game.state || {};
      var cfg = config();
      var table = cfg.endings || {};
      var initial = cfg.initial || {};
      var master = cfg.cashoutMaster || {};
      var TIER = { all_in: 100, comeback: 90, iron_patience: 80, master: 70, pua: 60, euro: 50, anti: 40, normal: 0 };
      var coins = s.coins || 0;
      var low = (s.minCoins == null) ? coins : s.minCoins;
      var conds = {
        all_in: (s.challengesWon || 0) >= 3 && (s.challengesLost || 0) === 0,
        comeback: low <= 10 && coins >= 200,
        iron_patience: s.patience != null && initial.patience != null &&
          s.patience === initial.patience && (s.round || 0) >= 3,
        master: (s.round || 0) >= (master.minRound == null ? 4 : master.minRound) &&
          coins >= (master.minCoins == null ? 200 : master.minCoins),
        pua: coins <= 99,
        euro: coins >= 200 && coins <= 299,
        anti: coins >= 300,
        normal: true
      };
      var ids = Object.keys(conds);
      var priorityOf = function (id) {
        var def = table[id];
        if (def && def.priority != null) return def.priority;
        return TIER[id] == null ? 0 : TIER[id];
      };
      ids.sort(function (a, b) { return priorityOf(b) - priorityOf(a); });
      for (var i = 0; i < ids.length; i++) {
        if (conds[ids[i]]) return ids[i];
      }
      return 'normal';
    },

    /** 结局展示文案（数据层未就绪时退回内置表）。 */
    endingSpec: function (id) {
      var table = config().endings || {};
      var def = table[id] || null;
      if (def) return { id: id, title: def.title || id, desc: def.desc || '', lineKind: def.lineKind || null };
      var fallback = {
        all_in: '全识破', comeback: '绝地翻盘', iron_patience: '稳如老狗', master: '见好就收大师',
        pua: '被旁白 PUA', euro: '欧皇候选', anti: '反杀旁白', normal: '普通赌徒'
      };
      return { id: id, title: fallback[id] || id, desc: '', lineKind: null };
    },

    /**
     * 契约 v3 §5.1：演示提词器 —— 告诉操作者「现在该点什么」。
     * 只读状态，不产生副作用；ui.js 在 flags.rehearsal 为真时调用。
     */
    hintNextAction: function () {
      var s = Game.state;
      var out = { phase: (s && s.phase) || '', text: '', choice: null };
      if (!s) return out;
      switch (s.phase) {
        case STATES.IDLE:
          out.text = '点「开始」进入第 1 轮（演示模式按固定剧本走）。';
          break;
        case STATES.ROUND_INTRO:
        case STATES.NARRATOR:
          out.text = '听旁白说完，再点一扇门。';
          break;
        case STATES.PICK:
          out.text = '点任意一扇门——旁白说的真假由你判断。';
          break;
        case STATES.HOST_OPEN:
          out.text = '看主持人开哪扇门，那是这一轮的线索。';
          break;
        case STATES.DECIDE: {
          var tickets = Game._itemCount ? Game._itemCount('switch_ticket') : 0;
          if (s.mode === MODES.DEMO && s.round === 2) {
            out.text = '剧本第 2 轮：先点「质疑旁白」识破它，再决定换不换门。';
            out.choice = 'challenge';
          } else if (tickets > 0) {
            out.text = '你有换门券：这轮换门免费。先质疑，再换门。';
            out.choice = 'switch';
          } else {
            out.text = '选：坚持 / 换门 / 质疑旁白 / 加倍 / 收手。';
          }
          break;
        }
        case STATES.REVEAL:
          out.text = '开奖中……';
          break;
        case STATES.SETTLE_ROUND:
          out.text = '点「继续下一轮」或「见好就收」。';
          break;
        case STATES.CASHOUT:
        case STATES.GAME_OVER:
          out.text = '点「再来一局」重开，或「看图鉴」。';
          break;
        default:
          out.text = '';
      }
      return out;
    },

    /** 评级（阶段 3 P0）：金币档位 + 高轮次收手加成。 */
    rating: function (state) {
      var cfg = config().ratings;
      var bands = Array.isArray(cfg) ? cfg : DEFAULT_RATINGS;
      var master = config().cashoutMaster;
      var coins = state.coins;
      if (master && state.round >= master.minRound && coins >= master.minCoins) {
        return { title: master.title || '见好就收大师', coins: coins, round: state.round };
      }
      if (!master && state.round >= 4 && coins >= 200) {
        return { title: '见好就收大师', coins: coins, round: state.round };
      }
      for (var i = 0; i < bands.length; i++) {
        var b = bands[i];
        // 最高档在 JSON 里是 max:null（Infinity 无法序列化）→ 视为无上限
        var max = (b.max == null) ? Infinity : b.max;
        var min = (b.min == null) ? -Infinity : b.min;
        if (coins >= min && coins <= max) return { title: b.title, coins: coins, round: state.round };
      }
      return { title: '普通赌徒', coins: coins, round: state.round };
    },

    /** demo 模式的固定剧本（阶段 4）：仅 demo 模式且轮次在剧本范围内生效。 */
    script: function () {
      var s = Game.state;
      if (!s || s.mode !== MODES.DEMO) return null;
      var data = Game.deps.data;
      var seq = data && data.seedDemo && data.seedDemo.rounds;
      if (!seq) return null;
      return seq[s.round - 1] || null;
    },

    /**
     * 固定种子演示脚本的确定性走法（给测试与彩排用）。
     * 不依赖固定时长：按状态机相位推进（PICK→选门 / DECIDE→决策 / SETTLE_ROUND→继续）。
     * 第 1 轮：选小奖门 → 坚持；第 2 轮：选大奖门 → 质疑 → 坚持；第 3 轮：选大奖门 → 收手。
     */
    autoDemo: function () {
      var out = { rounds: [], final: null };
      if (!Game.deps.data || !Game.deps.data.seedDemo) return Promise.resolve(out);

      var plan = [
        { pick: 'small_prize', choice: CHOICES.STICK },
        { pick: 'big_prize', challenge: true, choice: CHOICES.STICK },
        { pick: 'big_prize', choice: CHOICES.CASHOUT }
      ];
      Game.start(MODES.DEMO);

      var idx = 0, guard = 0;
      var delay = function (ms) {
        return new Promise(function (resolve) {
          (Game.deps.setTimeout || fallbackTimeout)(resolve, ms);
        });
      };
      var slotOf = function (itemId) {
        var doors = Game.state.doors;
        for (var i = 0; i < doors.length; i++) {
          if (doors[i].itemId === itemId && !doors[i].opened) return i;
        }
        return 0;
      };

      var tick = function () {
        if (guard++ > 5000) { out.error = 'autoDemo 超时（相位未推进）'; return Promise.resolve(out); }
        var s = Game.state;
        if (s.phase === STATES.PICK && idx < plan.length) {
          Game.action({ type: 'pick', slot: slotOf(plan[idx].pick) });
        } else if (s.phase === STATES.DECIDE && idx < plan.length) {
          var step = plan[idx];
          if (step.challenge && !s.lastChallenge) {
            Game.action({ type: 'decide', choice: CHOICES.CHALLENGE });
          } else {
            out.rounds.push(Game.snapshot());
            Game.action({ type: 'decide', choice: step.choice });
            idx++;
            if (step.choice === CHOICES.CASHOUT) {
              out.final = Game.snapshot();
              return Promise.resolve(out);
            }
          }
        } else if (s.phase === STATES.SETTLE_ROUND) {
          Game.action({ type: 'modal_choice', choice: 'continue' });
        } else if (s.phase === STATES.CASHOUT || s.phase === STATES.GAME_OVER) {
          out.final = Game.snapshot();
          return Promise.resolve(out);
        } else if (s.phase === STATES.IDLE) {
          out.final = Game.snapshot();
          return Promise.resolve(out);
        }
        return delay(2).then(tick);
      };
      return delay(0).then(tick);
    },

    /* ------------------------------------------------------------ 内部工具 */

    _freshState: function (mode, seed) {
      var cfg = config();
      var res = cfg.initial || root.DEFAULT_RESOURCES;
      var demo = (mode !== MODES.NORMAL);
      var data = Game.deps.data;
      var seedValue = demo
        ? ((data && data.seedDemo && data.seedDemo.seed) || root.DEMO_SEED)
        : (seed == null ? (Game.deps.now() >>> 0) : seed);
      var st = createInitialState(mode, { seed: seedValue, resources: res, rehearsal: rehearsalPref });
      st.flags.muted = mutedPref;   // 静音跨重置/切换模式保持（见 mutedPref 注释）
      st.joinedAt = Game.deps.now();
      Game._loadCodexInto(st);
      return st;
    },

    _ui: function () {
      if (!Game.deps.ui) Game.deps.ui = noopUI();
      return Game.deps.ui;
    },

    _render: function () {
      var ui = Game._ui();
      Game._safe(function () {
        if (ui.render) ui.render(Game.state);
        if (ui.setControls) ui.setControls(Game.state);
      });
    },

    _flashAll: function (delta) {
      if (!delta) return;
      var ui = Game._ui();
      ['coins', 'suspicion', 'patience'].forEach(function (key) {
        if (!delta[key]) return;
        Game._safe(function () { if (ui.flash) ui.flash(key, delta[key], Game.state); });
      });
    },

    /** 唯一资源结算入口：调用内容层的纯函数 applyEffect。 */
    _apply: function (effect, opts) {
      var fn = Game.deps.applyEffect;
      if (typeof fn !== 'function') {
        // 内容层未就绪时给出可解释的降级结果，而不是崩掉
        return { state: Game.state, delta: { coins: 0, suspicion: 0, patience: 0 }, events: [] };
      }
      var res = fn(Game.state, effect, opts) || {};
      Game.state = res.state || Game.state;
      /* 契约 v3 §4.2：记录本局金币最低点（「绝地翻盘」结局判定）。 */
      if (Game.state.coins != null) {
        Game.state.minCoins = (Game.state.minCoins == null)
          ? Game.state.coins
          : Math.min(Game.state.minCoins, Game.state.coins);
      }
      return Game._fuseGuard(res, opts);
    },

    /**
     * 保险丝（商店道具）：本轮第一次「负面结算」的金币 / 耐心 / 怀疑值损失全部归零，
     * 顺带撤掉耐心归零的死亡标记。只在开奖结算（source==='reveal'）时生效，
     * 买道具被宰不算（那是玩家自己的选择）。
     */
    _fuseGuard: function (res, opts) {
      var s = Game.state;
      if (!s.itemBuffs || !s.itemBuffs.fuse) return res;
      if (!opts || opts.source !== 'reveal') return res;
      var d = res.delta || {};
      var back = {
        coins: d.coins < 0 ? -d.coins : 0,
        patience: d.patience < 0 ? -d.patience : 0,
        suspicion: d.suspicion < 0 ? -d.suspicion : 0
      };
      if (!back.coins && !back.patience && !back.suspicion) return res;

      var fn = Game.deps.applyEffect;
      var fixed = fn(Game.state, {
        id: 'fuse_save', label: '保险丝',
        coins: back.coins, patience: back.patience, suspicion: back.suspicion
      }, { multiplier: 1, source: 'item' }) || {};
      Game.state = fixed.state || Game.state;
      Game.state.itemBuffs.fuse = false;   // 一根保险丝只顶一次
      Game.state.gameOver = false;         // 死亡标记一并撤销（耐心已被补回）
      var merged = fixed;
      merged.delta = { coins: 0, patience: 0, suspicion: 0 };
      merged.events = (res.events || []).concat([{ type: 'fuse_saved', coins: back.coins, patience: back.patience, suspicion: back.suspicion }]);
      return merged;
    },

    _play: function (method, args) {
      var ui = Game._ui();
      if (typeof ui[method] !== 'function') return Promise.resolve();
      try {
        var r = ui[method].apply(ui, args);
        if (r && typeof r.then === 'function') return r;
        return Promise.resolve(r);
      } catch (e) {
        Game._warn(method, e);
        return Promise.resolve();
      }
    },

    _playLine: function (line) {
      /* 契约 v3 §3：播过即解锁（图鉴可达）。 */
      if (line && line.id) Game._unlockLine(line);
      return Game._play('playNarratorLine', [line, 2]);
    },

    _wait: function (ms) {
      var setT = Game.deps.setTimeout || fallbackTimeout;
      return new Promise(function (resolve) {
        var id = setT(function () { resolve(); }, ms);
        if (id !== undefined) Game._timers.push(id);
      });
    },

    _clearTimers: function () {
      var clear = Game.deps && Game.deps.clearTimeout;
      (Game._timers || []).forEach(function (id) { if (clear) Game._safe(function () { clear(id); }); });
      Game._timers = [];
    },

    _toggleMode: function () {
      var next = Game.state.mode === MODES.DEMO ? MODES.NORMAL : MODES.DEMO;
      Game._toast(next === MODES.DEMO ? '已切到演示模式（固定剧本）' : '已切到普通模式（时间种子）');
      return Game.start(next);
    },

    _toggleMute: function () {
      Game.state.flags.muted = !Game.state.flags.muted;
      mutedPref = Game.state.flags.muted;   // 记住选择，重置/切换模式后仍然静音
      Game._render();
      return Game.state.flags.muted;
    },

    _skipAnim: function () {
      Game.state.flags.skipAnim = true;
      Game._render();
      var ui = Game._ui();
      if (ui.skip) Game._safe(function () { ui.skip(); });
      return true;
    },

    _skipLine: function () {
      var ui = Game._ui();
      if (ui.skip) Game._safe(function () { ui.skip(); });
      return true;
    },

    _closeModal: function () {
      var ui = Game._ui();
      if (ui.closeModal) Game._safe(function () { ui.closeModal(); });
    },

    _itemCount: function (id) {
      var list = Game.state.items || [];
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].count || 0;
      return 0;
    },

    _consumeItem: function (id, n) {
      var list = Game.state.items || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id !== id) continue;
        list[i].count = clampInt((list[i].count || 0) - n, 0, 99);
        if (list[i].count <= 0) list.splice(i, 1);
        break;
      }
      Game._render();
    },

    /* ---------------------------------------- 图鉴与本地存档（阶段 5 P1） */

    _store: function () {
      return (Game.deps && Game.deps.store) || null;
    },

    /** 开局时把上一次的图鉴读回 state.codex；无存档/坏存档 → 保持空图鉴。 */
    _loadCodexInto: function (st) {
      var store = Game._store();
      if (!store || !store.loadCodex) return st;
      var saved = null;
      try { saved = store.loadCodex(); } catch (e) { saved = null; }
      if (saved && (saved.items.length || saved.lines.length || saved.endings.length)) {
        st.codex = {
          items: (saved.items || []).slice(),
          lines: (saved.lines || []).slice(),
          endings: (saved.endings || []).slice()
        };
      }
      return st;
    },

    /** 图鉴写入后落盘（失败静默）。 */
    _saveCodex: function () {
      var store = Game._store();
      if (!store || !store.saveCodex) return false;
      try { return !!store.saveCodex(Game.state.codex); } catch (e) { return false; }
    },

    /** 最佳成绩：金币取最大、轮次取最高、称号取并集。 */
    best: function () {
      var store = Game._store();
      var prev = { coins: 0, round: 0, titles: [] };
      if (store && store.loadBest) {
        try { prev = store.loadBest() || prev; } catch (e) { prev = { coins: 0, round: 0, titles: [] }; }
      }
      var s = Game.state || {};
      var titles = (prev.titles || []).slice();
      var rating = Game.rating(s);
      if (rating && rating.title && titles.indexOf(rating.title) < 0) titles.push(rating.title);
      return {
        coins: Math.max(Number(prev.coins) || 0, Number(s.coins) || 0),
        round: Math.max(Number(prev.round) || 0, Number(s.round) || 0),
        titles: titles
      };
    },

    _saveBest: function () {
      var store = Game._store();
      if (!store || !store.saveBest) return false;
      try { return !!store.saveBest(Game.best()); } catch (e) { return false; }
    },

    /** 清空收集进度（图鉴 + 最佳成绩）。 */
    clearCodex: function () {
      var store = Game._store();
      var s = Game.state;
      if (s) s.codex = { items: [], lines: [], endings: [] };
      if (store && store.clearAll) { try { store.clearAll(); } catch (e) { /* 静默 */ } }
      Game._toast('收集进度已清空。');
      Game._render();
      return true;
    },

    _unlockItem: function (id) {
      var codex = Game.state.codex;
      if (codex.items.indexOf(id) < 0) { codex.items.push(id); Game._saveCodex(); }
    },

    _unlockLine: function (line) {
      if (!line || !line.id) return;
      var codex = Game.state.codex;
      if (codex.lines.indexOf(line.id) < 0) { codex.lines.push(line.id); Game._saveCodex(); }
    },

    /** 图鉴弹层：物品 / 语录 / 结局称号 + 最佳成绩 + 清空按钮。 */
    showCodex: function () {
      var s = Game.state;
      var codex = (s && s.codex) || { items: [], lines: [], endings: [] };
      var names = [];
      for (var i = 0; i < codex.items.length; i++) {
        var it = itemOf(codex.items[i]);
        names.push(it && it.name ? it.name : codex.items[i]);
      }
      var best = Game.best();
      var body = '<p>物品图鉴：<b>' + names.length + '</b>' +
        (names.length ? '（' + names.join('、') + '）' : '（还没有）') + '</p>' +
        '<p>语录图鉴：<b>' + codex.lines.length + '</b> 句</p>' +
        '<p>结局称号：<b>' + codex.endings.length + '</b>' +
        (codex.endings.length ? '（' + codex.endings.join('、') + '）' : '（还没有）') + '</p>' +
        '<p class="muted">最佳：金币 ' + best.coins + ' · 最高第 ' + best.round + ' 轮</p>' +
        '<p class="fine">存档仅保存在本机浏览器（three_doors_codex_v1 / three_doors_best_v1），不上传。</p>';
      var ui = Game._ui();
      if (ui.openModal) {
        Game._safe(function () {
          ui.openModal({
            kind: 'codex', title: '图鉴', body: body,
            actions: [
              { label: '清空收集进度', choice: 'clear_codex' },
              { label: '关闭', choice: 'close', primary: true }
            ]
          });
        });
      }
      return codex;
    },

    _deltaText: function (result) {
      if (!result) return '';
      var parts = [];
      var it = itemOf(result.itemId);
      if (it && it.coins) parts.push('金币 ' + (it.coins > 0 ? '+' : '') + it.coins);
      if (it && it.patience) parts.push('耐心 ' + it.patience);
      if (it && it.suspicion) parts.push('怀疑值 ' + it.suspicion);
      return parts.length ? parts.join(' · ') : '没有任何变化';
    },

    _toast: function (msg) {
      var ui = Game._ui();
      if (ui.toast) Game._safe(function () { ui.toast(msg); });
    },

    _safe: function (fn) {
      try { fn(); } catch (e) { Game._warn('ui', e); }
    },

    _warn: function () {
      if (root.console && root.console.warn) {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[三扇门]');
        root.console.warn.apply(root.console, args);
      }
    }
  };

  root.Game = Game;

  /** DOM 就绪后自动启动（Node 无 DOM 时只挂载 API，便于无头测试）。 */
  if (typeof root.document !== 'undefined') {
    var boot = function () {
      if (root.GameBooted) return;
      root.GameBooted = true;
      Game.init({ mode: MODES.DEMO });
    };
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

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

  /** 轮次风险提示兜底文案（若 GameData.config.roundHints 提供则以配置为准）。 */
  var ROUND_HINTS = {
    1: '第 1 轮：旁白今天心情不错，说的多半是实话。',
    2: '第 2 轮：旁白开始不老实了。',
    3: '第 3 轮：旁白已经不想装了。'
  };

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
     *        reset | toggle_demo | toggle_mute | skip_anim
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
      s.narratorLines = [];
      s.lastChallenge = null;
      s.flags.revealLocked = false;
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
      var hostSlot = (script && script.hostOpensSlot != null)
        ? script.hostOpensSlot
        : Game.hostPick(s.doors, slot);
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
          Game.switchDoor();
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

    /** 换门：在未被主持人打开的门里换到另一扇（背包有换门券则消耗，否则同样可换）。 */
    switchDoor: function () {
      var s = Game.state;
      var from = s.pickedSlot;
      var cands = s.doors.filter(function (d) {
        return d.slot !== from && !d.opened && !d.revealed;
      });
      if (!cands.length) return false;
      var next = cands[0].slot;
      var ticket = Game._itemCount('switch_ticket');
      if (ticket > 0) Game._consumeItem('switch_ticket', 1);
      s.pickedSlot = next;
      s.switchStreak = (s.switchStreak || 0) + 1;
      Game._render();
      Game._toast('换到 ' + (next + 1) + ' 号门' + (ticket > 0 ? '（消耗换门券）' : ''));
      return true;
    },

    /** 质疑旁白：消耗怀疑值，成功给奖励 / 失败扣金币与耐心；连续质疑让旁白记仇。 */
    challenge: function () {
      var s = Game.state;
      var narrator = Game.deps.narrator;
      var cfg = config().suspicion || {};
      var cost = cfg.cost == null ? 1 : cfg.cost;
      if (!narrator || typeof narrator.resolveChallenge !== 'function') {
        Game._toast('旁白不在线，质疑无效。');
        return false;
      }
      if (s.suspicion < cost) {
        Game._toast('怀疑值不足（需要 ' + cost + ' 点）。');
        return false;
      }
      var line = s.narratorLines[0] || null;
      var res = narrator.resolveChallenge(s, line) || {};

      var effect = { id: 'challenge', suspicion: -cost };
      if (res.ok) {
        effect.coins = res.coins == null ? (cfg.winCoins == null ? 20 : cfg.winCoins) : res.coins;
        s.challengeStreak = (s.challengeStreak || 0) + 1;
      } else {
        effect.coins = -(res.coins == null ? (cfg.loseCoins == null ? 20 : cfg.loseCoins) : Math.abs(res.coins));
        effect.patience = res.patience == null ? -(cfg.losePatience == null ? 1 : cfg.losePatience) : -Math.abs(res.patience);
        s.challengeStreak = 0;
        s.grudge = (s.grudge || 0) + 1;
      }
      var applied = Game._apply(effect, { source: 'challenge' });
      s = applied.state;
      s.lastChallenge = {
        ok: !!res.ok, text: res.text || '', hint: res.hint || null,
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
      var body = '<p class="big">最终金币：<b>' + s.coins + '</b></p>' +
        '<p>闯到第 <b>' + s.round + '</b> 轮</p>' +
        '<p>称号：<b>' + rating.title + '</b></p>' +
        (highlight ? '<p class="muted">' + highlight + '</p>' : '') +
        '<p class="fine">游戏内金币纯属娱乐，非真实货币。</p>';
      Game._saveCodex();
      Game._saveBest();
      var ui = Game._ui();
      Game._endingModal = {
        kind: 'cashout', title: '本局结算', body: body,
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
      var body = '<p>耐心归零，旁白赢了这一局。</p>' +
        '<p>你在第 <b>' + s.round + '</b> 轮被劝退，手里还剩 <b>' + s.coins + '</b> 金币。</p>' +
        '<p class="fine">游戏内金币纯属娱乐，非真实货币。</p>';
      Game._saveCodex();
      Game._saveBest();
      var ui = Game._ui();
      Game._endingModal = {
        kind: 'gameover', title: '耐心归零', body: body,
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
      var st = createInitialState(mode, { seed: seedValue, resources: res });
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
      return res;
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

/* ============================================================================
 * js/data.js —— 内容层生成产物（《三扇门：别信旁白》阶段 2）
 * 本文件由 tools/build-data.js 生成，勿手改。
 * 数据来源：data/items.json、data/config.json、data/narrator.json、data/seed_demo.json
 * 改数值请改 data/*.json，然后重新执行：node tools/build-data.js
 * 零构建：经典脚本挂 globalThis.GameData，file:// 双击可用，浏览器侧禁止 fetch JSON。
 * ========================================================================== */
(function (root) {
  'use strict';

  var meta = {
    "name": "三扇门：别信旁白（stage2）",
    "stage": "stage2",
    "version": "1.0.0",
    "generatedFrom": [
      "data/items.json",
      "data/config.json",
      "data/narrator.json",
      "data/seed_demo.json"
    ],
    "generator": "tools/build-data.js",
    "demoSeed": 20261024,
    "itemCount": 9,
    "itemAliasCount": 1,
    "narratorCount": 24
  };

  var itemList = [
    {
      "id": "big_prize",
      "name": "大奖",
      "coins": 100,
      "patience": 0,
      "suspicion": 0,
      "weight": 8,
      "minRound": 1,
      "lateWeight": 8,
      "kind": "prize",
      "desc": "金币 +100。全场的呼吸都会停半拍。",
      "icon": "奖"
    },
    {
      "id": "small_prize",
      "name": "小奖",
      "coins": 30,
      "patience": 0,
      "suspicion": 0,
      "weight": 22,
      "minRound": 1,
      "lateWeight": 22,
      "kind": "prize",
      "desc": "金币 +30。小甜头，容易让人上头。",
      "icon": "小"
    },
    {
      "id": "empty",
      "name": "空门",
      "coins": 0,
      "patience": 0,
      "suspicion": 0,
      "weight": 20,
      "minRound": 1,
      "lateWeight": 20,
      "kind": "no-prize",
      "desc": "什么都没有。连回声都懒得给你。",
      "icon": "空"
    },
    {
      "id": "bomb",
      "name": "炸弹",
      "coins": -50,
      "patience": -1,
      "suspicion": 0,
      "weight": 10,
      "minRound": 2,
      "lateWeight": 22,
      "kind": "hazard",
      "desc": "金币 −50、耐心 −1。第 1 轮不会出现，第 4 轮起明显变多。",
      "icon": "弹"
    },
    {
      "id": "trap",
      "name": "陷阱",
      "coins": -30,
      "patience": 0,
      "suspicion": -1,
      "weight": 12,
      "minRound": 1,
      "lateWeight": 24,
      "kind": "hazard",
      "desc": "金币 −30、怀疑值 −1。踩了还没处说理。",
      "icon": "阱"
    },
    {
      "id": "switch_ticket",
      "name": "换门券",
      "coins": 0,
      "patience": 0,
      "suspicion": 0,
      "weight": 8,
      "minRound": 1,
      "lateWeight": 8,
      "kind": "item",
      "desc": "背包 +1。换门不花资源，随时后悔。",
      "icon": "券",
      "special": "gain_item"
    },
    {
      "id": "mute_card",
      "name": "闭嘴卡",
      "coins": 0,
      "patience": 0,
      "suspicion": 0,
      "weight": 7,
      "minRound": 1,
      "lateWeight": 7,
      "kind": "item",
      "desc": "背包 +1。本轮跳过旁白，图个清静。",
      "icon": "闭",
      "special": "gain_item"
    },
    {
      "id": "double_coins",
      "name": "双倍金币",
      "coins": 0,
      "patience": 0,
      "suspicion": 0,
      "weight": 6,
      "minRound": 1,
      "lateWeight": 6,
      "kind": "item",
      "desc": "本轮收益与负面效果全部 ×2（本轮内有效）。",
      "icon": "双",
      "special": "double"
    },
    {
      "id": "mystery_box",
      "name": "神秘盒",
      "coins": 0,
      "patience": 0,
      "suspicion": 0,
      "weight": 7,
      "minRound": 1,
      "lateWeight": 7,
      "kind": "item",
      "desc": "随机小奖或小陷阱，开了才知道（同种子可复现）。",
      "icon": "盒",
      "special": "mystery"
    }
  ];

  var items = {};
  for (var i = 0; i < itemList.length; i++) items[itemList[i].id] = itemList[i];
  /* 兼容别名：与主条目共享同一份对象（不占物品名额、不进 itemList）。 */
  var itemAliases = {
  "shutup_card": "mute_card"
};
  for (var alias = null, aliasKeys = Object.keys(itemAliases), ai = 0; ai < aliasKeys.length; ai++) {
    alias = aliasKeys[ai];
    if (!items[alias] && items[itemAliases[alias]]) items[alias] = items[itemAliases[alias]];
  }

  var config = {
    "title": "三扇门：别信旁白",
    "stage": "stage2",
    "version": "1.0.0",
    "initial": {
      "coins": 100,
      "suspicion": 2,
      "patience": 3
    },
    "suspicion": {
      "cost": 1,
      "winCoins": 20,
      "loseCoins": 20,
      "losePatience": 1,
      "grudgeLieBonus": 0.2,
      "rewardMode": "coins",
      "maxGrudge": 3
    },
    "lies": {
      "base": 0.35,
      "cap": 0.95,
      "hardLineGrudge": 2,
      "linesPerRound": 2,
      "maxChars": 28
    },
    "pool": {
      "boostRound": 4,
      "noBombRounds": [
        1
      ]
    },
    "mystery": {
      "outcomes": [
        {
          "id": "small_prize",
          "label": "小奖",
          "weight": 60
        },
        {
          "label": "小陷阱",
          "coins": -15,
          "weight": 40
        }
      ]
    },
    "roundHints": {
      "1": "第 1 轮：旁白说真话，也没安好心。",
      "2": "第 2 轮：他开始撒谎了，怀疑值别攒着。",
      "3": "第 3 轮：骗子加重了语气，收手也算赢。",
      "4": "第 4 轮起：门后开始有炸弹，见好就收。"
    },
    "cashoutMaster": {
      "minRound": 4,
      "minCoins": 200,
      "title": "见好就收大师",
      "desc": "该走就走，这是赌桌上最贵的一课。"
    },
    "ratings": [
      {
        "id": "pua",
        "min": 0,
        "max": 99,
        "title": "被旁白 PUA",
        "desc": "金币没守住，旁白在你耳边笑了很久。"
      },
      {
        "id": "gambler",
        "min": 100,
        "max": 199,
        "title": "普通赌徒",
        "desc": "不赚不亏地活了下来，也算一种本事。"
      },
      {
        "id": "lucky",
        "min": 200,
        "max": 299,
        "title": "欧皇候选",
        "desc": "手气好到旁白开始改台词。"
      },
      {
        "id": "counter",
        "min": 300,
        "max": null,
        "title": "反杀旁白",
        "desc": "你把旁白的谎话全换成了金币。"
      }
    ],
    "ratingsTiers": [
      {
        "id": "pua",
        "min": 0,
        "max": 99,
        "title": "被旁白 PUA"
      },
      {
        "id": "gambler",
        "min": 100,
        "max": 199,
        "title": "普通赌徒"
      },
      {
        "id": "lucky",
        "min": 200,
        "max": 299,
        "title": "欧皇候选"
      },
      {
        "id": "counter",
        "min": 300,
        "max": null,
        "title": "反杀旁白"
      }
    ],
    "specials": [
      {
        "trigger": "switch3",
        "field": "switchStreak",
        "need": 3,
        "label": "连续 3 次换门"
      },
      {
        "trigger": "challenge2",
        "field": "challengeStreak",
        "need": 2,
        "label": "连续 2 次质疑成功"
      },
      {
        "trigger": "empty3",
        "field": "emptyStreak",
        "need": 3,
        "label": "连续 3 次空门"
      },
      {
        "trigger": "challenge",
        "field": "challengeStreak",
        "need": 0,
        "label": "单次质疑后"
      }
    ],
    "timings": {
      "introMs": 800,
      "narratorMs": 2000,
      "hostOpenMs": 600,
      "revealMs": 900,
      "revealDoubledExtraMs": 400,
      "resetMs": 1000
    }
  };

  var narrator = {
    "source": "《三扇门：别信旁白》开工清单 · 阶段 2/4 旁白语料（每句 ≤28 字）",
    "pairs": {
      "truth": [
        [
          "t01",
          "t02"
        ],
        [
          "t03",
          "t04"
        ]
      ],
      "lie": [
        [
          "l01",
          "l02"
        ],
        [
          "l03",
          "l04"
        ]
      ],
      "lie_hard": [
        [
          "h01",
          "l01"
        ],
        [
          "h03",
          "l03"
        ]
      ]
    },
    "lines": [
      {
        "id": "t01",
        "text": "这次是真的，我发誓。",
        "kind": "truth",
        "truthful": true
      },
      {
        "id": "t02",
        "text": "门不会骗人，只有我会。",
        "kind": "truth",
        "truthful": true
      },
      {
        "id": "t03",
        "text": "随便选，今晚运气站你这边。",
        "kind": "truth",
        "truthful": true
      },
      {
        "id": "t04",
        "text": "别犹豫，奖品没长腿。",
        "kind": "truth",
        "truthful": true
      },
      {
        "id": "l01",
        "text": "你听，警报响了，快撤。",
        "kind": "lie",
        "truthful": false
      },
      {
        "id": "l02",
        "text": "大奖早就被人拿走了。",
        "kind": "lie",
        "truthful": false
      },
      {
        "id": "l03",
        "text": "这一扇，我看过了，空的。",
        "kind": "lie",
        "truthful": false
      },
      {
        "id": "l04",
        "text": "门后那点东西，不值一提。",
        "kind": "lie",
        "truthful": false
      },
      {
        "id": "h01",
        "text": "我以旁白的名誉担保，选它。",
        "kind": "lie_hard",
        "truthful": false
      },
      {
        "id": "h02",
        "text": "不信我？那你把金币都押上。",
        "kind": "lie_hard",
        "truthful": false
      },
      {
        "id": "h03",
        "text": "骗你对我有什么好处呢？",
        "kind": "lie_hard",
        "truthful": false
      },
      {
        "id": "h04",
        "text": "这次我连谎都懒得编了。",
        "kind": "lie_hard",
        "truthful": false
      },
      {
        "id": "cw01",
        "text": "……算你赢。",
        "kind": "challenge_win",
        "truthful": true
      },
      {
        "id": "cw02",
        "text": "你怎么知道我在撒谎？",
        "kind": "challenge_win",
        "truthful": true
      },
      {
        "id": "cw03",
        "text": "好吧，这次是真的，别得意。",
        "kind": "challenge_win",
        "truthful": true
      },
      {
        "id": "cf01",
        "text": "我说的是真的，你偏不信。",
        "kind": "challenge_fail",
        "truthful": true
      },
      {
        "id": "cf02",
        "text": "怀疑是要付代价的。",
        "kind": "challenge_fail",
        "truthful": true
      },
      {
        "id": "cf03",
        "text": "再质疑一次，我就让你闭嘴。",
        "kind": "challenge_fail",
        "truthful": true
      },
      {
        "id": "in01",
        "text": "三扇门，一扇大奖，两扇空。",
        "kind": "intro",
        "truthful": true
      },
      {
        "id": "fl01",
        "text": "灯光很亮，金币很响。",
        "kind": "flavor",
        "truthful": true
      },
      {
        "id": "s01",
        "text": "换门换三次，你以为在洗牌？",
        "kind": "special",
        "truthful": true,
        "trigger": "switch3"
      },
      {
        "id": "s02",
        "text": "你连着抓我两次，够了。",
        "kind": "special",
        "truthful": true,
        "trigger": "challenge2"
      },
      {
        "id": "s03",
        "text": "三个空门，你的手气真稳定。",
        "kind": "special",
        "truthful": true,
        "trigger": "empty3"
      },
      {
        "id": "s04",
        "text": "敢质疑我的人，我都记得。",
        "kind": "special",
        "truthful": true,
        "trigger": "challenge"
      }
    ]
  };

  var seedDemo = {
    "seed": 20261024,
    "rounds": [
      {
        "round": 1,
        "doors": [
          "small_prize",
          "empty",
          "bomb"
        ],
        "hostOpensSlot": 2,
        "narrator": "truth",
        "expect": "small_prize"
      },
      {
        "round": 2,
        "doors": [
          "empty",
          "big_prize",
          "trap"
        ],
        "hostOpensSlot": 0,
        "narrator": "lie",
        "expect": "challenge_win"
      },
      {
        "round": 3,
        "doors": [
          "trap",
          "big_prize",
          "empty"
        ],
        "hostOpensSlot": 0,
        "narrator": "lie_hard",
        "expect": "cashout"
      }
    ]
  };

  /**
   * 第 round 轮的可抽取门池：[{ id, weight }]。
   * - round < item.minRound 的物品不出现；
   * - round 命中 config.pool.noBombRounds（第 1 轮）时排除 bomb；
   * - round >= config.pool.boostRound（第 4 轮）时改用 lateWeight，炸弹/陷阱变多。
   * 返回全新对象，调用方改它不会污染 GameData。
   */
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

  function itemById(id) { return (id && items[id]) || null; }

  /**
   * 结算评级：高轮次收手（config.cashoutMaster）优先，其次按 config.ratings 金币档位。
   * 确定性纯函数，不改任何状态。
   */
  function ratingFor(coins, round, opts) {
    opts = opts || {};
    var cn = Number(coins);
    if (!isFinite(cn)) cn = 0;
    var rd = Math.round(Number(round));
    if (!isFinite(rd) || rd < 1) rd = 1;
    var m = config.cashoutMaster || null;
    if (opts.cashout && m && rd >= (m.minRound || 1) && cn >= (m.minCoins || 0)) {
      return { id: 'cashout', title: m.title, desc: m.desc, by: 'cashout', coins: cn, round: rd };
    }
    var bands = Array.isArray(config.ratings) ? config.ratings : (config.ratingsTiers || []);
    for (var i = 0; i < bands.length; i++) {
      var t = bands[i];
      var min = (t.min == null) ? 0 : t.min;
      var max = (t.max == null) ? Infinity : t.max;
      if (cn >= min && cn <= max) {
        return { id: t.id, title: t.title, desc: t.desc, by: 'coins', coins: cn, round: rd };
      }
    }
    return { id: 'unknown', title: '无名赌徒', desc: '', by: 'fallback', coins: cn, round: rd };
  }

  root.GameData = {
    meta: meta,
    items: items,
    itemList: itemList,
    itemAliases: itemAliases,
    itemById: itemById,
    poolForRound: poolForRound,
    ratingFor: ratingFor,
    config: config,
    narrator: narrator,
    seedDemo: seedDemo
  };

  /* 兼容别名：测试与 ui.js 会按 ITEMS / GAME_DATA 探测内容层。 */
  root.ITEMS = itemList;
  root.GAME_DATA = root.GameData;
})(typeof globalThis !== 'undefined' ? globalThis : this);

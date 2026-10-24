/* ============================================================================
 * js/data.js —— 内容层生成产物（《三扇门：别信旁白》阶段 2）
 * 本文件由 tools/build-data.js 生成，勿手改。
 * 数据来源：data/items.json、data/shop.json、data/personas.json、data/achievements.json、data/config.json、data/narrator.json、data/seed_demo.json
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
      "data/shop.json",
      "data/personas.json",
      "data/achievements.json",
      "data/config.json",
      "data/narrator.json",
      "data/seed_demo.json"
    ],
    "generator": "tools/build-data.js",
    "demoSeed": 20261024,
    "itemCount": 9,
    "itemAliasCount": 1,
    "narratorCount": 72,
    "claimableCount": 13,
    "endingLineCount": 16,
    "endingCount": 8,
    "personaCount": 3,
    "achievementCount": 10,
    "settleCount": 16
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
      "suspicion": 1,
      "weight": 22,
      "minRound": 1,
      "lateWeight": 22,
      "kind": "prize",
      "desc": "金币 +30、怀疑值 +1。甜头也上头。",
      "icon": "小"
    },
    {
      "id": "empty",
      "name": "空门",
      "coins": 0,
      "patience": 0,
      "suspicion": 1,
      "weight": 20,
      "minRound": 1,
      "lateWeight": 20,
      "kind": "no-prize",
      "desc": "空手而归，怀疑值 +1。连回声都没有。",
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
      "maxGrudge": 3,
      "max": 3,
      "comboStep": 10,
      "comboCap": 20
    },
    "economy": {
      "switchCost": 15,
      "shopOpenStates": [
        "DECIDE",
        "SETTLE_ROUND"
      ],
      "spentStat": true
    },
    "personalities": {
      "default": "sarcastic",
      "lieRateDeltaCap": 0.1
    },
    "achievements": {
      "storageKey": "three_doors_achievements_v1"
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
      "1": "第 1 轮：旁白还在热身，先看清台面。",
      "2": "第 2 轮：灯光暗了一点，台下有人在看。",
      "3": "第 3 轮：气氛不太对，收手也算赢。",
      "4": "第 4 轮起：门后可能藏着炸弹，见好就收。"
    },
    "cashoutMaster": {
      "minRound": 4,
      "minCoins": 200,
      "title": "见好就收大师",
      "desc": "该走就走，这是赌桌上最贵的一课。"
    },
    "endings": {
      "all_in": {
        "priority": 100,
        "title": "全识破",
        "desc": "一次质疑都没输过，旁白的谎话被你逐条拆开。",
        "lineKind": "ending_all_in"
      },
      "comeback": {
        "priority": 90,
        "title": "绝地翻盘",
        "desc": "金币见底之后还能翻回两百，今晚的桌子记住你了。",
        "lineKind": "ending_comeback"
      },
      "iron_patience": {
        "priority": 80,
        "title": "稳如老狗",
        "desc": "三轮之后耐心一点没掉，你从不上头。",
        "lineKind": "ending_iron"
      },
      "master": {
        "priority": 70,
        "title": "见好就收大师",
        "desc": "该拿的钱拿到手，该走的时候一步不停。",
        "lineKind": "ending_master"
      },
      "pua": {
        "priority": 60,
        "title": "被旁白 PUA",
        "desc": "旁白说什么你都信，金币替他保管了一晚。",
        "lineKind": "ending_pua"
      },
      "euro": {
        "priority": 50,
        "title": "欧皇候选",
        "desc": "没怎么动脑，手气替你做完了一切。",
        "lineKind": "ending_euro"
      },
      "anti": {
        "priority": 40,
        "title": "反杀旁白",
        "desc": "你把旁白的谎话全换成了金币带走。",
        "lineKind": "ending_anti"
      },
      "normal": {
        "priority": 0,
        "title": "普通赌徒",
        "desc": "不赚不亏地活了下来，也是一种本事。",
        "lineKind": "ending_normal"
      }
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
    "source": "《三扇门：别信旁白》开工清单 · 阶段 2/4 旁白语料 + 设计契约 v3 §1（claim 线索）/§3（语录扩容）/§4.1（endings 赛后点评）",
    "pairs": {
      "truth": [
        [
          "t01",
          "t02"
        ],
        [
          "t03",
          "t04"
        ],
        [
          "t05",
          "t06"
        ],
        [
          "t07",
          "t08"
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
        ],
        [
          "l05",
          "l06"
        ],
        [
          "l07",
          "l08"
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
        ],
        [
          "h05",
          "l05"
        ],
        [
          "h07",
          "h08"
        ]
      ]
    },
    "claimTypes": [
      "slot_kind",
      "big_prize_in",
      "picked_kind"
    ],
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
        "text": "你选的那扇，奖品可没长腿。",
        "kind": "truth",
        "truthful": true,
        "claimable": true,
        "claimType": "picked_kind"
      },
      {
        "id": "t05",
        "text": "1 号门，我看得清清楚楚。",
        "kind": "truth",
        "truthful": true,
        "claimable": true,
        "claimType": "slot_kind"
      },
      {
        "id": "t06",
        "text": "大奖就压在那一扇上，我看见了。",
        "kind": "truth",
        "truthful": true,
        "claimable": true,
        "claimType": "big_prize_in"
      },
      {
        "id": "t07",
        "text": "你选的那扇，我给它打过光。",
        "kind": "truth",
        "truthful": true,
        "claimable": true,
        "claimType": "picked_kind"
      },
      {
        "id": "t08",
        "text": "3 号门，我盯了很久。",
        "kind": "truth",
        "truthful": true,
        "claimable": true,
        "claimType": "slot_kind"
      },
      {
        "id": "t09",
        "text": "我今晚只说实话，你自己掂量。",
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
        "id": "l05",
        "text": "2 号门，我替你确认过了。",
        "kind": "lie",
        "truthful": false,
        "claimable": true,
        "claimType": "slot_kind"
      },
      {
        "id": "l06",
        "text": "1 号门，我劝你别碰。",
        "kind": "lie",
        "truthful": false,
        "claimable": true,
        "claimType": "slot_kind"
      },
      {
        "id": "l07",
        "text": "大奖已经被人换走了，别惦记。",
        "kind": "lie",
        "truthful": false,
        "claimable": true,
        "claimType": "big_prize_in"
      },
      {
        "id": "l08",
        "text": "你选的那扇，我替你看过了。",
        "kind": "lie",
        "truthful": false,
        "claimable": true,
        "claimType": "picked_kind"
      },
      {
        "id": "l09",
        "text": "信我一次，就一次，好吗？",
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
        "id": "h05",
        "text": "3 号门，我已经查过了。",
        "kind": "lie_hard",
        "truthful": false,
        "claimable": true,
        "claimType": "slot_kind"
      },
      {
        "id": "h06",
        "text": "大奖就在你眼前这一扇，快选。",
        "kind": "lie_hard",
        "truthful": false,
        "claimable": true,
        "claimType": "big_prize_in"
      },
      {
        "id": "h07",
        "text": "你手里那扇，我可太熟了。",
        "kind": "lie_hard",
        "truthful": false,
        "claimable": true,
        "claimType": "picked_kind"
      },
      {
        "id": "h08",
        "text": "大奖早被我挪到别的门后了。",
        "kind": "lie_hard",
        "truthful": false,
        "claimable": true,
        "claimType": "big_prize_in"
      },
      {
        "id": "h09",
        "text": "你要是敢质疑我，就等着瞧。",
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
        "id": "cw04",
        "text": "你赢了，我的词穷了。",
        "kind": "challenge_win",
        "truthful": true
      },
      {
        "id": "cw05",
        "text": "行，这一局你的眼睛更亮。",
        "kind": "challenge_win",
        "truthful": true
      },
      {
        "id": "cw06",
        "text": "又被你抓住了，我记下了。",
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
        "id": "cf04",
        "text": "多疑的人，金币留不住。",
        "kind": "challenge_fail",
        "truthful": true
      },
      {
        "id": "cf05",
        "text": "这次是你冤枉我了，付钱吧。",
        "kind": "challenge_fail",
        "truthful": true
      },
      {
        "id": "cf06",
        "text": "看，白花了二十金币。",
        "kind": "challenge_fail",
        "truthful": true
      },
      {
        "id": "in01",
        "text": "三扇门，门后什么都可能。",
        "kind": "intro",
        "truthful": true
      },
      {
        "id": "in02",
        "text": "灯光已就位，请挑一扇。",
        "kind": "intro",
        "truthful": true
      },
      {
        "id": "in03",
        "text": "今晚的规则很简单：别信我。",
        "kind": "intro",
        "truthful": true
      },
      {
        "id": "in04",
        "text": "手别抖，我先开口了。",
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
        "id": "fl02",
        "text": "观众席上一片安静。",
        "kind": "flavor",
        "truthful": true
      },
      {
        "id": "fl03",
        "text": "记分牌在闪，像在催你。",
        "kind": "flavor",
        "truthful": true
      },
      {
        "id": "fl04",
        "text": "空气里有铜锈味。",
        "kind": "flavor",
        "truthful": true
      },
      {
        "id": "fl05",
        "text": "有人在你背后数金币。",
        "kind": "flavor",
        "truthful": true
      },
      {
        "id": "fl06",
        "text": "台下的呼吸声有点吵。",
        "kind": "flavor",
        "truthful": true
      },
      {
        "id": "fl07",
        "text": "地毯上有一道旧划痕。",
        "kind": "flavor",
        "truthful": true
      },
      {
        "id": "fl08",
        "text": "钟摆晃了一下，没人说话。",
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
      },
      {
        "id": "s05",
        "text": "三扇门你都指过了，选不出来？",
        "kind": "special",
        "truthful": true,
        "trigger": "switch3"
      },
      {
        "id": "s06",
        "text": "两次都被你识破，我改词。",
        "kind": "special",
        "truthful": true,
        "trigger": "challenge2"
      },
      {
        "id": "s07",
        "text": "又是空的，你要不要看看手心。",
        "kind": "special",
        "truthful": true,
        "trigger": "empty3"
      },
      {
        "id": "s08",
        "text": "质疑可以，别上瘾。",
        "kind": "special",
        "truthful": true,
        "trigger": "challenge"
      },
      {
        "id": "s09",
        "text": "你越不信我，我越有兴致。",
        "kind": "special",
        "truthful": true,
        "trigger": "challenge"
      },
      {
        "id": "pi_s1",
        "text": "又是你？行，看你今晚能撑几轮。",
        "kind": "intro",
        "truthful": true
      },
      {
        "id": "pi_s2",
        "text": "坐好，别急着把钱送给我。",
        "kind": "intro",
        "truthful": true
      },
      {
        "id": "pf_s1",
        "text": "手别抖，抖了也白抖。",
        "kind": "flavor",
        "truthful": true
      },
      {
        "id": "pf_s2",
        "text": "你猜？我最爱看你猜。",
        "kind": "flavor",
        "truthful": true
      },
      {
        "id": "pi_g1",
        "text": "今晚请放松些，慢慢挑就好。",
        "kind": "intro",
        "truthful": true
      },
      {
        "id": "pi_g2",
        "text": "灯光很软，我陪你一轮一轮来。",
        "kind": "intro",
        "truthful": true
      },
      {
        "id": "pf_g1",
        "text": "别紧张，选你心里那扇就好。",
        "kind": "flavor",
        "truthful": true
      },
      {
        "id": "pf_g2",
        "text": "深呼吸，门不会咬人的。",
        "kind": "flavor",
        "truthful": true
      },
      {
        "id": "pi_c1",
        "text": "来了来了来了！三扇门！开！",
        "kind": "intro",
        "truthful": true
      },
      {
        "id": "pi_c2",
        "text": "嘿嘿，今晚我要说点好听的。",
        "kind": "intro",
        "truthful": true
      },
      {
        "id": "pf_c1",
        "text": "嗨起来！金币在唱歌！",
        "kind": "flavor",
        "truthful": true
      },
      {
        "id": "pf_c2",
        "text": "快选快选，我快憋不住了！",
        "kind": "flavor",
        "truthful": true
      }
    ],
    "endings": {
      "ending_all_in": [
        {
          "id": "e_all_in_1",
          "text": "三问三中，你把我拆穿了。",
          "kind": "ending"
        },
        {
          "id": "e_all_in_2",
          "text": "我今晚一句谎都没能留住。",
          "kind": "ending"
        }
      ],
      "ending_comeback": [
        {
          "id": "e_comeback_1",
          "text": "从十个金币翻回来，你狠。",
          "kind": "ending"
        },
        {
          "id": "e_comeback_2",
          "text": "差点出局的人，最后数钱最多。",
          "kind": "ending"
        }
      ],
      "ending_iron": [
        {
          "id": "e_iron_1",
          "text": "你一次都没慌，我白说了。",
          "kind": "ending"
        },
        {
          "id": "e_iron_2",
          "text": "耐心还在，你赢在不动手。",
          "kind": "ending"
        }
      ],
      "ending_master": [
        {
          "id": "e_master_1",
          "text": "见好就收，这才是老手。",
          "kind": "ending"
        },
        {
          "id": "e_master_2",
          "text": "拿着钱走的人，我拦不住。",
          "kind": "ending"
        }
      ],
      "ending_pua": [
        {
          "id": "e_pua_1",
          "text": "我说什么你都信，谢了。",
          "kind": "ending"
        },
        {
          "id": "e_pua_2",
          "text": "金币归我，教训归你。",
          "kind": "ending"
        }
      ],
      "ending_euro": [
        {
          "id": "e_euro_1",
          "text": "运气站你这边，我认。",
          "kind": "ending"
        },
        {
          "id": "e_euro_2",
          "text": "你什么都没算，就是赢了。",
          "kind": "ending"
        }
      ],
      "ending_anti": [
        {
          "id": "e_anti_1",
          "text": "你把我按在桌上数钱了。",
          "kind": "ending"
        },
        {
          "id": "e_anti_2",
          "text": "今晚的旁白，是你。",
          "kind": "ending"
        }
      ],
      "ending_normal": [
        {
          "id": "e_normal_1",
          "text": "不赚不亏，也是一种活法。",
          "kind": "ending"
        },
        {
          "id": "e_normal_2",
          "text": "牌面平平，人也平平。",
          "kind": "ending"
        }
      ]
    },
    "settle": [
      {
        "id": "st_w1",
        "text": "这一轮，金币自己往你怀里跑。",
        "kind": "settle",
        "result": "win"
      },
      {
        "id": "st_w2",
        "text": "手气不错，我记你一笔。",
        "kind": "settle",
        "result": "win"
      },
      {
        "id": "st_w3",
        "text": "赢面这么大，我都有点酸。",
        "kind": "settle",
        "result": "win"
      },
      {
        "id": "st_w4",
        "text": "钱进了你的兜，台词归我。",
        "kind": "settle",
        "result": "win"
      },
      {
        "id": "st_l1",
        "text": "亏了吧？我早说过别冲动。",
        "kind": "settle",
        "result": "lose"
      },
      {
        "id": "st_l2",
        "text": "金币少了，教训多了一点。",
        "kind": "settle",
        "result": "lose"
      },
      {
        "id": "st_l3",
        "text": "这一把，你替观众交了学费。",
        "kind": "settle",
        "result": "lose"
      },
      {
        "id": "st_l4",
        "text": "别灰心，输的人才有故事。",
        "kind": "settle",
        "result": "lose"
      },
      {
        "id": "st_c1",
        "text": "拿钱走人？这步棋走得狠。",
        "kind": "settle",
        "result": "cashout"
      },
      {
        "id": "st_c2",
        "text": "见好就收，我不拦你。",
        "kind": "settle",
        "result": "cashout"
      },
      {
        "id": "st_c3",
        "text": "你走了，台上就剩我自言自语。",
        "kind": "settle",
        "result": "cashout"
      },
      {
        "id": "st_c4",
        "text": "收手也算赢，记住这句。",
        "kind": "settle",
        "result": "cashout"
      },
      {
        "id": "st_b1",
        "text": "耐心见底，今晚到此为止。",
        "kind": "settle",
        "result": "bust"
      },
      {
        "id": "st_b2",
        "text": "你被我劝退了，别不服气。",
        "kind": "settle",
        "result": "bust"
      },
      {
        "id": "st_b3",
        "text": "人走了，金币留在了桌上。",
        "kind": "settle",
        "result": "bust"
      },
      {
        "id": "st_b4",
        "text": "下次记得：旁白的话别全信。",
        "kind": "settle",
        "result": "bust"
      }
    ],
    "personas": {
      "sarcastic": {
        "intro": [
          "pi_s1",
          "pi_s2",
          "in03"
        ],
        "flavor": [
          "pf_s1",
          "pf_s2",
          "fl01"
        ],
        "settle": [
          "st_w2",
          "st_l1",
          "st_c2",
          "st_b2"
        ]
      },
      "gentle": {
        "intro": [
          "pi_g1",
          "pi_g2",
          "in01"
        ],
        "flavor": [
          "pf_g1",
          "pf_g2",
          "fl05"
        ],
        "settle": [
          "st_w4",
          "st_l4",
          "st_c4",
          "st_b4"
        ]
      },
      "crazy": {
        "intro": [
          "pi_c1",
          "pi_c2",
          "in02"
        ],
        "flavor": [
          "pf_c1",
          "pf_c2",
          "fl02"
        ],
        "settle": [
          "st_w3",
          "st_l3",
          "st_c3",
          "st_b3"
        ]
      }
    }
  };

  /* 旁白人格（契约 v4 §3.1）：lieRateDelta 叠加在撒谎率上，最终仍夹在 [base, cap]。 */
  var personas = [
    {
      "id": "sarcastic",
      "name": "毒舌旁白",
      "icon": "😏",
      "desc": "阴阳怪气，句句带刺。",
      "lieRateDelta": 0
    },
    {
      "id": "gentle",
      "name": "温柔旁白",
      "icon": "🌸",
      "desc": "轻声细语，但也不一定说真话。",
      "lieRateDelta": -0.05
    },
    {
      "id": "crazy",
      "name": "癫狂旁白",
      "icon": "🤪",
      "desc": "神经兮兮，语速都比别人快。",
      "lieRateDelta": 0.05
    }
  ];

  /** 按 id 取人格定义，未知 id 返回 null（引擎 / ui 渲染共用）。 */
  function personasById(id) {
    for (var i = 0; i < personas.length; i++) if (personas[i].id === id) return personas[i];
    return null;
  }

  /* 成就表（契约 v4 §3.2）：恰 10 条，check.type 白名单与阈值由构建期校验。 */
  var achievements = [
    {
      "id": "first_cashout",
      "name": "见好就收",
      "icon": "💰",
      "desc": "第一次主动收手，把钱装进口袋就走。",
      "check": {
        "type": "cashouts",
        "threshold": 1
      }
    },
    {
      "id": "rounds5",
      "name": "五关斩将",
      "icon": "🖐️",
      "desc": "一局活到第 5 轮还没倒下。",
      "check": {
        "type": "rounds",
        "threshold": 5
      }
    },
    {
      "id": "coins300",
      "name": "三百门客",
      "icon": "🪙",
      "desc": "单局金币达到三百，旁白开始紧张。",
      "check": {
        "type": "coins",
        "threshold": 300
      }
    },
    {
      "id": "combo3",
      "name": "三连问",
      "icon": "🔍",
      "desc": "单局连续三次质疑成功，眼睛很毒。",
      "check": {
        "type": "challengeWins",
        "threshold": 3
      }
    },
    {
      "id": "codex24",
      "name": "全知者",
      "icon": "📚",
      "desc": "图鉴里收录了二十四条旁白台词。",
      "check": {
        "type": "codexLines",
        "threshold": 24
      }
    },
    {
      "id": "endings4",
      "name": "剧作人",
      "icon": "🎬",
      "desc": "解锁四个结局，剧本被你翻烂了。",
      "check": {
        "type": "endings",
        "threshold": 4
      }
    },
    {
      "id": "all_in",
      "name": "梭哈",
      "icon": "🎲",
      "desc": "单局用掉三次加倍，胆子不小。",
      "check": {
        "type": "doubles",
        "threshold": 3
      }
    },
    {
      "id": "comeback",
      "name": "绝地反击",
      "icon": "🔥",
      "desc": "金币掉到三十以下还能翻回两百。",
      "check": {
        "type": "comeback",
        "threshold": 200
      }
    },
    {
      "id": "clean_run",
      "name": "火眼金睛",
      "icon": "👁️",
      "desc": "一局里质疑零失误，然后收手走人。",
      "check": {
        "type": "clean",
        "threshold": 1
      }
    },
    {
      "id": "persona3",
      "name": "千人千面",
      "icon": "🎭",
      "desc": "三种旁白人格都体验过一遍。",
      "check": {
        "type": "personas",
        "threshold": 3
      }
    }
  ];

  /** 按 id 取成就定义，未知 id 返回 null（引擎判定 / ui 成就墙共用）。 */
  function achievementsById(id) {
    for (var i = 0; i < achievements.length; i++) if (achievements[i].id === id) return achievements[i];
    return null;
  }

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

  /* 商店商品表（docs/设计契约_商店与美术.md §2.2）：cap=null 表示不限购，
     unlimited / immediate 为派生布尔，价格与单局上限由契约冻结。 */
  var shop = [
    {
      "id": "switch_ticket",
      "name": "换门券",
      "price": 25,
      "cap": 3,
      "kind": "bag",
      "icon": "ticket",
      "desc": "换门时自动顶上，省下 15 金币。",
      "unlimited": false,
      "immediate": false
    },
    {
      "id": "mute_card",
      "name": "闭嘴卡",
      "price": 20,
      "cap": 2,
      "kind": "bag",
      "icon": "mute",
      "desc": "下一轮让它闭嘴：防剧透，不防霉运。",
      "unlimited": false,
      "immediate": false
    },
    {
      "id": "double_coins",
      "name": "双倍金币",
      "price": 40,
      "cap": 2,
      "kind": "bag",
      "icon": "double",
      "desc": "本轮开奖收益翻倍，罚金也翻倍。",
      "unlimited": false,
      "immediate": false
    },
    {
      "id": "fuse",
      "name": "保险丝",
      "price": 35,
      "cap": 2,
      "kind": "bag",
      "icon": "fuse",
      "desc": "接上它，下一次负面结算直接归零。",
      "unlimited": false,
      "immediate": false
    },
    {
      "id": "mystery_box",
      "name": "神秘盒",
      "price": 15,
      "cap": null,
      "kind": "instant",
      "icon": "box",
      "desc": "当场开：小奖或小坑，手气自己扛。",
      "unlimited": true,
      "immediate": true
    },
    {
      "id": "patience_charm",
      "name": "续命符",
      "price": 60,
      "cap": 2,
      "kind": "instant",
      "icon": "charm",
      "desc": "立刻加 1 点耐心，最多到 5。",
      "unlimited": false,
      "immediate": true,
      "patienceCap": 5
    }
  ];

  /** 按 id 取商品定义，未知 id 返回 null（引擎 buy/useItem 与 ui 渲染共用）。 */
  function shopById(id) {
    for (var i = 0; i < shop.length; i++) if (shop[i].id === id) return shop[i];
    return null;
  }

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
    shop: shop,
    shopById: shopById,
    personas: personas,
    personasById: personasById,
    achievements: achievements,
    achievementsById: achievementsById,
    config: config,
    narrator: narrator,
    seedDemo: seedDemo
  };

  /* 兼容别名：测试与 ui.js 会按 ITEMS / GAME_DATA 探测内容层。 */
  root.ITEMS = itemList;
  root.GAME_DATA = root.GameData;
})(typeof globalThis !== 'undefined' ? globalThis : this);

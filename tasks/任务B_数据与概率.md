# 任务 B：数据与概率层（随机事件 + 经济闭环 + 难度曲线）

> 给执行本任务的 AI：你是资深数值/数据层工程师。先读完本文件再动手。产物必须**不破坏现有 12 种牌面、60 条旁白与既有测试**。

---

## 0. 一句话目标

让每一局"不一样"：新增**每轮随机事件层**、把**金币变成有出口的资源**（押注/利息/回收）、并给长局一个**目标与上限**（第 8 轮通关 / 硬核模式）。全部落地在 `data/*.json` + 生成器 + `js/narrator.js`/`js/effects.js`，不改引擎与 UI。

## 1. 仓库与基线

- 仓库：`https://github.com/gnbfp/heikesong`（或本地同结构副本）｜分支 `codex/stage0-1-vertical-slice`
- 基线：
  ```bash
  node tools/build-data.js --check    # exit 0
  node tests/run-all.js               # 514 PASS / 0 FAIL / 9 SKIP，exit 0
  ```

## 2. 数据层现状（只读）

| 文件 | 内容 |
|---|---|
| `data/items.json` | 12 种牌面（big_prize/small_prize/empty/bomb/trap + 7 特殊），字段 `coins/patience/suspicion/weight/minRound/lateWeight/kind/desc/icon` |
| `data/config.json` | 初始资源 100/2/3、质疑、撒谎率、`doorCount.weights`、`rating`、`timings`、`cashoutMaster` |
| `data/shop.json` | 6 件商品（price/cap/kind/desc） |
| `data/narrator.json` | 60 条旁白（truth/lie/lie_hard/challenge_win/challenge_fail/intro/flavor/special） |
| `data/seed_demo.json` | 演示剧本（guarantee 物品 + 规则说明） |
| `tools/build-data.js` | 生成 `js/data.js`，含全部校验与 `--check` |
| `js/effects.js` | 资源变更唯一入口（`applyEffect`），事件信封 |
| `js/narrator.js` | 选词、质疑裁决（`resolveChallenge`）、线索（`claimFor`）、结局台词 |

## 3. 允许修改（严格范围）

`data/**`、`tools/build-data.js`、`js/data.js`（**只由生成器产出**）、`js/narrator.js`、`js/effects.js`

**不改**：`js/game.js`、`js/state.js`、`js/ui.js`、`index.html`、`tests/**`、`style.css`。
需要引擎配合的（例如"每轮开始时触发事件"）→ 在交付说明中写清与引擎的接口约定，由整合者实现或协商。

## 4. 必做项

### B1 随机事件层 `data/events.json`（8 种）
字段：`id/name/desc/chance(0–1)/scope(round|game)/effect{coins|patience|suspicion|lieRateDelta|bombWeightDelta|rewardMult}/duration`
建议 8 种：`blackout 停电(旁白看不清：lieRateDelta -0.10)`、`bomb_wave 炸弹潮(bombWeightDelta +30%)`、`tax 税收(coins -10%)`、`cheer 观众喝彩(rewardMult 1.5 本轮)`、`lucky_coin 幸运币(coins +15)`、`sneeze 打喷嚏(本轮第一条旁白一定是假)`、`monsoon 梅雨(耐心 -1，但本轮金币 x1.5)`、`jackpot_wave 大奖潮(big_prize 权重 +50%)`。
约束：`chance` 合计 ≤ 0.35；每种 `chance` ≤ 0.12；事件效果必须**不新增状态机状态**；同一轮最多 1 个事件。

### B2 经济闭环（金币出口）
- 商店扩到 **12 件**（在现有 6 件基础上新增 6 件，`cap` 要有限购或明确 `null`）：
  - `押注 bet`（40 金，50% 赢 +80，输 -80；体现负期望但刺激）、`保险 insurance`（30 金，下一次负面结算归零）、`回收 recycle`（卖道具半价，不限量）、`存款 deposit`（存 50，每轮利息 5%，可随时取）、`透视镜`、`双保险`。
- 每件商品必须：`price > 0`、`cap∈{null,1..3}`、`desc` ≤ 22 字、`kind` 属于 `bag|instant`。

### B3 难度曲线与上限
- `data/config.json` 增：`roundCap`（普通模式 8 轮通关、硬核模式 6 轮）、`difficultyCurve`（每轮 `bomb/trap` 权重乘子，例如第 n 轮 1+0.08n）。
- `seed_demo.json` 保持演示剧本可用（guarantee 不变）。

### B4 概率与公平性文档
交付一份 `概率报告.md`：用 `node` 跑 10 万局模拟（脚本自写），给出每轮 EV、坏门率（≤25%）、事件触发率（12%±1.5%）、通关率、各结局分布。

## 5. 必须实测的验收

```bash
node --check js/narrator.js && node --check js/effects.js && node --check tools/build-data.js
node tools/build-data.js            # 两次输出 identical=True，给出 SHA256 与字节数
node tools/build-data.js --check    # exit 0
node tests/run-all.js               # 514 PASS / 0 FAIL / 9 SKIP（不得新增 FAIL）
```

## 6. 交付格式（回给整合者）

```
交付说明.md          # 改动清单、接口约定（与引擎/UI 的边界）、验收输出原文、已知取舍
概率报告.md          # 10 万局模拟数据
data/events.json     # 新增
data/shop.json       # 12 件
data/config.json     # roundCap / difficultyCurve / events 相关
data/items.json      # 只增不改
tools/build-data.js  # 校验扩展
js/data.js           # 生成物
js/narrator.js / js/effects.js
files/               # 与仓库相对路径一致的副本
```

## 7. 整合方式

```bash
node handoff/integrate.js --dir <交付目录> --scope b        # 校验 + 沙箱演练
node handoff/integrate.js --dir <交付目录> --scope b --apply
node tools/build-data.js                                     # 重新生成（必做）
node tests/run-all.js                                        # 0 FAIL
```

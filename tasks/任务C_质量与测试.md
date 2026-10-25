# 任务 C：质量与测试（新功能测试 + 真浏览器 E2E + 性能预算）

> 给执行本任务的 AI：你是资深测试/质量工程师。你只写测试与脚本，**不改产品代码**。判据是"测出问题"，不是"让测试变绿"。

---

## 0. 一句话目标

给下一批功能（随机事件、经济闭环、结局/档案）预先写好**可执行的质量门**，并把当前最大的盲区——"真实浏览器 / 动画 / 性能"——补上可在用户本机运行的 E2E 与性能脚本。

## 1. 仓库与基线

- 仓库：`https://github.com/gnbfp/heikesong`（或本地同结构副本）｜分支 `codex/stage0-1-vertical-slice`
- 基线：
  ```bash
  node tests/run-all.js     # 8 套件 514 PASS / 0 FAIL / 9 SKIP，exit 0
  ```
  9 条 SKIP = headless Edge 在沙箱内起不来（spawn EPERM），属预期；**不要试图"修"它们**。

## 2. 现有测试资产（只读）

| 文件 | 说明 |
|---|---|
| `tests/lib.js` | 加载器（vm 加载 js/*.js + 数据）、`recordingUI()`、`immediateTimeout`、`until/micro` |
| `tests/sim.js` | 状态机/演示/固定种子/结算（175 条） |
| `tests/shop.js` | 商店/背包/经济（75 条） |
| `tests/features.js` | 线索质疑/连击/多结局/图鉴（58 条） |
| `tests/ux.js` | 键盘/引导/成就/统计/种子（73 条） |
| `tests/doors.js` | 3–6 门、主持人规则、分布（26 条） |
| `tests/dom-smoke.js` | DOM 垫片下 ui.js 冒烟（98 条） |
| `tests/headless-check.js` | 无头 Edge E2E（本机可跑；沙箱 9 SKIP） |
| `tests/mutation-proof.js` | 变异测试 31/31（手动跑） |
| `tests/run-all.js` | 套件注册表 |

## 3. 允许修改（严格范围）

`tests/**`（含新增文件、`run-all.js` 注册表、`mutation-proof.js` 扩展）
**不改**：`js/**`、`data/**`、`tools/**`、`index.html`、`style.css`。

## 4. 必做项

### C1 `tests/events.js`（随机事件层，**条件套件**）
- 若 `GameData.events` 不存在 → 全部 `SKIP`（低噪声），存在则断言：
  - 每轮最多 1 个事件；`chance` 合计 ≤ 0.35；单事件 `chance` ≤ 0.12；
  - 1 万局模拟：事件触发率 12%±1.5%（或按配置合计值 ±10%）；
  - 事件效果确定性：同 seed 两次完全一致；事件效果不产生 `NaN`、不越界（coins/patience/suspicion 夹紧）；
  - 事件期间不改变状态机迁移表（`ALLOWED` 原样）。

### C2 `tests/economy.js`（押注/利息/回收，**条件套件**）
- 存在对应商品/配置才断言：押注 EV 与文案一致（50% 赢/输额对称）；存款利息每轮 +5%（复利，10 轮可复算）；回收半价；负期望项不得在 1 万局内产生正 EV。

### C3 `tests/e2e/`（真实浏览器，**本人重点交付**）
- 用 Playwright（`npm i -D playwright` 仅用于你本机，交付时附 `package.json` 与运行说明；**不要**把 node_modules 提交进仓库）。
- 20 条场景：双击打开 `file://` 四档视口无滚动条、开始→选门→开奖→决策→结算、质疑成功/失败、商店购买、键盘全流程、静音切换、重置、竖屏提示、连点 50 次。
- 输出：每条 PASS/FAIL + 截图（存 `tests/e2e/out/`，交付时只附说明，不提交截图）。

### C4 `tests/perf.js`（性能预算）
- 断言：`js/data.js` 解析 < 25ms；`Game.init` < 50ms；状态迁移吞吐 ≥ 2000 次/秒；内存峰值 < 40MB。
- 输出 `perf-report.md`（实测数字 + 预算对照）。

### C5 扩展 `tests/mutation-proof.js` 到 **≥ 40 条**
- 为事件/押注/结局优先级/种子/存档各加 1–2 个锚点；每个变异必须让 ≥1 条断言变红（记录变了哪条）。

### C6 `tests/save-migrate.js`
- `three_doors_*` 存储：正常读写；损坏 JSON 静默降级；缺 `schemaVersion` 视作 v1；未知字段忽略。

## 5. 硬约束

1. 新套件必须在 `tests/run-all.js` 注册，且**不引入任何外部依赖**（Playwright 仅限 `tests/e2e/`，不进 run-all，不下载浏览器到仓库）。
2. `run-all` 最终必须 `exit 0`：新增套件在功能未落地时 SKIP，不制造 FAIL。
3. 测试只增不删；改既有断言必须先证明旧断言是错的（写进交付说明）。
4. 所有断言要有**具体数字**的失败信息（不要只写 `assert(false)`）。

## 6. 必须实测的验收

```bash
node tests/run-all.js       # exit 0，给出套件表与 PASS/FAIL/SKIP
node tests/mutation-proof.js  # 40/40 全灭，exit 0
node tests/perf.js            # exit 0（本机）
# e2e（本机）：npx playwright install chromium && node tests/e2e/run.js  → 20/20
```

## 7. 交付格式

```
交付说明.md        # 新增/改动套件清单、每条断言依据、旧断言纠错说明、验收输出原文
perf-report.md
tests/events.js / economy.js / save-migrate.js / perf.js
tests/e2e/run.js + 用例 + package.json + README（如何在本机跑）
tests/mutation-proof.js（扩展版）
tests/run-all.js（注册版）
files/             # 与仓库相对路径一致的副本
```

## 8. 整合方式

```bash
node handoff/integrate.js --dir <交付目录> --scope c
node handoff/integrate.js --dir <交付目录> --scope c --apply
node tests/run-all.js          # exit 0
node tests/mutation-proof.js   # 40/40
```
整合者会把你写的 E2E 与 perf 脚本一起归档到 `docs/` 给用户本机跑；不会在本沙箱里执行浏览器。

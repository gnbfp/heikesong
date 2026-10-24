# 三扇门：别信旁白

创意互动与娱乐赛道 · 黑客松 Demo。零构建纯静态网页：**双击 `index.html` 即可运行**（也支持任意静态服务器），断网可用，无后端、无登录、无任何外部接口。

游戏规则一句话：三扇门后是大奖、小奖与空门，主持人会替你打开一扇门（普通模式优先开空门，演示剧本会故意开出炸弹/陷阱），而**旁白说的每一句话都可能是谎**。你可以坚持、换门、质疑旁白、加倍下注，或者见好就收；赚到的金币还能在**商店**里买道具（换门券、闭嘴卡、双倍金币、保险丝、神秘盒、续命符）。

## 快速开始

```powershell
# 方式一：直接双击 index.html（推荐，零依赖）
start index.html

# 方式二：本地静态服务（可选）
python -m http.server 8000
```

演示模式使用固定种子 `20261024` 与固定剧本，评委面前那一局每次完全一致。

## 目录结构

```
index.html            单页容器：#stage / #narrator / #hud / #modal / #decide / #bag / #btn-shop
style.css             暗色舞台风、木纹门、HUD 卡片、按钮五档层次、窄屏媒体查询
js/state.js           全局状态定稿（GameState 模板、createInitialState、可复现 RNG、CodexStore）
js/data.js            由 tools/build-data.js 从 data/*.json 内联生成（勿手改）
js/effects.js         applyEffect(state, effect, opts)：金币/怀疑值/耐心的唯一加减点
js/narrator.js        旁白取材、撒谎率、质疑判定、彩蛋与高光文案
js/ui.js              DOM 渲染与动画（Promise 接口，可跳过；含商店弹层、背包栏、WebAudio 音效）
js/game.js            状态机主循环（setState 集中切换，无 DOM 依赖，可无头运行）
data/*.json           内容源文件：items / shop / narrator / config / seed_demo
tools/build-data.js   生成 js/data.js（零依赖，node 内置模块）
tests/                无头自测与验收脚本：sim / shop / dom-smoke / headless-check / run-all / mutation-proof
assets/               素材占位（当前全部用 CSS 色块 + 内联 SVG + 文字，不引外链）
docs/                 协作说明、回滚说明、现场自测清单、商店与美术设计契约
```

浏览器侧不 fetch JSON（`file://` 下会被 CORS 拦住），所以内容以 `js/data.js` 的形式随页面一起加载；`data/*.json` 是可读、可评审的作者源文件，二者由 `tools/build-data.js` 保持同步。

## 操作

| 操作 | 说明 |
| --- | --- |
| 点门 | 选一扇门，主持人会替你打开一扇门（**绝不会开你选的那扇，也绝不会开大奖门**） |
| 长按门 | 窥视（每轮一次，只给模糊提示） |
| 坚持本门 | 决定最终翻开当前这扇门 |
| 换门 | 翻到另一扇没被打开的门：**有换门券就消耗券，否则扣 15 金币**；两者都没有则留在决策阶段 |
| 质疑旁白 | 消耗 1 点怀疑值，**每轮只能质疑一次**；成功得金币，失败扣金币与耐心；连续质疑会让旁白记仇 |
| 加倍下注 | 本轮收益与负面效果 ×2，不可叠加 |
| 商店（右上角） | **决策阶段 / 本轮结算页**可开，金币买道具；买了自动进背包 |
| 背包 | 有道具时显示在舞台下方；点道具使用（仅决策阶段可点） |
| 收手 | 在决策阶段或本轮结算页均可，进入结算页 |
| 右上角 | 重置 / 演示模式切换 / 静音（WebAudio 现场合成，无音频文件；**重置或切换模式后仍保持静音**） / 跳过动画 |
| 结算页 | 「再来一局」重开一局；「看图鉴」查看收集进度与最佳成绩 |

## 商店与背包（2026-10-24 第二轮新增）

赚到的金币不再是死数字：决策阶段可以开商店，把金币换成道具，道具进背包，需要时点一下就用。

| 商品 | 价格 | 限购 | 效果 |
| --- | --- | --- | --- |
| 换门券 `switch_ticket` | 25 | 3 | 换门时自动顶上，省下 15 金币 |
| 闭嘴卡 `mute_card` | 20 | 2 | 使用后**下一轮**旁白沉默（防剧透，不防霉运） |
| 双倍金币 `double_coins` | 40 | 2 | 本轮开奖收益 ×2，罚金也 ×2（等价于「加倍」） |
| 保险丝 `fuse` | 35 | 2 | 接上后下一次负面结算归零，用掉即烧断 |
| 神秘盒 `mystery_box` | 15 | 不限（每买一次当场开一次） | 当场开：小奖（+30）或小坑（−15），期望值略亏，手气自己扛 |
| 续命符 `patience_charm` | 60 | 2 | 立刻 +1 点耐心（上限 5） |

经济规则：换门不再免费（无券扣 15 金币，`data/config.json` 的 `economy.switchCost`）；商店只在 `DECIDE` / `SETTLE_ROUND` 两个相位可开；消费金额累计进 `state.spentCoins`，结算页会多出一行「商店消费」；买过的件数记在 `state.shopBuys`。所有金钱变动仍然只经过 `js/effects.js` 这一个加减点。


## 图鉴与本地存档

首次获得的物品、首次听到的旁白话术、结算解锁的结局称号会写入**本机浏览器**的 `localStorage`，键名固定：

- `three_doors_codex_v1`：物品图鉴 / 语录图鉴 / 结局称号
- `three_doors_best_v1`：最佳金币、最高轮次、已解锁称号

图鉴弹层里的「清空收集进度」会同时清掉这两个键。存档只存在本机、不上传；隐私模式、配额不足或存档损坏时**静默降级为空图鉴**，不会白屏、不会中断演示。

## 本地校验

```powershell
node tools/build-data.js          # 重新生成 js/data.js（应与提交内容一致）
node tools/build-data.js --check  # 只校验 data/*.json 与 js/data.js 是否同步
node tests/sim.js                 # 无头逻辑 + 清单验收项（175 项）
node tests/shop.js                # 商店 / 背包 / 经济 / 换门代价（75 项）
node tests/dom-smoke.js           # Node DOM 垫片：页面结构、商店 DOM 契约、六档视口、WCAG 对比度（98 项）
node tests/run-all.js             # 全量自测，5 个套件：357 PASS / 0 FAIL / 9 SKIP
node tests/mutation-proof.js      # 变异自证：19/19（故意改坏数据/逻辑，确认自测真的会红）
```

`tests/run-all.js` 默认第一项就是 `tools/build-data.js --check`（防「改了 `data/*.json` 忘了重建 `js/data.js`」的假绿）；`STRICT=1 node tests/run-all.js` 会把 SKIP 视为失败（最终验收用）。浏览器端到端用例（`tests/headless-check.js`）在无法启动浏览器的环境里会 SKIP，并在汇总表里逐条点名。仓库用 `.gitattributes` 把文本文件固定为 LF，且 `--check` 比较前会归一化换行，所以 Windows 上 `core.autocrlf=true` 不会让 `run-all` 假失败（换行差异不判为产物漂移，数值/文案漂移照旧判失败）。

演示前 30 分钟的手工自测步骤、固定剧本的三轮预期结果与备用方案见 [现场自测清单](docs/现场自测清单.md)。

## 验收对照（对应《开工清单》阶段 0–7）

| 清单阶段 | 落地位置 | 证据 |
| --- | --- | --- |
| 0 骨架与状态定稿 | `js/state.js`、`js/game.js`（状态机 10 态） | `node tests/sim.js` 阶段 0 组 |
| 1 单轮闭环 | `js/game.js` generateDoors / hostPick / chooseDoor / reveal | 阶段 1 组：门面不变量、主持人开门规则 |
| 2 资源与质疑 | `js/effects.js`（唯一加减点）、`js/narrator.js`（撒谎率 / 记仇 / 质疑判定） | 阶段 2 组：九种物品结算、质疑成败 |
| 3 连续闯关与收手 | `js/game.js`（跨轮继承、风险提示、DECIDE/SETTLE_ROUND 双收手、评级档位） | 阶段 3 组：评级 0–99 / 100–199 / 200–299 / 300+ 与「见好就收大师」 |
| 4 双模式与固定种子 | `DEMO_SEED = 20261024`、`data/seed_demo.json` 三轮剧本、普通模式时间种子、一键重置 | 阶段 4 组：固定种子多次结果一致、重置 ≤1 s |
| 5 图鉴与本地存档（P1） | `CodexStore`（`js/state.js`）+ 结算页「看图鉴」 | 阶段 5/6 组：落盘键名、读回、清空、坏存档降级 |
| 6 演示保障 | 全本地资源、可跳过动画、旁白截断、HUD 娱乐声明 | 阶段 6 组：无外链、连点 50 次、跳过照常结算 |
| 7 演示前自测 | —（人工流程） | [现场自测清单](docs/现场自测清单.md) |

## 本轮评审修复（2026-10-24）

三份外部评审（玩法数值 / 表现层 / 测试工程化）加 Lead 独立复核后，按批准范围落地 **8 项修复（4 个 P0 + 4 个 P1）**，另含 2 项在修 P0 时顺带发现的附带修复。每项都有可复现证据，命令见「本地校验」。

| # | 修复 | 涉及文件 | 证据 |
| --- | --- | --- | --- |
| 1（P0） | **剧本门位也过硬不变量**：主持人绝不打开玩家所选的门或大奖门；剧本槽位不合法时退化为 `hostPick`（留痕 `state.hostScriptFallback`） | `js/game.js` | `tests/sim.js` G8.1/G8.1b/G8.1c |
| 2（P0） | **质疑每轮一次**：同一轮第二次质疑直接被拦并提示，金币不变（此前撒谎轮可连点刷 +20） | `js/game.js` | `tests/sim.js` CHALLENGE-ONCE |
| 3（P0） | **轮次横幅去剧透**：`roundHints` 与兜底文案不再出现「哪轮旁白说真话 / 哪轮撒谎」 | `data/config.json`、`js/game.js` | `tests/sim.js` HINT-NO-SPOILER |
| 4（P0） | **「静音」变成真开关**：WebAudio 现场合成的提示音（零音频文件、离线可用、`gain ≤ 0.05`、单音 ≤ 0.2s）；`muted` 时零发声 | `js/ui.js` | 34 项 Fake AudioContext 动态校验 |
| 5（P1） | **门卡高度上限**：`max-height` + 矮视口媒体查询，修掉 667×375 / 640×360 下门卡底部被裁 | `style.css` | 七档静态推算表（见评审报告） |
| 6（P1） | **测试去假绿**：`run-all` 默认先跑产物一致性校验；5 处恒真断言换成真断言（含「离线可跑」静态证明）；新增变异自证脚本 | `tests/**` | `node tests/mutation-proof.js` 13/13 |
| 7（P1） | **文档门号 off-by-one**：屏上门号 = `slot + 1`，文档此前按 0 基写成「2 号门」 | `README.md`、`docs/现场自测清单.md` | 与 `data/seed_demo.json` + `js/ui.js` 对齐 |
| 8（P1） | **`main` 指向已验证提交**：此前 `main` 只有文档，按 README 拉下来打不开页面 | git 分支指针 | 回滚点分支 + `git log` 关系 |
| 附 1 | **静音跨重置/切换模式保持**（修 4 时发现的尾巴）：静音是本机偏好，不是本局状态 | `js/game.js` | `E:\dsh3\lead_mute_check.js` 10/10 |
| 附 2 | **文案一致**：主持人台词不再断言「打开的是空门」（剧本会故意开炸弹/陷阱） | `js/ui.js` | 文案审校 |

## 第二轮：商店 / 美术 / 测试加固（2026-10-24 晚）

在原有 8 项修复之上，本轮解决「金币无处可花」与「界面过于朴素」两件事，口径与上一轮一致：每项都有可复现证据。

| # | 内容 | 涉及文件 | 证据 |
| --- | --- | --- | --- |
| N1 | **商店与背包**：右上角「商店」在 DECIDE / SETTLE_ROUND 可开，6 件商品含限购；买不起 / 已满 / 未知 id / 相位不对四类拒绝；背包点道具使用 | `index.html`、`js/state.js`、`js/game.js`、`data/shop.json`、`js/ui.js` | `tests/shop.js` 75/75、`tests/dom-smoke.js` U10.* |
| N2 | **换门不再免费**：无券换门扣 15 金币（`economy.switchCost`），换门券才真正有价值 | `js/game.js`、`data/config.json` | `tests/shop.js` SH4.* |
| N3 | **四件道具生效**：保险丝（抵一次负面）、双倍金币（本轮 ×2）、续命符（+1 耐心，上限 5）、神秘盒（当场开，小奖/小坑） | `js/game.js`、`js/effects.js` | `tests/shop.js` SH3.* / SH5.* / SH6.* |
| N4 | **修掉换门两处真缺陷**（qa-verify 报，Lead 修，qa-verify 独立复验）：① `_apply` 会替换 `Game.state`，旧实现把 `pickedSlot` 写回旧对象 → 扣了 15 金币却没换门；② 换门失败时被拖进 REVEAL，未留在 DECIDE | `js/game.js` | `tests/shop.js` SH4.2 / SH4.5 / SH4.12、`lead_shop_check.js` 91/91 |
| N5 | **美术升级**：木纹门 + 金属框 + 铭牌把手 + 3D 掀门、舞台聚光与暗角、HUD 卡片化、按钮五档层次、旁白气泡尾巴与打字机光标、大奖彩带；`prefers-reduced-motion` 下停装饰动画 | `style.css`、`js/ui.js` | `tests/dom-smoke.js` 对比度 49/49、六档视口静态推算全过 |
| N6 | **测试工程化加固**：新增 `tests/shop.js`（75 项）、`tests/mutation-proof.js` 扩到 19/19；并修掉 dom-shim 的 `innerHTML` 只存不解析（商店卡片在垫片里根本不存在） | `tests/**` | `node tests/run-all.js` 357 PASS / 0 FAIL / 9 SKIP |

> 本轮仍未引入任何外部依赖、外部字体或网络请求：音效是 WebAudio 现场合成，图标是内联 SVG，美术是纯 CSS。

## 已知偏差与取舍（评审请看这里）

1. **主持人开门的边界（硬不变量优先于剧本）**：任何模式下主持人都**不得打开玩家所选的门、不得打开大奖门**（`js/game.js` `chooseDoor` 统一校验）。① 普通模式：存在未选空门时优先空门（`hostPick`）。② 演示模式：剧本 `hostOpensSlot` 优先，但同样要过硬不变量——不满足时（例如玩家恰好点了剧本指定的那扇门）自动退化为 `hostPick`，并在 `state.hostScriptFallback` 留痕。按**屏上门号**：第 1 轮开 3 号门（bomb，slot 2），第 2 轮开 1 号门（empty，slot 0）；第 3 轮剧本指定 1 号门（trap，slot 0），而本轮预期是直接收手，只有玩家先点门时主持人才会开。这与清单「主持人打开一扇空门」字面表述的差异只存在于演示剧本（那是阶段 4 逐字写死的戏剧安排），普通模式始终走 `hostPick`。演示三轮剧情与结果（小奖 → 质疑反杀 → 收手结算）与清单一致。
2. **演示模式收手称号**：评级里「见好就收大师」要求 `round ≥ 4 且 coins ≥ 200`（`config.cashoutMaster`），而固定剧本只演 3 轮，所以演示收手时的称号是「欧皇候选（200–299 金币）」，不是「见好就收大师」。这是配置与剧本长度决定的，非缺陷；想现场展示大师称号可在第 3 轮结算后选「继续下一轮」再收手。
3. **浏览器真机渲染未自动化**：本仓库的自测在 Node 中运行（`tests/sim.js` + Node DOM 垫片 `tests/dom-smoke.js`）。开发沙箱无法启动浏览器子进程（Edge mojo 管道被禁），因此真机渲染、控制台报错、断网这三项按清单阶段 6/7 由人工自测覆盖：见 [现场自测清单](docs/现场自测清单.md)。`node tests/run-all.js` 在浏览器不可用时会把该套件标为 SKIP 而不是失败。
4. **`rewardMode` 切到 `hint` 会剧透**：`js/narrator.js` 在 `suspicion.rewardMode === 'hint'` 时会输出「真话：第 N 扇门里是大奖。」。当前 `data/config.json` 配的是 `'coins'`，走不到该分支；若改成 `'hint'`，横幅去剧透的保证就会被这条台词破坏。这是刻意的奖励模式开关，保留但默认不启用。
5. **图鉴存档键无版本迁移**：`three_doors_codex_v1` / `three_doors_best_v1` 是 v1 固定结构，读到损坏或不兼容的 JSON 时静默降级为空图鉴（不白屏、不中断演示）；后续若改结构需升键名。
6. **换门有代价，演示剧本不经过付费换门**：普通模式下无券换门要扣 15 金币（`economy.switchCost`），所以「换门恒为正收益」不再成立——这是为了让换门券有意义。固定种子的自动演示走「坚持本门 + 质疑反杀」，不触发换门，因此三轮金币仍是 130 → 250 → 250 收手（`E:\dsh3\lead_smoke.js`）。**若演示时手动点「换门」而不带券，会扣 15 金币、结局数字随之变化**；现场请让自动演示跑完。
7. **闭嘴卡改为「下一轮」生效**：这张卡在决策阶段使用，而本轮旁白早就念完了，「本轮闭嘴」实际永远拦不到旁白。实现改为沉默下一轮旁白，`narrate()` 消费后立即清空（用完即失效，不会跨轮残留）。
8. **即时道具的限购用 `state.shopBought` 计数**：神秘盒 / 续命符是「买下即结算」、不进背包，用背包计数做限购会永远算 0（→ 无限买）。因此即时商品按「本局买过几次」计数；`cap: null`（神秘盒）解释为不限购，`cap: 2`（续命符）为真正的一局两次；耐心已满时续命符直接拒绝购买，不让玩家花 60 金币买一次空操作。
9. **`#vignette` 由 `js/ui.js` 自建**：设计契约把它列在 `index.html` 里，但装饰层归渲染层所有；`js/ui.js` 检测到缺失就创建一个（幂等，二次渲染不会重复插入）。所以 `index.html` 里没有这个标签是**有意**的，不是遗漏。

## 开发约定

- `main` 保存团队集成版本。
- 每个任务使用独立分支，例如 `feature/<成员>-<功能>`、`fix/<成员>-<问题>`；本对话使用 `codex/<任务>`。
- 每个可独立说明的改动单独提交，完成相应检查后推送，通过 Pull Request（PR）协作。
- 每个阶段保留提交编号；重要改动开始前和里程碑完成后建立远端回滚点。
- 回滚共享代码时优先使用 `git revert` 产生撤销提交，保留其他成员的工作和提交历史。

详细操作见 [协作说明](CONTRIBUTING.md)、[回滚说明](docs/ROLLBACK.md)。自动化开发须遵守 [AGENTS.md](AGENTS.md)。

## 初始回滚点

`checkpoint/2026-10-24-initial`：仅包含仓库文档和 Git 基础配置，不代表应用已经可运行或通过测试。该分支创建后固定保留，不继续开发、不移动。

## 队员加入

仓库所有者在 GitHub 仓库的 **Settings → Collaborators** 中邀请队员的 GitHub 账号；队员接受邀请后，使用各自账号和任务分支协作。公开可查看不等于拥有推送权限。

## 免责声明

游戏内金币纯属娱乐，非真实货币，不涉及任何充值、提现或赌博表达。

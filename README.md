# 三扇门：别信旁白

创意互动与娱乐赛道 · 黑客松 Demo。零构建纯静态网页：**双击 `index.html` 即可运行**（也支持任意静态服务器），断网可用，无后端、无登录、无任何外部接口。

游戏规则一句话：三扇门后是大奖、小奖与空门，主持人会替你打开一扇坏门，而**旁白说的每一句话都可能是谎**。你可以坚持、换门、质疑旁白、加倍下注，或者见好就收。

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
index.html            单页容器：#stage / #narrator / #hud / #modal / #decide
style.css             暗色舞台风、门牌样式、按钮三态
js/state.js           全局状态定稿（GameState 模板、createInitialState、可复现 RNG）
js/data.js            由 tools/build-data.js 从 data/*.json 内联生成（勿手改）
js/effects.js         applyEffect(state, effect, opts)：金币/怀疑值/耐心的唯一加减点
js/narrator.js        旁白取材、撒谎率、质疑判定、彩蛋与高光文案
js/ui.js              DOM 渲染与动画（Promise 接口，可跳过）
js/game.js            状态机主循环（setState 集中切换，无 DOM 依赖，可无头运行）
data/*.json           内容源文件：items / narrator / config / seed_demo
tools/build-data.js   生成 js/data.js（零依赖，node 内置模块）
tests/                无头自测与验收脚本
assets/               素材占位（当前全部用 CSS 色块 + 文字，不引外链）
docs/                 协作与回滚说明
```

浏览器侧不 fetch JSON（`file://` 下会被 CORS 拦住），所以内容以 `js/data.js` 的形式随页面一起加载；`data/*.json` 是可读、可评审的作者源文件，二者由 `tools/build-data.js` 保持同步。

## 操作

| 操作 | 说明 |
| --- | --- |
| 点门 | 选一扇门，主持人会替你打开一扇坏门 |
| 长按门 | 窥视（每轮一次，只给模糊提示） |
| 坚持本门 / 换门 | 决定最终翻开哪扇门 |
| 质疑旁白 | 消耗 1 点怀疑值；成功得金币，失败扣金币与耐心；连续质疑会让旁白记仇 |
| 加倍下注 | 本轮收益与负面效果 ×2，不可叠加 |
| 收手 | 在决策阶段或本轮结算页均可，进入结算页 |
| 右上角 | 重置 / 演示模式切换 / 静音 / 跳过动画 |

## 本地校验

```powershell
node tools/build-data.js          # 重新生成 js/data.js（应与提交内容一致）
node tests/run-all.js             # 无头自测：逻辑、验收项、页面渲染
```

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

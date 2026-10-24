# 团队协作说明

## 开始任务

先取得仓库访问权限，克隆仓库，然后检查工作区并同步主分支：

```sh
git clone https://github.com/gnbfp/heikesong.git
cd heikesong
git status
git fetch origin --prune
git switch main
git pull --ff-only origin main
git switch -c feature/yourname-task
```

若工作区存在未提交改动，先保存自己的工作再切换分支。每人每个任务使用独立分支。

## 提交与集成

1. 分步实现功能，执行相应检查。
2. 使用 `git add <明确的文件路径>` 选择本任务文件，再运行 `git diff --cached` 检查提交范围。
3. 运行 `git commit -m "feat: 说明功能"`，然后 `git push -u origin <任务分支>`。
4. 在 GitHub 创建面向 `main` 的 PR，说明变更、检查结果和对应回滚点。
5. 合并前再次同步远端信息，检查冲突以及队员同时修改的功能；按团队约定审阅后合并。

目前尚未选择应用技术栈，因此没有应用安装、运行或测试命令；项目建立时补充。

## 保留回滚点

较大改动开始前保存当前基线；阶段功能验证后保存新里程碑。每次记录提交 SHA 和验证结果。操作见 [回滚说明](docs/ROLLBACK.md)。

`checkpoint/*` 分支仅用于保留历史位置。开发从它另建新分支，勿直接向它推送。

## 并发与权限

- 远端有新提交时先同步并整合；推送被拒绝时检查原因，不使用强推解决。
- 使用各自的 GitHub 账号，队员的推送权限由仓库所有者邀请授予。
- PR 与回滚点是本仓库的协作约定；当前没有配置 GitHub 强制分支保护或强制审阅规则。

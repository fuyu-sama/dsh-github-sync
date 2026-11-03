# dsh-github-sync

用 GitHub 仓库同步当前 DSH profile 的**配置、插件、模式（agent preset）与 skill**。

- **界面**：左侧 Plugins 页新增 **GitHub 同步** 标签页（连接配置、状态、检查 / 拉取 / 推送）。
- **命令**：任何会话里输入 `/dsh-sync status | check | pull | push | config ...`。
- **自动拉取**：可选，启动后延迟 15 秒拉取一次（默认关闭）。
- **认证**：完全使用本机 git 凭据（SSH key / ssh-agent / HTTPS credential helper）。插件不读取、不保存、不传递任何令牌。

## 安装

在本机 DSH 里安装一次（新机器引导也只需这一步）：

```text
plugin_manager install_bundle(target: "/绝对路径/dsh-github-sync", enabled: true)
```

或用本仓库地址安装（<https://github.com/fuyu-sama/dsh-github-sync>，默认分支 `master`）：

```text
plugin_manager install_bundle(target: "github:fuyu-sama/dsh-github-sync", enabled: true)
```

安装后打开 **Plugins → GitHub 同步**：

1. 填仓库地址（建议私有仓库，可以是空仓库）：`git@github.com:you/dsh-config.git` 或 `https://github.com/you/dsh-config.git`。
2. 点 **测试连接**（校验 git 可用、仓库可访问、分支状态）。
3. 先 **推送** 初始化远端；到另一台机器上重复安装 + 填仓库 + **拉取**。

## 同步什么

| 内容 | 本地路径 | 仓库路径 |
|---|---|---|
| profile 配置（含**模式**） | `$DSH_PROFILE_DIR/cordis.patch.yml`、`package.json`、`cordis.yml`、`pnpm-workspace.yaml`、`compatibility.json`（存在才同步） | `profile/<同名文件>` |
| 插件清单 | 上面 `package.json` 的 `dsh.profile.bundles` 与 `dependencies` | 同上；拉取时经 `pluginManager` 安装缺失 bundle |
| skill | 默认 `$DSH_HOME/skills`，可在连接配置里加 `skillDirs`（如 `{"user":"~/.dsh/skills","mtg":"/Users/you/magic-skill/skill"}`） | `skills/<label>/...` |
| 元信息 | — | `dsh-sync.json`（固定内容，标记仓库格式） |

**模式（agent preset）** 在 DSH 里就是 `cordis.patch.yml` 里的 `@deepseek-ai/dsh-agent-preset` insert 行（或某个 bundle 补丁）。因此模式随 profile 配置一起同步；状态页会额外列出当前组合出的模式清单，拉取结果里也能看到模式数量。不额外生成“模式文件”，避免两份来源互相覆盖。

## 永不同步

`.env`、`.credentials.yaml`、`sessions/`、`storages/`、`attachments/`、`node_modules/`、`pnpm-lock.yaml`、`.plugin-manager/`、私钥（`*.pem`、`*.key`、`id_*`）、dotfiles，以及本插件的 `link:`/`file:` 依赖。

推送前还会做一次密钥特征扫描（私钥头、`ghp_` / `github_pat_` / `sk-` / `AKIA` / `xox` 令牌、URL 内嵌账号密码）；命中则拒绝推送，除非显式 `force`。

## 行为

### 推送

1. 收集本地快照 → 写入本机缓存 clone；多出的受管文件被移除。
2. 从同步的 `package.json` 里剥离 `link:`/`file:` 依赖与本插件自身（它们只在一台机器上有效）。
3. 密钥扫描 → `git add -A` + commit（`--no-verify`）→ `git push -u origin HEAD:<branch>`。
4. 远端有新提交时返回 `remote-ahead`，提示先拉取。

### 拉取

1. 先把本地快照提交到 clone（不推送），因此本地未推送的改动会参与合并。
2. `git fetch origin <branch>` → `git rebase FETCH_HEAD`。
3. 冲突则 `rebase --abort`：**本地文件一个字节都不动**，返回冲突文件列表。
4. 合并成功后落回本地：只覆盖配置过的路径；**只删除上次同步记录过、且远端已删除的文件**；覆盖/删除前统一备份到
   `$DSH_HOME/dsh-github-sync/<profile>/backups/<时间戳>/`。
5. 插件对账（默认开）：缺失 bundle 通过 `pluginManager.installBundle` 安装；本地多出的 bundle 只禁用、不删除；
   `link:`/`file:` 依赖与本插件自身受保护。
6. `cordis.patch.yml` 写回后由 HMR 实时重组合；需要重启的插件变更会标 `restart-required`。

### 检查

`git fetch` 后报告领先/落后提交数与差异文件列表，不改本地任何文件。

## 本机状态

`$DSH_HOME/dsh-github-sync/<profile>/`

- `connection.json`：仓库、分支、自动拉取、同步范围（**本机私有**，不进仓库）
- `state.json`：上次同步/检查、上次错误、已同步文件哈希表
- `repo/`：git clone 缓存
- `backups/`：最近 10 次覆盖前的备份（不自动清理）

## 已知限制

- 需要 `git` 可执行文件；认证失败时按 git 的 stderr 提示检查 SSH key / credential helper。
- Desktop Host 不导出 `DSH_PROFILE*` 环境变量，插件会从 Loader 条目与 `$DSH_HOME/profiles/*/package.json` 推断当前 profile；推断不到时明确报 `profile-dir-unknown`，不会猜路径写错地方。CLI 启动（`dsh web --profile ...`）直接读环境变量。
- 修改插件 Host 代码后需要重启或重新启用该 bundle 才会加载新模块（模块级 HMR 未开启）。在 Plugins 页把它关掉再打开即可让 Host 半重新加载。
- 不同步 settings 文档命名空间（主题、语言等）；模型/供应商配置写在 `cordis.patch.yml` 里，因此会同步。
- 只同步当前运行的 profile。
- 缺失 bundle 自动安装；**版本/range 变化只报告、不自动升级**；不自动删除包。
- 合并是 git 文本级；语义冲突（例如两个分支各自插入同名 preset id）会在重组合时以警告暴露。
- 自定义 HTTP 路由没有 cookie 鉴权（沿用本机插件既有做法）：服务只监听回环地址，POST 会校验 `Origin` 必须是本机页面。
- 插件没有模型工具：DSH 的 agent 工具位于 preset realm 内，host 平面注册的工具对 preset 会话不可见。聊天里请用 `/dsh-sync` 命令。

## 排错

| 现象 | 处理 |
|---|---|
| `git-missing` | 安装 git 或确认它在 Host 进程的 PATH 中（也可放到 `/usr/bin/git`、`/opt/homebrew/bin/git`）。 |
| `auth-failed` | `ssh -T git@github.com` 是否成功；HTTPS 用 `git credential` 是否可用；确认仓库权限。 |
| `merge-conflict` | 用返回的冲突文件列表手动合并：在 `$DSH_HOME/dsh-github-sync/<profile>/repo` 里处理，或先在一台机器上推送、另一台手动对齐后重试。 |
| `secret-detected` | 从本地文件移除密钥后重试；确实要推送时用 `force`（例如 `/dsh-sync push` 不支持 force，请在企业内部用 API 调用）。 |
| `restart-required` | 插件包有增删，重启 DSH 后生效。 |
| 标签页没出现 | 刷新页面；确认 `GET /plugins/dsh-github-sync/client.js` 返回 200。 |

## 自测

```bash
node --check index.js && node --check client.js && for f in lib/*.js; do node --check "$f"; done
node --test test/
```

单测在临时目录里用**本地 bare 仓库**模拟两台机器，覆盖：往返、删除传播、冲突中止、非冲突合并、密钥拦截、
永不收集清单、覆盖前备份、manifest 清洗。

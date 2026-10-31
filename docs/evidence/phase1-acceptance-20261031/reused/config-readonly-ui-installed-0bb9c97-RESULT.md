# 安装副本黑盒验证 — Console 配置面只读（候选 0bb9c97）

## 结论

安装副本黑盒 10/10 通过。npm tarball 安装到隔离前缀后，用真实 Chrome/CDP
打开真实 control daemon 提供的 Console：设置抽屉只读、0 个写控件、打开期间 0 个
config.* 指令；线面 4 个配置写指令均返回 typed 拒绝 UNSUPPORTED_OPERATION；
control daemon 由 CLI 按 generation 停止，显式 PID 已退出。

## 候选与打包

- Worktree：`/Volumes/Intel/playground/agentteams/config-readonly-ui`，分支
  `config-readonly-ui`，HEAD `0bb9c97fcd5a20e1a4d807234f1f0d240efabf2f`。
- 校验：构建前后 `git status --short` 均为空输出；仅 gitignored 构建产物变化。
- `pnpm build`：退出码 0（opencode-adapter、console-host、ui/teams-console、
  generated/runtime-lib）。日志 `build.log`。
- `node scripts/package-artifact.mjs --mode final`：退出码 0，含 DAGpipe runner
  构建；日志 `package-final.log`。未触发 `appsdk compile`，无 pin 阻塞。
- 打包回执（`package-receipt.json`）：mode=final，317 files，
  `content_sha256=056bb42aa370737d64ca68d14f8b52a3af41151facc496f8eae4548e5afa140d`，
  candidate head=`0bb9c97…`，base=`b7236b2…`，source_state=committed。
- npm tarball：`agentteams-0.2.0-internal.1.tgz`，1,706,807 bytes，
  sha256 `9aa8b11ea951618ae1b065d60b98e10d0ce21a7bcc3ab69c967ea853e16c9ec4`，
  npm pack size 1.7 MB / unpacked 6.6 MB / shasum `7b2b3454218fecf879f65ab7b591fbddf8ab2eca`。
- 安装：`npm install --prefix <prefix> <tgz>`，added 10 packages，exit 0；
  node v22.22.2，npm 10.9.7。日志 `install.log`。
- 安装前缀（保留供检查）：
  `/Volumes/Intel/playground/agentteams/.worker-runs/config-readonly-ui-installed-0bb9c97-20261029/install-prefix`

## 黑盒结果（installed CLI）

入口：`AGENTTEAMS_CLI=<prefix>/node_modules/agentteams/cli/agentteams.mjs`，
`EVIDENCE_REPO_ROOT=<prefix>/node_modules/agentteams`。真实 Chrome
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`（headless via CDP，
1440x900），随机 loopback 端口 54303，control pid 83310。

| # | 检查 | 结果 |
|---|---|---|
| 1 | 安装副本 CLI 起真实 control daemon | PASS pid=83310 listener=127.0.0.1:54303 |
| 2 | 认证 HTTP 提供真实 Console 源 | PASS 473 bytes |
| 3 | 设置抽屉只读投影 | PASS 0 buttons / 2 providers / 2 models / binding / 7+6 revisions |
| 4 | CDP 截图设置抽屉 | PASS `screenshots/settings-drawer-readonly.png` 108,419 bytes |
| 5 | UI 打开期间无 config.* 指令 | PASS 0 command requests，0 config.* |
| 6 | 线面拒绝 config.putProvider | PASS UNSUPPORTED_OPERATION |
| 7 | 线面拒绝 config.bindModel | PASS UNSUPPORTED_OPERATION |
| 8 | 线面拒绝 config.refreshModels | PASS UNSUPPORTED_OPERATION |
| 9 | 线面拒绝 config.apply | PASS UNSUPPORTED_OPERATION |
| 10 | CLI stop 按显式 PID 收口 | PASS state=stopped，pid 已退出 |

`report.json` 记录完整检查、origin、`cliPath`（指向安装前缀）、UI 投影摘要。

## 证据产物

- `RESULT.md`、`report.json`、`screenshots/settings-drawer-readonly.png`
- `logs/black-box.log`、`build.log`、`package-final.log`、`install.log`
- `agentteams-0.2.0-internal.1.tgz`、`package-receipt.json`
- `black-box-config-readonly.mjs`（复用脚本的副本）、`script.diff`

## 边界

- 复用脚本为字节副本加 3 处证据改动：固定 1440x900 CDP 视口、抽屉截图步骤、
  报告改名为 `report.json` 并附 `cliPath/projectRoot/ui`。原脚本未改动，差异见
  `script.diff`。第一项检查名称保留原文“worktree CLI”，实际入口以 `report.json`
  的 `cliPath` 为准（安装前缀）。
- 投影输入使用 `AGENTTEAMS_CONTROL_PROJECTION_FIXTURE` 确定性 fixture（一个 runtime
  Agent + config 行，accepted 7 / effective 6）；transport、frames、auth、静态字节与
  DOM 都是真实路径。fixture 中 provider 地址（127.0.0.1:4444 / provider.invalid）
  未被真实调用，不证明外部 provider 网络。
- 未覆盖：`pnpm verify` 全量门禁（既有
  `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0014` 阻塞，与本次改动无关）；完整
  installed Relay + 双 Agent start/restart 生命周期；跨设备/移动端回放；配置文件
  owner 的真实写入路径。
- 截图中顶部“展开/关闭”与工具栏“服务配置/关闭”是抽屉外壳控件，位于
  `.teams-drawer-body` 之外；抽屉体内按钮数为 0。

## 资源回收

- control daemon 由 `agentteams control stop --generation` 停止；显式 pid 83310 已确认
  退出。Chrome 子进程由脚本按显式 PID 终止。事后无匹配的残留进程。
- 安装前缀保留供检查；不再需要时可删除：
  `rm -rf <prefix>`。候选 worktree 未改动、未提交，保留给集成 owner。

一句话：安装副本黑盒 10/10 通过；边界是 headless Chrome/CDP 1440x900、随机
loopback 端口、确定性 fixture 投影输入；未覆盖既有 appsdk pin 阻塞下的全量
`pnpm verify`、完整 installed Relay+Agent 生命周期与移动/跨设备回放。

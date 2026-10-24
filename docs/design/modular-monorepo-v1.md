# AgentTeams 模块化 monorepo 设计 v1

状态：design candidate r3（验收官 Alice 2026-10-24 定向复核 PASS，可按授权进入实现；
实现后的测试、安装、正式 Review 与集成交付仍按项目合同，本 PASS 不替代）。
基线：`origin/main` 89cd91d。本文件只描述结构落地方案，不替代任何已合入契约。

## 0. 修订记录

- r1：初稿。验收官 NEEDS-FIX（裸包名进 runtime 产物、产物路径迁移未同步 consumer、build.mjs repoRoot、
  AppSDK 安装单元）。
- r2：全部相对导入、显式 consumer 清单、repoRoot 三层、单一 tarball + 隔离安装回放。
- r3（本轮）：dagpipe→runtime 相对路径改为三层；vitest include 显式加 packages/dagpipe/tests；
  teams-source 保留为完整安装准入单元。验收官 r3 PASS（设计定向复核）。

### 0.1 r2 对 r1 的修订（逐条回应 NEEDS-FIX，保留记录）

1. **裸包名不再进入 runtime 产物。** r1 让 `console-host/src`、`opencode-adapter/src` 用裸包名是错的：
   `tsconfig.runtime.json` 把这两处源码一并编进 `generated/runtime-lib`（见 include 第 13–15、44–45 行），
   tsc 不会把裸 specifier 改写成相对路径，而 tarball 内没有 node_modules。r2 规定：
   **凡进入 `generated/runtime-lib` 的源文件一律用相对路径**，裸包名只允许出现在不进入该产物的消费者，
   且其交付产物必须自包含。本批进一步收敛为**全部用相对路径**（见 §4），彻底消除该风险类别。
2. **产物路径迁移是真实契约变更，不声称“布局等价”。** r1 说“完全等价”不准确：`rootDir: "."` 会保留相对目录，
   迁移后产物实际落在 `generated/runtime-lib/packages/shared/src/*.js` 与 `.../packages/dagpipe/src/*.js`，
   不再有 `generated/runtime-lib/control-protocol/*`、`.../runtime/dagpipe/*`。r2 显式列出所有真实 consumer 并同步更新（见 §5.3）。
3. **runner 构建入口的 repoRoot 会错一层。** `packages/dagpipe/src/build.mjs` 若沿用 `moduleRoot/../..`
   会解析到 `packages/`，五个 Work graph 与 runnerRoot 全部错位。r2 明确改写 repoRoot 与相关路径（见 §5.2）。
4. **AppSDK 拆分指明唯一可安装交付单元与依赖门禁。** 最终 tarball 仍由 `scripts/package-artifact.mjs`
   产出单一安装单元；拆分的模块是源码/产物准入单位，不产生第二个发布包。compile/verify 仍覆盖完整 tarball 安装回放（见 §6）。

## 1. 目标与非目标

### 1.1 目标

1. AppSDK 治理覆盖 appsdk 与 dagpipe：`.appsdk` 模块登记拆分；dagpipe 编排登记为独立 owner，
   graph 校验与 runner 构建纳入治理门禁。
2. UI 模块化、共用模块：UI 拆成内部模块（client / components / state / styles），
   跨包共用协议与类型抽到共享函数库，UI 只依赖该库。
3. 项目模块化：共享函数库 + 流程编排（dagpipe）+ 独立 UI，三者边界清晰、各自可单测。

### 1.2 非目标

- 不改业务语义、线协议、控制台 API、会话模型。
- 不引入第二套构建/打包、第二套治理骨架或新的运行时生命周期。
- 不改 `control-protocol` / `runtime/dagpipe` 的文件内容（只移动位置与改写 import 说明符）。
- 不实现群组 WebUI 业务功能（另一条任务），本设计只保证结构不挡它。

## 2. 当前锚点（已读、真实存在）

- `control-protocol/` 在仓库根：20 个源文件 + 14 个 `.spec.ts` + `vitest.config.ts`。
- `runtime/dagpipe/`：`host.ts`、`protocol.ts`、`build.mjs`、`fixtures/`、`runner/`（Rust）。
- `tsconfig.runtime.json`：`rootDir: "."`，`outDir: ./generated/runtime-lib`，
  `rewriteRelativeImportExtensions: true`；include 同时含 `runtime/**`、`network/**`、`server/**`、
  `console-host/src/{auth,http-api,server}.ts`、`opencode-adapter/src/{acp-engine,managed-config}.ts`、
  `runtime/dagpipe/host.ts`、`control-protocol/{acp,engine,teams-connection,teams-state}.ts`。
- `ui/teams-console/scripts/finalize-build.mjs`：把 `(?:\.\./)+control-protocol/(x).{ts,js}` 重写为
  指向 `lib/canonical/x.js` 的相对路径，并把编译后的 `control-protocol` 拷进 `lib/canonical`。
- `scripts/package-artifact.mjs`：`import { buildRunner } from '../runtime/dagpipe/build.mjs'`；
  只拷 `generated/runtime-lib`、`console-host/lib`、`console-host/static`、`ui/teams-console/lib|assets`、
  `cli/agentteams.mjs`；tarball 无 node_modules。
- `pnpm-workspace.yaml` 当前只列 `console-host`、`opencode-adapter`、`ui/teams-console`。

## 3. 目标结构

```text
packages/
  shared/                  # @teams/shared —— 共享函数库
    package.json           # name @teams/shared, type module, exports ./src/*.ts 仅用于类型/工具消费
    tsconfig.json          # 独立 typecheck，noEmit
    src/                   # 原 control-protocol 内容整体迁入（含 .spec.ts 与 vitest.config.ts）
    README.md              # 边界说明：不参与运行时打包，运行时由 tsconfig.runtime.json 扁平编译
  dagpipe/                 # @teams/dagpipe —— 流程编排
    package.json
    tsconfig.json
    src/
      host.ts protocol.ts
      build.mjs            # 内部 repoRoot 改为三个 '..'
      fixtures/            # 原样
      runner/              # Rust 原样（Cargo.toml.template / Cargo.lock / src/）
    tests/                 # 原 runtime/dagpipe-build.spec.ts 等
ui/teams-console/
  src/
    client/                # HTTP 客户端、live 客户端、projection 订阅
    components/            # 渲染组件（discovery / networking / interaction / history / drawer）
    state/                 # controller、model、drafts、observation、focus
    styles.ts
    index.ts browser.ts fixture.ts
  scripts/finalize-build.mjs
  tests/
console-host/  opencode-adapter/  runtime/  server/  network/ ...   # 维持，仅改 import 说明符
```

## 4. 导入策略（唯一规则：相对路径）

本批采用**单一规则**：所有消费者都用指向包内源码的相对路径，不使用裸包名。

- 原因：`tsconfig.runtime.json` 的编译闭包包含 `console-host/src`、`opencode-adapter/src`，
  一旦出现 `@teams/shared` 裸 specifier，`generated/runtime-lib` 就会带上无法在 tarball 内解析的 import。
  统一相对路径可让“是否裸名”这个易错判断从流程里消失。
- 具体形式：
  - 仓库根各目录（`runtime/`、`network/`、`server/`、`agent/`、`agent-host/`、`config/`、
    `acp-adapter/`、`dsh-adapter/`、`cli-adapter/`）→ `../packages/shared/src/<x>.ts`
  - `console-host/src/`、`opencode-adapter/src/` → `../../packages/shared/src/<x>.ts`
  - 原 `runtime/dagpipe/*` 迁到 `packages/dagpipe/src/` 后：到 `packages/shared/src` 是
    `../../shared/src/<x>.ts`（`..`→`packages/dagpipe`，`../..`→`packages`）；
    到仓库根 `runtime/agent-work-client.ts` 是 `../../../runtime/agent-work-client.ts`
    （三层，`../../..`→仓库根）。两者深度不同，不能合并成一个前缀。
  - runtime 内的 dagpipe 调用点：`../packages/dagpipe/src/<x>.ts`
  - UI：按**每个调用点的实际深度**计算，不统一套四层。当前只有
    `src/client/{api,protocol}.ts`（深度 4）→ `../../../../packages/shared/src/<x>.ts`，
    与 `tests/{boundary,contract-compat}.spec.ts`（深度 3）→ `../../../packages/shared/src/<x>.ts`；
    UI 内部再拆分组件后，新增文件的深度以实际目录为准逐个计算。
    finalize-build 只改目标目录名，不改变相对层级。
- `packages/shared/package.json` 的 `exports` 只服务包外工具/类型消费，不作为运行时解析契约；
  运行时解析永远由 `tsconfig.runtime.json` 的扁平编译产物承担。

## 5. 构建与打包改动

### 5.1 工作区与类型检查

- `pnpm-workspace.yaml` 增加 `packages/shared`、`packages/dagpipe`。
- 根 `tsconfig.json` include：`control-protocol/**/*.ts` → `packages/shared/src/**/*.ts`，
  增加 `packages/dagpipe/src/**/*.ts`，并保留原其余目录。
- 新增 `packages/shared/tsconfig.json`、`packages/dagpipe/tsconfig.json`（`noEmit`，独立 typecheck）。

### 5.2 runtime 扁平编译与 runner 构建

- `tsconfig.runtime.json` include：
  - 删 `runtime/dagpipe/host.ts` → 增 `packages/dagpipe/src/host.ts`、`packages/dagpipe/src/protocol.ts`
  - 删 `control-protocol/{acp,engine,teams-connection,teams-state}.ts` → 增
    `packages/shared/src/{acp,engine,teams-connection,teams-state}.ts`
  - 其余 include 不变；`rootDir: "."`、`outDir`、`rewriteRelativeImportExtensions` 不变。
  - 结果产物路径：`generated/runtime-lib/packages/shared/src/*.js`、
    `generated/runtime-lib/packages/dagpipe/src/*.js`（其余目录产物路径不变）。
- `packages/dagpipe/src/build.mjs`：
  - `moduleRoot = dirname(fileURLToPath(import.meta.url))`（迁到 `packages/dagpipe/src`）
  - `repoRoot = resolve(moduleRoot, '..', '..', '..')`（三层，回到仓库根）
  - `runnerRoot = join(moduleRoot, 'runner')` 不变；graph 路径基于新 `repoRoot` 仍指向
    `docs/design/dagpipe/graphs/*.graph.json`；构建产物仍写 `packages/dagpipe/src/.build/`
    （`.gitignore` 一并迁移）。
  - 行为测试 `packages/dagpipe/tests/dagpipe-build.spec.ts` 同步 `buildEntry`/`buildParent` 常量。

### 5.3 真实 consumer 同步（r1 遗漏项）

| 文件 | 现状 | 改为 |
| --- | --- | --- |
| `scripts/package-artifact.mjs:5` | `from '../runtime/dagpipe/build.mjs'` | `from '../packages/dagpipe/src/build.mjs'` |
| `scripts/package-sdk-smoke.mjs:242` | `'runtime/dagpipe/host.js'` | `'packages/dagpipe/src/host.js'` |
| `scripts/package-sdk-smoke.mjs:244` | 拼接 `generated/runtime-lib/<rel>` | 同上，rel 用新路径 |
| `cli/package-install.spec.ts:390-397` | 断言 `generated/runtime-lib/control-protocol/*.js` 与 `runtime/dagpipe/host.js` | `generated/runtime-lib/packages/shared/src/*.js`、`packages/dagpipe/src/host.js` |
| `.appsdk/project.json:121-128` | artifact_paths 指向旧 `control-protocol/*.js`、`runtime/dagpipe/*.js` | 指向新 `packages/shared/src/*.js`、`packages/dagpipe/src/*.js` |
| `vitest.config.ts:21` | `'control-protocol/*.spec.ts'` | `'packages/shared/src/*.spec.ts'` |
| `vitest.config.ts` include | 无 `packages/dagpipe` | 增 `'packages/dagpipe/tests/**/*.spec.ts'`（测试已迁出 `runtime/`，原 `runtime/**/*.spec.ts` 不再覆盖） |
| `docs/architecture/*.json` | 多处 `command` 里的 `control-protocol/x.spec.ts` | `packages/shared/src/x.spec.ts`（仅改命令路径，不改 gate 语义） |

`scripts/installed-runtime-smoke.mjs` 的 `packRoot` 与 `package-artifact` 输出目录不变，无需改动。

### 5.4 UI

- `ui/teams-console/scripts/finalize-build.mjs`：
  - `compiledCanonicalRoot = resolve(temporaryRoot, 'packages', 'shared', 'src')`
  - `canonicalSpecifier` 正则匹配 `(?:\.\.\/)+packages\/shared\/src\/([\w./-]+)`，
    改写目标 `lib/canonical/<x>.js`。
- UI 内部拆分（client / components / state / styles）只做文件移动与相对 `./` 引用，
  不改变导出面与 DOM 契约。

## 6. AppSDK 治理改动

- 最终可安装交付单元只有一个：`scripts/package-artifact.mjs` 产出的
  `generated/modules/<pack>/lib` 完整 tarball；本批不新增第二个发布包。
- `.appsdk/project.json` 的 `modules` 调整：
  - **`teams-source` 保留为完整交付/安装准入单元**（`active_artifact`
    `generated/modules/teams-source/lib`、`package-receipt.json`、安装回放仍归它），
    不删除、不改名。
  - 新增源码/产物切片模块作为它的依赖单位：
    - `teams-shared`（owner `packages/shared`）：协议与编解码
    - `teams-dagpipe`（owner `packages/dagpipe`）：编排 host/protocol/runner、graph 校验
  - 既有 `teams-runtime`、`teams-console-host`、`teams-ui`、`teams-adapter` 若已存在则只随迁移
    更新 `owned_paths` 与 `artifact_paths`；不存在则不新造，避免与 `teams-source` 重复承担安装准入。
  - 每个切片模块的 `artifact_paths` 只指向同一 tarball 内的产物切片；完整安装准入仍由
    `teams-source` 的 `active_artifact` 与 §7 安装回放承担，compile/verify 不会退化为只验证局部。
- 五个 architecture map 同步更新受影响路径与 owner，不新增无关条目。
- dagpipe 的 `dagpipe graph validate` 与 runner 构建登记为 `teams-dagpipe` 必过门禁。

## 7. 验收（含打包产物到安装入口）

1. 类型检查：`pnpm typecheck`；`pnpm --dir packages/shared exec tsc --noEmit`、
   `pnpm --dir packages/dagpipe exec tsc --noEmit`。
2. 运行时编译：`pnpm build:runtime` 成功；确认产物含
   `generated/runtime-lib/packages/shared/src/*.js` 与 `.../packages/dagpipe/src/*.js`，
   且 **不含** 任何 `@teams/shared` / `@teams/dagpipe` 裸 specifier（`grep -r` 校验为 0 命中）。
3. UI 构建：`pnpm --dir ui/teams-console build` 成功；`lib/canonical` 含共享库编译结果；
   UI 产物内无 `@teams/shared` 裸 specifier。
4. 回归：`pnpm test`（`build:runtime` + adapter build + `scripts/regression.mjs`）通过；
   保留现有回归的语义与断言，仅同步迁移路径；不把“304+ 数量不降”当作行为验收。
   另用测试发现清单（`pnpm exec vitest list`）确认迁移后的原 suite 仍被执行，
   至少包括 `packages/shared/src/*.spec.ts` 与 `packages/dagpipe/tests/dagpipe-build.spec.ts`。
5. 安装回放（必过）：复用现有 `scripts/package-install`、`scripts/package-sdk-smoke.mjs`、
   `scripts/installed-runtime-smoke.mjs`：隔离安装 tarball、脱离仓库 node_modules/workspace 链接，
   加载实际 runtime / Console / UI，并用真实 consumer 覆盖 Work runner 与五个 graph 路径。
   产物中不得残留无法解析的 `@teams/shared` 或 `@teams/dagpipe`。
6. 治理：`node scripts/appsdk.mjs guide compile`、`node scripts/appsdk.mjs compile`、
   `pnpm smoke`、`node scripts/appsdk.mjs verify` 通过。
7. 构建链 DAG：在既有映射中补齐 构建→编译→UI finalization→package artifact→安装→公开入口
   的目录边与失败出口，不新建无关治理图。

## 8. 风险与回退

- 风险：相对 import 漏改某处 → tsc 直接报错，属显式失败，不会静默通过。
- 风险：`build.mjs` 的 repoRoot 少改一层 → `dagpipe-build.spec.ts` 立即失败，属显式失败。
- 风险：consumer 路径漏改 → 安装回放门禁失败，属显式失败。
- 回退：本批不做兼容双路径；若需分阶段，可在同一里程碑内先落 shared 再落 dagpipe，
  但旧 `control-protocol/` 目录在全量切换后删除，不保留无 consumer 的兼容分支。
- 所有改动在主树只读；仅在 `/Volumes/Intel/playground/agentteams/modular-monorepo` 实施。

## 9. 实施记录（r3 落地）

结构已按 §3 落地，语义不变，只改路径与归属：

- `control-protocol/` → `packages/shared/src/`（31 项整体迁入，含 `.spec.ts` 与 `vitest.config.ts`），
  新增 `packages/shared/{package.json,tsconfig.json,README.md}`；`pnpm --dir packages/shared test`
  用 `src/vitest.config.ts`，109 例通过。
- `runtime/dagpipe/` → `packages/dagpipe/src/`，`runtime/dagpipe-build.spec.ts` →
  `packages/dagpipe/tests/dagpipe-build.spec.ts`；`build.mjs` 的 `repoRoot` 改为三个 `..`，
  产物仍写 `packages/dagpipe/src/.build/`。
- UI 按 §3 拆成 `src/client/`（api、live-client、protocol、locale）、`src/components/`
  （render、page-networking）、`src/state/`（controller、model、drafts、observation、focus）、
  `src/styles.ts` 与 `src/mount.ts`（原 `client/index.ts`）；`index.ts`、`browser.ts`、
  `fixture.ts` 不动，公开入口不变。
- 导入：全部相对路径，无 `@teams/*` 裸 specifier。`packages/shared/src/engine.ts` 到仓库根的
  深度是三层，已按实测定为 `../../../config/*.ts`。

验收证据（本候选实测）：

| 项 | 结果 |
| --- | --- |
| `pnpm test`（build:runtime + adapter build + regression） | 144 文件 / 1447 例全通过，0 失败 |
| `pnpm typecheck`（根 + adapter + console-host + UI） | 通过 |
| `pnpm --dir ui/teams-console build`、`test` | 构建通过；13 文件 / 66 例通过 |
| `generated/runtime-lib` 裸名扫描 | `@teams/` 0 命中；产物落在 `packages/shared/src/*.js`（16）与 `packages/dagpipe/src/*.js`（2） |
| UI `lib` 裸名扫描 | `@teams/` 0 命中；`lib/canonical` 自包含 |
| `node scripts/appsdk.mjs compile` / `verify` / `guide compile` | 均 EXIT 0（`verify` 报 `delivery_not_evaluated`，属未做发布评估的既有状态） |
| `pnpm smoke` | artifact-smoke 与 runtime-smoke 通过 |
| `pnpm smoke:installed` | 安装回放通过：tarball 在源树外安装，installed CLI/Relay/Agent/Console 入口与 SDK consumer 全绿 |

AppSDK 契约的实际约束（与 §6 预期的差异，按 SDK 真实规则收敛）：

- `dependency_modules` 要求被依赖模块的产物先于本模块构建。切片产物在 `teams-source`
  的 tarball 内，声明依赖会构成环，SDK 报 `MODULE_DEPENDENCY_ARTIFACT_STALE`。
  因此三个模块改为平级：`teams-source` 保留安装准入与全部产物路径，
  `teams-shared`（owner `packages/shared/**`）与 `teams-dagpipe`（owner `packages/dagpipe/**`）
  只管各自的源码切片与类型检查门禁，`dependency_modules` 为空。
- `owned_paths` 不允许重叠（`OVERLAPPING_MODULE_OWNERSHIP`），故 `teams-source`
  不再声明 `packages/**`；切片的 `artifact_paths` 仍指向 `generated/modules/teams-source/lib/...`。
- 模块在 `modules` 数组中的顺序即构建顺序，切片排在 `teams-source` 之后。

构建链 DAG 落在 `docs/architecture/mainline-call-map.json` 的
`build-and-package-chain-v1` 链：构建 → 编译 → UI finalization → package artifact → 安装 → 公开入口，
四条目录边 + `required_gates`（`teams-source-typecheck`、`teams-compiled-library-smoke`、
`teams-package-install`、`teams-source-artifact`、`teams-dagpipe-runner-build`、
`teams-work-sdk-installed`、`teams-static-ui-replay`）作为失败出口，未新建无关治理图。

### 提交前阻塞（验收仲裁通道）

代码与门禁已全部就绪，但本里程碑的提交仍在等验收官 Alice 的仲裁，仲裁通道在实施期间失效：

- 我的 collab 身份绑定里保存的网关命名空间是 `rt-c71a724c-2e6e-4d0c-800a-6198b9a1b98a`；
  DSH 网关在 2026-10-23 21:37 重启后当前运行时是 `rt-21a037a7-5ed8-4cbd-ac5c-8256709894a1`，
  `register-peer` 对旧运行时返回 `unknown-runtime`。
- 同时当前网关的能力集是 `agent.list`、`agent.get`、`agent.notify`、`agent.interrupt`、
  `event.agent-status`，已不含 collab 期望的 `enqueue_wake` 与 `agent_facts`（实测两个方法均返回
  `unknown-op`），collab 因此判定 `IDENTITY_RESTORE_CONFLICT: DSH communication API differs from the current binding`。
- `collab context`、`--provide`（新旧两种锚点写法）、`--recover-communication`、`--op` 续跑均返回同一冲突；
  按职责边界未重启 collab daemon，也未手改身份绑定。

恢复条件：宿主把 collab 服务与当前网关版本对齐（或恢复网关的 `enqueue_wake`/`agent_facts`），
之后 `collab context` 一次即回到正常，再按流程完成仲裁与提交。候选取证不受影响：
所有改动已 staged 在 `feat/modular-monorepo` 分支，`pnpm verify`、`pnpm smoke:installed`、
`appsdk compile|verify` 均为本候选实测结果。

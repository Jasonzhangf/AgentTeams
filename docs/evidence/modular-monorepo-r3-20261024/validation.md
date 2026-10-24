# modular-monorepo r3 实施与验收证据

候选：worktree `/Volumes/Intel/playground/agentteams/modular-monorepo`，分支 `feat/modular-monorepo`，
基线 `origin/main` 89cd91d。设计：`docs/design/modular-monorepo-v1.md`（r3，验收官定向复核 PASS）。

## 1. 本轮修复：新 workspace 包的锁文件 importer

验收仲裁 P1：`pnpm-workspace.yaml` 新增 `packages/shared`、`packages/dagpipe` 后未同步
`pnpm-lock.yaml`，干净 checkout 的 `--frozen-lockfile` 安装失败。

修复：用项目入口 `pnpm install --lockfile-only --ignore-scripts`（pnpm 10.31.0）同步锁文件。

```text
pnpm-lock.yaml | 24 +++++++++++++++++++++++
```

diff 只新增两个 importer 段，三段依赖版本全部复用既有解析：

| importer | @types/node | typescript | vitest |
| --- | --- | --- | --- |
| `packages/dagpipe` | 22.20.1 | 6.0.3 | 4.1.11 |
| `packages/shared` | 22.20.1 | 6.0.3 | 4.1.11 |

包条目对比（`packages:` 段键集合）：新增 0、删除 0，无版本漂移。

冻结安装证据（临时目录，只复制根清单、workspace 配置、锁文件与 5 份 workspace 清单）：

```text
$ pnpm install --frozen-lockfile --lockfile-only --ignore-scripts --offline
Scope: all 6 workspace projects
Done in 190ms using pnpm v10.31.0      # EXIT 0

$ pnpm install --frozen-lockfile --ignore-scripts --offline
Scope: all 6 workspace projects
Progress: resolved 97, reused 97, downloaded 0, added 97, done
Done in 850ms using pnpm v10.31.0      # EXIT 0；packages/{shared,dagpipe}/node_modules 均已链接
```

## 2. 受影响验证（只补 importer，无版本变动）

```text
pnpm --dir packages/shared typecheck    # EXIT 0
pnpm --dir packages/shared test         # 13 文件 / 109 例通过
pnpm --dir packages/dagpipe typecheck   # EXIT 0
pnpm --dir packages/dagpipe exec vitest run tests   # 21 文件 / 141 例通过
```

## 3. 里程碑既有证据（同一候选，复用）

| 门禁 | 结果 | 原始日志 |
| --- | --- | --- |
| `pnpm verify`（test+typecheck+guide compile+compile+smoke+appsdk verify） | EXIT 0 | `/tmp/verify2.log` |
| `generated/validation/regression.json` | success=true，144 文件，1447 通过 / 0 失败 / 0 跳过 | 同上 |
| `pnpm smoke:installed`（隔离安装回放） | EXIT 0，installed CLI/Relay/Agent/Console 入口 + SDK consumer 全绿 | `/tmp/install-replay.log`，回执 `generated/u1-receipts/1792817225700-31574/installed-runtime-smoke.receipt.json` |
| `appsdk compile` | EXIT 0 | `/tmp/appsdk-final.log` |
| `appsdk verify` | EXIT 0，`delivery_not_evaluated` | `/tmp/appsdk-verify-final.log` |

`delivery_not_evaluated` 的边界：这是 SDK 对发布评估的既有状态，说明契约绑定与命令有效，
不表示交付闭环，也不替代安装到真实用户环境的验收。模块依赖调整（shared/dagpipe 与
teams-source 平级）由 `appsdk compile`/`verify` 与 `smoke:installed` 的实际构建和安装回放核对，
不从 `compile` 的退出码推导全交付闭环。

## 4. 迁移只搬不改

逐文件比较 `HEAD` 原路径与现路径的差异行，非 import 改动为 0：

| 迁移 | 文件数 | 非 import 改动行 |
| --- | --- | --- |
| `control-protocol/` → `packages/shared/src/` | 31（含 13 spec） | 0 |
| UI `client/*` → `components/` `state/` `styles.ts` `mount.ts` | 9 | 0 |
| `runtime/dagpipe/{host,protocol}.ts` → `packages/dagpipe/src/` | 2 | 0 |

`packages/dagpipe/src/build.mjs` 唯一实质改动是 `repoRoot` 由两层改三层（3 行），与设计 §5.2 一致。

## 5. 测试发现

`pnpm exec vitest list` 命中 `packages/shared/src/*.spec.ts` 与
`packages/dagpipe/tests/dagpipe-build.spec.ts`；`regression.json` 的 144 条 testResults 同时包含
`packages/dagpipe/tests/dagpipe-build.spec.ts` 与 `runtime/dagpipe-work.spec.ts`，
迁移后的构建回归未被漏发现。

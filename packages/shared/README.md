# @teams/shared

Teams 共享函数库：ACP 帧、engine adapter port、Teams 协商 frame、连接状态 DTO、
Console 线材、Work 线材、relay 编解码与 JSON 值边界。所有运行时、Console Host、
adapter 与 UI 都从这里取同一份语义实现，不各自复制。

## 边界

- 本包是源码库，不是运行时打包单位。`pnpm build:runtime` 由根
  `tsconfig.runtime.json` 扁平编译整个闭包，产物落在
  `generated/runtime-lib/packages/shared/src/*.js`；npm tarball 里没有 `node_modules`，
  也没有独立安装的 `@teams/shared`。
- 消费者一律使用指向 `packages/shared/src/<x>.ts` 的相对路径，不使用 `@teams/shared`
  裸 specifier。裸名会让 `generated/runtime-lib` 在安装副本里无法解析。
- 相对深度：仓库根各目录用 `../packages/shared/src/`；`console-host/src`、
  `opencode-adapter/src` 用 `../../packages/shared/src/`；UI `src/client`、`src/components`、
  `src/state` 用 `../../../../packages/shared/src/`，UI `tests` 用
  `../../../packages/shared/src/`。
- `package.json` 的 `exports` 只服务包外工具与类型消费，不是运行时解析契约。

## 命令

```bash
pnpm --dir packages/shared typecheck   # 独立 noEmit 类型检查
pnpm --dir packages/shared test        # 13 个 spec，109 例
```

根 `pnpm verify` 已经覆盖本包的 spec（`vitest.config.ts` 的
`packages/shared/src/*.spec.ts`），这里的两条命令只用于改动本包时的快速回路。

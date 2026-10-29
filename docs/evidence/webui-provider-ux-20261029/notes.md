# WebUI 状态带本地化与 provider 配置/重试交付 — evidence notes

- Date: 2026-10-29
- Delivered head: `f58f6a9` on `main` (`origin/main` 已核对一致)
- Base: `b4cca1b`
- Worktree: `/Volumes/Intel/playground/agentteams/integration-provider-ux-20261029`（已关闭）

## 本轮范围

- 承接分支 `integration-provider-ux-20261029` 的既有三条线：配置以 `config.toml` 为唯一真源、
  provider 错误有界重试（拒绝 401/403 与已输出回合重放）、WebUI 桌面/移动端 UX 修复（F1/F2/F3）。
- 本轮补一处遗漏：发现页四条状态带把 owner 原始 token 直接显示在中文界面，且没有标签。
  现改为本地化标签与状态文案；`data-team-band` 和 `data-band-state` 保留原始 token，黑盒读取方式不变。
  样式改为卡片栅格，520px 以下两列。
- 变更文件：`ui/teams-console/src/client/locale.ts`、`src/components/render.ts`、`src/styles.ts`、
  `tests/locale.spec.ts`（新增本地化断言）。

## 验证证据

1. UI 定向测试：`pnpm --filter @deepseek-ai/teams-console test` → 23 文件，159 passed，0 failed，exit 0。
2. UI 类型检查：`pnpm --filter @deepseek-ai/teams-console typecheck` → exit 0。
3. 根类型检查：`pnpm typecheck`（main 检出，合并后）→ exit 0。
4. 构建：`pnpm build:governance` → exit 0，final pack root `generated/modules/teams-source/lib`。
5. 编译库 smoke：`pnpm smoke` → Packaged Console smoke 与 Packaged runtime smoke 均 passed。
6. 全量回归：`pnpm test` → `generated/validation/regression.json`：382 套件、1714 条通过、0 失败/挂起。
7. 安装包黑盒：`node scripts/blackbox-user-mvp.mjs --case BB08,BB09,BB10` → 3 例全 passed，exit 0；
   回执 `/Volumes/Intel/playground/agentteams/.worker-runs/provider-config-single-source-20261029/receipts/final-f58f6a9-bb08-bb09-bb10.json`。
   BB09 覆盖安装版 Console 生命周期与中文回执文案，BB10 覆盖显式 provider/model Session（RCC 4444）。

## Review 边界

- 基础候选由 `review-provider-ux-20261029` 首轮 review 给出 2 条重试 P1；修复后
  `review-retry-fixes-20261029` 覆盖全部模块（config、observation、WebUI 无阻断），仍判 2 条重试 P1；
  再次修复后 `review-retry-fixes-r2-20261029` 对所涉 finding 判 PASS。
- 状态带本地化是本 milestone 内的呈现小修，不改协议、owner 或数据；未单独起 review。

## 边界声明

- 证据止于本机安装包与真实本地入口（Relay、Console、真实 Chrome、RCC 4444 本地推理端点）。
  不证明公网/NAT、跨设备、managed OpenCode 部署或移动真机。
- 未声明 `pnpm verify` 全链；本轮实际执行的是第 1–7 项所列命令。

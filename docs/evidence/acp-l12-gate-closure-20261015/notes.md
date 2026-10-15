# L12 门禁按证据升级与地图收口 —— 证据（2026-10-15）

## 结论

L12 未升级任何门禁。14 个 `teams-acp-*` 门禁在候选 `4d3ffe5` 上按其自身命令
全量重跑，13 个通过，D08 黑盒因远端 provider 限流停在 A02。所有门禁的未闭合项
均未消除，按不变量全部保留 `partial`。五张 map、两份 design、governance 与三处
历史证据的措辞已按 L9 notes §11 的 7 条 advisory 收紧并写入行内标记。

## 重跑记录（同树 4d3ffe5，build 与 typecheck 先通过）

| gate | 命令文件数 | 结果 | 退出码 | 日志 |
| --- | --- | --- | --- | --- |
| teams-acp-daemon-intent | 2 | 35 passed | 0 | gate-teams-acp-daemon-intent.log |
| teams-acp-public-contract | 3 | 17 passed | 0 | gate-teams-acp-public-contract.log |
| teams-acp-d01-host | 4 | 61 passed | 0 | gate-teams-acp-d01-host.log |
| teams-acp-d02-opencode | 4 | 65 passed | 0 | gate-teams-acp-d02-opencode.log |
| teams-acp-d03-dsh | 3 | 58 passed | 0 | gate-teams-acp-d03-dsh.log |
| teams-acp-d04-registry | 6 | 75 passed | 0 | gate-teams-acp-d04-registry.log |
| teams-acp-d05-network | 11 | 103 passed | 0 | gate-teams-acp-d05-network.log |
| teams-acp-d06-control | 7 | 143 passed | 0 | gate-teams-acp-d06-control.log |
| teams-acp-d07-webui | 13 | 66 passed | 0 | gate-teams-acp-d07-webui.log |
| teams-acp-serve-entry | 3 | 68 passed | 0 | gate-teams-acp-serve-entry.log |
| teams-acp-l9-intent-side | 4 | 72 passed | 0 | gate-teams-acp-l9-intent-side.log |
| teams-acp-l9-session-write-side | 4 | 81 passed | 0 | gate-teams-acp-l9-session-write-side.log |
| teams-acp-l10-session-projection | 6 | 86 passed | 0 | gate-teams-acp-l10-session-projection.log |
| teams-acp-d08-acceptance | 黑盒 | FAIL，见下 | 1 | gate-teams-acp-d08-acceptance.log |

同树 `pnpm build` 退出码 0（build.log），`pnpm exec tsc --noEmit` 退出码 0
（typecheck.log）。

## D08 黑盒：A02 DSH prompt 处外部限流

11 项子断言 PASS：install（final 包 271 files、tarball 装进树外 prefix、
installed 副本暴露编译模块）、A01 六项（一 config 一 daemon、身份/存储/IP
独立、installed CLI 读回、一 config 不启第二个）、A02 两项（两引擎是真实子进程、
OpenCode 完成真实 prompt/process/reply）。A02 DSH prompt 被网关拒绝：

```
HTTP 400 {"code":"model_unavailable","gateway_hint":"model_blocked: 13 account(s)
cooling down this model; earliest unblock at 2026-10-16T02:00:01+08:00; ..."}
```

A03–A11 未执行。同一 run 的 OpenCode prompt 完成，证明被验链路可用，阻塞是外部。
D08 门禁保持 `partial`；其 2026-10-12 的 45 checks / 3 gaps / exit 0 记录不变。

## 构建前置（环境，非缺陷）

新 worktree 缺少 `console-host/static` 与 `ui/teams-console` 编译产物时，
spawn 出的 control 子进程在写 state 前于 `presentationRoots()` 抛错
（`runtime/control-process.ts:1096`，抛错在 try 块外），父进程 `waitForState`
一直读到 `starting` 并 `START_TIMEOUT`。`pnpm build` 退出码 0 后
`runtime/control-process.spec.ts` 27/27。已写入 D06 门禁 note 与 governance。

## 计数纠正（新树，非范围变化）

- d01-host：旧 53/53 → 现 61（同命令，更大树；L9/L10 加 case）。
- d06-control：旧 119/119、135/135 → 现 143（control-process 17→27、host 23→27）。
- l9-session-write-side：旧 77/77 → 现 81（同上）。
- d04-registry、d05-network、l9-intent-side、l10 计数与记录一致，无需纠正。
- d07-webui 收窄后重跑：首次 L12 只跑了记录命令 13 个文件中的 6 个（29 用例），
  漏掉 7 个快速非 DOM spec（controller 17、model 8、live-client 4、observation 3、
  page-networking 2、drafts 2、locale 1），该 6/29 不是本门禁结果。已用完整记录命令
  重跑，66/66 通过，13 文件与记录基线一致，退出码 0。此收窄与纠正在门禁 note、
  verification.json、本文件与 governance 表均已披露。

## map / design / governance 收口

- verification-map.json：14 个门禁 note 追加 2026-10-15 标记，状态全保持 partial。
- development-governance.md：追加 L12 收口段（全量重跑 + 不变量 + D08 外部限流
  + 构建前置 + AppSDK pin 未变）。
- resource-map.json `acp-frame-contract`：收尾句按本 gate 范围收紧。
- mainline-call-map.json：`provider-config-v1` master-host edge 的「production
  daemon binding remains pending」更正为已绑定；`acp-host-wiring-v1` chain note
  收尾句按本 chain gate 范围收紧。
- design docs 状态段：「当前源码尚未实现本协议」「仅有部分状态组件与旧 Console
  HTTP 原型」更正，并限定未实现范围。
- 三处历史证据行内 2026-10-14 标记：D05 notes 第 2/4/5/6 项、D08 verification
  `.gaps[2].reason`、D07 notes:122。

## 未闭合项（保留，交后续）

- D08：A07 事件驱动动画、installed 层 DOM、L10 的 sessionEvents/permission 身份
  /notification title；DSH prompt 待 provider 冷却窗口后重跑（2026-10-16 02:00 UTC+8）。
- 14 门禁各自的 installed-copy/restart/deployed-entrypoint/cross-device 回执。
- AppSDK compile/verify：仍被既有 `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0014` 阻塞。
- 10 个 PROTECTED_HOLD worktree 的 EXTRACT_THEN_CLOSE 决定（见 resource-inventory.md）。

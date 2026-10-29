# WebUI 移动端与交互验收发现（2026-10-29）

驱动：`black-box-session-loop.mjs`（`E562_EXTRA_PATHS=1`），95/95 检查通过。
回执：`receipt-extra-paths.json`；截图：`mobile-pending-permission.png`、`mobile-discovery.png`。

驱动覆盖了真实安装包 + 真实 control daemon + 真实 OpenCode agent daemon + 真实 Chrome 下的
三条新增路径：浏览器点击 Reject、浏览器点击 Allow always、390x844 移动端视口。
几何断言全部通过（无文档横向溢出、三个权限按钮均有可点击区域、composer 与抽屉在视口内）。

但人工看图后确认三处真实 UX 缺陷。几何断言不足以发现它们，故单列。

## F1 状态行向用户展示原始 JSON 与英文动作名

- 现象：发送消息后页面底部状态行显示 `Send message: {"acceptedRevision":14}`。
- 位置：`ui/teams-console/src/state/controller.ts:194` `actionResult()` 返回
  `${label}: ${JSON.stringify(result.result)}`；由 `ui/teams-console/src/components/render.ts:1140`
  `renderStatus` 写入用户可见的 live region。
- 影响：用户看到内部修订号 JSON，且中文界面里出现英文 `Send message:`。

## F2 时间线事件头重复显示同一状态

- 现象：事件头显示 `MESSAGE user completed completed`。
- 位置：`ui/teams-console/src/components/render.ts:51` `sessionEventTitle()` 已返回
  `${event.role} ${event.state}`，`render.ts` 又在同一 `eventHeader` 追加
  `statusPill(event.state)`（见 `eventHeader` 组装处），状态出现两次。
- 影响：message/part/tool/final 四类事件都存在重复状态词，噪音大。

## F3 390px 移动端布局缺陷

- 现象一：交互页通知行的“确认”(Acknowledge) 按钮溢出所在行，压在 tab 下划线上
  （`mobile-pending-permission.png`）。
- 现象二：发现页 / Agent 抽屉在 390px 下出现大片空白，抽屉压住 tab 条，agent 名列被挤成
  多行窄列（`mobile-discovery.png`）。
- 影响：手机上主要操作路径可读性差、按钮误触风险高。

## 结论

桌面 once 路径、移动端渲染通路、Reject 与 Allow always 决策路径的功能语义均已验证通过。
以上三处属于前端呈现与文案质量，需产品/设计侧确认修复方案后再改代码。

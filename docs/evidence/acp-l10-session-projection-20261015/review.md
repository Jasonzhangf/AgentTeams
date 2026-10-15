# L10 independent review

## 1. 这次 review 是什么

- **审查对象**：本 worktree 的候选提交 `2349be7`（代码与地图 tip）+ `97c0e00`（证据提交），
  base 为 `origin/main` `83496b7`。审查范围是 `git diff 83496b7..97c0e00` 的全部内容，加上
  `recon.md` / `design.md` / `notes.md` / `verification.json` / `receipt.json` 与 L9 前序记录。
- **审查者**：`openai-codex/gpt-6.1-sol`，全新上下文，**未运行任何测试**（作者已跑并记录），
  只读代码、地图和证据，并独立复核了作者声称的测试结果之间是否自洽。
- **独立性**：审查者没有参与本单元的观察、设计或实现；作者自检与黑盒验收在派发 review 之前
  已完成（项目合同要求）。
- **判定**：**FAIL**，2 minor + 4 advisory。核心交付被判为正确（owner 边界、单写者单读者、
  无 control→agent 通道、无 Console relay、无协议变更、外来/错配记录被拒绝）。

## 2. 两条 minor（阻断项）与收口

### minor 1：stop 时空观测可能被在飞的轮询写抢走

- **位置**：`runtime/session-observation-publisher.ts:114`，调用点 `runtime/acp-serve.ts:1574`
  （500 ms 轮询）与 `:1619`（stop 时的发布）。
- **理由**：`publish()` 没有重入保护，`clearInterval` 不能取消已经开始的 pass。若轮询 pass 的
  写在 stop pass 读到同一 revision 之后、store 内部读旧内容之前落盘，stop pass 会得到
  `REVISION_CONFLICT`、记录拒绝并置 `seeded=false` 后直接返回，于是**停掉的 daemon 的非空观测
  留在盘上继续被投影**，与本单元已交付的验收项「停掉的 agent 行消失」以及 `acp-serve.ts:1615`
  的注释矛盾。另一交错下两次 rename 携带同一 revision，陈旧观测可能最后落盘。
- **修法**：publisher 改为一次只跑一个 pass，后到的调用串到在飞 pass 之后；`stop()` 的 pass 因此
  一定排在轮询 pass 之后。`stop()` 处不再 `.catch()`，因为 pass 本身永不 reject。
- **红测**：`runtime/session-observation-publisher.spec.ts`「serializes overlapping passes…」
  用「第一次读有 Session、第二次读没有」的假 host 并发调用两次 `publish()`。去掉串行化后该用例
  失败：`AssertionError: expected 1 to be 2`（陈旧非空观测留在 revision 1）。恢复后 7/7 绿。

### minor 2：F4 只关了一半，却有四处宣称已关闭

- **位置**：`config/relations-intent-store.ts:203/214/244`（本次 diff 未触及），
  而 `notes.md:84`、`verification.json:94`、`function-map.json:2222`、
  `module-registry.json:203` 都宣称 F4 的重复持久写 helper 已关闭。
- **理由**：`config/durable-record.ts` 只从 session-intent-store 抽出，relations store 仍自带
  字节级相同的 `discard` / `uncertainty` / `persist`；地图是语义 owner，该陈述不成立。
- **修法**：把 `config/relations-intent-store.ts` 迁移到 `writeRecordAtomically`，删除三处重复
  实现；`config/durable-record.ts` 的文档同步改为「config/ 下每个 record store 共用的唯一实现」。
- **受影响验证**：`config/relations-intent-store.spec.ts` + `runtime/relations-intent-watch.spec.ts`
  18/18 exit 0；L9 intent-side 门命令（4 文件）72/72 exit 0。行为未变，测试结论一致。

## 3. 四条 advisory 与收口

1. `verification.json` 曾称 `sessionEvents` 的缺席在 `control-session-projection.spec.ts` 里被
   断言，而该 spec 没有这条断言 → 改为「黑盒在真实 `/api/v1/projection` 上断言缺席；控制 daemon
   组装投影的位置（`runtime/control-process.ts:939`）本身不含 `sessionEvents` 键」。
2. `verification-map.json` 的 L10 门曾宣称覆盖「引擎结束的通道」，而当时只有 `host.close` 用例
   → 新增 `agent-host/acp-host.spec.ts`「reports no Session after the engine ends the channel it
   owns」，并反过来做消融：删掉 `releaseSessions` 的 `channel.sessions.clear()` 会让两条用例
   一起失败，所以该声明现在有用例支撑。
3. 单 home / 单 account / 单 scope 的限制未进 L10 保留项 → 写入 `notes.md` §7.5 与
   `verification.json` 的 gaps / retained_obligations。
4. `sessionObservation.failures()` 只被 handle 暴露、没有生产读者 → 写入 retained_obligations，
   并把 `acp-serve.ts` 的注释改为「pass 永不 reject，拒绝记录在 handle 上供读者读」。

## 4. 审查者确认无误的部分

owner 边界（`openedSessions()` 只读非关闭通道真正持有的 `channel.sessions`，没有第二事实源）；
归属（读侧同时校验由声明 peer 派生的路径与记录内 `agentId`，外来记录永不投影）；持久写纪律
（mode-0600 临时文件 + rename、CAS on revision、`REVISION_CONFLICT` 只重对齐不猜测覆盖、损坏记录
是有类型的抛出且永不修复）；生命周期顺序（`local.close()` 关闭每个活跃通道先于 stop 发布）；
两个网络 wrapper 是纯转发；证据诚实（`gate-l10.log` 与实际计数一致、`receipt.json` 31/31、
`pnpm verify` 阻塞与全量回归不绿都如实写明）。

## 5. 复审

上述 6 项按「finding 修复后只补受影响验证并复核该 finding」处理：修复提交为 `TO_BE_FILLED`，
同一审查者被再次派发，只复核这两个 minor 的修法与红测、四条 advisory 的收口，以及修复是否引入
新的 owner/边界问题；不重跑全量测试，因为修复只影响 publisher 的并发调度、一个 config store 的
内部实现、一个只读方法的一处冗余过滤与文档/地图陈述。

**复审结论**：待填（本轮修复提交后派发）。

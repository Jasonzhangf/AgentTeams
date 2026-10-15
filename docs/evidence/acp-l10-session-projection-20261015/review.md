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

## 5. 复审（两轮，结论都写在这里）

修复提交是 `4e5b77e`，其后是证据提交 `5403cca`。按「finding 修复后只补受影响验证并复核该
finding」，修复后只做**针对性复核**，不重跑全量测试。

### 第 2 轮（复核 `97c0e00..5403cca`）

结论 **FAIL，2 minor + 2 advisory**。它确认第 1 轮的两条 minor 与四条 advisory **都已真正关闭**
（publisher 串行化让 stop 发布一定排在在飞 pass 之后；relations store 的迁移逐字节保持原消息与
fence 形状；sessionEvents 的缺席由黑盒与投影字面量共同绑定；引擎结束通道有了真实用例；限制与
`failures()` 的形态都进了保留项）。

它同时指出两件本轮自己的问题：

1. **作者在同一 diff 里删掉 `openedSessions()` 的 `closed` 过滤是错的**。`close()` 先置
   `channel.closed = true`，**之后**才 `await` 持久 settle，最后才 `releaseSessions`；这两个
   await 是真实 I/O，所以在那个窗口里读者会看到一条已关闭通道仍然列着它的 Session id。
   作者原来的消融（删掉过滤跑测试，测试不失败）是因为**测试没有覆盖这个窗口**，不是过滤不可达。
   修法：过滤按原意恢复（理由改为与 `channelForSession`、`pendingPermissions` 一致），并新增
   `agent-host/acp-host.spec.ts`「reports a closed channel as holding no Session while its close
   is still settling durably」：用一个保持 append 挂起的 gate 让 settle 卡在窗口里，再采样
   `openedSessions()`。删掉过滤后该用例失败（`expected [ 'session-1' ] to deeply equal []`）。
2. **声称的「72 passed / 4 files」没有任何日志**。作者先跑了两文件（18）并把它写成了
   `gate-l9-intent-side-rerun.log`，随后又把四文件的数字挂到同一个文件名上。修法：四文件命令重跑
   并单独留存 `gate-l9-intent-side-4files.log`，两处指针改成它。

两条 advisory 同轮收口：`review.md` 不再留 `TO_BE_FILLED` /「待填」占位（本节就是结论所在），
`notes.md` 不再把 publisher 的**排队**说成与 `createPollingProjectionSubscriber` 的
**丢弃**同惯例——排队是因为 stop 那次发布不能被丢弃，代价是一个 500ms tick 在 pass 在飞时再排一个
pass，而排队到的 pass 一般在「无变化」比较处立即返回、不做任何 I/O。

### 第 3 轮（复核第 2 轮的两条修法，`5403cca..874252c`）

结论 **FAIL，2 minor + 3 advisory，全部落在证据文本的计数与标注上**；该轮同时逐条确认第 2 轮的
两条 minor 与两条 advisory 已真正关闭，并独立核对 `close()` 的顺序（置 `closed` → 两条持久
settle → `releaseSessions`）证明恢复的过滤**必要**、关闭窗口用例**确定性**地采到窗口且红测信息
与作者声称一致、四文件门日志真实且被四处引用。

它揭出的问题是作者写错的数：`agent-host/acp-host.spec.ts` 写成 28（提交的 `gate-l10.log` 是
27，相加 87 ≠ 86）；`clear()` 消融的「3 of 28」在提交树上不可复现（过滤恢复后被遮罩，本机重测
**0 of 27**，那个 2 次失败属于恢复过滤**之前**的中间树 26 用例）；`resolved_defects` 还留着
「过滤无法改变行为、因此被删除」这条废弃结论，`notes.md` 的算式与用例增量也不成立。修法见
`notes.md` §4d，计数真值 27 写回所有位置，消融行改为**按树标注**。

## 6. 总判定

本单元在独立 review 路上共走**四轮 FAIL**（第 1-3 轮为全量 review，第 4 轮为计数复核轮；
第 1 轮 2 minor + 4 advisory，第 2 轮 2 minor + 2 advisory，第 3 轮 2 minor + 3 advisory 纯
证据计数），随后第 5 轮只读计数确认 **PASS**。每轮结论、修法与红测命中的失败都在本节与
`verification.json` 里，与代码一一对应。

三轮**代码事实**（owner 边界、单写者单读者、无 control→agent 通道、无 Console relay、无协议
变更）都没有被质疑；第 2 轮之后被质疑的只有本单元自己新写的行与本单元自己写的证据陈述，第 3 轮
更是只有计数与标注。第 3 轮的修正提交后，同一位独立审查者被再次派发做**只读计数复核**。

第 4 轮（`874252c..753775d`）结论 **FAIL，2 处遗漏**：它确认 `verification.json` 的
`per_file` / `per_file_sum` / `log_line`、`notes.md` §4c 与 §5 表格、`.appsdk` 与 `module-registry`
的计数、`mutation_basis` 及其转移声明、追踪式红测推导（0/27 被遮罩、过滤 1/27）、废弃项删除、
`review.md` 无占位、build/typecheck/gate 日志自带退出码、72/4 引用——这些全部正确，**同时
指出两处修正没有落盘**：`docs/architecture/verification-map.json` 的 L10 门注仍写「28」与
「3 failures」（此前脚本把 `n` 改完没写回 `g['note']`，属于作者脚本缺陷，不是审查者误读），
`notes.md` §5 的红测段仍写「3 个失败」（与 §4c 矛盾）。两处已在本轮修正（提交 `HEAD`），
第 5 轮做只读核对该文件落盘后的计数。

### 第 5 轮结论（`753775d..e83a7b0`）

**PASS**。同一独立审查者只读核对了三处修正：`verification-map.json:1196` 全部门市中
agent-host 计数为 27，host mutation 句与本树实测一致（过滤遮罩下 clear 0/27、过滤本身
1/27），per-file 相加 8+7+5+12+27+27 = 86 与 `gate-l10.log` 一致，72/4 引用指向
`gate-l9-intent-side-4files.log`；`notes.md` §5 与 §4c、`verification.json` 的 mutation 行完全
一致（clear 0/27 本树遮罩 + 2/26 中间树；过滤 1/27）；`verification.json` 的 `source` 不再以
被取代的候选为当前 head。它指出三项遗留措辞（review.md §6 的「三轮 FAIL」、`source` 未命名
当前 head、门注只写「两轮 review」），本提交一并修掉后 PASS。

至此本单元的独立 review 链为 **FAIL x4 + PASS x1**，通过项全部落在证据与措辞层面，
owner 边界、单写者/单读者、无 control→agent 通道、无 Console relay、无协议变更未被任何一轮质疑。

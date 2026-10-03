# U2 Config Design Run Notes

## 2026-10-03 UTC / primary narrow admission preparation

- Worker r3 exit0、已停止写入；primary组合最新origin/main8d143ae（仅goal文档变化），不改产品。
- 首偏离：用户schema仍要求leasePort/presenceIntervalMs并开放本地transport内部材料，与config.toml用户意图/internal.toml内部配置边界和U1动态端口设计冲突。Primary删除两个用户示例中的固定端口/心跳字段，明确只在internal配置；迁移保留旧transport材料到internal而不丢语义；新机器系统分配端口，已有内部端口冲突明确失败。
- 本候选仅两个允许设计/notes文件，machine source和per-daemon accepted/effective、唯一async锁/CAS、显式迁移边界保留。下一步定向Markdown/链接/图/diff验证，独立窄设计审查，不宣称U2产品/黑盒完成。

## 2026-10-03 UTC / r2 | design | r1 P1/P2 窄修正已落盘 | `docs/design/teams-local-config-v3.md` | base `8d143ae8bab7594d25402282a4a2ed33d06919b0`，r1 review hash `e09db4f1ecfdb5f67112c68c595ed592bd153ac62f48bff4791ea5c6f31741da` | targeted validation

- 首偏离：r1 审查的当前 staged tree 仍是 config-first migration、宽锁 apply/refresh、
  volatile-only uncertain、以及 `[agents.*.identity]` 漏 `agentId`。输入设计 hash
  `753bf7e456894b7c757696abcca95acfb470a08c223899f8144d4d962f68d5a7`；本轮只改
  允许的两个文档，产品代码只读。
- P1 migration：`internal.toml [migration]` 成为唯一 pending owner；固定写序为
  `prepared` pending -> candidate `config.toml` rename -> `config-committed` ->
  readback -> `verified`。pending 记录捕获 legacy refs/hashes、显式 Console 输入、
  candidate source/hash 及逐 daemon accepted/effective/catalog/binding recovery；
  `loadLocalConfig` 在普通 parse 前调用唯一 `resumePendingMigration()`。恢复不重读、
  不扫描 legacy，用户改写目标 source 则 `MIGRATION_SOURCE_CONFLICT` 且不覆盖。
  明确区分 temp+rename 的单文件进程中断完整性，与未提供的 fsync/电源故障/双文件原子性。
- P1 锁：`RuntimeConfigStore` 是唯一 public lock owner，低层 `*Unlocked` persistence
  primitive 不重入锁。pure mutation 单短锁；refresh/apply 采用 capture lock ->
  锁外 provider/OpenCode/stop/closed -> reconcile lock。`ConfigTargetIdentity` 固定
  target generation/accepted/source/endpoint/credential identity；不匹配返回
  `APPLY_TARGET_MISMATCH`/`REVISION_CONFLICT`，不把旧结果标成新 source。accepted-only
  catalog observation 允许在 machine source 单独漂移时保留，并明确以 acceptedSource
  identity 归属；accepted 不因 source 变化自动替换。
- P1 durable uncertain：`ConsoleProjectionV1.configs[]` 增加 typed
  `applyState: clean|uncertain`，Console wire parser/readback 同步；同一
  `createManagedConfigOwner` 增加唯一 public `recover()` 端口，`agent-process` 在
  开放 Session/Session command 前 await。重启不得清 uncertain；必须确认前一 substrate
  终止并 truthful reconcile 后才写 clean。U6 Session readiness 与 U2 config-owner
  startup port 分开，只共享该 single-owner proposal。
- P2 identity：`agentId` 固定由 `[agents.<id>]` 表键注入 `HostIdentity`；其他协议字段
  保留，重复 `identity.agentId` fail closed。
- port 一致性：新机器由系统选择并持久化 bridge/daemon/Console/OpenCode 端口；示例
  不再使用 `48010/48020` 默认，已持久化端口冲突显式失败。internal 端口/TLS/transport/
  heartbeat 仍是内部事实；`config.toml` 只承载用户模型/provider/binding 意图，manual
  model 可在 empty catalog 下使用，不引入自动 fallback。
- 图表与 handoff：中文业务 SESE DAG 与 lifecycle 图均引用同一 pending/短锁/reconcile
  流程；新增 red test/安装后 public consumer 用例 14-18。`provider-config.graph.json`
  未修改；本轮只在文档中记录若需图变化由图的 owner 走 genuine ARC 变更，不直接改图。
- targeted validation：后续条目记录 `git diff --check`、`git diff --cached --check`、
  Markdown fence/link、`dagpipe graph validate`、exact paths 与关键字一致性结果。

## 2026-10-03 UTC / r2 | verification | r1 P1/P2 修正针对性检查通过 | `docs/design/teams-local-config-v3.md` + 本文件 | design sha256 `1333899cab01ad65a1a66d676e1e8d06d7d0365160bd35e85d5db3d087aeae06`，graph sha256 `b05350d7b6fc0890c4e0c304bd4d8b22a1cb883a59655de39d7ce7082420b10a` | 收口汇报

- exact changed paths（唯一允许写入面）：`docs/design/teams-local-config-v3.md`、
  `docs/evidence/u2-config-design-20261003/run-notes.md`。`git status --short --branch`
  仅显示这两个既有新增文件的 `AM`，未触碰产品源码、测试、maps、graph JSON、goals、
  package/lock、SDK records、memory、credentials。
- `git diff --check` PASS（exit 0）、`git diff --cached --check` PASS（exit 0）。Markdown
  fences：design `fences=14 balanced`，run notes `fences=0 balanced`。Markdown 相对
  链接：`markdown links ok`（按行号后缀剥离后逐链接 existsSync 校验）。
- `dagpipe graph validate docs/design/dagpipe/graphs/provider-config.graph.json`：
  `valid DAG: agentteams.provider-config@1 (5 nodes, 4 edges, 5 waves)`；graph 未修改，
  收口 hash 与验证前一致 `b05350d7...`。本 design 如需图变化，只登记由图的 owner 走
  genuine ARC 变更，不自行改图。
- 关键字一致性扫描：无 `saveMachineSource(`/`acceptMachineSource(`/`saveObservation(`/
  `loadDaemon(`/`pending-verification`/`legacyFiles`/`legacyAcceptedByDaemon` 旧接口名；
  无“每个 public 操作共享一把锁”的旧表述；无 `48010/48020` 固定默认（仅显式保留
  “不写固定 `48010` 默认值”的否定约束）。`agentId` 表键注入、short-lock capture/
  release/reconcile、`RuntimeConfigApplyRequest` applier 形状全文一致。
- r1 结论映射：P1 migration -> §3/§5 pending-first 单写序 + `resumePendingMigration()`；
  P1 lock -> §4/§6.5 `RuntimeConfigStore` 唯一 public lock owner + `*Unlocked` primitive
  + capture/unlocked-external/reconcile；P1 durable uncertain -> §4/§6.6 typed
  `applyState` projection + 唯一 `recover()` startup 端口；P2 identity -> `agentId`
  表键注入 `HostIdentity`；port 一致性 -> 系统选择并持久化端口、冲突显式失败、internal
  端口/TLS/heartbeat/transport 保持内部事实。
- 本文件 sha256 `0388a8012980499a1dd1fb18bc33d42c679b6e55306c342a3da956c9113f42b2`
  为本次验证运行时的候选内容（本收口条目 append 后该值变化属预期，不断言自指 hash）；
  design 与 graph hash 为最终值，收口后未再改动。
- 未运行产品测试、build、安装、daemon 重启、blackbox 或 live replay；本任务为纯文档
  修正，不宣称 U2 产品实现或产品 PASS。剩余依赖：独立窄 design review 对 design
  sha256 `1333899c...` 准入；U2 实现按本 design 的 owner/API/blackbox handoff 落地；
  U1 CLI v3 模板与显式 legacy 输入、U5 Console readback 接线、U6 共享 `recover()`
  single-owner proposal、U7 driver。未拉取/rebuild/commit/merge/push，未关闭 issue，
  未做 review；本任务未创建临时产物，`/Volumes/Intel/playground/agentteams/u2-config-design-20261003`
  即既有任务工作树，无自有临时资源需清理。

## 2026-10-02 / 01:30 | design-start | 目标、范围与基线已确认 | evidence/u2-config-design-20261003/run-notes.md | base `20051913b8145d176d50afdae563adb6737d2779` | 读取合同和项目规则

- 合同要求：U2 编码前窄设计；`config.toml` 是用户意图唯一编辑源；
  `internal.toml` 是系统/运行状态；bridge、Console、多 provider 不再要求编辑 JSON；
  `RuntimeConfigStore` CAS 落到同一 TOML 真源；多 daemon writer lock 保留 launcher 字段；
  手工编辑与 Console 冲突检测；迁移不丢数据；崩溃/重启/effectiveRevision；精确验收合同。
- 允许路径：`docs/design/teams-local-config-v3.md`、
  `docs/evidence/u2-config-design-20261003/**`。禁止产品代码、commit、merge、push、
  Collab、旧 session/transcript。
- 读取锚点：`runtime/local-config.ts`、`runtime/process-config.ts`、
  `runtime/console-config.ts`、`runtime/console-process.ts`、`config/runtime-config.ts`、
  `runtime/managed-config-owner.ts`、`runtime/agent-process.ts`、`runtime/local-process.ts`、
  `runtime/local-supervisor.ts`、`cli/agentteams.mjs`、对应 specs、五张 architecture maps、
  D1 behavior contracts 和 U2 合同。
- 输入版本：`20051913b8145d176d50afdae563adb6737d2779`；当前 worktree clean，
  分支 `codex/u2-config-design-20261003`；该描述指基线未含本轮产物，实际本轮两个
  允许路径在结案时为 untracked，不是 worktree 无新文件。

## 2026-10-02 / 01:40 | evidence | 现状接口已核实 | design doc §1 | base 同上 | 写入设计结论

- `config.toml` v2 当前只解析 `version/relay/endpoints`，仍要求 relay JSON 和 endpoints 运行时细节。
- `loadLocalConfig` 已编译到 `internal.toml` v1，已有 temp+rename 和
  `withLocalInternalConfigLock`；现有合并逻辑会保留 launcher/daemon 生命周期字段。
- `RuntimeConfigPersistence` 当前只 `load/save(VersionedRuntimeConfig)`，JSON-only；
  `RuntimeConfigStore` 的 `expectedRevision` 只对内存 state CAS，没有磁盘 source-hash 检测。
- daemon 当前用 `openCode.configFile` 指向独立 JSON；这是与“单一用户真源”冲突的第二 editable 源。
- Console 配置命令已存在 `expectedRevision`、显式 target、显式 apply failure；可复用而不新增第二套 store。
- `process-config.ts` 只接受 env credential reference；解析值不进入声明。

## 2026-10-02 / 02:00 | design | v3 单一用户源与事务边界已落盘 | docs/design/teams-local-config-v3.md | base 同上 | parent 做设计准入

- `config.toml` v3：bridge enabled；agents 身份/role/services/connect/model；可选 console；
  providers 实例；manual models；Agent/model binding。
- `internal.toml` v2：source hash、runtime generated bridge/console/daemon projection、
  `[configRuntime]` acceptedRevision、每 Agent `[configRuntime.effective.<agentId>]`、
  catalogs、launcher/daemon lifecycle、migration 记录。
- `RuntimeConfigPersistence` 拆为 `saveAccepted`（config.toml user intent）与
  `saveObservation`（internal observations）。Console CAS 增加 source-hash 冲突检测；
  人工编辑后旧 expectedRevision 返回 `REVISION_CONFLICT`。
- 写入崩溃恢复规则：config.toml 保持 intent 真源；双文件间无伪原子保证；重启后
  accepted 可前进、effective 保持旧值，需显式 apply/reconcile。
- apply 活动/uncertain 保留现有 `applyInFlight` 守卫，新增显式 uncertain 结果，
  effective 不夸大。
- 迁移从旧 relay JSON / OpenCode JSON 复制 provider/binding/manual model/credentialRef
  /catalog/effective 到 v3 和 internal v2；旧 JSON 不删除，待实现后的 BB02/BB08/BB10
  证据确认等价后另行核销。
- 未决跨界依赖已列为待补接口：CLI v3 默认模板、blackbox driver、U4 Work、U6 Session。
- 审计补强：`RuntimeConfigStore` 写/读/apply/refresh 必须迁移为 async，才能复用
  `withLocalInternalConfigLock`；refresh 不再推进 acceptedRevision；legacy provider
  多文件必须整体合并并在冲突时零写入；legacy Console JSON 必须显式输入路径，不能
  扫描猜文件；internal catalog 增加 providerFingerprint 并处理 stale。

## 2026-10-02 / 02:10 | verification | 文档针对性检查 | `rg`/`git diff --check` | design candidate | 汇报

- 检查设计中的唯一真源、CAS、锁、崩溃、迁移、精确命令和 U2/U1/U3/U4/U5/U6 边界是否齐全。
- 对设计执行最终一致性审计：修正了接口 async 迁移、refresh revision 语义、TOML
  只替换 store 段、多 provider/Console 迁移冲突、applyState/uncertain durable fence、
  internal port 非零、legacy 文件不删除等缺口；`git diff --check` 通过。
- 未运行产品测试、未安装依赖、未进行编译：本 worker 不拥有产品代码或测试范围。
- 无产品黑盒结果；本文件只报告 design candidate，不称 U2 完成或 PASS。

## 2026-10-02 / 02:30 | verification | 最终候选一致性复核 | design sha256 `80ae0b295fa7e1ca58da070c99ab09b3d3cf27ac12932bfa29178971fe7dd8d0` | base `20051913b8145d176d50afdae563adb6737d2779` | parent design 准入

- 修正 `acceptedRevision` 全机 owner 与 provider design “per-daemon accepted” 的表述冲突：
  单文件 v3 采用 internal 全局 accepted + 每 Agent effective，派单前须由 parent
  确认该解释。
- `saveObservation` 类型不再接受 `acceptedRevision`，避免 observation 误写 accepted。
- 统一崩溃恢复字段名为 `configRuntime.acceptedSourceHash`；section 6 子节重新按序编号。
- 最终 `git diff --check -- docs/design/teams-local-config-v3.md
  docs/evidence/u2-config-design-20261003/run-notes.md` 通过；`git status --short`
  仅显示上述两个允许路径为 untracked；HEAD 仍为
  `20051913b8145d176d50afdae563adb6737d2779`。
- 未运行产品测试、build、安装、daemon 重启或 blackbox；无 U2 PASS/完成声明。

## 2026-10-02 / 23:05 | baseline | 实际 HEAD 与首偏离已锁定 | `git rev-parse HEAD`：
`55c8282cbad3886022790d9ffb4b04a84b776820` | worktree
`/Volumes/Intel/playground/agentteams/u2-config-design-20261003`，branch
`codex/u2-config-design-20261003` | 修订 design candidate

- 本时间点以前各节保留为历史 append-only 记录；“全机 accepted”“saveAccepted”
  “待 parent 确认”等旧表述均已被本时间点起的修订取代，不得作为当前候选结论引用。
- 本 worker 只改 `docs/design/teams-local-config-v3.md` 与
  `docs/evidence/u2-config-design-20261003/**`；两者在修订前均为 untracked，未发现其他
  工作树改动。
- 首偏离：上一版候选把全机 `acceptedRevision` 用作所有 daemon 的接受事实，与
  `docs/design/teams-provider-config.md` 的 per-daemon durable accepted 冲突；图还
  存在 Console 到 config 的回边并以函数名表达节点语义。
- 第二偏离：async 接缝只有 sync/async “或”方案，RuntimeConfigStore 调用者归属不完整；
  迁移同时包含 merge/scan 含糊路径，无法独立准入。

## 2026-10-02 / 23:05 | design | per-daemon accepted 与唯一事务 owner 已修订 |
`docs/design/teams-local-config-v3.md` | HEAD 同上 | 一致性审计

- 机器 `sourceRevision/sourceHash`、目标 daemon
  `acceptedRevision/acceptedSourceRevision/acceptedSourceHash + snapshot`、
  目标 daemon `effectiveRevision/applyState/lastApplyError` 三层事实已分离；
  `config.toml` 仍是唯一用户编辑源，accepted snapshot 只是该 daemon 已接受事实。
- Console `expectedRevision` 固定为目标 daemon accepted CAS；机器 source 漂移返回
  `SOURCE_CHANGED`，目标 accepted 冲突返回 `REVISION_CONFLICT`。接受新 source 只允许
  显式 Console/CLI 目标命令或该 daemon 自身 start/restart reconcile，load/status/read
  不接受、不冒充，也不替其他 daemon 接受。
- `RuntimeConfigPersistence` 固定为 async 锁内 primitive；
  `RuntimeConfigStore` 的 read/mutation/apply/refresh 每次只取一次
  `withLocalInternalConfigLock` 后调用 primitive；U2 owner 覆盖
  `runtime/console-config.ts`、`runtime/agent-process.ts` 配置接缝、
  `config/runtime-config.ts` 及真实调用者 specs，U4/U6 在冻结前禁写。
- `runtime/agent-process-config.spec.ts` 已读：它只验证 child config 读取，尚未覆盖
  `RuntimeConfigStore` 构造；该 spec 已列入 U2 的相同实现 owner，并要求补配置接缝用例。
- observation 以 exact accepted/source/endpoint/credential identity 为准，不推进 user
  intent/accepted；catalog 按 daemon Agent ID 隔离，manual entries 只从 accepted
  snapshot 重组。`applyState/uncertain` 与现有 apply/ManagedConfigOwner 状态保持单源，
  未新增状态机框架。
- 迁移仅从显式 v2 endpoint/provider/Console 输入读取，不 scan；逐 daemon 保留
  accepted/effective/binding/catalog，不止取最大 revision；冲突整体零写入，旧 JSON
  在 v3 readback 等价前不删除。
- §12.4 已加入中文业务 SESE DAG 与独立生命周期状态图。单次配置 DAG 无回边；生命周期
  可循环。节点/边不写函数名，typed 字段、成功、失败、取消/保留责任终点已补齐。

## 2026-10-02 / 23:05 | verification | U2 文档针对性检查 | design/run notes |
HEAD `55c8282` | 汇报 design candidate

- `git diff --check`、Markdown fence、相对链接、`dagpipe graph validate
  docs/design/dagpipe/graphs/provider-config.graph.json` 见下述收口结果；图未修改且
  validate 通过。
- 收口时本地 `origin/main` ref 已从组合基线 `55c8282` 前进到
  `8d143ae8bab7594d25402282a4a2ed33d06919b0`（只改 goals handoff 文档）。本 worker
  未 fetch、未 rebase、未 commit；branch 仍指向组合基线 `55c8282`，上游前进
  `+0/-1` 作为明确的集成后依赖记录。
- 已只读核对 `config/runtime-config.ts`、`runtime/console-config.ts`、
  `runtime/agent-process.ts`、`runtime/managed-config-owner.ts` 及
  `config/runtime-config.spec.ts`、`config/config-boundary.spec.ts`、
  `runtime/console-config.spec.ts`、`runtime/managed-config-owner.spec.ts`、
  `runtime/managed-config-live.spec.ts`、`runtime/agent-process.spec.ts` 的现有同步调用面。
- 未运行产品测试、build、安装、daemon 重启或 blackbox，也未实现 driver；本文件只报告
  design candidate，不称 U2 实现或产品 PASS。剩余依赖：独立 design review、U2 实现、
  U1 CLI v3 模板/迁移输入、D3/U4 接缝与 U7 driver。

## 2026-10-03 / primary exact r2 correction

- 节点：独立设计 r2 正式 FAIL 已消费；作者90849与reviewer57802/57786均signal0 ESRCH，当前无 writer。基线从4fc38a4 ff组合至最新origin/main c3aa36fc637e2da4ac821d1b26d587eadbbf1268，仅goal文档增量；原允许两文档保留，product/graph未修改。
- 结论：修两个 P1 的唯一契约。§12.4 语义图把source与目标accepted写入留在同一短锁内，accepted完成后才释放；保留§6.5双文件非原子及无fsync边界。§5 observation类型固定lastApplyError三态 absent保留/null删除/error设置；exact成功apply/reconcile显式写effective+clean+null；catalog只改catalog，不清apply error/fence；unknown/reconcile失败保留责任。
- 证据：docs/design/teams-local-config-v3.md 的端口、observation表、§6.1/6.6、§12.2红测19–21与§12.4图。只为后续实现冻结契约，未运行或声称产品红绿/E2E。
- 下一步：两文件定向检查、已有provider-config图validate、精确tree冻结后新独立r3设计审查；PASS才集成和派产品实现。旧r2 FAIL不作为准入，其他冻结review树不改。

## 2026-10-03 / fresh independent U2 r4 correction

- 节点：fresh independent Desktop gcm author 接手 U2 设计修正；当前 base/HEAD `c3aa36fc637e2da4ac821d1b26d587eadbbf1268`，branch `codex/u2-config-design-20261003`。允许写入仅 `docs/design/teams-local-config-v3.md` 与 `docs/evidence/u2-config-design-20261003/run-notes.md`；product source、tests、graph、maps、goals、memory、config/credentials、install/service、commit/merge/push 全部未触碰。

- primary 接手作者终态后组合 origin/main 71094ac：作者76172 ESRCH、exit0/turn.completed，尚无 r4 reviewer。发现 typed primitive 仍要求 target CAS，却文字承诺旧 target 的 fence 可持久化；另一个成功清 lastApplyError 的表述也与并发 unknown 保留冲突。只修两允许文档：同一 primitive 用 target-observation/owner-fence discriminant，前者保持 exact current target，后者只 upsert exact owner/operation/generation responsibility、不写 latest target facts；clear 仅清自己的 record，其他 unknown 在时不清 error。新增已准入 U5 consoleRuntime 的同 serializer 依赖。无产品变更或测试 PASS 宣称；下一步两文件定向校验、freeze、独立 r4 design review。
- 消费 r3：`.agent-collab/review/u2-config-design-20261003-r3/review.final.md` 的两个 P1 与一个 P2 均已转化为设计修正，未作为产品 PASS。首偏离是 §12.1 的 future allowed source/test ownership 漏掉 `control-protocol/console-api.ts`、`control-protocol/console-wire.ts` 与 `runtime/managed-config-owner.ts`；第二偏离是 `ManagedConfigOwner.use()` 的 volatile uncertainty 缺少 required durable persistence caller，重启可能从 clean 静默恢复；第三偏离是 header 仍把历史 r2 输入 `8d143ae8bab7594d25402282a4a2ed33d06919b0` 标为当前组合基线。
- 修正 allowed path/table：§12.1 现列出 `runtime/local-config.ts`、`runtime/process-config.ts`、`config/runtime-config.ts`、`runtime/console-config.ts`、`runtime/agent-process.ts` 配置接缝、`control-protocol/console-api.ts`、`control-protocol/console-wire.ts`、`runtime/managed-config-owner.ts`，并逐项绑定 `local-config.spec.ts`、`agent-process-config.spec.ts`、`runtime-config.spec.ts`、`config-boundary.spec.ts`、`console-config.spec.ts`、`console-api.spec.ts`、`console-wire.spec.ts`、`managed-config-owner.spec.ts`、`managed-config-live.spec.ts`、`agent-process.spec.ts`。U6 只消费同一 U2 owner API，不复制 recover/fence/persistence implementation。
- 修正 uncertainty persistence owner/port：§5 冻结 `ManagedOperationIdentity`、`ManagedConfigUncertainty`，并把 `uncertain`/`expectedUncertain` 放入同一 `saveObservationUnlocked()` observation slice；§6.6 冻结 `ManagedConfigOwnerPersistence.readRecovery/persistUncertainty/clearUncertainty`。writer ownership 是同一 `ManagedConfigOwner` 实例，不是 Session caller、Console、U6 adapter、日志、payload 或新 store/manager/scheduler。
- 修正 identity/recovery 规则：operation capture 区分 latest accepted/source identity 与实际 effective substrate identity（`pid`、`effectiveRevision`、`effectiveHandleFingerprint`）。旧 active `use()` 抛 ambiguous error 时，owner 设置 volatile uncertain 后在返回前 await `persistUncertainty()` 写同一 config-owned internal fence；accepted 可前进，但旧 uncertainty 不能覆盖新 accepted/source/effective facts，也不能被当作 stale observation 丢弃。clean/fence 写使用 exact `expectedFence` CAS，catalog refresh 与 unrelated success 保持 fence-neutral，不能清另一个并发操作的 unknown。
- 修正 failure/recovery endpoints：persistence failure 或 identity mismatch 保持 volatile uncertain、当前 handle 与 owned-resource responsibility，显式返回 `UNAVAILABLE` 或 `APPLY_TARGET_MISMATCH`/`REVISION_CONFLICT`，不得声称 durable fence；后续 use/apply/stop/replacement 均拒绝。restart 的 `recover()` 先于 Session ingress 读取 durable owner facts，只有确认旧 substrate termination 且 exact target apply/readback 成功后，才通过 owner-owned clear path 写 clean 并移除 fence。Session identity/obligation facts 保持独立；config reconcile 不推断 Session request 的最终业务结果。
- 修正 planned tests/blackbox：§12.2 保留原 1-21，并新增 22 uncertain `use()` -> restart preserved fence、23 concurrent success cannot clear another unknown、24 accepted change while old `use()` active cannot drop fence、25 failed durable persistence remains explicit/retained；§12.3 增加 planned blackbox obligation，要求真实 daemon/Console/Session 入口覆盖 ambiguous use durable fence 与 restart/reconcile。这些都是 planned product tests/blackbox，不是当前 PASS claims。
- 证据/检查：`git diff --check` 通过；`git diff --cached --check` 通过；Markdown fences design=16 balanced、run notes=0 balanced；按去掉 `:line` 后缀校验两文件相对 Markdown links ok；`dagpipe graph validate docs/design/dagpipe/graphs/provider-config.graph.json` 输出 `valid DAG: agentteams.provider-config@1 (5 nodes, 4 edges, 5 waves)`。`git status --short --branch` 仅显示允许两路径：`AM docs/design/teams-local-config-v3.md` 与 `A docs/evidence/u2-config-design-20261003/run-notes.md`。
- 限制/依赖：未运行产品 tests/build/typecheck/install/restart/live replay/blackbox，未修改 graph/maps/goals/product source/tests/credentials/services，未 commit/merge/push。新候选仅绑定上述两文档与 base `c3aa36fc637e2da4ac821d1b26d587eadbbf1268`；下一项是新独立 r4 design review。

# Teams Provider 配置设计

状态：proposed，尚未实现。owner：config。适用对象是需要 LLM 的 Agent；浏览器、
CLI 或其他被动能力 Agent 不要求配置 provider，也不要求运行 OpenCode。

## 1. 执行与配置边界

OpenCode 是推理型 Agent 的执行基座，Teams 不复制它的 LLM 请求/流式执行栈。
Teams 独立拥有 provider 实例、模型目录和 Agent 绑定；OpenCode 配置只是派生输出。
Console 是可离线客户端；目标 daemon 的 config 持久化接受的 revision。
多 Console 修改同一 Agent 必须提交 expectedRevision；冲突显式拒绝。

流程：Console config command → daemon config CAS/持久化 → runtime 调用 adapter
编译/应用 → effective revision 读回。acceptedRevision 与 effectiveRevision 分开；
应用失败不宣称生效，不自动覆盖当前有效 revision。缺凭据/未支持协议明确失败。
运行中任务不隐式切模型；下一次请求使用明确选定 revision。配置、路由与资源控制
位于 typed control resource，不写入 Session 内容或 metadata。OpenCode 官方 API
要求的显式 provider/model 参数由 adapter 投影，不等于把配置对象塞进业务内容。

每个 daemon 自己保存配置。首版跨 Agent 复制配置是显式逐目标操作，不实现隐式
全局合并；各目标独立报告 accepted/effective。共享模板库不属于首版前置。

## 2. OpenMinis 参考依据

本轮从 `https://github.com/OpenMinis/OpenMinis.git` 获取 `origin/main`，核对提交
`4ef29002e88db1e20e462ec2ff46916e8a7dcb45`。通过 Git object 读取最新源码，保留
本地 checkout 与未提交笔记。以下均为该提交的 iOS 配置/接口实现，不引用其 UI：

| 源文件 | 核实内容 | Teams 采用方向 |
|---|---|---|
| `src/ios/Providers/ProviderInstance.swift` | 稳定 instance ID、同类型多个实例、enabled、customBaseURL、凭据类型和 Keychain 隔离 | provider 实例与协议类型分离；凭据只存引用 |
| `src/ios/Providers/ProviderTypes.swift` | OpenAI Chat 与 Responses 是不同 backend 类型 | protocol 显式声明，不凭 vendor/model 名猜测 |
| `src/ios/Providers/ModelEntry.swift` | 模型绑定 providerInstanceId；baseModel 与用户 overrides 分离 | 相同模型在不同 endpoint 是不同条目；刷新保留用户编辑 |
| `src/ios/Providers/ProviderConfigStore.swift` | 单 store；add/update/removeInstance、replaceEntries、refreshModels | config 唯一写入口，结构化验证后原子更新 |
| `src/ios/Providers/OpenAI/OpenAIModelsAPI.swift` | GET models、明确 URL 拼接、401/403 失败、自定义 endpoint 不按官方模型前缀过滤 | endpoint 自带模型目录、显式错误与路径契约 |
| `src/ios/Providers/LLMProviderFactory.swift` | entry → instance → credential → protocol-specific provider | Teams 改为编译到 OpenCode adapter，不复制 provider 客户端 |
| `src/ios/Providers/ModelGroup.swift` | 分组、顺序 fallback、load balance | 首版不复制自动路由，备用仅作显式选择 |

不采用 OpenMinis UI、iCloud 合并、平台 Keychain 实现、OAuth 全套、语音/图像路由、
模型名能力猜测或缓存失败伪装成功。参考架构和接口，不直接引入其代码依赖。

## 3. 最小领域模型

```ts
type ProviderProtocol = 'openai-chat' | 'openai-responses';
type ModelRef = { providerInstanceId: string; modelId: string };

interface ProviderInstance {
  id: string;
  label: string;
  protocol: ProviderProtocol;
  apiBaseUrl: string; // 完整 API base，如 https://host/v1；禁止自动补第二个 /v1
  enabled: boolean;
  auth: { kind: 'none' } | { kind: 'bearer'; credentialRef: string };
}

interface ModelEntry {
  ref: ModelRef;
  origin: 'discovered' | 'manual';
  base: ModelMetadata;
  overrides: Partial<ModelMetadata>;
}

interface ModelMetadata {
  label?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  tools?: boolean;
  streaming?: boolean;
  reasoning?: boolean;
  inputModalities?: string[];
  outputModalities?: string[];
}

interface AgentModelBinding {
  primary: ModelRef;
  backup?: ModelRef; // 备用引用不触发自动重试/切换
}
```

模型引用使用二元对象；不将可含斜杠的上游模型 ID 通过字符串切分来重建身份。
同协议可配置多个实例，同名模型互不混淆。协议 union 是首版候选支持集，只有
OpenCode adapter 当前版本验证过的协议才可启用；其他协议返回 unsupported。
数字范围、URL、认证类型、重复 ID、provider/model 引用和 enabled 状态均需验证。
API 返回的数据与用户 override 分开；未知能力保持 unknown，不默认为支持。

## 4. 拟实现的配置接口

以下是 Teams typed control command 设计，当前没有可调用的 HTTP 实现：

| command | 输入 | 输出 |
|---|---|---|
| `config.providers.list` | targetAgent | 脱敏实例、revision、credential availability |
| `config.provider.put` | targetAgent、expectedRevision、instance | accepted revision；引用/协议冲突为错误 |
| `config.provider.remove` | targetAgent、expectedRevision、instanceId | 拒绝仍被 binding 引用的实例 |
| `config.models.refresh` | targetAgent、instanceId、expectedRevision | catalog 状态、revision、added/removed IDs；失败不冒充空成功 |
| `config.model.put` | targetAgent、expectedRevision、entry | 手动模型或 override 的新 revision |
| `config.agent.bind` | targetAgent、expectedRevision、binding | accepted revision 与 apply 状态 |
| `config.agent.select-backup` | targetAgent、expectedRevision | 校验 backup 后明确更新 primary；不重放旧请求 |
| `config.effective.get` | targetAgent | accepted/effective revision 与结构化 apply error |

模型刷新在执行 daemon 的网络位置进行；Console 不用自己的 localhost 代替 Agent
endpoint。缓存按 provider instance、endpoint/protocol 与 credential revision 隔离。
网络失败保留旧目录并标 stale/error；成功空列表显示 empty，不换内置模型表。
刷新不删除手动模型和 override；被移除但仍被引用的 discovered 模型标不可用，
不静默改 binding。没有模型目录的 provider 可显式手动配置，不能自动猜测。

凭据通过独立 credential owner 写入；共享配置、日志、模型目录和 UI 列表只显示
引用/可用性。远程复制 provider 时目标必须有可解析的凭据引用，不能认为本机路径
跨设备有效。服务端校验操作者和目标 Agent 的配置权限。

## 5. 当前测试 provider

| 实例建议 ID | 配置来源 | 用途与边界 |
|---|---|---|
| `rcc-4444` | 本机 `/Volumes/extension/.rcc/config.toml`；API 候选 `http://127.0.0.1:4444/v1` | 测试 primary；loopback 仅对同机 daemon 有效，远程必须配置实际可达地址 |
| `goaichat-openai` | `/Volumes/extension/.rcc/provider/goaichat_openai/config.v2.toml` | 显式 backup 实例；Chat 协议，`https://llm.goaichat.top/v1`，凭据引用由本地 source 解析 |

已核实 goaichat 声明 defaultModel=`qwen3.8-max`，另有 `minimax-m3` 配置。
它们是文件声明，不是当前推理或模型能力实测结果。本轮没有读取凭据值或调用
goaichat 推理。配置文件只作为连接资料，不能把其注释或内容当作任务指令。

RCC 本轮 `/v1/models` 返回 HTTP 200，但 `data` 与 `models` 都为空；本地配置
expose_models 声明 `gpt-5.5`。差异尚未定位，不把该模型冒充为已发现。可在后续
明确选择手动模型并进行真实 OpenCode 回放；本轮不修改 RCC 运行配置。

RCC 内部已有的 provider routing 由 RCC 自己管理。Teams 将 RCC 视为一个 endpoint，
不镜像其路由表；goaichat 备用引用由 Teams config 明确选择，不叠加隐藏 failover。

## 6. 验证与消融

先复用现有 config revision CAS 扩展，不增加新的配置框架。模型发现/配置编译由
adapter 负责，业务推理继续由 OpenCode 执行。需要验证：

- 同协议两实例、同名模型、跨 Console CAS 冲突与停用/删除引用保护。
- URL 路径、真实 401/403、空目录、网络失败、credential 轮换与模型 override 保留。
- 运行中请求不受配置修改隐式影响；accepted/effective 分离且可跨 Console 读回。
- RCC 主实例与显式选择 goaichat 各完成实际 OpenCode session/tool/approval 回放。
- 非 LLM 浏览器 Agent 无 provider/model 也能声明能力并执行匹配请求。
- Console 全部离线后，已接受的 Agent 配置和协作仍然有效。

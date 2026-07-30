# 结构化 Capture

## Capture 的信任边界

Capture 把当前聊天、角色卡和世界书整理成人物候选、地点候选、事件容器和 Claim。模型只提供候选；Schema 校验、来源支持校验和业务校验共同决定哪些项目可以写入。

输入分成三部分：

- `allowedSourceRefs`：本次允许作为证据的来源 ID。
- `existingMemoryContext`：只用于消歧和去重，不能成为新事实证据。
- `sourceBlocks`：按段落/句子切分后的连续证据片段；每段不超过 800 字符并带稳定 `evidenceSpanId`。

人物、地点和 Claim 只输出 `evidenceSpanId`。模型不复制证据正文；服务端核对 span 与 `sourceRef` 属于同一来源后，按原始偏移回填现有事实 DTO 的 `evidenceExcerpt`。

根对象必须包含 `actorCandidates`、`locationCandidates`、`episodes`、`claims` 四个数组。LLM 插件先校验根容器，再逐项校验四个数组；模型输出不是可信契约。

## 逐项 Schema 校验

LLM 插件不会提取代码围栏、拼接 JSON，也不会修正枚举、数字字符串、字段别名、数组长度或缺失字段。

- 根 JSON 无法解析、缺少必需数组或数组整体约束失败属于 envelope failure。
- envelope failure 最多允许一次同资源、同模型、同 Schema 的完整重新生成。
- 能定位到具体数组项的 Schema 失败只排除该项；合法 sibling 原样返回。
- rejection 只包含 `collection`、`itemIndex`、`{ path, keyword, expected }` 和已通过 Schema 枚举验证的 `sourceRefs`。
- rejection 不保存错误值、失败 JSON、Prompt 或聊天正文。

一次普通 batch 只发起一次 Capture。逐项失败不会在原请求内立即修补，也不会阻塞后续 batch。每次真实 Provider 调用都必须先持久化日志，并具有独立 `attemptId`。

## 原子部分提交与 checkpoint

Memory 对 Schema 合法项再执行一次业务校验。合法事实、证据、Trace、根 ChangeSet、repair descriptor 和扫描 checkpoint 在一个 Workspace commit 中提交。

- 即使一个 batch 没有合法事实，也要原子提交 repair descriptor 和 `lastScannedBatch`。
- checkpoint 同时记录扫描进度、全部 unresolved rejection，以及可重试、已耗尽、需审阅、已修复、已降级和已忽略计数。
- 已扫描 batch 在刷新、续跑或聊天重绑后不得重复调用模型。
- 仍有 AI 可重试项时状态为 `needs_repair`；次数耗尽或只剩必需语义项时为 `needs_review`。
- 队列清空或用户明确忽略剩余项后才能进入 `completed`。

修复队列接收 `schema_validation_failed`、`entity_ref_unsupported`、`invalid_reference`、`excerpt_mismatch` 和 `dependency_invalid`。同一请求、批次、集合和项目的多个字段问题聚合为一个队列项。

未知 `kind` 不会自动变成 `other`；只有模型明确输出合法枚举值时才接受。每个失败项目最多进行三次真实调用：一次普通 Capture、一次定向重新提取、一次保守修复。禁止叠加修复、路由回退或无限重试。

## 延后定向修复

全部 batch 扫描完成后，Memory 按人物、地点、事件、Claim 的依赖顺序处理 `capture-repair-queue`。每个队列项独立调用；前置依赖尚未解决时延后且不消耗尝试次数。

加载旧 Job 时会从 unresolved rejection 补建缺失队列。旧策略已经耗尽的项目在证据闭集策略 v1 下只增加一次机会，策略版本未变化时不得再次重置。

修复提示只包含：

- 原 Capture 中该类型的字段规则与精简 item Schema。
- 出错集合、项目序号和安全的 `{ path, keyword, expected }`。
- 可信来源锚点前后的楼层正文。
- 由当前来源正文或来源元数据支持的动态闭集：规范名、去重别名、短引用和支持来源。

同一动态闭集同时用于 Prompt、修复 JSON Schema 的 `enum` 和最终业务校验。整个 Workspace 中存在、但当前来源不支持的实体不会进入闭集；无法可靠重建的事件引用只允许空字符串。

修复输入不包含完整失败 JSON、错误字段原值、无关批次正文、旧 Prompt、密钥或日志原文。第一次修复只依据来源窗口、目标集合、安全字段路径和闭集重新提取一个项目；第二次只反馈最新 `{ path, keyword, expected }` 并要求可选字段无证据时留空。语义失败消耗尝试次数；取消、超时、Core 不可用和 Workspace 冲突不消耗。

第二次修复后，仅允许确定性安全降级：清空无支持的可选地点或事件关联、过滤可选人物/Knowledge 引用，以及在已有来源支持文本时清空非 relationship Claim 的可选实体引用。降级后必须重新通过完整 Schema、来源和业务校验，并记录 `resolutionMode: degraded` 与字段动作。relationship 主客体、私密/自述/听闻 Claim 的必需 speaker，以及清空后核心语义不成立的项目禁止降级，继续保持 `unresolved`。任何阶段都禁止模糊匹配、自动别名改绑或选择“最接近”的实体。

## 请求内实体引用

Workspace 继续使用稳定持久主键；模型只看到请求内短引用：

- 人物使用 `A01`、`A02`……
- 地点使用 `L01`、`L02`……
- 未来正式物品目录使用 `O01`、`O02`；普通物品仍使用文本字段。

目录同时给出规范名、去重别名和确认状态。短引用仅在本次请求有效，不能写入 Workspace。落库前必须同时满足：

1. 短引用存在且类型正确。
2. 对应持久实体属于本次目录。
3. 来源的 actor/location 元数据，或来源正文中的名称/别名，能够支持该引用。

同名实体使用不同短引用，名称永远不充当机器 ID。格式合法但来源不支持的引用必须以 `entity_ref_unsupported` 拒绝并进入定向修复，禁止模糊匹配或静默换绑。

## 新增字段时的同步清单

新增或修改 Capture 字段时必须同时检查：

1. Capture 提示词、根 Schema 和对应 item Schema。
2. LLM Schema 关键字预检、逐项校验和安全 rejection 测试。
3. Schema 通过后的 typed mapper。
4. 来源支持与业务校验、Workspace 写入映射和审计白名单。
5. repair queue、定向修复输入、设置项和界面状态。
6. 请求日志的根 `requestId`、`parentRequestId` 与 attempt 关联。

不要只修改提示词，也不要通过解析器静默修复模型输出。

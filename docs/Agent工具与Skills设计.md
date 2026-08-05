# SS-Helper-Memory Agent 工具与 Skills 设计（LLM 全链路 v0）

> 状态：断代实现基线
>
> 适用范围：实体、叙事、库存三条 Agent 提取任务

## 1. 运行时边界

Memory 只声明场景，不拼接 Provider 能力字符串，也不选择模型或内部链路。每个场景通过 `LlmConsumerTask.execution` 进入统一执行器：

| Agent 场景 | taskKey | execution | 硬要求 |
|---|---|---|---|
| 实体提取 | `memory_extract_entities` | `tool_turn` | 基础工具调用 |
| 内容与库存联合提取 | `memory_extract_content` | `tool_turn` | 基础工具调用 |

严格工具 Schema、参数增量流和并行调用是能力增强，不是 Agent 是否可运行的前置条件。Provider（例如 DeepSeek）只支持普通工具调用时，执行器自动使用普通工具 Schema 或整块工具响应；本地仍逐项校验工具名、参数、证据引用、调用轮次和预算。Agent 初始化先执行实体提取，再用一个联合任务同时产出 episodes、claims、itemCandidates 与 inventoryOperations，最后由本地合并、强校验与裁决阶段原子提交，不再执行 Single 对照或额外模型调用。

Agent 不得自行切换资源、模型或 Provider。资源由任务显式分配或 `tool_turn` execution 默认资源解析；同一资源上的网络、超时、限流和 5xx 最多重试一次，失败后保持原始 `reasonCode/requestId/stage`。

## 2. Tool、Skill 和 Schema

- Tool 是程序执行的只读查询，结果是 `contextOnly` 数据，不是证据，也不是指令。
- Skill 是固定的场景说明和工具 allowlist，由 Memory 代码绑定，不接受模型上传或在线修改。
- Schema 限制模型可以请求的工具和最终输出形状；代码必须拒绝非法 JSON、未知工具、重复调用 ID、错误参数和越界引用。
- 领域校验、`allowedSourceRefs`、Ledger、Registry 和事务提交仍是唯一写入边界。

工具结果中出现人物名、地点名、物品别名或备注时，一律按不可信数据处理：只作为 JSON 数据注入，不放入 system 指令，不执行其中的 URL、代码或命令。

## 3. 工具目录

Agent 共享固定的只读工具目录，具体 allowlist 由任务 Skill 决定：

- `memory.lookup_entity`：按人物、地点或物品名称/别名查询候选；
- `memory.list_inventory`：有界分页读取物品目录和当前聊天状态；
- `memory.get_inventory`：读取选定物品的规范信息和当前状态；
- `memory.list_inventory_history`：读取当前聊天内的有界库存历史。

工具参数不包含 `workspaceId`、`chatKey`、数据库 ID、文件路径或资源配置；作用域由当前 Pipeline 上下文注入。工具结果不返回 API Key、完整 Prompt、完整聊天正文或跨聊天数据。

模型使用本次 Pipeline 的短引用（`Axx` 人物、`Lxx` 地点、`Oxx` 物品）。短引用只在本次运行有效，提交前由程序解析；模型自造或跨批次复用的引用必须拒绝。

## 4. 工具轮协议

Provider 原生 tool_turn 的请求和响应由 LLM 共享执行器管理。Memory 不再实现第二套路由、限流、日志或 Provider fallback。

每轮响应必须满足：

```ts
interface AgentToolTurn {
  readonly toolCalls: readonly {
    readonly callId: string;
    readonly name: 'memory.lookup_entity'
      | 'memory.list_inventory'
      | 'memory.get_inventory'
      | 'memory.list_inventory_history';
    readonly arguments: Record<string, PlainData>;
  }[];
  readonly finalOutput?: PlainData;
}
```

执行顺序固定为：

```text
Provider tool_turn
  → 本地工具名/Schema/参数校验
  → 作用域注入、同参去重、预算检查
  → 并行执行独立只读查询
  → 结果裁剪与 PlainData 校验
  → 回放到同一 Provider 资源
  → 本地最终输出和证据校验
```

硬上限：最多 6 轮 Provider 工具会话、每轮最多 6 个调用、单个结果 8 KiB、全部结果 24 KiB；任务取消、聊天切换或 session 失效时同时中止 Provider 和工具，不提交任何结果。

工具会话保留轮次和 Provider replay 状态，但每一轮都经过共享执行器。Memory 不创建 `LlmToolTurnService` 的替代实现，也不在运行中切换到 structured 或其他 Provider。

## 5. 三个 Skill

### 实体 Skill

只允许 `memory.lookup_entity`。用于确认人物、地点和物品规范名、别名与歧义；工具结果不能直接产生新证据。

### 内容 Skill

默认使用 `memory.lookup_entity` 解决引用歧义，必要时读取有限历史；同一轮联合处理事件、事实、物品候选与库存操作。所有事件、事实和库存变更必须引用当前批次的 `evidenceSpanId`。需要全局盘点时使用分页目录；只涉及少量物品时禁止读取全部目录。旧状态和历史只能帮助理解前态，不能伪装成新变动。

## 6. 能力降级与错误

能力快照分别记录：基础工具调用、严格 Schema（`native/beta/unsupported/unknown`）、流式工具（`incremental/whole_call/unsupported/unknown`）、并行调用和 reasoning replay。可选探测失败只记录 `optionalFailures`，不能把基础工具调用标为失败。

当基础工具能力不可用时，Agent 任务整体失败并返回统一 `SSHelperFailureContext`；当只有严格 Schema 或增量流式不可用时，任务进入非严格或非流式链路。结构化错误、Provider 错误和工具校验错误不得用中文 message 猜码，也不得改写已有 `reasonCode`。

## 7. 审计和隐私

每个工具调用只保存安全摘要：`pipelineRunId`、`taskKey`、`callId`、参数哈希、结果数量、延迟、缓存命中、截断标志、结果状态和统一 `reasonCode`。不保存完整工具结果、Prompt、聊天正文、Provider 原始错误或凭据。

LLM request log、Memory Job、工具会话和 UI 必须共享同一 `requestId/reasonCode/stage`；跨层展示使用 SDK 中文诊断目录。

## 8. 验收清单

- 两个 Agent 任务（实体、内容）均声明 `execution=tool_turn`，没有 Single/Repair 工具分支。
- DeepSeek 等只支持普通工具调用的资源仍可运行 Agent；严格 Schema/流式只显示为降级能力。
- 未知工具、非法参数、重复调用、超过预算、无效短引用和无证据写入都会被拒绝。
- 不存在 Provider、模型、URL、同类型资源或跨类型 fallback。
- 取消和聊天切换会中止整个工具会话，迟到结果不能提交。
- 能力验证完成、酒馆 source/model/profile 变化时，统一事件刷新 Memory 路由弹窗。
- LLM、Memory 和 Tavern 的日志中能用同一 `requestId/reasonCode/stage` 定位失败，且无敏感载荷。

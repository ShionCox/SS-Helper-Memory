# SS-Helper-Memory 记忆总结与初始化质量优化方案

> 本文基于当前真实初始化结果、`酒馆聊天数据.jsonl`、真实 `.env` 模型接口、SQLite 审计数据，以及 TypeChat、Instructor、Outlines、Graphiti、Mem0、LangGraph Memory 等开源项目的实现思路整理。

## 一、当前总体质量判断

当前版本已经从“完全不能稳定召回”提升到“事实、向量、重排序和代表性召回可以工作”，但还没有达到可以长期无人值守运行的生产质量门槛。

| 质量维度 | 当前结果 | 判断 |
|---|---|---|
| 初始化完整性 | 24/24 批、117 条消息完成 | 通过 |
| 事实落库 | 225 条事实，208 条 active | 基本通过 |
| 引用完整性 | orphan Trace、orphan Observation 均为 0 | 通过 |
| 代表性召回 | 紫罗能力、加油站 45% 燃油可以召回 | 初步通过 |
| Schema 稳定性 | 89 条 unresolved rejection，5 个 partial 批次 | 不通过 |
| 角色唯一性 | 短名、全名拆分，并出现“重构体”“表情的话”等误角色 | 不通过 |
| 任务状态可信度 | job 显示 complete/0 rejection，但批次审计有 89 条拒绝 | 不通过 |
| 向量一致性 | 事实、vector-index、物理向量数量和状态不完全一致 | 部分通过 |
| 自动恢复能力 | 缺少针对后台 Memory 的自动结构修复闭环 | 不通过 |

**总体结论：当前是“可用原型”，不是“质量过关的最终实现”。**

当前最大的问题并不是模型不理解剧情，而是：

1. 输出契约过于复杂；
2. Provider 表面接受 `json_schema`，实际没有进行严格约束；
3. Schema、归一化器、应用层验证器对可选字段的语义不一致；
4. 人物和地点仍使用自由文本引用，模型可以自行创造名称；
5. 一个事件错误会级联使多条观察失效；
6. 最终任务状态没有真实汇总批次质量。

## 二、实测证明：当前接口并不真正执行 Strict JSON Schema

使用 `.env` 中当前生成模型接口进行最小探测：

- 请求使用 `response_format.type=json_schema`；
- `strict=true`；
- Schema 要求 `occurredAt` 只能是 `number | null`；
- 接口返回 HTTP 200；
- 实际模型输出为：

```json
{
  "mode": "ok",
  "occurredAt": "",
  "items": [{ "name": "测试" }]
}
```

`occurredAt` 被输出为空字符串，明显违反请求中的 Schema。这说明当前中转属于：

> **接受 `json_schema` 参数，但并没有在解码层真正限制模型输出。**

因此，不能把“接口没有报错”当作“原生 Strict Structured Output 可用”。后续必须建立模型资源级别的真实能力探测，而不是只检测参数是否被接受。

## 三、提示词加入角色名和地名是否有用

### 3.1 角色清单：应该加入，但必须是系统生成的稳定目录

建议每批向模型提供角色目录，但不要只给一段自然语言角色列表，也不要让模型自己总结角色名单。应该提供稳定 ID、规范名、别名和状态：

```json
{
  "knownActors": [
    {
      "ref": "actor-001",
      "canonicalName": "白夕小时",
      "aliases": ["小时", "小時", "小时姐姐"],
      "status": "confirmed"
    },
    {
      "ref": "actor-002",
      "canonicalName": "白夕琴乃（重构体）",
      "aliases": ["白夕琴乃", "琴乃", "琴乃·重构体"],
      "status": "confirmed"
    }
  ]
}
```

模型输出时不再填写自由文本角色名称，而是填写：

```json
{
  "participantRefs": ["actor-001", "actor-002"]
}
```

这样可以直接避免：

- `小时` 与 `白夕小时` 被拆成两个人；
- `琴乃`、`白夕琴乃`、`白夕琴乃（重构体）` 被拆开；
- `重构体` 被当成独立人物；
- 模型自行创造不存在的规范名。

### 3.2 是否每批提供全部角色

建议规则：

- 已确认角色不超过 64 个：每批全部提供；
- 超过 64 个：提供当前场景角色、近期提及角色，以及通过关键词/向量检索选出的相关角色；
- 当前在场角色和当前视角角色必须始终加入；
- 角色目录由数据库和人工确认结果生成，不由模型自由总结。

### 3.3 地点清单：应该加入，但不建议把全世界所有地点都塞进每批

地点比人物更容易增长，建议采用“相关地点目录”：

```json
{
  "knownLocations": [
    {
      "ref": "location-001",
      "canonicalName": "赤坂·天穹御苑3801室",
      "aliases": ["豪宅", "3801室", "住所"]
    },
    {
      "ref": "location-002",
      "canonicalName": "豪宅地下车库",
      "aliases": ["地下车库", "车库"]
    }
  ]
}
```

每批只提供：

- 当前场景地点；
- 本批正文直接出现的已知地点；
- 近期场景地点；
- 检索得到的少量相关地点。

新地点必须通过 `locationCandidate` 输出，并带当前来源中的逐字证据，不能直接写入正式地点库。

### 3.4 物品、能力、组织是否也全部做目录

不建议一开始把所有名词都变成强约束目录。优先顺序应为：

1. 人物；
2. 地点；
3. 组织/阵营；
4. 关键唯一物品；
5. 普通物资、能力、状态继续使用自然文本，但在写入后做规范化和实体链接。

人物串错的代价最高，因此人物必须最严格。

## 四、不能只依赖提示词解决 Schema 问题

可靠结构化输出应采用五层防线：

```text
Provider 能力探测
    ↓
选择真实可用的传输模式
    ↓
本地确定性归一化
    ↓
JSON Schema + 领域规则验证
    ↓
定向自动修复 / 隔离失败记录
```

提示词只能是其中一层，不能承担全部可靠性。

## 五、Provider 结构化输出能力分级

建议在 SS-Helper-LLM 中为每个“资源 + 模型”保存探测结果：

| 模式 | 含义 | 处理方式 |
|---|---|---|
| `native_strict` | 实际通过严格 Schema 探测 | 使用 `json_schema` |
| `json_object_validated` | 能稳定输出 JSON，但不真正约束 Schema | 使用 `json_object` + 本地验证与修复 |
| `prompt_json` | 不支持 response_format，但能按提示输出 JSON | Schema 注入提示词 + 本地解析 |
| `unsupported` | 无法稳定产生结构化输出 | 不允许承担 Memory Capture |

能力探测不能只检查 HTTP 状态，必须使用包含以下陷阱的测试 Schema：

- enum；
- required；
- additionalProperties=false；
- nullable number；
- 嵌套数组；
- 最大长度；
- 故意要求模型输出空值。

只要有一项违反，就不能标记为 `native_strict`。

按照当前 `.env` 实测结果，当前生成资源应暂时标记为：

```text
json_object_validated
```

而不是 `native_strict`。

## 六、立即修复当前 89 条拒绝的方式

### 6.1 不再让模型生成机器时间戳

当前 `occurredAt`、`validFrom`、`validUntil` 都是机器数值，但模型实际看到的是剧情文本和 SourceBlock。模型并不适合生成可信的 Unix 时间戳。

建议从模型响应 Schema 中移除：

- `episode.occurredAt`；
- `observation.occurredAt`；
- `fact.validFrom`；
- `fact.validUntil`。

由系统确定性计算：

- Episode 时间：取 sourceRefs 中最早来源的 `createdAt`；
- Observation 时间：直接使用 sourceRef 对应的 `createdAt`；
- Fact freshestEvidenceAt：直接使用证据来源时间；
- validFrom：状态事实默认使用首次证据时间；
- validUntil：发生 supersede 时由系统填写；
- 剧情中的“第十八日”“凌晨四点”另存为 `storyTimeText`，不要和机器时间混用。

这项修改可以直接消除当前 65 条直接拒绝，并消除由事件失败引起的 23 条级联拒绝。

### 6.2 对可选字段建立统一规则

建议统一约定：

- 不确定的可选字段必须省略；
- `null`、`""`、空数组按字段规则删除；
- 只有明确支持 null 的业务字段才能保留 null；
- Schema、归一化器、领域类型和应用层验证必须使用同一套定义。

确定性修复器增加：

```text
occurredAt: null / ""       → 删除，之后由来源回填
validFrom: null / ""        → 删除，之后由来源回填
validUntil: null / ""       → 删除
viewportRef                  → viewpointRef
sourceRefs[0]                → sourceRef
90%                          → 0.9
visual / auditory            → narration
plan                          → goal
action                        → event
```

### 6.3 修复事件失败的级联问题

当前 Observation 强依赖 `episodeLocalId`。如果 Episode 因一个非核心字段失败，整组观察也会全部失败。

建议：

1. Episode 核心字段只有 `localId`、`sourceRefs`、`summary`；
2. location、人物、故事时间均为可选增强字段；
3. 如果 Observation 的 episodeLocalId 无效：
   - 当前批只有一个 Episode 时自动绑定；
   - sourceRef 与某个 Episode sourceRefs 唯一重叠时自动绑定；
   - 否则创建确定性的“来源事件容器”，而不是直接丢弃 Observation；
4. 只有无法确认来源的 Observation 才进入隔离区。

## 七、建议简化模型输出结构

当前一次调用要求模型同时维护：

- actorCandidates；
- episodes；
- observations；
- facts；
- 多组 localId；
- 多组跨数组引用。

这种 Schema 对普通 OpenAI-compatible 模型非常容易出错。建议改为：

```json
{
  "actorCandidates": [],
  "locationCandidates": [],
  "episodes": [],
  "claims": []
}
```

### 建议的 Episode

```json
{
  "localId": "episode-1",
  "sourceRefs": ["message:floor-116"],
  "participantRefs": ["actor-001", "actor-002"],
  "presentRefs": ["actor-001", "actor-002"],
  "locationRef": "location-003",
  "storyTimeText": "第三十八日清晨",
  "summary": "团队侦察加油站并确认地下储油库状态。"
}
```

### 建议的 Claim

```json
{
  "localId": "claim-1",
  "sourceRef": "message:floor-116",
  "episodeLocalId": "episode-1",
  "kind": "state",
  "subject": {
    "type": "location",
    "ref": "location-004"
  },
  "predicateKey": "燃油储量",
  "objectText": "总容量的百分之四十五",
  "content": "加油站地下储油库的燃油液面约为总容量的百分之四十五。",
  "evidenceExcerpt": "液面高度约储油库总高度的百分之四十五",
  "knowledge": {
    "mode": "experienced",
    "ownerRefs": ["actor-002"],
    "privacy": "limited"
  },
  "confidence": 0.98
}
```

随后由服务器从 Claim 确定性生成：

- MemoryFact；
- MemoryEvidence；
- MemoryObservation；
- ActorMemoryTrace；
- FactHead / supersession；
- Graph node / edge。

这样可以删除：

- `factLocalIds`；
- `observationLocalIds`；
- 多数 Observation 的自由文本结构；
- 大量跨数组依赖。

模型负责“理解”，服务器负责“建模和关联”。

## 八、人物和地点的正确处理流程

### 8.1 初始化前建立实体目录

来源优先级：

1. 用户人工确认；
2. 角色卡明确人物定义；
3. 世界书明确人物定义；
4. 聊天中的“目前已出场角色”清单；
5. 状态栏中的规范姓名；
6. 模型提出的新人物候选。

注意：

- “目前已出场角色”可作为角色种子，但不能作为对话事实；
- “状态栏”可作为状态快照，但不能被当成叙事发言；
- “剧情选项”不得作为已发生事件；
- `重构体` 属于人物描述，不应独立建人；
- `表情的话` 属于普通短语，应进入否定样例和黑名单规则。

### 8.2 新人物进入正式库的门槛

满足任一条件才能自动确认：

- 角色卡或世界书明确声明；
- 当前正文中有明确命名，并且存在独立行动、发言、思考或知情证据；
- 两个独立来源重复出现且名称一致；
- 用户人工确认。

否则只进入 pending candidate，不得参与私密记忆召回。

### 8.3 实体合并顺序

```text
规范化完全匹配
→ 已确认别名匹配
→ 繁简转换匹配
→ 姓名包含关系（白夕小时 / 小时）
→ 向量相似度 + 场景一致性
→ LLM 仅对歧义项作裁决
→ 无法确定则 pending，不自动合并
```

## 九、自动结构修复闭环

借鉴 TypeChat 和 Instructor 的方式，建议为后台 Memory 增加一次自动修复，而不是要求用户手工点击重试。

处理顺序：

```text
原始输出
→ JSON 解析
→ 确定性归一化
→ Schema 验证
→ 领域验证
→ 若仍失败，生成最小错误清单
→ 仅对无效记录发起一次定向修复
→ 再验证
→ 有效记录提交，无效记录隔离
```

定向修复提示只包含：

- 原始无效记录；
- 对应 sourceBlocks；
- 具体 JSONPath；
- 期望类型；
- 允许字段；
- 禁止修改已经验证通过的记录。

例如：

```text
只修复 facts[3].validFrom。
该字段是可选字段；无法从来源确定时必须删除，不得输出 null、空字符串或猜测数字。
其他记录不得修改。
```

自动修复上限建议为一次。仍失败则进入隔离区，并让任务显示 `partial`，不能静默显示 complete。

## 十、提升“记忆内容本身”的质量

Schema 正确不代表记忆有价值。还需要写入前质量门禁。

### 10.1 记忆价值评分

建议为每个 Claim 计算：

```text
质量分 =
  证据精确度
× 来源可信度
× 信息具体度
× 后续可召回价值
× 实体解析置信度
× 时间清晰度
```

建议阈值：

- ≥ 0.75：自动写入；
- 0.55–0.75：pending；
- < 0.55：不写入，只保留审计。

### 10.2 需要优先保留的内容

- 人物身份、关系、能力、弱点；
- 位置和场景变化；
- 库存、数量、百分比；
- 任务、目标、承诺；
- 世界规则；
- 已发生的重要事件；
- 当前有效状态；
- 角色亲历、听闻、相信或怀疑的认知边界。

### 10.3 应跳过或降权的内容

- 剧情选项菜单；
- “顺着剧情发展”等控制文本；
- 模板化状态栏标题；
- 重复描述但没有新信息的段落；
- 未发生的假设选项；
- 无证据的推断；
- 仅为文风修饰、对后续剧情无检索价值的句子。

### 10.4 采用追加式事实，而不是让模型直接覆盖旧事实

建议借鉴 Mem0 新算法的 ADD-only 思路：

- 模型只抽取当前来源的新 Claim；
- 不让模型直接删除或覆盖旧事实；
- 系统根据 slotKey 和时间关系生成 supersede；
- 历史事实保留；
- 当前状态由 FactHead 指向最新事实；
- 查询过去状态时仍可召回旧事实。

这非常适合剧情记忆，因为“肉类罐头 15 盒”变成“11 盒”不是前一条错误，而是不同时间的状态。

## 十一、开源项目中值得借鉴的方案

| 项目 | 值得借鉴的点 | 在本项目中的应用 |
|---|---|---|
| Microsoft TypeChat | 类型定义、验证失败后让模型修复、再验证 | 为 Memory 增加一次自动定向修复 |
| Instructor | Pydantic/Zod 验证、把具体校验错误反馈给模型、有限重试 | 统一 Schema 与领域验证错误格式 |
| Outlines | 在解码阶段约束 Token，使非法 JSON 无法生成 | 如果后续自建 vLLM/Ollama/llama.cpp，可使用 guided JSON/grammar |
| Graphiti | 区分 `json_schema` 与 `json_object`；警告部分兼容接口接受 Schema 但不真正约束；实体与边去重 | 增加真实能力探测、资源级结构模式、实体解析阶段 |
| Mem0 | ADD-only 抽取、实体链接、语义+BM25+实体多信号融合、时间推理 | 保持追加式事实，服务器管理 supersession 与当前 head |
| LangGraph Memory / LangMem | 区分持续更新的 Profile Schema 与可检索 Event Memory | 分开人物画像、当前状态和事件记忆 |
| Letta | Subject + Memory Block 的分区思想 | 世界、角色、当前场景、人物画像分区维护 |

## 十二、推荐实施顺序

### P0：先消除当前明确错误

1. 从模型 Schema 移除机器时间字段；
2. 由 sourceRef 确定性生成时间；
3. null / 空字符串可选字段自动删除；
4. `viewportRef → viewpointRef`；
5. capture job 聚合批次 unresolved rejection；
6. 当前生成资源标记为 `json_object_validated`；
7. 后台结构错误自动定向修复一次。

预期：当前 89 条拒绝理论上可下降到接近 0。

### P1：解决人物和地点质量

1. 初始化前建立可信角色目录；
2. 输出字段改用 actorRef，而不是自由文本姓名；
3. 添加相关地点目录和 locationRef；
4. 解析 SillyTavern 的角色清单、状态栏、剧情选项等区块；
5. 增加误人物否定样例和候选门禁；
6. 合并现有短名/全名重复记录。

### P2：简化 Capture Schema

1. `observations + facts` 改为单层 `claims`；
2. Observation、Trace、Evidence 由服务器派生；
3. 减少跨数组 localId 引用；
4. 把世界时间与机器时间分开；
5. 事实采用 append-only + FactHead。

### P3：建立质量评测集

用当前 117 条聊天制作固定评测集，至少包含：

- 规范角色与别名；
- 关键地点；
- 30–50 条必须抽取的核心事实；
- 10–20 条必须跳过的元文本；
- 角色私密记忆边界；
- 库存和状态更新；
- 代表性召回查询。

## 十三、建议验收指标

| 指标 | 建议门槛 |
|---|---:|
| JSON 可解析率 | 100% |
| Schema 首次通过率 | ≥ 98% |
| 归一化/自动修复后通过率 | ≥ 99.8% |
| unresolved rejection | 0；非 0 时任务不得显示 complete |
| 证据逐字匹配率 | 100% |
| orphan Episode/Observation/Trace | 0 |
| 角色重复数 | 0 |
| 明显误人物 | 0 |
| 关键事实抽取召回率 | ≥ 95% |
| 核心事实精确率 | ≥ 95% |
| 私密记忆串角率 | 0 |
| 应索引事实向量覆盖率 | 100% |
| 代表性查询 Top 3 命中率 | ≥ 90% |

## 十四、建议下一轮讨论先确定的决策

1. 是否接受“模型不再输出 occurredAt/validFrom/validUntil，由系统生成”；
2. 是否将人物引用全面改为稳定 actorRef；
3. 是否加入 LocationRegistry；
4. 是否把 Observation 改为服务器派生；
5. 当前 `.env` 生成资源是否固定使用 `json_object_validated`；
6. 自动修复允许 1 次还是 2 次；
7. pending 事实和 pending 人物在召回时允许到什么程度；
8. 是否把当前 117 条聊天制作成正式回归评测集。

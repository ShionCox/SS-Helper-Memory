# SS-Helper-Memory 召回质量优化技术调研与落地记录

## 1. 调研目标

本轮调研只围绕完整真实数据测试中已经复现的问题：

1. 事件、命令、目标被后续同谓词事实错误覆盖；
2. 模型将稳定的 prompt-local 人物或地点引用写错一个字符；
3. 证据只存在中英文标点差异，却被当作原文不匹配；
4. 向量与关键词融合后，只把头部少量候选交给重排序，直接能力事实进不了最终候选池；
5. “最初”“当前”“能力”“如何指挥”等不同问题类型缺少不同的时间与事实类型策略；
6. OpenAI-compatible 中转接受 JSON Schema 参数，却不一定真正约束生成。

## 2. 可直接借鉴的仓库与论文

### 2.1 Graphiti / Zep：时间事实、Episode 溯源、混合检索

- 仓库：https://github.com/getzep/graphiti
- 关键设计：
  - 原始 Episode 作为不可变来源；
  - 事实带有效时间窗口，历史不会被物理删除；
  - 语义、BM25、图遍历联合检索；
  - OpenAI-compatible 服务可显式切换 `json_schema` 和 `json_object`；
  - 对不可靠结构化输出服务降低并发并进行本地验证。
- 对本项目的应用：
  - 保留 SourceBlock、Evidence、Episode 的完整溯源；
  - mutable state 使用 supersede，event/goal/commitment 使用 append-only；
  - 生成资源能力探测后选择 `json_object_validated`，不能把 HTTP 200 等同于 strict schema 生效。

### 2.2 Mem0 2026 新算法：ADD-only、实体链接、多信号与时间推理

- 仓库：https://github.com/mem0ai/mem0
- 关键设计：
  - 单次 ADD-only 抽取，不让抽取模型直接 UPDATE/DELETE；
  - 实体链接作为召回增强信号；
  - semantic、BM25、entity matching 并行融合；
  - 当前状态、历史事件、未来计划采用不同时间检索策略。
- 对本项目的应用：
  - Claim 只追加，冲突与 FactHead 由服务器判定；
  - actorRef/locationRef 采用稳定目录；
  - 召回阶段增加 query intent 和 fact kind affinity。

### 2.3 TG-RAG 与 DyG-RAG：相同实体的不同时间事件必须是不同检索单元

- TG-RAG：https://arxiv.org/abs/2510.13590
- DyG-RAG：https://arxiv.org/abs/2507.13396
- 关键设计：
  - 同一事实或关系在不同时间出现时，用独立时间边或 Dynamic Event Unit 表达；
  - 通过时间范围和语义范围共同检索；
  - 查询“最初”“后来”“当前”时按时间算子选择不同证据。
- 对本项目的应用：
  - event、goal、commitment 不再按 `subject + predicate` 互相 supersede；
  - source floor 作为故事内顺序的可靠代理；
  - “最初”查询优先选择最早匹配事件，而不是最早写入数据库的记录。

### 2.4 Query-aware KG Fusion、CAR：重排序应关心查询用途，而不只是相似度

- QMKGF：https://arxiv.org/abs/2507.16826
- CAR：https://arxiv.org/abs/2605.04495
- 关键设计：
  - 查询决定要检索的路径、关系和证据类型；
  - 单纯 query-document relevance 不等于对最终回答最有用；
  - 已经高置信的查询可跳过昂贵重排，困难查询扩大候选。
- 对本项目的应用：
  - 能力问题优先 capability；
  - 当前数量问题优先最新、精确 numeric state；
  - 历史指挥问题优先对应时间的 event；
  - 普通查询重排 4 条，类型、时间、多主题或多跳查询重排 8 条；
  - 实测当前 Qwen3 资源的 12 条长文档重排会超过 30 秒，因此以真实 SLA 为准回落到 8 条；
  - 发送给 Reranker 的 query 包含明确的排序任务说明。

### 2.5 Google LangExtract：精确 source grounding 与长文多轮提取

- 仓库：https://github.com/google/langextract
- 关键设计：
  - 每条结构化结果映射回来源中的准确位置；
  - 使用高质量示例约束输出；
  - 长文通过分块和多轮处理提升召回率。
- 对本项目的应用：
  - Evidence 永远保存来源中的连续原文；
  - 模型证据只有标点、空格、全半角差异时，先投影定位，再回写来源真实字符串；
  - 歧义匹配仍然 fail-closed。

### 2.6 Instructor / TypeChat / Outlines：结构化输出不能只靠提示词

- Instructor：https://github.com/567-labs/instructor
- Instructor JS：https://github.com/567-labs/instructor-js
- Outlines：https://github.com/dottxt-ai/outlines
- 关键设计：
  - Schema 是唯一数据契约；
  - 验证错误可以反馈给模型进行有限定向修复；
  - 能控制 logits 时，生成阶段直接屏蔽非法 Token。
- 对本项目的应用：
  - 当前远程中转不能保证 constrained decoding，因此使用：
    `JSON object → 确定性归一化 → Schema/领域校验 → 一次定向修复 → 隔离`；
  - 未来若改为自建 vLLM/SGLang，可接入 grammar-constrained decoding，进一步降低结构修复成本。

### 2.7 HaluMem / LongMemEval：验收不能只看数据库是否写成功

- HaluMem：https://github.com/MemTensor/HaluMem
- Memory Benchmarks：https://github.com/mem0ai/memory-benchmarks
- 关键设计：
  - 分开评估 Event、Persona、Relationship；
  - 覆盖 basic recall、dynamic update、multi-hop、conflict、boundary；
  - 长期记忆需要固定金标准，而不是只统计生成条数。
- 对本项目的应用：
  - 当前 117 条聊天建立四个强制召回断言；
  - 同时检查 rejection、orphan、角色重复、地点重复、向量覆盖和来源覆盖；
  - 后续扩大为事件、人物画像、关系、当前状态、私密边界、时间变化六类评测集。

## 3. 已落地改动

| 问题 | 当前实现 |
|---|---|
| 事件被后续命令覆盖 | `event / goal / commitment` append-only |
| 地点或人物引用一字符转置 | Damerau-Levenshtein 距离 + 正文实体唯一命中双门禁 |
| 中英文省略号等价 | 去标点投影定位，保存来源精确原文 |
| 能力事实进不了 Reranker | fact-kind affinity + 意图保留候选 |
| 固定 Top 4 候选不足 | 4 / 8 自适应候选池，并保留最早事件组 |
| Reranker 只看普通相关性 | query 注入能力、时间和事实类型优先级 |
| “最初”事件选错 | source floor 时间顺序保护 |
| 结构化输出不可靠 | `json_object_validated` + 一次定向修复 |

## 4. 暂不直接引入的方案

### Neo4j / FalkorDB 全量替换 SQLite

Graphiti 的图数据库方案适合大规模、多跳、跨会话系统，但当前插件需要本地、低依赖、可备份的 SillyTavern 使用体验。现阶段保留 SQLite，并将时间、实体、图谱和来源关系作为规范化集合存储；只有实际规模证明 SQLite 查询或图遍历成为瓶颈时再评估外部图数据库。

### 在每次召回中使用生成模型做多轮 CAR

CAR 的置信度增益重排需要多次生成答案，质量潜力高，但不适合当前生成前注入链路的延迟预算。当前采用单次跨编码 Reranker，并用规则化 query intent 减少候选噪声；CAR 可作为离线审计或高价值诊断模式。

### 对所有实体使用宽松模糊匹配

宽松 fuzzy matching 容易将剧情中相似人物或地点错误合并。当前只修复 prompt-local 短 ID，且要求：

1. 编辑距离极小；
2. 正文明确出现对应规范名或别名；
3. 候选唯一；
4. 有歧义时拒绝。

## 5. 最终验收门槛

1. 24/24 批、117/117 消息真实持久化；
2. unresolved rejection = 0；
3. orphan Episode / Observation / Trace = 0；
4. actor/location 明显重复和错误实体 = 0；
5. active + pending 事实向量覆盖率 = 100%；
6. 以下查询全部通过：
   - 紫色晶雨初期指挥；
   - 紫罗能力；
   - 地下储油库精确 45% 燃油；
   - 琴乃通过紫罗感知外界并协助侦察；
7. `pnpm lint`、`pnpm test`、`pnpm build`、`git diff --check` 全部通过。

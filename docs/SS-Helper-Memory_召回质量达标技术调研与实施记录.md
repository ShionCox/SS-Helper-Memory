# SS-Helper-Memory 召回质量达标技术调研与实施记录

## 1. 本轮问题与采用的技术方向

| 实测问题 | 借鉴方向 | 本项目实施 |
|---|---|---|
| 后续“命令/目标”覆盖早期事件 | Graphiti 的时间知识图谱与双时态事实；事件溯源 | `event`、`goal`、`commitment` 改为 append-only；只有状态、数量、位置等互斥槽位允许 supersede |
| 模型把 prompt-local 实体引用写错一个字符 | Graphiti 的实体解析/去重；实体链接中的候选生成与唯一消歧 | 仅在编辑距离不超过 1、候选唯一、且证据明确写出实体规范名/别名时自动修复 |
| 中文省略号与英文句点导致证据被拒 | 结构化抽取的确定性规范化与 fail-closed evidence grounding | 使用忽略标点/空白/全半角的投影定位，但最终保存来源中的连续逐字原文 |
| 正确事实未进入 4 条 Rerank 候选 | RankRAG 的 query-aware ranking；BGE-M3 的多阶段混合检索 | Rerank 候选由固定 4 条改为动态 12–24 条；文档加入类型、主体、谓词、客体和来源元数据 |
| “能力”问题被未来任务压过 | 查询意图路由与类型感知排序 | 识别 capability、current numeric state、historical directive 等意图；直接主体 + 目标类型形成确定性优先通道 |
| 只看最终答案，难以判断是哪一层失败 | RAGChecker 的细粒度检索/生成诊断；LongMemEval/LoCoMo 的长期记忆评测 | 分开记录来源覆盖、抽取拒绝、实体唯一性、向量覆盖、候选召回、Rerank、Top-K 命中和历史/当前状态一致性 |

## 2. 参考仓库与论文

### Graphiti / Zep

- 仓库：https://github.com/getzep/graphiti
- 适用点：时间知识图谱、双时态事实、实体去重、混合检索和历史事实失效管理。
- 本项目不直接引入其数据库，而是借鉴“事件追加、状态更新、查询时按时间选择”的数据语义。

### HippoRAG 2

- 仓库：https://github.com/OSU-NLP-Group/HippoRAG
- 适用点：实体链接后使用图上的 Personalized PageRank 扩展候选，适合跨事件、多跳和关系问题。
- 本项目保留现有事实背书图谱，并把图谱作为关键词、向量之外的第三路候选，而不是让图谱直接覆盖证据事实。

### BGE-M3 / FlagEmbedding

- 仓库：https://github.com/FlagOpen/FlagEmbedding
- 适用点：Dense、Sparse、Multi-vector 三种检索能力以及长文本支持。
- 本项目当前继续使用配置中的 Qwen3 Embedding，但沿用 dense + lexical + graph 的多路候选融合结构，避免只靠单向量近邻。

### RankRAG

- 论文：RankRAG: Unifying Context Ranking with Retrieval-Augmented Generation in LLMs
- 适用点：让排序阶段理解查询目标，不只比较表面语义相似度。
- 本项目实现轻量版 query-aware reranking：先解析问题意图，再用 Reranker 做同一意图通道内的语义排序。

### RAGChecker

- 仓库：https://github.com/amazon-science/RAGChecker
- 适用点：分别诊断检索器与生成器，避免“最终答错”时无法判断是抽取缺失、候选漏召回还是重排错误。
- 本项目最终报告分开输出 Capture、Evidence、Entity、Vector、Candidate、Rerank、Top-K 七层指标。

### LongMemEval 与 LoCoMo

- LongMemEval：https://github.com/xiaowu0162/LongMemEval
- LoCoMo：https://github.com/snap-research/locomo
- 适用点：长时间、多会话、时间更新、历史追溯和对话记忆问答。
- 本项目把真实酒馆聊天构造成固定回归集，要求同时验证“最初发生什么”和“目前最新状态”，防止只会召回最近内容。

## 3. 最终召回流水线

```text
查询
  ↓
规则/模型意图解析
  ├─ 当前数值状态
  ├─ 历史事件/最初指令
  ├─ 人物能力
  ├─ 关系/世界规则
  └─ 多主题/多跳
  ↓
关键词 BM25 + 向量 + 事实图谱候选
  ↓
时态与隐私硬过滤
  ↓
动态 12–24 条结构化 Rerank 文档
  ↓
直接主体 × 目标类型意图通道
  ↓
Reranker 通道内排序
  ↓
覆盖检查与 Top-K 输出
```

## 4. 严格安全边界

1. 近似引用只允许唯一候选，且正文必须明确写出候选实体名称。
2. 证据规范化只用于定位，持久化内容必须是来源中的连续原文。
3. 事件追加不等于所有事实都不更新；库存、数量、位置和当前状态仍按时间 supersede。
4. Reranker 不能绕过聊天范围、角色知情边界、隐私或证据门禁。
5. 当前状态事实在重排前被保护，不能被旧状态重新排到前面。

## 5. 验收目标

| 指标 | 门槛 |
|---|---:|
| 24 批真实持久化 | 24 / 24 |
| 117 条消息来源覆盖 | 117 / 117 |
| unresolved rejection | 0 |
| 孤立 Observation / Trace | 0 |
| 人物和地点明显重复 | 0 |
| active/pending 事实向量覆盖 | 100% |
| 晶雨初期指令 Top 5 | 命中 |
| 紫罗能力 Top 3 | 命中 |
| 地下储油库 45% Top 3 | 命中 |
| 琴乃感知侦察能力 Top 5 | 命中 |
| 最终关键问题 | 4 / 4 通过 |

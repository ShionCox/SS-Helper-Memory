# 卡内多角色认知记忆重构实施跟踪

> 基线：`0.0.1` / `v0`。本文件只记录新链路实施证据，不提供旧 SQLite 数据迁移。

## 当前状态

- 当前阶段：P7（离线评测、UI 收口与发布门禁）
- 下一任务：由用户删除 `I:\\SillyTavern\\data\\_ss-helper-v0` 中的旧 SQLite 数据并重启酒馆后，重新执行真实 Capture、Dream Apply/回滚与跨角色使用率 smoke
- 阻塞项：当前 v0 SQLite 仍在 `character:default_Assistant.png` 工作区发现退休集合 `fact-slots`、`jobs`、`job-audits`；实现按约定安全停用且不会自动迁移、清空或覆盖旧库。截图聊天 `小時` 已绑定到干净的 v0 工作区，但保留了先前一次失败的暂停 Capture 记录；最新部署后未再次发起模型请求，因此真实模型串线率、自动 Dream Apply/回滚仍缺少外部环境证据
- 最后更新：2026-07-22

## 决策记录

| 日期 | 决策 | 结果 |
| --- | --- | --- |
| 2026-07-22 | 宿主角色卡/群组是世界容器，不是 `MemoryOwner` | owner 使用卡内自动发现主体及固定 `world/narrator/player/unknown` |
| 2026-07-22 | 角色全自动发现 | 精确/规范化/唯一模糊候选自动接受，歧义进入 pending/unknown |
| 2026-07-22 | 单次整合生成 | 分区召回合并为一个原生酒馆生成调用 |
| 2026-07-22 | Dream 默认自动应用 | 每主体独立队列、审计、ChangeSet 与回滚 |
| 2026-07-22 | 用户直接删除旧数据库 | 不实现迁移、归档导入、旧集合兼容或重置工具 |

## P0–P7 清单

- [x] P0 跟踪基线与召回清理
- [x] P1 卡内人物发现与场景身份
- [x] P2 事件、观察、角色记忆痕迹与新事务
- [x] P3 多角色召回与单次分区 Prompt
- [x] P4 记忆强度与确定性模糊召回
- [x] P5 人物与关系画像
- [x] P6 自动 Dream
- [ ] P7 离线评测、UI 收口与发布门禁

## 验收证据

| 阶段 | 命令/检查 | 结果 | 日期 |
| --- | --- | --- | --- |
| 基线（用户锁定） | `SS-Helper-Memory: pnpm test` | 219 passed, 1 skipped（真实历史集成测试） | 2026-07-22 |
| 基线 | `SS-Helper-Memory: pnpm typecheck` | passed | 2026-07-22 |
| 基线 | `SS-Helper-Memory: pnpm lint` | passed | 2026-07-22 |
| 基线 | `SS-Helper-Memory: pnpm build` | passed | 2026-07-22 |
| 基线（用户锁定） | `SS-Helper-SDK: pnpm test/typecheck/artifact:gate` | 93 项测试、类型夹具与 9 项架构边界检查通过 | 2026-07-22 |
| P0–P6 | `SS-Helper-Memory: pnpm test` | 222 passed, 1 skipped（真实历史集成测试） | 2026-07-22 |
| P0–P6 | `SS-Helper-Memory: pnpm typecheck/lint/build` | passed；legacy scan PASS | 2026-07-22 |
| P1–P3 | `test/multi-actor-memory.spec.ts` | 7 passed：卡片容器/自动发现、私密与世界隔离、明确主体播种、单次分区、强度种子、画像门槛、Dream 回滚 | 2026-07-22 |
| SDK | `SS-Helper-SDK: pnpm typecheck` | passed | 2026-07-22 |
| P4 | `test/multi-actor-memory.spec.ts` | 6 passed：强度公式/稳定种子、Exposure rehearsal、分区隔离 | 2026-07-22 |
| P5 | `test/multi-actor-memory.spec.ts` | 画像重复证据门槛、关系双方 ownerId 与 Trace 引用通过 | 2026-07-22 |
| P6 | `test/multi-actor-memory.spec.ts` | Dream 默认 Apply、阶段审计、fictional DreamNarrative 与回滚通过 | 2026-07-22 |
| P7 | `MemoryUiController`/Workbench | 新增概览、人物与别名、场景与事件、角色记忆、画像与关系、Dream 页面；保留 dry-run 入口 | 2026-07-22 |
| 门禁 | `SS-Helper-Memory: pnpm test/typecheck/lint/build` | 222 passed, 1 skipped；类型检查、legacy scan、构建通过 | 2026-07-22 |
| 门禁 | `SS-Helper-SDK: pnpm test` | 93 passed；type fixtures、migration baseline 9/9 通过 | 2026-07-22 |
| 门禁 | `SS-Helper-SDK: pnpm artifact:gate` | PASS G009；SDK/Core 产物与 contentDigest 校验通过 | 2026-07-22 |
| 门禁 | 根目录 `pnpm build` | SDK、Core、LLM、Memory 三产物构建通过 | 2026-07-22 |
| 收尾修正 | `SS-Helper-Memory: pnpm test/typecheck/lint/build` | 220 passed, 1 skipped；强度显著度/强化时间、客观索引同步修正后仍全部通过 | 2026-07-22 |
| 收尾修正 | `MEMORY_RECALL_V0` SDK/Core/Memory adapter | v0 请求/响应已切换为严格多主体分区 DTO，移除 `items/limit/actorKey` 兼容分支；Memory adapter、Core 跨插件契约测试通过 | 2026-07-22 |
| 收尾修正 | `SS-Helper-SDK: pnpm test/typecheck/lint` | 93 passed；类型夹具 nodenext/bundler、迁移基线 9/9、边界 lint 通过 | 2026-07-22 |
| 收尾修正 | SDK vendor/tarball | `ss-helper-sdk-0.0.1.tgz` SHA-256 `3b3d24051b64100f4b3a9f8baa016dcbc58bcc13b61f5633fc22ec76f09ab862`，Memory lockfile integrity 已同步 | 2026-07-22 |
| 收尾修正 | 来源契约清理 | 删除 `SourceBlock`/`MemorySourceType` 的旧 `character` 来源别名，工作台与初始化选择统一使用 `host_card`；Memory 220 passed/1 skipped 复验 | 2026-07-22 |
| 收尾修正 | Dream idle gate | 自动 Dream 以主体为单位持久化 queued job，并在默认 30 秒宿主空闲窗口后 Apply；聊天切换/停止会取消定时器，失败按指数退避重试 | 2026-07-22 |
| 最终门禁 | `SS-Helper-SDK: pnpm artifact:gate` | PASS G009；SDK `3b3d24051b64100f4b3a9f8baa016dcbc58bcc13b61f5633fc22ec76f09ab862`、Core `a7a6aa365c723720f9156dc7d8f0504ae0ed712beed55f616140c34751807267`、contentDigest `709ddb5e359aa1baeecfe76e450c31bc45c55fc4cb8a2a8a72de027efe890cae` | 2026-07-22 |
| 最终门禁 | 根目录 `pnpm build` | LLM、Memory、SDK/Core 三产物构建通过；版本策略 0.0.1、API 0.0.1、schema/protocol v0 通过 | 2026-07-22 |
| 审查修正 | `test/multi-actor-capture.integration.spec.ts` | 固定故事完成 A/B/玩家/旁白发现、公开/私密/传闻/谎言、世界事实隔离、场景切换与待确认归属验证 | 2026-07-22 |
| 审查修正 | `test/multi-actor-repository.spec.ts` | Trace 合并保留强度、清晰度、信念置信度、情绪显著度、rehearsal 与 revision；派生记录随 ChangeSet 回滚 | 2026-07-22 |
| 审查修正 | `test/actor-pipeline.performance.spec.ts` | 10,000 facts + 50,000 traces 重复测量，角色过滤/索引/Prompt 组装 p95 < 300ms | 2026-07-22 |
| 审查修正 | `test/prompt-injection.spec.ts` / `test/multi-actor-memory.spec.ts` | XML 分区、规则与自定义文本转义；低清晰度回忆不退回完整事实正文；同一场景种子稳定 | 2026-07-22 |
| 审查修正 | `actor-registry.ts` / `multi-actor-memory-repository.ts` / `memory-application.ts` | 待确认候选、别名纠正/拆分审计可跨重启恢复；候选状态与别名旧记录同步清理；旧 `fact-slots`/`jobs`/`job-audits`/初始化 staging 非空时启动返回 `MEMORY_RETIRED_STORAGE_DETECTED`，不执行迁移 | 2026-07-22 |
| 审查修正 | `actor-registry.ts` / `test/actor-registry.spec.ts` | pending 主体及 pending 别名不再参与自动精确/模糊归属；重复低置信提及仍待确认，必须显式确认后才进入 confirmed | 2026-07-22 |
| 审查修正 | `actor-recall-service.ts` / `profile-coordinator.ts` | 未提供显式时以 SceneCast.createdAt 固定召回时钟，避免同一场景的 S_eff 因毫秒抖动变化；画像 weaken 仅携带已加载的合法 Trace 引用，不再产生无来源增量 | 2026-07-22 |
| 审查修正 | `knowledge-leakage-audit.ts` / `multi-actor-memory-repository.ts` | 生成后泄漏审计现在以 outputHash、主体 ID、指标和 marker hash 写入 change-audits，不保存聊天、Prompt 或事实正文 | 2026-07-22 |
| 审查修正 | `multi-actor-memory-repository.ts` / `test/multi-actor-repository.spec.ts` | Trace 合并仅在出现新 sourceObservation 时增加 rehearsal 与 lastRehearsedAt；重复 Capture 保持幂等，避免候选召回自我强化 | 2026-07-22 |
| 审查修正 | `memory-application.ts` / `memory-ui.ts` / `ui-contract.spec.ts` | 旧 SQLite 归档导入 API 改为 `MEMORY_ARCHIVE_IMPORT_DISABLED` 安全拒绝，工作台移除旧归档导入入口，v0 不再提供迁移或归档恢复链路 | 2026-07-22 |
| 最终复核 | `SS-Helper-Memory: pnpm test/typecheck/lint/build` | 225 passed, 1 skipped；低置信确认、跨聊天清理、旧存储拒绝、派生回滚、泄漏审计、重复观察强化与无 staging 初始化回归通过 | 2026-07-22 |
| 最终复核 | `SS-Helper-SDK: pnpm test/typecheck/lint` | 93 passed；类型夹具、迁移基线 9/9、边界 lint 通过 | 2026-07-22 |
| 最终复核 | 根目录 `pnpm build` | SDK、Core、LLM、Memory 三产物构建通过；版本策略 0.0.1、API 0.0.1、schema/protocol v0 通过 | 2026-07-22 |
| 最终复核 | `SS-Helper-SDK: pnpm artifact:gate` | PASS G009；SDK `3b3d24051b64100f4b3a9f8baa016dcbc58bcc13b61f5633fc22ec76f09ab862`、Core `a7a6aa365c723720f9156dc7d8f0504ae0ed712beed55f616140c34751807267`、contentDigest `709ddb5e359aa1baeecfe76e450c31bc45c55fc4cb8a2a8a72de027efe890cae` | 2026-07-22 |
| 审查修正复核 | `test/actor-registry.spec.ts` / `test/multi-actor-repository.spec.ts` | 同名冲突与泛称不再自动归属；pending 别名需显式确认；事实头按最终 head 去重；Trace 合并与派生回滚保持完整元数据 | 2026-07-22 |
| 审查修正复核 | `multi-actor-capture.integration.spec.ts` / `memory-application.ts` | Capture 对 sourceRef、episode、observation、逐字 evidence 做 fail-closed 校验；主事务过期自动回滚；向量/图谱派生在提交后同步并避免重复记录 | 2026-07-22 |
| 审查修正复核 | `memory-repository.ts` / `memory-application.ts` | 旧批处理列表不会读取 actor capture-jobs/change-audits；v0 事实列表可显示 actor ChangeSet；归档导入继续安全拒绝 | 2026-07-22 |
| 审查修正复核 | `multi-actor-capture-service.ts` / `memory-application.ts` | Episode 支持并校验局部 sourceRef；多来源事实保留有效来源集合；同一 Trace 的新观察/新 revision 计入 Dream 20 条变化阈值 | 2026-07-22 |
| 审查修正复核 | `SS-Helper-Memory: pnpm test/typecheck/lint/build` | 38 个测试文件、226 passed、1 skipped；类型检查、legacy scan、生产构建通过 | 2026-07-22 |
| 审查修正复核 | `SS-Helper-SDK: pnpm test/typecheck/lint/artifact:gate` | 93 passed；类型夹具、迁移基线 9/9、边界 lint、PASS G009 通过；SDK/Core/contentDigest 产物校验通过 | 2026-07-22 |
| 审查修正复核 | 根目录 `pnpm build` | SDK、Core、LLM、Memory 三产物构建通过；版本策略 0.0.1、API 0.0.1、schema/protocol v0 通过 | 2026-07-22 |
| 审查修正复核 | `multi-actor-memory-repository.ts` / `memory-application.ts` / `memory-ui.ts` | 手动事实编辑/删除统一走 v0 `facts`、`evidence`、`fact-heads`、Trace 与 ChangeSet；工作台按当前聊天显示，事实、派生记录和事实向量在删除/回滚时失效 | 2026-07-22 |
| 审查修正复核 | `actor-recall-service.ts` / `memory-strength.ts` / `profile-coordinator.ts` | Recall 使用客观 cue 参与确定性强度；实际被生成使用的 RecallExposure 写回；无新 Trace 的仅提及/在场主体不更新画像 | 2026-07-22 |
| 审查修正复核 | `memory-runtime.ts` / `memory-application.ts` | 生成开始暂停 Dream idle timer，生成结束且 Capture/回滚空闲后恢复逐主体自动 Dream；Narrator 默认 limited | 2026-07-22 |
| 审查修正复核 | `knowledge-projector.ts` / `test/multi-actor-memory.spec.ts` | 普通消息的主体/对象引用不再自动授予知情 Trace；A 的私密思想即使提及 B 也不会生成 B 的 Trace；仅卡片/世界书/状态的明确主体绑定允许播种 | 2026-07-22 |
| 审查修正复核 | `memory-repository.ts` / `fact-validation.ts` | 旧回退入口的手动事实最小长度同步为 6，和 v0 Schema、Capture 与新仓储保持一致 | 2026-07-22 |
| 最终门禁 | `SS-Helper-Memory: pnpm test/typecheck/lint/build` | 38 个测试文件、226 passed、1 skipped（真实历史集成测试）；类型检查、legacy scan、生产构建通过 | 2026-07-22 |
| 最终门禁 | `SS-Helper-SDK: pnpm artifact:gate` | PASS G009；SDK `3b3d24051b64100f4b3a9f8baa016dcbc58bcc13b61f5633fc22ec76f09ab862`、Core `a7a6aa365c723720f9156dc7d8f0504ae0ed712beed55f616140c34751807267`、contentDigest `709ddb5e359aa1baeecfe76e450c31bc45c55fc4cb8a2a8a72de027efe890cae` | 2026-07-22 |
| 最终门禁 | 根目录 `pnpm build` | SDK、Core、LLM、Memory 三产物构建通过；版本策略 0.0.1、API 0.0.1、schema/protocol v0 通过 | 2026-07-22 |
| P7 离线评测 | `test/multi-actor-offline-eval.spec.ts` + `test/fixtures/multi-actor-story.jsonl` | 固定故事 8 行；安全报告归属准确率 100%、泄漏/虚构/无来源声明 0、Dream 回滚 100%、客观召回 p95 58ms、角色过滤/Prompt p95 91ms；故意错误报告被拒绝 | 2026-07-22 |
| P4/P7 回归 | `test/multi-actor-memory.spec.ts` | 229 passed（含主体记忆特质强度覆盖、显式角色台词泄漏审计）；Memory 全套共 39 个测试文件、1 项真实历史集成测试跳过 | 2026-07-22 |
| 最终门禁 | `SS-Helper-Memory: pnpm test/typecheck/lint/build` | 39 个测试文件、229 passed、1 skipped；类型检查、legacy scan、生产构建通过 | 2026-07-22 |
| 最终门禁 | `SS-Helper-SDK: pnpm test/typecheck/lint/artifact:gate` | 93 passed；类型夹具 nodenext/bundler、迁移基线 9/9、边界 lint、PASS G009 通过；SDK `3b3d24051b64100f4b3a9f8baa016dcbc58bcc13b61f5633fc22ec76f09ab862`、Core `a7a6aa365c723720f9156dc7d8f0504ae0ed712beed55f616140c34751807267`、contentDigest `709ddb5e359aa1baeecfe76e450c31bc45c55fc4cb8a2a8a72de027efe890cae` | 2026-07-22 |
| 发布 | `node scripts/deploy-sillytavern.mjs --tavernRoot='I:/SillyTavern'`（dry-run） | 通过；SDK/LLM/Memory staging 摘要分别为 `09ec448f3e5ee98c06ba6f76c452d8198dd5fcd2f3d49fc0bd8882de7a705e45`、`d2f054097b78f157088a11b1bdfa40042e152d0ebd99225680863e85b5c83d67`、`e12b907d7b9559bd9a00aff9cf0ce1a4c1e86f5949aaaaa9af6c86bc7e7f223f`；active v0 数据保留且 legacy namespace 不存在 | 2026-07-22 |
| 发布 | `node scripts/deploy-sillytavern.mjs --apply --tavernRoot='I:/SillyTavern'` | 部署成功：`ss-helper-0.0.1-20260722T154857Z`；备份位于 `I:\\SillyTavern\\backups\\ss-helper-0.0.1-20260722T154857Z`；三个 deployed digest 与 staging 完全一致 | 2026-07-22 |
| 宿主 smoke | `http://127.0.0.1:8022/` / 截图聊天 `小時 - 2026-04-23@10h30m03s277ms imported.jsonl` | 刷新后加载新包；Core、LLM、Memory 均显示正常，设置中心和多主体工作台可打开，人物/场景/角色记忆/画像/Dream 页面可见；宿主未连接 API，未执行真实生成和自动 Dream 验收 | 2026-07-22 |
| 收尾修正 | `multi-actor-memory-repository.ts` / `memory-application.ts` | Capture 进度统一写入 v0 `capture-jobs`，并与 Capture ChangeSet 共用 job ID；回滚会恢复为 `paused`，不再读取旧批处理进度/审计 API；持久化 Dream 审计在重启后仍可安全回滚 | 2026-07-22 |
| 收尾修正 | `memory-application.spec.ts` / `multi-actor-repository.spec.ts` | 工作区不可用时在进入 LLM Capture 前 fail-closed；v0 Capture 进度与回滚回归通过；Memory 全套 `39` 个测试文件、`236 passed、1 skipped` | 2026-07-22 |
| 最终门禁复核 | `SS-Helper-Memory: pnpm test/typecheck/lint/build` | `236 passed、1 skipped`；类型检查、legacy scan、生产构建通过（`dist/index.js` 1,518.18 kB） | 2026-07-22 |
| 最终门禁复核 | 根目录 `pnpm build` | SDK、Core、LLM、Memory 三产物构建通过；版本策略 0.0.1、API 0.0.1、schema/protocol v0 通过 | 2026-07-22 |
| 发布复核 | `node scripts/deploy-sillytavern.mjs --tavernRoot='I:/SillyTavern'`（dry-run） | 通过；SDK `09ec448f3e5ee98c06ba6f76c452d8198dd5fcd2f3d49fc0bd8882de7a705e45`、LLM `d2f054097b78f157088a11b1bdfa40042e152d0ebd99225680863e85b5c83d67`、Memory `1f5c625f4aeddfad90031a5cac5cbf77612bc5f25f196fca745cc02aa7d96068`；active v0 数据保留，未删除旧库 | 2026-07-22 |
| 发布复核 | `node scripts/deploy-sillytavern.mjs --tavernRoot='I:/SillyTavern' --apply` | 部署成功：`ss-helper-0.0.1-20260722T170027Z`；备份位于 `I:\\SillyTavern\\backups\\ss-helper-0.0.1-20260722T170027Z`；三个 deployed contentDigest 与 staging 完全一致 | 2026-07-22 |
| 宿主 smoke 复核 | `http://127.0.0.1:8022/` / `小時 - 2026-04-23@10h30m03s277ms imported.jsonl` | 精确加载 `78` 条消息的测试聊天；Core 设置中心正常，工作台展示 `9` 个可见页面；场景页显示 `host_card` 来源、暂停 Capture 及安全错误审计；召回页含关系图谱与 0 条索引，审计页显示 SQLite/WAL 诊断；部署后没有新的 `memory_capture` 请求，也未发送或改写聊天正文 | 2026-07-22 |
| 存储安全复核 | `I:/SillyTavern/data/_ss-helper-v0/ss-helper.sqlite3` 只读检查 | 数据库完整性为 `ok`；`character:default_Assistant.png` 仍含退休 `fact-slots/jobs/job-audits`，按计划留给用户删除并重启，运行时不迁移、不清空 | 2026-07-22 |

## 偏差说明

- 单次模型调用同时看到多个分区，Prompt 层无法从技术上保证绝对零串线；P7 通过泄漏评测与生成后审计量化。
- 参考仓库只吸收 Mem0、Graphiti、SimpleMem、RecMem、MIRIX 的数据建模和调度思想，不引入其外部服务或数据库。
- 通用事实/向量/图谱工作台已切换到 v0 `facts`、`fact-heads`、`capture-jobs` 与 `change-audits`；旧集合只在 `MultiActorMemoryRepository.open()` 中用于非空安全诊断，永不读取、写入或迁移。
- 旧宿主菜单挂载实现与旧 SDK 迁移基线文档/测试已删除；设置、Popup、Toast 仅保留 Core 注册链路。
- 工作台的关系图谱、存储诊断和初始化进度已嵌入九个核心页面（召回、审计、场景），不再作为额外可见导航页；初始化与运维操作仍保留在对应页面内。
- P7 尚未标记完成：离线固定集、发布门禁、新 UI 和浏览器 smoke 已有证据，但真实模型跨角色使用率、生成后泄漏率、自动 Dream Apply/回滚仍需要用户清理旧 SQLite 并提供可用宿主 API/模型连接；当前代码提供安全审计与确定性测试入口。

## 阶段记录模板

### Pn

- 完成日期：
- 变更摘要：
- 测试证据：
- 未完成/阻塞：
- 偏差：

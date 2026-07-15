# SS-Helper [记忆]

Memory 是证据优先的 SillyTavern 长期记忆插件。它以 SillyTavern 服务端插件提供的 SQLite 数据库作为唯一持久化来源；浏览器不使用 IndexedDB、Dexie、localStorage 或其他持久缓存保存 Memory 数据。

## 运行架构

```text
SillyTavern 前端扩展（Memory）
  ├─ 来源采集与 Prompt 注入
  ├─ 关键词 / 向量 / 混合召回与 LLM rerank
  └─ /api/plugins/ss-helper-memory/v1
           │
SillyTavern 服务端插件（ss-helper-memory-sqlite）
  ├─ 类型化 query / command / vector API
  ├─ 专用 Worker Thread + node:sqlite
  └─ data/<user>/_memory/memory.sqlite3
```

- 只支持 SillyTavern 1.16.0、Windows 和 Node.js 24。
- 服务端使用 SQLite schema v2，并启用 `foreign_keys=ON`、WAL、`synchronous=NORMAL` 和 `busy_timeout=5000`。
- 每个酒馆用户拥有独立数据库，数据库路径由酒馆用户目录推导，前端不能指定。
- 服务端不可用时 Memory 停止整理、召回和注入，但不阻止普通聊天。

## 数据与召回

SQLite 保存事实、证据、任务、设置、召回日志、批次审计、主聊天 usage、批次快照和事实向量。业务写入在服务端以高层事务完成，并通过 `requestId` 保证重试幂等。向量以 Float32 BLOB 保存，top-K 在服务端执行。

自动事实必须引用本批次的来源证据；正文和证据通过严格校验后才能写入。召回支持 `auto | lexical | vector | hybrid`，rerank 支持 `off | adaptive | always`。向量或 rerank 路由失败时只降级召回策略，不影响消息发送。最终注入仍使用统一的 `<memory_context>`。

## SQLite 状态与备份

设置页固定展示服务端连接、服务端/SQLite/schema 版本、数据库相对路径、文件大小、WAL、各表记录数、向量覆盖率和最近事务错误。工作台可以：

- 导出一致性 SQLite 快照；
- 用 SQLite 快照原子恢复整个当前用户数据库；
- 执行 SQLite 完整性检查；
- 清空当前聊天的数据。

批次回滚会撤销所选批次及其后续批次，并恢复到所选批次执行前的事实、证据和替代链状态，避免保留依赖已撤销批次的后续结果。

恢复是破坏性操作，应先导出快照。Memory 不读取旧 IndexedDB，不导入旧 JSON backup，也不提供旧链路迁移或回退。

## Core 集成与公共 API

运行后由 SS-Helper Core 管理插件会话、类型化服务、设置与 popup 工作台。Memory 不暴露跨插件全局对象；事实管理、整理、召回、诊断与 SQLite 快照均通过当前插件内部控制器及公开 Core 契约完成。`manifest.json` 的酒馆加载标识保持为 `stx_memory`，公开 Core/settings 标识为 `ss-helper.memory`，SQLite 设置和业务命名空间仍为 `stx_memory`；这是刻意保留既有数据边界，不是重命名，也不提供旧版兼容层。旧 JSON backup 与旧插件 ID 均不兼容。

SDK/Core 的当前外部消费者说明、固定构建输入和所有权边界见 [docs/sdk-integration.md](docs/sdk-integration.md)。[docs/sdk-migration-baseline.md](docs/sdk-migration-baseline.md) 仅保留 G0/G5C 历史证据，不能作为当前操作指南。

## 构建与验证

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
node scripts/legacy-scan.mjs
```

本仓库不提供本地安装脚本、`Memory` 子目录命令或开发者机器路径。发布和部署由对应发行流程处理；在此仓库中只运行上述现有验证命令。

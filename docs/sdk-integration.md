# SDK/Core 外部消费者集成指南

Memory 是 `@ss-helper/sdk` 的前端消费者，不是 SDK 的服务端子模块。仓库内唯一 SDK 依赖是 `vendor/ss-helper-sdk-1.0.0.tgz`，当前 SHA-256 为：

`1e40f5510e817292c4b9a7510ac536da725b8410de4b3c2ce0c89ceac28902dd`

## 加载与会话

`src/entry.ts` 从 `/api/plugins/ss-helper-sdk/browser/core.js` 加载 Core，然后用 `bootstrapSSHelper` 建立可重连的 `ss-helper.memory` 会话。运行时不使用 workspace/link/绝对路径、相邻仓库源码或跨插件全局对象。

Memory 通过版本化服务契约暴露召回与更新事件，并通过 LLM 服务契约调用提取、embedding 和 rerank。设置 schema 与工作台 popup 由 Core 承载，具体 UI 和所有记忆操作仍由 Memory 实现。

## workspace 边界

Memory 只依赖 `PluginSession.workspace` 的通用能力：collection、记录、索引查询、条件事务、向量、健康检查和 owner 级归档。SDK 从 session descriptor 派生调用方 ID，Memory 不能伪造其他插件身份。

Memory 的 workspace 与 collection 约定属于 Memory 自己：

| 范围 | workspace |
| --- | --- |
| 单角色 | `character:<character.id>` |
| 群聊 | `group:<group.id>` |
| 全局设置 | `settings:global` |

`facts`、`fact-slots`、`evidence`、`jobs`、`job-audits`、`usage` 和 `recall-logs` 的含义、冲突规则、清理规则与召回策略都不属于 SDK 公共实现。

SDK 只维护酒馆实例级的 `data/_ss-helper/ss-helper.sqlite3`，不按登录用户隔离。Memory 不包含 server plugin、SQLite Worker、专用 schema、专用 HTTP 协议或原始 SQLite 备份逻辑；旧 `/api/plugins/ss-helper-sdk/v1/memory/*` 返回 404 是预期行为。

## 故障边界

若 Core、workspace 端口或数据库不可用，Memory 明确停用持久记忆功能。该故障不会阻断普通聊天，也不会影响 LLM 或 Core 的非存储功能。Persona 切换只改变每次 Prompt 中的身份说明，不改变 workspace。

[sdk-migration-baseline.md](sdk-migration-baseline.md) 仅是旧架构历史证据，不是当前运行或发布指南。

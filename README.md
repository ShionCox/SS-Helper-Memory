# SS-Helper [记忆]

Memory 是证据优先的 SillyTavern 长期记忆前端扩展。它拥有全部记忆领域逻辑，通过 `PluginSession.workspace` 使用 SS-Helper SDK 的通用 SQLite workspace；SDK 不包含事实整理、冲突判断、召回或 Memory 路由。

## 运行架构

```text
SillyTavern 前端扩展（Memory）
  ├─ 来源采集、事实整理与冲突重试
  ├─ 关键词 / 向量 / 混合召回与 Prompt 注入
  ├─ 当前聊天清理、完整性检查与 Memory 归档
  └─ session.workspace
           │
SillyTavern 服务端插件（SS-Helper-SDK）
  ├─ 通用 workspace / collection / transaction / vector API
  ├─ 所有权、授权、索引、归档和 SQLite 健康检查
  └─ data/_ss-helper/ss-helper.sqlite3
```

- 目标宿主为 SillyTavern 1.18.0 和 Node.js 24。
- SDK 首次启动时幂等创建唯一共享数据库，并启用外键、WAL 和 `busy_timeout`。
- 数据不按登录用户或 Persona 隔离。单角色使用 `character:<character.id>`，群聊使用 `group:<group.id>`；设置使用 `settings:global`。
- 缺少稳定角色/群组 ID 或 workspace 端口不可用时，Memory 停止整理、召回和注入，但不影响普通聊天与 LLM 的非存储功能。

## 数据与召回

Memory 在自己的 workspace 中维护 `facts`、`fact-slots`、`evidence`、`jobs`、`job-audits`、`usage` 和 `recall-logs` collection。事实、证据、槽位、任务与审计通过 SDK 条件事务原子提交；版本冲突时 Memory 重新读取并最多自动重试一次。

`sourceChatKey` 只用于来源审计和当前聊天清理，不参与事实可见性。同一角色卡的不同聊天和不同酒馆登录用户共享角色记忆，不同角色卡或群组默认隔离。关键词搜索、冲突判断、向量覆盖率和事实—向量一致性均由 Memory 计算。

Persona 在每次生成提示词前实时读取并注入，只声明当前回复对象，不改变 workspace，也不默认沉淀为长期事实。

## 清理、完整性与备份

- “清空当前聊天来源”只删除当前 `sourceChatKey` 的证据、任务、审计、usage 和召回日志，并重新计算受影响事实；仍有其他聊天证据的事实保留。
- “清空全部角色记忆”删除 Memory 拥有的所有 `character:*` 与 `group:*` workspace，保留 `settings:global`，不影响 LLM 或其他插件数据。
- 备份是带版本和 SHA-256 校验的 Memory JSON workspace 归档；恢复只替换 `ss-helper.memory` 拥有的数据，不导出或导入原始 SQLite 文件。

本项目不读取、迁移或自动删除旧 Memory 专用表、旧 `_memory/memory.sqlite3`、IndexedDB 或旧 HTTP 备份。

## 安装与构建

Memory 只安装在 SillyTavern 前端扩展目录；SDK 只安装在 `SillyTavern/plugins/SS-Helper-SDK`。`plugin.config.json` 是名称、设置标题和版本的唯一配置源，根项目 `pnpm build` 会在 `dist/SS-Helper-Memory` 生成可发布扩展。

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

SDK/Core 公共边界见 [docs/sdk-integration.md](docs/sdk-integration.md)。

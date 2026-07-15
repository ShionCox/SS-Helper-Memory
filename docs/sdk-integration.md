# SDK/Core 外部消费者集成指南

本文是 Memory 当前的 SDK/Core 集成说明。它取代 [sdk-migration-baseline.md](sdk-migration-baseline.md) 中的 G0/G5C 历史快照；后者保留审计证据，不是运行或发布指南。

## 固定输入与加载关系

Memory 只使用仓库内的 `vendor/ss-helper-sdk-1.0.0.tgz` 作为 `@ss-helper/sdk` 依赖。该 tarball 的 SHA-256 为：

`425e5509fdff5c73cdc7cf1200f969359caa76de9645199dd00fdda0fd9524ad`

最终 Core 发行 zip 的 SHA-256 为：

`73f35d03156f49460592fba71625feca4f8ca7a108a3f5353afc9281d20da125`

该 Core 发行内容的 `contentDigest` 为：

`baaa73720a8eb0a334a322a00e26c6e0da2d8a44fc18ff50b009eb5cd8b5c514`

酒馆 manifest 将 `third-party/SS-Helper-SDK` 声明为依赖。运行时由 `src/entry.ts` 通过 SDK 的 `bootstrapSSHelper` 建立可重连的插件会话；Memory 只在该会话可用时注册能力并在停止时释放注册项。不要改为 workspace、link、绝对路径、sibling 源码导入或运行时全局对象。

## 类型化服务与宿主能力

Memory 在 `src/ss-helper/plugin.ts` 声明所需的酒馆上下文、聊天、世界书、Prompt、普通插件请求和二进制插件请求能力。`src/ss-helper/services.ts` 通过 `MEMORY_RECALL_V1` 暴露类型化召回服务，并以 `MEMORY_UPDATED_V1` 发布更新事件；LLM 任务、embedding 与 rerank 同样经会话服务契约发现和调用。调用方应通过这些版本化服务契约交互，而不是探测跨插件全局变量。

## 设置、工作台与 SQLite 边界

Core 负责承载 `ss-helper.memory` 设置 schema 和 `ss-helper.memory` 的记忆工作台 popup。Memory 在 `src/ss-helper/settings.ts` 定义设置字段与工作台 token，并在 `src/ss-helper/plugin.ts` 将它们注册到当前 Core 会话；复杂工作台 UI 仍由 Memory 渲染。

Memory 保留 SQLite 业务数据所有权。Core 提供类型化普通请求和二进制请求传输；Memory 的服务端负责每个酒馆用户的 SQLite 数据库、schema、协议、备份导出、完整性检查和原子导入恢复。二进制 SQLite 备份/导入必须经该 Core 管理的传输通道进入 Memory 服务端，不能由浏览器持久化或替代为客户端数据库。

SQLite、服务端、schema、协议和版本所有权始终属于 Memory：浏览器不拥有 IndexedDB、Dexie、localStorage 或其他 Memory 持久存储；前端版本仍只由 `manifest.json` 的 `V0.0.2` 管理，服务端版本仍只由 `server/package.json` 的 `0.0.1` 管理。

## 标识不变量

以下三个标识刻意不同，必须原样保留：

| 用途 | 标识 |
| --- | --- |
| SillyTavern manifest 加载标识 | `stx_memory` |
| 公开 Core/settings 标识 | `ss-helper.memory` |
| SQLite 设置与业务命名空间 | `stx_memory` |

这不是对 Memory OS 的兼容层，也不是重命名迁移；不得把保留的 `stx_memory` SQLite/业务命名空间改为 `ss-helper.memory`，也不得把 `ss-helper.memory` 改为 manifest 标识。

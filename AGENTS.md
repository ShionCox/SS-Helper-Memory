# SS-Helper Memory 项目约束

## 项目定位

- 本项目是供 SillyTavern 使用的 SS-Helper 记忆插件。
- 当前目标宿主为 `G:\SillyTavern`（SillyTavern 1.18.0）。
- 本项目由 `I:\VUE\SillyTavern-SS-Helper` 系列插件中的 MemoryOS 重构而来，但不得恢复旧版 MemoryOS 的版本命名和兼容外观。

## 版本规则（强制）

- 前端插件发布版本的唯一来源是根目录 `plugin.config.json` 的 `manifest.version`，当前固定为 `V0.0.2`；`manifest.json` 仅是构建产物。
- 根目录 `package.json` 不得增加 `version` 字段。
- 公共前端 API、UI、日志、README、测试名称和测试数据标识不得再次硬编码插件发布版本。
- `server/package.json` 的 `0.0.1` 仅是 SDK 内嵌 Memory 语义 worker 的内部协议版本；插件发布版本仍只来自 `plugin.config.json`。
- 服务端运行时必须读取 `server/package.json` 的版本，不得再维护第二份硬编码服务端版本常量。
- 禁止恢复旧标记，包括但不限于：`Memory 3.0`、`Memory v2`、`Memory v3`、`MemoryPluginApiV3`、`memory-v2` 和插件版本 `3.0.0`。
- 测试探针、示例 manifest 和其他辅助 package 不得新增独立的插件发布版本。

## 不属于插件发布版本的技术编号

以下内容用于构建、运行或数据兼容，不得因为清理插件版本而删除或随意改写：

- npm 依赖版本约束；
- SillyTavern 与 Node.js 兼容要求；
- API 路径中的协议编号；
- SQLite schema、协议和迁移编号；
- LLMHub 注册协议编号；
- 模型 ID 中自带的版本片段；
- 生命周期、并发代次、快照格式和导入聊天内容中的业务编号。

## 修改与验证

- 修改版本规则前，先更新或补充版本元数据回归测试。
- 修改完成后至少运行版本元数据测试、受影响测试、TypeScript 类型检查和旧版本标记扫描。
- 本仓库单独检出时缺少上级系列仓库的 `SDK` 相对路径；全量验证应在提供对应 SDK 的临时镜像或完整系列仓库结构中运行。
- `test-results`、覆盖率、构建目录和临时验证镜像属于生成物，不得作为版本来源；包含旧版本信息时应删除并重新生成。

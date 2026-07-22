# SS-Helper Memory 项目约束

## 项目定位

- 本项目是供 SillyTavern 使用的 SS-Helper 记忆插件。
- 当前目标宿主为 `G:\SillyTavern`（SillyTavern 1.18.0）。
- 本项目由 `I:\VUE\SillyTavern-SS-Helper` 系列插件中的 MemoryOS 重构而来，但不得恢复旧版 MemoryOS 的版本命名和兼容外观。

## 版本规则（强制）

- 前端插件发布版本的唯一来源是根目录 `plugin.config.json` 的 `manifest.version`，本次断代基线为裸 SemVer `0.0.1`；`manifest.json` 仅是构建产物。设置 UI 负责显示当前版本。
- 根目录 `package.json` 不得增加 `version` 字段。
- 公共前端 API、UI、日志、README、测试名称和测试数据标识不得再次硬编码插件发布版本。
- `server/package.json` 的 `0.0.1` 仅是 SDK 内嵌 Memory 语义 worker 的内部协议版本；插件发布版本仍只来自 `plugin.config.json`。
- 服务端运行时必须读取 `server/package.json` 的版本，不得再维护第二份硬编码服务端版本常量。
- 禁止恢复旧标记，包括但不限于旧 MemoryOS/Memory v2/v3 命名、旧 `memory-v2` 数据键、旧 SS-Helper API 版本轴和插件版本 `3.0.0`。
- 测试探针、示例 manifest 和其他辅助 package 不得新增独立的插件发布版本。

## 不属于插件发布版本的技术编号

以下内容用于构建、运行或数据兼容，不得因为清理插件版本而删除或随意改写；本次断代明确改写的 SS-Helper 自有协议/数据基线除外：

- npm 依赖版本约束；
- SillyTavern 与 Node.js 兼容要求；
- 第三方 API 路径中的协议编号；
- SQLite schema、协议和迁移编号（当前 SS-Helper 自有基线为 v0）；
- LLMHub 注册协议编号；
- 模型 ID 中自带的版本片段；
- 生命周期、并发代次、快照格式和导入聊天内容中的业务编号。

## 修改与验证

- 修改版本规则前，先更新或补充版本元数据回归测试。
- 修改完成后至少运行版本元数据测试、受影响测试、TypeScript 类型检查和旧版本标记扫描。
- 本仓库单独检出时缺少上级系列仓库的 `SDK` 相对路径；全量验证应在提供对应 SDK 的临时镜像或完整系列仓库结构中运行。
- `test-results`、覆盖率、构建目录和临时验证镜像属于生成物，不得作为版本来源；包含旧版本信息时应删除并重新生成。

## 设置提示与 Toast

- Memory 只能使用 SDK 授权后的 `session.ui.showToast(...)`；禁止直接调用 `window.toastr`、自行创建 Toast DOM 或依赖 SDK 内部 class。
- 严格能力模式无法满足、workspace 事务失败等情况必须阻止保存，让 SDK 回滚控件，并显示一次 error Toast；自动召回或自适应重排发生非显然降级时允许保存并显示 warning Toast。
- 当前聊天不可用等禁用原因必须同时保留在设置字段的内联说明中；后台能力轮询、启动恢复和聊天切换只刷新状态，不弹 Toast。
- Toast 文案不得包含聊天正文、Prompt、凭据、数据库记录或其他敏感 payload；`code` 使用稳定且不含用户数据的安全标识。

## 图标

- Memory 只能使用 SDK Core 注册的 `<ss-helper-icon name="...">`，名称不带 `fa-` 前缀并且必须存在于 SDK Solid 图标清单。
- 禁止加载或复制 Font Awesome CSS/字体、使用全局 `fa-*` class、内联 SVG 或 Emoji 替代现有统一图标；Three.js 图谱几何与着色器不属于 UI 图标。
- 带可见文本或位于已有 `aria-label` 按钮内的图标必须使用 `decorative`；独立表达状态的图标必须提供 `label`，图标按钮的可访问名称由按钮自身承担。

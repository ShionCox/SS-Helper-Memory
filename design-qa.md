# 人物与别名重设计 Design QA

## 验收目标

- 视觉基线：`I:/VUE/SS-Helpers/.tmp/product-design/current-actors-live.png`
- 真实 SillyTavern 空数据状态：`I:/VUE/SS-Helpers/.tmp/product-design/actors-redesign-live.png`
- 有数据人物主档状态：`I:/VUE/SS-Helpers/.tmp/product-design/actors-redesign-populated.png`
- 待确认归属状态：`I:/VUE/SS-Helpers/.tmp/product-design/actors-redesign-pending.png`
- 前后并排对照：`I:/VUE/SS-Helpers/.tmp/product-design/actors-redesign-comparison.png`

## 视口与状态

- 视觉基线：1786 × 1272，旧版未绑定聊天空状态。
- 真实实现：1280 × 720，SillyTavern 1.18.0、本地已绑定聊天、当前聊天尚无 Capture 结果。
- 有数据与待确认状态：1280 × 720，使用实际 `renderMemoryWorkbench` 与真实 CSS，在隔离的 Vite QA 页面中注入人物、别名、系统主体、待确认候选和审计记录；截图完成后已删除临时 QA 页面。
- 页面保留原工作台弹窗、顶部状态条、左侧导航和宿主字体；工作台内部使用设计稿炭黑色板。

## 视觉比较

- 旧版单块空面板已替换为人物主档优先的双栏工作区；左侧负责选择人物或待确认项，右侧集中展示资料和操作。
- 搜索、状态筛选、人物/别名/待确认计数和刷新位于统一工具栏，待确认数量使用金色描边入口，没有引入额外视觉概念。
- 人物与系统主体分组清晰；名称、别名摘要、状态和置信度可以在列表中快速扫读。
- 人物详情的名称、统计、别名来源、最近操作与技术信息形成稳定层级，原始 ID 不再占据主要位置。
- 空状态仍保持双栏骨架，因此从无数据到有数据不会发生页面结构跳变。
- 没有新增位图资产；所有图标沿用 `ss-helper-icon`。人物页和其他工作台页面自动继承局部炭黑表面、暖白文字和金色强调，不覆盖 SDK 设置中心或其他插件的 SmartTheme。

## 核心交互验收

- 人物/待确认标签切换：通过。
- 名称与别名搜索、状态筛选：通过自动化 UI 测试。
- 人物选择与刷新后选择保持：通过自动化 UI 测试。
- 改名、纠正别名、合并、拆分：控制器参数通过自动化 UI 测试。
- 别名纠正抽屉：真实浏览器中确认 `role="dialog"`、目标选择获得初始焦点、Escape 关闭并将焦点恢复到原“纠正归属”按钮。
- 待确认归入已有人物：证据、来源、目标人物和确认动作均可见，参数通过自动化 UI 测试。
- 待确认创建新人物：切换后规范名称为空，确认按钮保持禁用；输入有效名称后才可提交。
- 审计撤销：已应用记录显示“撤销”，已撤销记录只读。

## 响应式与可访问性

- 桌面为双栏，`760px` 以下切换单列；选择人物后滚动到详情，操作抽屉改为全宽。
- 标签使用 `tablist` / `tab` / `tabpanel`，选中人物使用 `aria-selected`，候选确认方式使用 `aria-pressed`。
- 操作抽屉标题与对话框关联，支持 Escape、初始焦点与焦点恢复。
- 已保留减少动画规则，并增加强制颜色样式。
- 键盘、ARIA、焦点恢复、空状态、加载失败、操作失败与忙碌禁用由 UI 测试覆盖。

## 验证结果

- `pnpm test`：41 个测试文件通过，1 个跳过；267 个测试通过，1 个跳过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过，legacy scan PASS。
- `pnpm build`：通过。
- 真实 SillyTavern 已成功加载 SDK、LLM、Memory 扩展并打开重设计页面；实机人物面板为 `#1d2024`、内容底为 `#121417`、边框为 `#34383f`，记忆库同步继承，无裁切或阻断性错误。
- 无剩余 P0、P1、P2 视觉或交互问题。

## 场景与事件 v4 原型落地

### 验收目标与证据

- 视觉真值：`G:/vue/SS-Helpers/.tmp/原稿/ss-helper-memory-scenes-events-visual-v4.html`。
- 桌面同视口整页对照：`G:/vue/SS-Helpers/SS-Helper-Memory/.tmp/design-qa/scenes-v4-comparison-scene-final-1440.jpg`。
- 桌面场景工作区局部对照：`G:/vue/SS-Helpers/SS-Helper-Memory/.tmp/design-qa/scenes-v4-comparison-focused-scene-final-1440.jpg`。
- 桌面观察记录对照：`G:/vue/SS-Helpers/SS-Helper-Memory/.tmp/design-qa/scenes-v4-comparison-observation-final-1440.jpg`。
- 实现截图还覆盖 `scene`、`event`、`observation` 三类在 `1440 × 1000`、`900 × 900`、`540 × 900` 三档视口下的状态；截图设备像素比为 1。
- QA 页面使用实际 `renderMemoryWorkbench`、Memory CSS、SDK 控件样式与 PixiJS 渲染器；数据仅用于隔离的本地视觉验证，不进入产品运行时。

### 视觉比较与修正记录

- v4 的类别卡、等高工具栏、统计块、列表—详情—辅助信息结构、金色选中态和炭黑 SmartTheme 已落地；人物、来源、事件与观察文案均由真实字段确定性生成。
- 第一轮对照发现 Pixi 图在详情区内被额外侧栏压缩，图形只有约 42% 可用宽度；同时两个缩放图标名不在 SDK 图标集内。已将图形与文字详情改为纵向排列、调整确定性布局与来源节点位置，并换用 SDK 支持的放大镜加减图标。
- 第二轮对照确认桌面场景图可读，选中场景、关系边界、来源节点、图例和文字等价操作均可见；实现保留产品真实的 10 项导航和状态条，没有复制原型的假导航数据。
- 响应式检查发现 SDK `segmented` 的横向自动流覆盖了类别卡单列规则；已在 `900px` 断点显式切换为行流。复测时 `900px` 与 `540px` 的类别卡和三栏内容均为单列，页面宽度分别保持 900 和 540，无横向页面溢出。
- `540px` 工具栏按搜索、筛选、统计、刷新纵向排列；Pixi 区保持文字角色边界和键盘按钮，不依赖画布才能读取场景信息。

### 核心交互与可访问性

- 10 个导航入口与独立“初始化”页：通过自动化 UI 测试。
- 三类别切换、搜索、筛选、统计、各类别选择保持、空数据状态：通过自动化 UI 测试。
- 场景—事件—观察关联切换、人物详情入口、聊天来源跳转：通过自动化 UI 测试与浏览器检查；浏览器中 `message:17` 正确触发第 17 层跳转。
- PixiJS WebGL 画布真实创建，未进入降级状态；节点聚焦后按钮 `aria-pressed` 同步，控制台无 error 或 warning。
- 确定性布局、角色优先级、相机命令、减少动画、ResizeObserver 与销毁由 Pixi 单元测试覆盖；画布失败时仍保留完整文字边界与角色按钮。
- 焦点、强制颜色与减少动画样式均已覆盖；图标仅使用 `ss-helper-icon`，提示仅走 SDK Toast。

### 验证结果

- `pnpm test`：43 个测试文件通过，1 个跳过；274 个测试通过，1 个跳过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过，legacy scan PASS。
- `pnpm build`：通过；产物只有 `index.js`、`style.css`、`THIRD_PARTY_NOTICES.txt`，没有额外 JS chunk。
- 根工作区 `pnpm build`：通过，现有总构建脚本可继续装配 Memory 单一 JS 产物。
- 未修改 Capture / SQLite schema，未升级 SDK、Core 或 Memory 版本，未部署到 `G:\SillyTavern`。
- 无剩余 P0、P1、P2 视觉或交互问题。

## 2026-07-23 浏览器批注修订

### 对照证据

- 参考：用户在 `2535 × 1272` 视口提交的 8 条场景页浏览器批注。
- 实现截图：`.tmp/design-qa/scenes-v4-annotation-fixes-2535x1272.jpg`。
- 来源展开截图：`.tmp/design-qa/scenes-v4-source-column-compact-2535x1272.jpg`。
- 关联内容截图：`.tmp/design-qa/scenes-v4-related-content-2535x1272.jpg`。
- 最终默认状态：`.tmp/design-qa/scenes-v4-final-2535x1272.jpg`。

### 迭代记录

- P2：Pixi 图中文字偏小、来源楼层分散且默认可见。已增大角色、职责、置信度和来源文字，来源节点固定为画布右侧自上而下的紧凑纵列并默认隐藏。
- P2：页面出现两处 `PixiJS` 技术字样。已移除标题状态和画布右下角品牌字样，仅保留用户需要的缩放百分比。
- P2：QA 页面筛选仍显示原生 `select`。已接入 SDK `createSelectControl`，浏览器实测选中“有仅提及者”后列表由 2 条正确过滤为 1 条。
- P2：列表项、关联记录和当前场景详情横向空间利用不足。已让记录内容撑满容器，关联卡改为图标—内容—箭头结构，当前场景详情改为两列，并在窄屏恢复单列。
- P2：主体按钮贴近上方内容且按钮间距不足。已增加上边距、分隔线和按钮间距。
- P3：页面信息层级缺少视觉锚点。已使用 `ss-helper-icon` 为列表、关系图、角色边界、来源、关联记录和辅助信息补充一致图标；未引入自制图标。

### 最终复核

- 桌面截图确认：列表副标题已删除，列表与关联项横向空间得到利用，当前场景信息为两列，关系图文字清晰，来源展开后位于右侧纵列。
- SDK 选择框可键盘聚焦并正确驱动筛选；来源切换默认关闭，重新加载后保持关闭。
- 无剩余 P0、P1、P2 视觉或交互问题。

## 2026-07-24 场景来源归位

### 对照证据

- 来源视觉真值：用户在酒馆 `http://127.0.0.1:8000/` 圈选的场景页截图，要求来源只位于 Pixi 关系图右侧。
- 实现截图：`.tmp/design-qa/scenes-v4-source-inside-pixi-only-2535x1272.jpg`。
- 视口：`2535 × 1272` CSS 像素；来源按钮处于展开状态。

### 比较与修订

- P2：实现同时在 Pixi 右侧和页面辅助栏显示来源，形成重复入口。已删除即时场景辅助栏中的“本场景来源”卡片，保留“场景速览”和“场景边界说明”。
- 修订后来源消息只由 Pixi 的“来源”按钮控制，展开时在画布内部右侧自上而下排列，默认仍为隐藏。
- 字体、色彩、图标、画布节点和页面其他布局均未改动；本次为注释指定区域的局部修订。
- 聚焦截图足以清楚判断来源位置和辅助栏去重；无需额外全页对比。

### 最终复核

- 浏览器 DOM：独立“本场景来源”卡片数量为 0，Pixi 画布数量为 1，“来源”默认 `aria-pressed="false"`。
- 展开来源后的截图确认消息楼层位于 Pixi 画布内部右侧。
- 页面无新错误；观察到的两条警告为酒馆现有宏 API 弃用提示，与 SS-Helper 本次修改无关。
- 无剩余 P0、P1、P2 视觉或交互问题。

## 2026-07-24 初始化原稿落地

### 验收目标与证据

- 视觉真值：`G:/vue/SS-Helpers/.tmp/原稿/ss-helper-memory-initialization-prototype.html`。
- 原稿不可用状态：`.tmp/design-qa/initialization-source-unavailable-1280x720.png`。
- 真实酒馆不可用状态：`.tmp/design-qa/initialization-implementation-unavailable-1280x720.png`。
- 整页并排对照：`.tmp/design-qa/initialization-comparison-unavailable-1280x720.jpg`。
- 浏览器实际 CSS 视口为 `1280 × 720`、设备像素比为 `1.5`；真实实现截图包含 SillyTavern 宿主与 Memory Popup，因此像素画布大于原稿独立页面。
- 当前聊天未绑定且来源为 0，属于真实的能力不可用状态；原稿中的假聊天、假来源、演示活动与状态选择器未复制。

### 视觉比较与修正记录

- 初始化内容已按原稿重组为准备状态条、主状态卡、来源与估算、四步流程、固定操作栏、最近活动和安全说明；保留现有顶部状态栏与 10 项导航。
- 首次、排队、捕获中、暂停、完成、失败、取消、不可用和重新初始化抽屉共用同一组真实视图模型，页面没有引入原稿演示数据或版本文案。
- 原稿独立页面与正式 Popup 的外围尺寸不同；局部对照确认内容密度、双栏比例、卡片层级、金色操作强调、危险提示和空状态结构一致。
- `1150px` 以下调整内容密度，`900px` 以下切换单栏，`540px` 下来源卡、指标和操作栏改为紧凑纵向布局；样式均限定在 `.stx-memory-workbench` 内，无页面级横向溢出规则。
- 所有图标使用 `ss-helper-icon`；按钮、复选框、状态、进度和刷新操作均使用 SDK 公共控件契约，重绘后由 SDK 刷新控件。

### 核心交互与数据边界

- 来源选择、不可见历史开关与估算联动：通过自动化 UI 测试；不可见历史仍默认关闭且只对本次任务生效。
- 开始、继续、取消、刷新、查看记忆库和重新初始化：通过自动化 UI 测试；刷新使用 SDK Toast。
- 阶段推导覆盖提交/排队、普通批次、最终批次、完成与暂停断点；最近活动严格限制为真实的 5 条。
- 重新初始化抽屉保留 Escape 关闭、初始焦点和焦点恢复，并沿用“取消当前任务 → 清理当前聊天派生数据 → 启动新初始化”的既有顺序。
- 能力不可用状态仍可浏览真实来源；提交按钮禁用并显示 SQLite、聊天绑定或 LLM 的真实原因。
- 浏览器实机确认 Memory、LLM 与 SDK 资源正常加载；控制台无本次实现产生的 error，现有提示仅为 SillyTavern 宏 API 弃用警告。

### 验证与部署结果

- `pnpm test`：44 个测试文件通过，1 个跳过；282 个测试通过，1 个跳过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过，legacy scan PASS。
- Memory `pnpm build`：通过；只有 `index.js`、`style.css` 与许可证文件，没有额外 JS chunk。
- 根工作区 `pnpm build`：通过，SDK、Core、LLM、Memory 版本策略与装配检查全部通过。
- 已完成酒馆 dry-run、停服、备份、原子部署、重启、HTTP、日志和资源哈希检查；备份位于 `G:/SillyTavern/backups/ss-helper-0.0.1-20260723T184007Z`。
- 未修改 Controller 公共接口、Capture、SQLite schema 或结构化输出契约，未升级 SDK、Core 或 Memory 版本。
- 无剩余 P0、P1、P2 视觉或交互问题。

## 2026-07-24 记忆块面板 V3 原稿落地

### 验收目标与证据

- 视觉真值：`G:/vue/SS-Helpers/.tmp/原稿/记忆块面板原型_V3.html`。
- 原稿同视口基线：`.tmp/design-qa/memory-blocks-v3-prototype-2535x1272.png`。
- 真实酒馆最终桌面状态：`.tmp/design-qa/memory-blocks-v3-live-final-2535x1272.png`。
- 响应式证据：`.tmp/design-qa/memory-blocks-v3-live-900x900.png`、`.tmp/design-qa/memory-blocks-v3-live-540x900.png`。
- 实机数据来自当前已绑定聊天：22 条记忆、22 条待确认、100% 证据覆盖；未将原稿中的 12 条演示数据或假版本信息写入运行时。

### 视觉比较与修正记录

- 原“记忆库”双栏列表已替换为原稿的四项统计、搜索筛选工具栏、快速范围、记忆块列表和审阅详情三栏，并将正式导航文案改为“记忆块”。
- 详情完整展示状态、置信度、证据、来源引用、可编辑正文、版本关系和捕获记录；来源消息继续使用现有聊天楼层跳转，其他来源使用 SDK Toast 说明。
- 首轮实机检查发现 22 条真实数据会触发 Grid 轨道压缩，使列表卡片正文被挤成细条。已将列表轨道改为 `max-content` 并恢复 116px 最小卡片高度；最终实测首项高度为 116px，列表可正常滚动。
- 桌面三栏实测宽度为 224 / 651 / 957px，高度均为 726px；页面级横向溢出为 0。900px 切换两栏并让详情跨整行，540px 为单栏纵向内容，页面级横向溢出均为 0。
- 所有图标使用 `ss-helper-icon`；搜索、排序、筛选、状态、进度和按钮使用 SDK 公共控件契约。实机排序选择框已由 SDK 增强，切换“类型”后第一项为“承诺”，恢复“最近更新”正常。

### 功能与数据边界

- 搜索“洛赤焰”后真实结果由 22 条缩小为 10 条，同时四项全量统计保持 22 / 0 / 22 / 100%，清空搜索后恢复 22 条。
- 类型、状态、排序、快速范围、选择保持、上一条/下一条、编辑取消、删除确认、来源跳转、捕获批次导航和空状态均由自动化测试覆盖。
- 统计始终来自当前聊天全量事实；搜索结果单独加载，不会污染全量统计。没有修改 Capture、SQLite schema、结构化输出、SDK 公共 API 或插件版本。
- 浏览器控制台没有本次实现产生的 error；仅观察到 SillyTavern 现有宏 API 弃用警告。

### 验证与部署结果

- `pnpm test`：46 个测试文件通过，1 个跳过；289 个测试通过，1 个跳过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过，legacy scan PASS。
- Memory `pnpm build`：通过；产物只有 `index.js`、`style.css` 与许可证文件。
- 根工作区测试、工作区一致性、版本策略和 `pnpm build`：通过。
- 已完成 dry-run、停服、备份、原子部署、重启、HTTP 200、资源哈希和真实工作台浏览器检查；最终备份位于 `G:/SillyTavern/backups/ss-helper-0.0.1-20260723T210743Z`。
- 无剩余 P0、P1、P2 视觉或交互问题。

final result: passed

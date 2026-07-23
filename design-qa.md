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

final result: passed

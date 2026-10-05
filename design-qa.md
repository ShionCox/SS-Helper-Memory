# 召回与索引 UI 验收

日期：2026-10-02（Asia/Shanghai）。选定方向：方案 3，图谱优先。

**Findings**

最终对照未发现尚未解决的 P0 / P1 / P2 问题。保留 SDK Popup、SmartTheme、原有关系数据和 Three.js 渲染器，完成布局与可读性调整。

**视觉依据与状态**

- source visual truth：`C:/Users/liao/.codex/generated_images/01a0f812-37a7-7662-8382-7b6aadf530d0/exec-0c3425bd-3ebe-4b28-90f1-812b8e9420d2.png`。
- implementation screenshot：`G:/vue/SS-Helpers/.tmp/real-tavern-evidence/recall-ui-final-empty.png`。
- 实际页面：[本地测试酒馆](http://localhost:8001/)，使用独立测试数据目录。
- 对照状态：4 条事实，向量覆盖 4/4，0 节点、0 关系，无搜索或筛选，关系页签选中，召回诊断折叠。另检查 6 条事实、2 节点、2 关系与选中关系详情。
- source 与桌面 implementation 均为 1487×1058 像素；CSS viewport 1487×1058，deviceScaleFactor / devicePixelRatio 约 1，无密度缩放。图纸占满画面，实际页面包含宿主 Popup 外边距；以内容区域为主要比较对象。
- 平板 1024×900；手机 390×844；均按约 1 倍密度捕获。手机 document.scrollWidth=390，图谱与诊断之间实测间隔为 14px。

**Full-view comparison evidence**

在同一次视觉比较输入中并排检查选定图纸与最终空图谱截图：顶部索引摘要、左侧主画布、右侧关系/详情、底部诊断的层级一致。补充检查真实关系、选中详情、平板侧栏与手机正文截图。

**Focused region comparison evidence**

同次比较还检查 `recall-ui-final-controls.png`（实际索引摘要和图谱工具栏裁切）与原图对应区域，核对输入、筛选、按钮、数字、图标和文字对齐；检查 `recall-ui-final-detail.png` 的选中状态与独立滚动区。原图按原始分辨率展示，未放大或重新生成素材。

**五项视觉检查**

| 表面 | 结论与依据 |
| --- | --- |
| 字体与层级 | 实际继承宿主 Noto Sans / sans-serif；图谱标题 16px、索引值 15.2px、输入 14px。标题、指标与灰色说明层级清楚，中文无乱码；长关系有完整可访问名称、悬停标题和详情。图纸字号更大，实际遵循现有 SDK 外壳密度，这是明确的实现约束。 |
| 间距与布局 | 工作区间距 14px，索引摘要与画布分组清楚；宽屏左右布局，可用内容宽度不超过 850px 时上下排列。图谱、模型卡、诊断均可通过对应滚动区完整读取。 |
| 颜色与 tokens | 复用 SmartTheme 炭黑背景、暖白正文（实测 rgb(238,234,225)）、灰色说明和金色强调；状态复用 SDK 语义色。焦点、选中状态与背景可区分。 |
| 图像与图标 | UI 图标均使用 SDK 的 ss-helper-icon；缩放图标已改为清单内名称。空态用 SDK 图谱图标，遵循项目禁止自制 UI SVG 的要求；图纸示意节点图不是业务数据。实际有关系时由原有 Three.js 绘制，无假关系或新图片依赖。 |
| 文案与内容 | 指标、模型名称、关系、置信度和来源均来自当前工作区。没有向量批次时明确显示暂无记录；没有正式生成时说明逐角色诊断何时出现。图纸示例批次数字未硬编码到界面。 |

**比较与修复记录**

| 优先级 / 位置 | 早期证据与影响 | 修复 | 修复后证据 |
| --- | --- | --- | --- |
| P2 桌面画布高度 | `recall-ui-desktop-first.png`：画布挤出底部诊断，影响主要区域比例。 | 图谱使用剩余网格高度，消除固定高度挤占。 | `recall-ui-final-empty.png`：索引、画布和诊断在同一桌面视口完整显示。 |
| P2 工具栏换行 | 初次工具栏在较窄画布中过于拥挤。 | 搜索允许伸缩、标题与筛选自然换行。 | `recall-ui-final-controls.png`、`recall-ui-final-mobile.png`。 |
| P2 手机区域重叠 | 前一轮手机布局中诊断与图谱重叠。 | 容器查询放到内容父容器，窄屏工作区与图谱使用自然高度。 | 最终手机 DOM 测量：诊断位于图谱后方，间隔 14px；`recall-ui-final-mobile-diagnostics.png`。 |
| P2 缩放图标 | `recall-ui-desktop.png`：旧 plus 名称显示问号。 | 使用 SDK magnifying-glass-plus / magnifying-glass-minus。 | `recall-ui-final-empty.png`、`recall-ui-final-populated.png`。 |
| P2 小图谱可读性 | `recall-ui-populated.png`：2 个节点被原最小相机距离 170 压得过小。 | 按实际三维边界和视口视野适配，最低距离 24；纳入聚类边界，同步降低聚焦与旋转距离下限。 | `recall-ui-final-populated.png`、`recall-ui-final-detail.png`：节点名称可读；相机距离回归测试通过。 |
| P2 平板侧栏裁切 | 1024×900 早期左右排列只有 420px 高，模型卡被侧栏隐藏。 | 内容宽度 ≤850px 时上下排列；桌面可伸缩行允许收缩。 | `recall-ui-final-tablet-inspector.png`：关系、重建、两张模型卡与诊断可完整滚动读取。 |

**交互与验证**

- 真实测试工作区：选择“交付青铜钥匙”自动打开详情，显示关联事实、来源证据和相邻关系；切回关系页签正常。
- 关系/事件列表、事件筛选、搜索无匹配反馈、清空搜索恢复、缩放与适配视图已通过浏览器检查。
- 诊断默认折叠；Enter 可展开/收起；手机诊断正文与原始日志入口可滚动读取。
- SDK 选择菜单浮动显示；输入、选择与图标按钮有可访问名称。焦点样式和 reduced-motion 样式保留。未进行专门的屏幕阅读器或高倍文字缩放验收。
- 受影响测试：73 passed / 4 files（memory-ui、ui-contract、relationship-graph-rendering、relationship-graph-layout）。类型检查、legacy scan、全工作区构建、版本规则、workspace/error policy 和 diff 检查通过。
- 证据日志：`G:/vue/SS-Helpers/.tmp/recall-ui-continuation-tests.log`、`G:/vue/SS-Helpers/.tmp/recall-ui-continuation-build.log`、`G:/vue/SS-Helpers/.tmp/recall-ui-qa-final-build.log`。
- 最终页面控制台 error 查询返回空列表。前一轮曾捕获宿主 Horde 外部请求错误，未归因于本次 UI。
- 已保留数据部署：`ss-helper-0.0.1-20261002T041036Z`；版本仍为 0.0.1。备份在 `G:/SillyTavern/backups/ss-helper-0.0.1-20261002T041036Z`。

**Open Questions / 验证边界**

无影响本次交付的待确认项。本轮未重新执行付费模型调用、向量重建、正式聊天生成或完整 Prompt 注入；本报告只确认 UI 改动与上述交互。手机顶部状态和横向导航继续采用既有工作台外壳；详情正文在独立滚动区内读取。

**Implementation Checklist**

- [x] 第 3 版布局落地；复用 SDK 与既有图谱。
- [x] 修复验收中发现的 P2 问题；移除旧图谱统计卡样式。
- [x] 自动检查、真实页面交互与三个宽度的视觉复核通过。
- [x] 保存最终截图与数据保留部署证据。

**Follow-up Polish**

无阻碍验收的视觉问题；大规模关系数据的性能与密集标签不属于本次小规模 UI 验收覆盖范围。

final result: passed

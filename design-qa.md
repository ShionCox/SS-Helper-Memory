# 候选检查 UI 验收

日期：2026-10-07（Asia/Shanghai）。用户选择方案 2：证据对照台。

**结果：passed**。最终未发现尚未解决的 P0 / P1 / P2 展示或操作问题。

**本次修改与修复**

- 左侧候选队列、中间候选内容与本地检查结果、右侧来源原文，三栏独立滚动；筛选合为一行，技术详情默认折叠。使用真实摘要、状态、原因码和证据，不补写模型未提供的内容。
- 使用 SDK 虚拟列表、选择框、分段按钮、状态和图标。队列行自动测高、两行摘要、6px 间距；长摘要保留完整内容并局部滚动，底部导航持续可用。
- P2 已修复：SDK 按钮默认宽度导致状态栏竖排；原文读取错误被吞掉导致永久显示读取中；手机切换候选后页面返回顶部。错误说明与重试入口复用 SDK 诊断目录。
- 原文失败的根因是对未声明索引的 `id` 字段查询。改用 Workspace 原生主键读取，并校验工作区和聊天归属；没有新增索引或数据迁移。原文首次读入滚到首段证据，后续重绘保留阅读位置。
- 批次选项来自统计中的真实批次 ID；来源按实际类型显示“聊天原文”“角色卡原文”等中文。缺少聊天楼层的来源禁用聊天跳转。

**视觉对照**

- source visual truth：`C:/Users/liao/.codex/generated_images/01a1145e-7093-7750-b268-cb6e56b462a7/exec-c8acb4c0-df84-4723-8172-38492ee5261b.png`，1592×988。
- implementation：`F:/VUE/SS-Helpers/.tmp/resource-row-browser-qa/candidate-option2-desktop-accepted.png`，同为 1592×988，devicePixelRatio=1，使用真实小時聊天、已写入候选和原文证据。
- 同一次视觉输入对照：`candidate-option2-comparison.png`（设计左、实现右）；正文细节：`candidate-option2-focused.png`。以上截图均位于工作区 `.tmp/resource-row-browser-qa/`。
- 保留既有 SDK 弹窗、导航与资源摘要；省去设计图中重复的状态栏及没有业务数据支撑的主张字段和统计。原文真实状态为“来源已更新”，没有伪装成“来源一致”。

| 检查表面 | 结果 |
| --- | --- |
| 字体与层级 | 继承 SmartTheme 字体；面板标题、13–14px 正文和灰色元数据区分清晰，队列摘要不撑高整页。 |
| 间距与布局 | 桌面三栏约 414 / 376 / 470px；栏间 10px、行间 6px。窄屏纵向排列，各长正文仍可滚动。 |
| 颜色与 tokens | 炭黑、暖白、灰色与金色，语义状态保留绿色、黄色和红色；所有样式限定在工作台。 |
| 图像与图标 | 使用 SDK 图标与控件，没有新增图片依赖或装饰素材。 |
| 文案与内容 | 真实处理状态和 SDK 原因说明；全文可读、证据高亮，技术信息默认收起；无虚构 AI 审核操作。 |

**交互、检查与边界**

- 真实浏览器验证了状态筛选、清除筛选、空结果、上下条、键盘方向键与 Enter 选择、原文跳转并关闭弹窗、来源中文标签和证据高亮定位。390×844 视口无横向溢出，底部操作可见；手机换条后保留页面位置并按新内容高度自然夹紧。
- 证据：`candidate-option2-mobile-top.png`、`candidate-option2-mobile-bottom.png`、`candidate-option2-empty.png`、`candidate-option2-batch-overlay.png`；真实失败提示在根因修复前的 `candidate-option2-desktop-revised.png` 中已核对。最终浏览器无未捕获异常。
- 134 项相关测试通过；最后原文定位改动再跑 70 项 UI 测试通过。构建、旧契约扫描、资产扫描与 diff 检查通过。最终直接运行 tsc --noEmit 仍有 1 项既有测试类型错误（test/memory-application.spec.ts 的 true/false 推断），本次改动无新增；没有升级版本或依赖。
- 同日推送前复核：为上述参数补充 boolean 类型，TypeScript 检查通过；完整测试 585 项通过、2 项跳过，修正后再跑 MemoryApplication 55 项全部通过。构建、旧契约扫描、资产扫描通过，同版本 SDK 包与当前构建同步。
- 已备份并更新本机酒馆 Memory 前端，安装文件与构建哈希一致。备份：`F:/VUE/SS-Helpers/.tmp/candidate-option2-backup-20261007-190009/`。不自动刷新用户的浏览器。
- 上下条使用当前已加载候选，页脚明确标注加载数量；更多候选通过虚拟队列按页读取。没有发起初始化、模型请求或修改记忆记录。

以下保留已有初始化与其他页面的验收历史。

# 初始化 UI 验收

日期：2026-10-07（Asia/Shanghai）。选定方向：方案 1，来源配置与任务进度双栏。

**加载性能修复**

- SDK 服务端打开工作区时比较索引字段集合，定义不变跳过重建；变更定义仍在事务中完整重建。真实打开请求从中途复测的 21,741ms 降到最终 2ms / 189ms，避免同步 SQLite 重建阻塞其他请求。
- Memory 恢复检查跳过拒绝项没有变化的审计更新；原子写入与真实状态修复保持原路径。同一工作区/聊天的并发占用统计共享进行中的扫描，完成或失败后均清除，下一次刷新仍读新数据。
- 实际聊天复测审计分块请求 27 次（原诊断记录 134 次），无变化的恢复没有 commit；最终最长主线程长任务 349ms，未再出现原先 0.7～1.7 秒阻塞。统计仍完整扫描后台数据，未把后台全量统计宣称为瞬时完成。前后资源时间线缓冲区大小不同，不比较总下载字节降幅。
- Memory 105 项、LLM 50 项、SDK 服务端 7 项测试通过；LLM 类型检查、两插件构建通过。Memory 类型检查 HEAD 基线 2 项、当前 2 项，没有新增。版本保持 0.0.1。
- 已安装前端与服务端并重启本机服务；备份 `.tmp/load-performance-backup-20261007-165553/`。性能证据 `.tmp/workbench-load-profile-final.json`（路径均相对工作区根目录）。

**记录超限与失败恢复修复**

- 单条工作区记录上限从 1 MiB 提高到 10 MiB，保留 UTF-8 序列化边界；密钥限制不变。10 MiB 精确边界可读写，超出 1 字节拒绝并回滚整个事务，SDK 服务端 6 项测试通过。
- 只读检查确认失败任务保留 13/16 批断点。任务中的 297 份候选快照均有完整审计副本；后续任务写入只保存拒绝项摘要，完整内容继续留在分块审计。该历史记录按新规则计算可从 1,002,336 字节减至 134,998 字节，未直接修改历史数据库。
- 有断点的失败初始化显示真实进度与“继续初始化”，调用既有恢复处理器；183 项 Memory 相关测试通过。构建、legacy scan、资产扫描和 SDK 边界检查通过；类型检查与 HEAD 基线各有 2 项既有错误，无新增错误。
- 已备份并安装 SDK 服务端及 Memory 前端，文件哈希一致；本机酒馆重启后 HTTP 200。备份：`F:/VUE/SS-Helpers/.tmp/workspace-record-size-backup-20261007-162824/`，未升级版本。
- 桌面 2005×1244 与手机 390×844 已检查，恢复按钮可见，无横向溢出，浏览器无未捕获异常。截图：`.tmp/resource-row-browser-qa/record-size-failed-desktop.png`、`record-size-failed-mobile.png`（相对工作区根目录）。失败状态使用生产渲染器与内存样例；未触发真实初始化或模型请求，实际后续批次需用户恢复执行。

**本次反馈修正：来源卡片与批次单位**

- 来源卡片改为两列，缩小图标、字号和内边距；“包含隐藏楼层”移入聊天消息卡片底部。两个复选框使用独立 label，点击附加项不会切换来源。
- 批次范围数量使用“16 批次”等明确单位；重新初始化确认页复用相同来源布局。
- 桌面 2005×1244：来源卡片宽 188px、高 96px；390×844：两列均宽 152.5px、高 96px，无横向溢出。浏览器鼠标点击与空格键操作附加项通过，聊天来源保持选中。
- 证据：`F:/VUE/SS-Helpers/.tmp/resource-row-browser-qa/initialization-source-compact-desktop.png`、`initialization-source-compact-mobile.png`；实际未绑定状态为 `initialization-source-compact-live.png`。有来源状态继续使用生产渲染器的内存样例，未发起初始化。
- 85 项相关测试（3 文件）、构建、legacy scan、资产检查和 diff 检查通过。构建文件已备份并更新本机安装，哈希一致；版本保持 0.0.1。
- 本次反馈验收：passed。以下保留方案 1 初次落地的验收记录。

**Findings**

最终未发现尚未解决的 P0 / P1 / P2 问题。保留既有任务、诊断、来源选择和 SDK 操作契约，精简展示层；未新增依赖或升级版本。

**视觉依据与对照**

- source visual truth：`C:/Users/liao/.codex/generated_images/01a1145e-7093-7750-b268-cb6e56b462a7/exec-56b2a630-b5ef-4712-a380-fdec0062779f.png`，1540×1024。
- implementation screenshot：`F:/VUE/SS-Helpers/.tmp/resource-row-browser-qa/initialization-option1-final.png`，弹窗裁切 1408×928；完整浏览器视口 2005×1244，devicePixelRatio=1。
- 原图与实现已在同一次视觉输入中对照。比较区域是初始化正文；保留既有宿主导航和顶部摘要，原图中的批次下拉改用既有可编辑数值范围。
- 实际页面：<http://127.0.0.1:8022/>。真实未绑定状态见 `initialization-option1-live.png`；运行、暂停、完成截图使用生产渲染器与内存测试数据。外层宿主仍显示未绑定，内层小時与进度是测试状态，不是实际任务记录。

**五项视觉检查**

| 表面 | 结果 |
| --- | --- |
| 字体与层级 | 继承宿主字体，22px 任务标题、32px 进度数字；主内容与灰色次级说明区分清楚。 |
| 间距与布局 | 左侧约 38% 放来源、批次与操作，右侧约 62% 放进度、阶段与记录；左右独立滚动，窄屏改为自然高度单列。 |
| 颜色与 tokens | 沿用 SmartTheme 炭黑、暖白、灰色和金色，成功及失败保留语义色。 |
| 图像与图标 | 使用 SDK 图标；无新增图片或自制装饰资产，图标形状与原图的细微差异来自组件库。 |
| 文案与内容 | 估算、用量与高级说明默认折叠；来源、批次和进度继续取真实模型，未硬编码示例计数。结构化错误和 requestId 保留。 |

**修复记录与交互**

- P2：首轮手机布局中网格收缩导致上下内容重叠。改为自然高度行与滚动容器后，390×844 下配置区域底部与进度区域顶部均为 1057.89px，前后衔接无重叠；内容 scrollWidth/clientWidth 均为 345px，无横向溢出。证据：`initialization-option1-mobile-fixed.png`、`initialization-option1-mobile-progress.png`。
- Enter 可以展开估算；重渲染保留折叠状态和滚动位置。任务按钮继续使用既有开始、取消、恢复与重新初始化处理器。
- 运行状态 6/16 已完成显示 38%，不把正在执行的第 7 批算作完成；暂停停止动画，完成显示成功反馈。
- 活跃阶段呼吸、加载旋转和原生进度过渡随状态变化；浏览器开启 prefers-reduced-motion 后，动画列表为空。
- 暂停和完成截图已检查：诊断、操作与阶段可读，较长内容通过独立滚动区访问。

**验证与交付边界**

- 86 tests passed / 4 files：initialization-view、memory-ui、ui-contract、version-metadata。
- Vite 构建、legacy scan、inventory assets 校验与 git diff --check 通过。
- 类型检查与 Git HEAD 基线均为 97 项已有诊断，本次新增 0 项；不能视为全仓类型检查通过。
- 浏览器实际未绑定状态检查通过；其他任务状态使用生产渲染器的内存样例核对，未发起真实初始化、付费模型调用或聊天数据写入。控制台未捕获运行异常。
- 已将构建后的 index.js/style.css 更新到 `F:/SillyTavern/public/scripts/extensions/third-party/SS-Helper-Memory/`。覆盖前备份：`F:/VUE/SS-Helpers/.tmp/initialization-ui-backup-20261007-150330/`。版本保持 0.0.1。
- 未进行专门的屏幕阅读器验收；窄屏顶部导航沿用既有工作台外壳。

final result: passed

---

以下保留既有验收记录。

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

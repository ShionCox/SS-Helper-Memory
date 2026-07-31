# 召回预览悬浮窗设计验收

- 视觉基准：`I:/VUE/SS-Helpers/.tmp/preview.html`
- 酒馆实测：`I:/VUE/SS-Helpers/.tmp/product-design/recall-preview-live-final.png`
- 验收日期：2026-07-29
- 版本：Memory / SDK `0.0.1`
- final result: passed

## 对齐结果

| 检查项 | 原型要求 | 实测结果 | 状态 |
| --- | --- | --- | --- |
| 窗口 | 初始 680×610，最小 520×420，居中并受视口约束 | 实测 680×610；首次打开居中；拖拽后按 action id 恢复位置 | passed |
| 标题区 | 图标、`召回预览 · 第 N 层`、覆盖徽章、说明、最小化、关闭 | Core 统一渲染，徽章与标题同行，图标来自隔离图标集 | passed |
| 摘要栏 | 查询、角色数、实际注入数、字符预算 | 四栏完整显示；角色数只统计实际注入 owner，旧记录明确显示未保存查询摘要 | passed |
| 主导航 | 实际召回、全部候选、发送内容及数量 | 三页均可切换；选中下划线与标签按钮同宽 | passed |
| 实际召回 | 搜索、来源筛选、角色 chips、展开详情 | 仅展示实际注入角色；条目有 8px 可视间距、折叠内容垂直居中且整项可展开 | passed |
| 全部候选 | 多维筛选与冷加载 | 410 条候选首屏仅 8 个虚拟 DOM 行，滚动到底续载 | passed |
| 发送内容 | Memory 注入、完整请求、换行、复制、旧记录降级 | 新记录按需校验并展示；历史记录显示“未保存请求快照” | passed |
| Footer | 只读说明、召回次数、耗时、预算与覆盖 | 信息完整且固定在窗口底部 | passed |
| 交互 | 拖拽、缩放、最小化/恢复、Escape、聊天切换关闭 | 自动测试与酒馆实测通过 | passed |
| 响应式 | 小视口全屏单列 | 620px 以下使用 6px 视口留白并关闭拖拽式布局 | passed |

## 修复记录

首轮酒馆验收发现 SDK 虚拟列表和公共输入控件样式只覆盖普通 Popup，导致聊天窗口内列表越界、输入框回落为浏览器默认样式。现已将通用控件和虚拟列表样式扩展到聊天动作窗口作用域，并通过第二轮酒馆实测。

二轮实测发现摘要把候选 owner 数误写成召回角色数、虚拟列表重绘会让原生 `details` 展开状态丢失。现已改为按实际注入 owner 去重，并由稳定 key 托管展开状态；酒馆实测确认 2 条旁白注入显示为 1 个注入角色，展开状态在布局测量后仍保持。

完整 Prompt 只写入专用 `generation-prompt-snapshots` / `generation-prompt-snapshot-chunks` 集合；日志、诊断和 Toast 仅保存安全元数据。

---

# Memory 工作台审计界面重设计验收

- 视觉基准：`I:/VUE/SS-Helpers/.tmp/preview.html`
- 本地实现：`http://127.0.0.1:4177/.tmp/memory-audit-preview.html`
- 验收日期：2026-07-31
- 版本：Memory / SDK `0.0.1`（未调整版本源）

## 视觉对照

| 视口 | 对照图 | 结果 |
| --- | --- | --- |
| 1280×720 | `I:/VUE/SS-Helpers/.tmp/product-design/memory-audit-comparison-1280x720.png` | 深色双栏、暖白正文、金色强调和紧凑信息密度与基准一致；保留现有顶部状态栏与左侧工作台导航。 |
| 900×720 | `I:/VUE/SS-Helpers/.tmp/product-design/memory-audit-comparison-900x720.png` | 无页面级横向溢出；记录栏 240px、详情栏 397px，筛选工具栏按可用宽度换行。 |
| 480×900 | `I:/VUE/SS-Helpers/.tmp/product-design/memory-audit-comparison-480x900.png` | 无页面级横向溢出；状态栏末项占满整行，审计列表与详情使用钻取模式，返回后恢复原记录焦点。 |

基准在窄屏使用顶部横向导航；本实现按需求保留现有工作台外壳，因此继续使用工作台自己的移动导航。未复制基准中的人工同意、拒绝或继续修复状态。

## 功能与无障碍验收

| 检查项 | 验收结果 | 状态 |
| --- | --- | --- |
| 审计页签 | SDK segmented 的“操作记录 / Token 用量”可切换并保留选择 | passed |
| 审计筛选 | 搜索、状态、只看待处理、有效选择保留和虚拟列表均可用 | passed |
| 真实操作 | 忽略失败项、来源消息跳转、Core 确认框回滚、刷新均已在浏览器执行 | passed |
| 统一诊断 | 仅展示错误码、中文原因、建议及安全定位字段；未展示原始错误消息或候选正文 | passed |
| Token 空值 | 缺失 Prompt、总计和缓存 Token 显示“未返回”，筛选后仍未被压成 0 | passed |
| 趋势与替代 | Canvas 趋势图带真实可聚焦数据点按钮，并提供完整数据表 | passed |
| 用量详情 | 候选数、注入数、主体数、Prompt 占用、失效状态和消息跳转可用 | passed |
| 安全导出 | JSON 与 UTF-8 CSV 入口执行成功；自动测试校验白名单与敏感字段剔除 | passed |
| 数据维护 | 已成为正式导航页，进入该页后才读取 SQLite 详细状态 | passed |
| 移动焦点 | 操作记录与用量详情返回后均恢复到原选择项；Tab 焦点顺序可达 | passed |
| 控制台 | 完整交互后 `error` / `warn` 均为 0 | passed |

## 本轮修正

视觉对照发现 480px 状态栏因七个状态项形成空白网格单元，已让重排序模型状态跨满末行。交互验收同时发现移动详情返回按钮受 CSS cascade layer 的 `!important` 规则压制；现已调整为桌面隐藏、移动钻取时显示，并在操作记录和 Token 用量两条路径验证焦点恢复。

代码审查后的闭环修正包括：repair queue 按 Capture 任务与批次双重隔离；安全诊断逐字段补齐原请求上下文；同一失败项的多条字段问题分别展示；审计与用量列表改为安全读模型的真实 SQLite cursor 分页，完整汇总在首屏之后流式计算；快速切换用量详情只接受最后一次请求；“当前事实”读取实时工作区数量；CSV 对公式前缀进行转义；Token 虚拟列表改用 `region → listbox → option` 的有效无障碍层级。

验证结果：Memory typecheck、lint、定向 111 项测试、全量 496 项测试（2 项 live integration 按配置跳过）和生产构建通过；根目录 `verify:dist`、`verify:workspace`、`verify:versions` 与部署 fixture 全部通过。未执行真实 SillyTavern `--apply`。

final result: passed

---

# 卡牌细胞镭射、星空与切换动画跟进验收

- 镭射参考：`C:/Users/lyy/AppData/Local/Temp/codex-clipboard-6595b428-7c00-494e-b42a-104ed51f6ddb.png` 与 `C:/Users/lyy/AppData/Local/Temp/codex-clipboard-e5bfe69a-6aeb-45de-89be-7841b9d92f42.png`；两图为同一卡面在不同倾角下的柔和紫/青/粉薄膜反射，只作为材质效果基准，不替换现有卡面内容。
- 本地实现：`http://127.0.0.1:4177/.tmp/memory-inventory-preview.html`
- 双倾角实现截图：`I:/VUE/SS-Helpers/.tmp/inventory-holo-chroma-left.png`、`I:/VUE/SS-Helpers/.tmp/inventory-holo-chroma-right.png`，1280×720 px；与两张参考图在同一比较输入中完成对照。
- 状态列表截图：`I:/VUE/SS-Helpers/SS-Helper-Memory/.tmp/inventory-compact-state-list-1280x720.png`。
- 状态：深色主题、网格视图、同一卡牌正面、指针位于左上与右下两个真实倾角；另检查离场、纹理替换和入场中间帧。

## 对照结论

| 表面 | 参考 / 实现证据 | 结论 |
| --- | --- | --- |
| 镭射形态 | 两张参考图以整卡柔和换色为主，细胞高度只形成轻微局部扰动；双倾角实现裁图呈现同类紫/青/粉迁移。 | `cellularData` 仍以距离和坡向组成高度场与 `microNormal`，但最终以宽幅椭圆 `broadSheen` 承载主要薄膜光，局部高度响应只占较小权重，不再逐个强调细胞边界。 |
| 镭射可见度与覆盖 | 两个倾角的整体色温与宽幅亮区发生变化，底部属性区同样带有紫/青/粉反光，细胞纹理不再形成高对比气泡；最终截图没有无色白雾。 | 微法线坡度为 0.78、倾角光程为 3.2；`baseFilm` 覆盖整面，局部高度只叠加轻微 `reliefFilm`。交互强度为 0.52 / 0.92、透明度上限 0.46；膜层颜色使用线性空间的低亮高色度紫/青/粉，并在输出前提升饱和度、压低亮度，避免 sRGB 转换造成泛白。 |
| 背景星空 | 完整实现图中卡牌四周保持明显的深色星空。 | 圆环几何已完全移除；118 个确定性星点具有独立尺寸、相位和 `aBlink`，少量亮星独立闪烁，减少动画模式会冻结闪烁。 |
| 切换与白闪 | `inventory-card-angle-leaving-1280x720.png`、`inventory-card-angle-swap-1280x720.png`、`inventory-card-angle-entering-1280x720.png` | 选择变化不再销毁 WebGL Renderer/Canvas；同一 Canvas 先让旧卡飞出，再原位更新两张 CanvasTexture、分类材质和星空缓冲，最后让新卡从右侧飞入。关键帧始终只有一个深色 Canvas，未出现白色或灰色空帧。 |
| 当前状态 | `inventory-compact-state-list-1280x720.png` | 双列卡片改为带统一外框的单列账目；每条只占一行，按“计量/精确度、数值、来源”三列对齐，来源按钮仍可跳转聊天楼层。 |
| 页面批注 | 1280×720 与 1786×1272 浏览器实测 | 三维预览技术顶栏已移除；物品卡分类改为中文；网格卡不再显示来源栏与顶部 3px 分类描边；“确认写入账本”使用 SDK `md` 高度并增加 8px 上间距。 |
| 字体、间距、颜色、图像和文案 | 完整实现图与既有 `preview2.html` 页面验收结果。 | 三栏比例、本地 WebP、真实库存文案及 SDK 控件保持不变；右侧仅把当前状态从双列卡片压缩为单列账目。 |

## 迭代历史

用户先反馈旧版镭射不明显且仍像单条扫光，并指出切换时出现灰色/白色闪烁、缺少清楚的出场过程。前序修正让动画只驱动 Three.js 内部卡牌组，并降低强度、缩小 Cellular 颗粒。后续先把细胞距离和坡向转换为高度场与微法线，再按反馈增强迎光/背光差异；对照最新参考图发现该版局部高光过强，最终改为整体薄膜换色为主、细胞高度轻扰动为辅，并增加覆盖整张卡面的底膜反光。最后针对“泛白”反馈保留膜层可见度，改用低亮高色度的线性色值并做饱和度约束。白闪从根因上改为同一 Renderer 原位换纹理，避免切换时创建新 WebGL 上下文。右侧当前状态和页面批注也已同步落实。

## 功能、无障碍与运行状态

- 旋转、翻面、离屏暂停、ResizeObserver、WebGL 上下文丢失回退、完整资源释放和减少动画继续有效。
- 同一物品重绘和不同物品选择都复用既有 host、renderer 与 Canvas；只有离开物品页、无可选物品或销毁工作台时才释放 WebGL 资源，异步纹理更新仍由 generation/token 防止旧结果回写。
- 快速 A→B→C 只提交最后一个选择；同卡取消可让飞出中的卡片平滑返回。
- 内置浏览器实测加载、转动、连续切换、离场和入场；控制台只有 Vite 调试日志，`error` / `warn` 为 0。

## 自动验证

Memory typecheck、lint、504 项全量测试（2 项 live integration 跳过）和生产构建通过；本轮镭射与 UI 定向 68 项测试通过。根目录 `verify:dist`、`verify:workspace`、`verify:versions` 与部署 fixture 通过，生产卡面资源扫描通过。已使用 `--apply --preserveData` 部署到 `I:/SillyTavern`；部署证据位于 `I:/SillyTavern/backups/ss-helper-0.0.1-20260731T104816Z/deployment-evidence.json`，状态为 `DEPLOYED`，活动 v0 数据与备份逐文件一致。未提交或推送 Git。

final result: passed

---

# Memory「物品与资源」Three.js 重设计验收

- 视觉基准：`I:/VUE/SS-Helpers/.tmp/preview2.html`
- 本地实现：`http://127.0.0.1:4177/.tmp/memory-inventory-preview.html`
- 验收日期：2026-07-31
- 版本：Memory / SDK `0.0.1`（未调整版本源）
- 主题与状态：深色 SmartTheme；当前聊天；网格视图；选中“曜石长剑”
- 密度归一：三组源码与实现截图均按 CSS 视口 1:1、`devicePixelRatio = 1` 采集；像素尺寸分别为 1280×720、900×720、480×900。

## 完整视图对照

| 视口 | 源码 / 实现证据 | 结果 |
| --- | --- | --- |
| 1280×720 | `I:/VUE/SS-Helpers/.tmp/product-design/inventory-comparison-1280x720-pass2.png` | 统计 HUD、分类栏、四列物品网格与详情卡保持原型的三栏比例、深色密度和分类强调色；现有顶部状态栏与左侧工作台导航按需求保留。 |
| 900×720 | `I:/VUE/SS-Helpers/.tmp/product-design/inventory-comparison-900x720.png` | 实现按确认方案在 900px 进入分类、物品、详情单列堆叠；页面 `scrollWidth = clientWidth = 900`。原型本身仍保持桌面三栏，差异属于明确的响应式产品约束。 |
| 480×900 | `I:/VUE/SS-Helpers/.tmp/product-design/inventory-comparison-480x900.png` | 工作台使用既有移动导航，库存内容单列滚动；页面 `scrollWidth = clientWidth = 480`，不存在页面级横向溢出。原型没有独立移动版，实施结果以批准的双列卡片和单列表单要求为准。 |

## 聚焦区域证据

| 区域 / 状态 | 实现截图 | 验收结果 |
| --- | --- | --- |
| 移动端双列卡片 | `I:/VUE/SS-Helpers/.tmp/product-design/inventory-implementation-480x900-grid.png` | 前四张卡片实测为两列：每列 206px，横向坐标 23 / 236px；来源按钮没有造成横向溢出。 |
| 移动端详情钻取 | `I:/VUE/SS-Helpers/.tmp/product-design/inventory-implementation-480x900-detail.png` | 选择第二件物品后，详情 `#stx-memory-inventory-detail` 获得焦点并滚入可视区域；3D 正面完整显示，没有裁切。 |
| 本地背面资源与翻面 | `I:/VUE/SS-Helpers/.tmp/product-design/inventory-implementation-480x900-card-back.png` | 真实 Three.js 翻面后展示提取自原型的本地背面 WebP，按钮同步为“正面”状态。 |
| 移动端新增表单 | `I:/VUE/SS-Helpers/.tmp/product-design/inventory-implementation-480x900-create.png` | 规范名称、别名和分类三项实测均为 413px 单列；保存与取消使用 SDK 按钮和选择框。 |

这些聚焦图覆盖了完整视图中无法清楚辨认的卡面清晰度、双列宽度、详情焦点、翻面状态和移动表单，因此不再额外裁切小图。

## 必查视觉表面

| 表面 | 对照结论 | 状态 |
| --- | --- | --- |
| 字体与排版 | 继续使用工作台的 Segoe UI / 微软雅黑回退、暖白正文和灰色说明；标题、指标、卡片数值和紧凑元数据层级清楚，无异常换行。 | passed |
| 间距与布局节奏 | 桌面三栏、900px 单列堆叠、480px 双列卡片与单列表单均符合批准方案；圆角、边框、8px 主间距沿用现有工作台。 | passed |
| 颜色与主题令牌 | 炭黑表面、金色主强调与武器/药品/食物/防具/特殊/核心/材料分类色均映射到 SmartTheme 和库存局部变量，选中态不依赖颜色以外的单一信号。 | passed |
| 图像质量与资源保真 | 正反面均为从原型提取的本地 WebP；Three 卡牌保留源图比例和清晰度，没有 CDN、Base64、CSS 假卡面或内联 SVG。 | passed |
| 文案与内容 | UI 使用真实库存语义：精确、近似、未知、已移除、来源、账本与可信度；未加入虚假的装备属性或审批状态。 | passed |
| 图标 | 分类、刷新、创建、视图切换、来源和翻面全部使用 SDK 图标元素，无文本符号图标。 | passed |

## 功能、无障碍与运行状态

| 检查项 | 验收结果 | 状态 |
| --- | --- | --- |
| HUD 与范围 | 五项统计不受搜索、分类与范围筛选影响；`absent` 不计入当前持有，无维持天数显示“未记录”。 | passed |
| 搜索、分类、排序、视图 | 名称/别名搜索、真实分类计数、四种排序、网格/列表和筛选后的选择保持均有纯逻辑与 DOM 测试。 | passed |
| 创建与账本 | 创建名称/别名/分类、设置/增加/减少/移除、三种精确度、可维持天数约束、`expectedRevision` 和幂等键均连接真实控制器。 | passed |
| 确认与通知 | 作废使用 Core 确认框；创建、账本、作废和刷新结果使用 Core Toast 通道。 | passed |
| Three.js | 浏览器实测本地正面、背面与翻面；自动测试覆盖无 WebGL 回退、DPR 上限、减少动画、Resize/Intersection observer、上下文丢失 teardown 和重复销毁门禁。 | passed |
| 键盘与焦点 | 翻面控件为带可访问名称和 `aria-pressed` 的原生按钮；选择物品后移动详情恢复焦点，普通 DOM 同步提供全部卡面信息。 | passed |
| 控制台 | 480px 完整交互后页面控制台 `error` / `warn` 均为 0；1280px 与 900px 加载、WebGL 和响应式检查无页面错误。 | passed |

## 对照迭代历史

首轮 1280×720 对照记录在 `I:/VUE/SS-Helpers/.tmp/product-design/inventory-comparison-1280x720.png`，发现两项 P2：卡牌相机距离过近导致卡面上下裁切；物品网格只有三列且卡片过高，和原型的信息密度不一致。来源按钮的默认描边也抢占了卡片视觉层级。

修正后将 Three 相机后移，卡牌在桌面和移动详情中完整显示；桌面卡片最小宽度降为 96px、行高降为 146px，恢复四列密度；来源按钮改为透明无边框。二轮证据为 `I:/VUE/SS-Helpers/.tmp/product-design/inventory-comparison-1280x720-pass2.png`，没有剩余可操作的 P0 / P1 / P2。900px 与 480px 对照随后确认单列堆叠、双列卡片、详情焦点和零页面横向溢出。

## 验证结果

Memory typecheck、lint、504 项全量测试（2 项 live integration 按配置跳过）和生产构建通过；本轮镭射与 UI 定向 68 项测试通过，生产卡面资源扫描确认两张 WebP 独立落盘且 bundle 中没有 `data:image/webp;base64`。根目录 `verify:dist`、`verify:workspace`、`verify:versions` 与部署 fixture 均通过。已保留活动 v0 数据部署到 `I:/SillyTavern`，部署证据为 `I:/SillyTavern/backups/ss-helper-0.0.1-20260731T104816Z/deployment-evidence.json`；未提交或推送 Git。

final result: passed

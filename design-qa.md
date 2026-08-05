# 初始化真实分片、Agent 标记与最新流程验收

- 用户问题证据：当前长聊天在“每组最多 10 层”时显示 110 批次，范围输入失焦后恢复旧值
- 真实验收聊天：`助手 · 2026年7月18日 03:30:01`，275 个聊天楼层与 1 个角色卡来源
- 本地实现：`http://127.0.0.1:8000/`
- 验收日期：2026-08-01
- 版本：Memory / SDK `0.0.1`（未调整版本源）
- 部署证据：`G:/SillyTavern/backups/ss-helper-0.0.1-20260801T114328Z/deployment-evidence.json`
- final result: passed

## 批次语义与 Agent 状态

该聊天包含 275 个可处理聊天楼层。楼层模式现在严格按“每组最多 10 层”形成 28 个真实批次，不再由字符上限二次扩张为 110 个执行分片；字符上限仅控制字数分组模式和单个超长来源块。估算、范围选择、任务断点和完成状态统一使用 28 批口径。网页实测输入范围 1–2 后失焦仍保持 2，并以“第 1–2 批 / 共 28 批”启动。

当前配置实测为 Agent 正式写入。初始化区显示独立的 `Agent · 正式写入` 状态标记、并发 2、只读工具和“开始 Agent 初始化”操作文案；若 Agent 已配置但运行能力不可用，开始操作会被阻止，不再静默退回 Single。完成态直接报告正式记忆和召回状态。

## 最新流程核对

| 阶段 | 当前界面 | 实际管线 | 状态 |
| --- | --- | --- | --- |
| 1 | 确定性预取 | 清洗来源、建立短引用、锁定数据修订 | passed |
| 2 | 实体优先与联合提取 | 实体先行；内容与库存一次联合提取；歧义时按需只读工具 | passed |
| 3 | 本地合并、强校验与裁决 · 不调用模型 | 程序合并、硬校验、Read Set 与更新规划 | passed |
| 4 | 原子提交并召回 | 裁决结果同批写入正式记忆并更新派生索引 | passed |

Single 模式也已使用对应的四阶段描述：读取与确定性预取、单阶段结构化提取、硬校验与定向修复、原子提交并召回。界面不再展示与实际执行脱节的通用旧流程。

## 视觉、交互与运行结果

| 检查项 | 实测结果 | 状态 |
| --- | --- | --- |
| 指标层级 | 来源、楼层、真实批次和 Token 估算使用同一口径 | passed |
| Agent 标记 | 独立状态条 54 px；模式、原子写入、并发和工具策略均可见 | passed |
| 流程卡高度 | 四张流程卡均为 64 px，宽度一致，无单项拉伸 | passed |
| 范围语义 | 起止值使用真实楼层批次，输入草稿在重绘后保持，带分组和可访问名称 | passed |
| 溢出 | 页面与工作台主区横向溢出均为 0 | passed |
| 控制台 | 实测 `error = 0`，没有 SS-Helper / Memory 新警告 | passed |

本轮在酒馆网页直接执行了真实模型调用。已保存的 `grok / grok-4.3` 中转资源通过连接与原生工具调用验证，Chat Completions 工具协议有效，五个 Memory 提取任务均绑定 Grok 并显示 `5 / 5 可用于 Agent`。Agent 处理 1–2 批约 157 秒后完成，正式事实、场景和召回索引均可用；随后在自动定向修复阶段收到结构化 `RATE_LIMITED` 并安全暂停，断点保留。整个实测没有再出现固定请求超时；修复任务数量与聊天批次数已分开展示。Memory 全量测试通过（另 2 项外部实测跳过），生产构建与根目录 SDK / LLM / Memory 三件套构建通过。

---

# 初始化来源等高卡片与批次范围验收

- 变更前截图：`G:/vue/SS-Helpers/SS-Helper-Memory/.tmp/product-design/initialization-before.png`
- 同视口同状态对照：`G:/vue/SS-Helpers/SS-Helper-Memory/.tmp/product-design/initialization-before-after-comparison.png`
- 全选实现截图：`G:/vue/SS-Helpers/SS-Helper-Memory/.tmp/product-design/initialization-range-after-all-selected.png`
- 未选中状态截图：`G:/vue/SS-Helpers/SS-Helper-Memory/.tmp/product-design/initialization-range-after-unselected.png`
- 本地实现：`http://127.0.0.1:8000/`
- 验收日期：2026-08-01
- 版本：Memory / SDK `0.0.1`（未调整版本源）
- 部署证据：`G:/SillyTavern/backups/ss-helper-0.0.1-20260801T063742Z/deployment-evidence.json`
- final result: passed

## 视觉与交互结果

对照图左右均为 2061×1065 px、同一长聊天、同一深色主题和全部来源选中状态。变更后保留原有 SmartTheme、字体、金色强调与双栏工作台结构，只把隐藏楼层选项和两张来源卡统一为固定 60 px 高，并在估算区加入连续批次范围控件。三张卡实测高度均为 60 px；全选时三项均带 `is-selected`，取消“处理隐藏楼层”后该项立即回到中性灰色背景、灰色图标和普通边框，另外两张已勾选来源继续保持金色高亮。

长聊天包含隐藏楼层时共 110 批，实测选择 1–5 后估算区显示 `5 / 110`、底栏显示 `1–5 / 110`。取消隐藏楼层后来源缩减为 34 / 275 项、共 17 批，范围自动保留为 1–5，估算区和底栏同步显示 `5 / 17` 与 `1–5 / 17`。本轮未点击“开始初始化”，没有改写记忆数据。

| 检查项 | 实测结果 | 状态 |
| --- | --- | --- |
| 卡片高度 | 隐藏楼层、聊天消息、角色卡世界容器均为 60 px | passed |
| 选中反馈 | 只有复选框为选中状态的卡片使用金色背景、边框与图标；未选中项保持中性灰 | passed |
| 批次范围 | 起止输入支持连续区间，范围、Token 估算、操作底栏同步更新 | passed |
| 状态切换 | 隐藏楼层开关会重新计算可用批次数，并安全夹取、保留有效范围 | passed |
| 溢出与密度 | 2061×1065 桌面视口无新增横向溢出，流程卡和固定底栏保持原节奏 | passed |
| 键盘与语义 | 两个数字输入有可访问名称、`min/max` 和分组语义，复选框沿用原生键盘能力 | passed |
| 控制台 | 交互过程未产生新错误；仅保留页面首次加载时已有的 4 条 SillyTavern `MutationObserver` 错误 | passed |

视觉复核未发现 P0、P1 或 P2 问题。Memory lint、typecheck、535 项测试（另 2 项外部实测跳过）、生产构建及根目录 SDK / LLM / Memory 三件套构建均通过；随后完成 dry-run、停止 SillyTavern、保留数据部署、重新启动、HTTP 200、卡片像素测量与浏览器交互验收。

---

# 提取模型分配固定任务行高度跟进验收

- 问题截图：`C:/Users/liao/AppData/Local/Temp/codex-clipboard-8e057327-7432-452a-9aeb-f0757aed872c.png`
- 同状态对照：`G:/vue/SS-Helpers/SS-Helper-Memory/.tmp/product-design/task-routing-fixed-items-comparison.png`
- 完整实现截图：`G:/vue/SS-Helpers/SS-Helper-Memory/.tmp/product-design/task-routing-fixed-items-2001x1065.png`
- 聚焦区域截图：`G:/vue/SS-Helpers/SS-Helper-Memory/.tmp/product-design/task-routing-fixed-items-nav.png`
- 本地实现：`http://127.0.0.1:8000/`
- 验收日期：2026-08-01
- 版本：Memory / SDK `0.0.1`（未调整版本源）
- 部署证据：`G:/SillyTavern/backups/ss-helper-0.0.1-20260801T045805Z/deployment-evidence.json`
- final result: passed

## 对照与密度

问题截图为用户提供的 558×919 px 聚焦裁图，截图密度未知；实现以 2001×1065 CSS 视口、`devicePixelRatio = 1.5` 实测，完整截图为 2001×1065 px，左侧任务栏聚焦裁图为 316×573 px。对照图保持两侧原始像素与顶部对齐，不做几何拉伸。状态统一为深色主题、实体提取选中、自动选择。

首轮实测确认五行虽彼此等高，但 `repeat(5, minmax(4.75rem, 1fr))` 会把每行随容器拉伸到 105.74 px，形成大面积空白，属于 P2 密度与节奏问题。修正后桌面网格轨道和 SDK 按钮均固定为 76 px，五行实测高度全部为 76 px，行距均为 4 px；图标与状态点中心和选中项中心同为 y=410.95，标题与说明维持紧凑的两行层级。移动断点继续固定为 48 px 横向任务条。

## 必查视觉面

| 检查项 | 跟进结果 | 状态 |
| --- | --- | --- |
| 字体与文案 | 现有字体、字号、字重和五项任务文案不变；标题与“自动选择”均无换行或截断 | passed |
| 间距与布局节奏 | 五行从弹性拉伸改为固定 76 px，剩余空间留在任务栏底部；选中背景不再形成过高色块 | passed |
| 颜色与令牌 | SmartTheme 暖白、灰色和金色选中令牌不变，未引入新颜色 | passed |
| 图标与资源 | 继续使用 SDK 公共图标，尺寸和光栅质量无变化；本轮无新增图像资产 | passed |
| 响应式与溢出 | 桌面工作区 `scrollWidth = clientWidth = 1039`，任务栏 `scrollWidth = clientWidth = 315`；移动规则显式保持 48 px | passed |

## 验证

任务切换在“单次提取 / 叙事提取 / 实体提取”之间实测可用并回到问题截图状态；本轮仅修改受 Popup 根节点约束的 CSS。Memory lint、3 项定向弹窗测试、生产构建和根目录三件套构建通过；随后完成 dry-run、停止 SillyTavern、`--apply --preserveData` 部署、重新启动、HTTP 200 与插件加载核验。既有完整交互验收的页面控制台 `error` 为 0，本轮 CSS 跟进未引入脚本逻辑。

---

# 提取模型分配方案 3 重设计验收

- 视觉基准：`C:/Users/liao/.codex/generated_images/019fbb87-144d-79a0-8603-c3923239dff0/exec-19ce3933-1eb8-407d-aae4-8680247afb3c.png`
- 同视口对照：`G:/vue/SS-Helpers/SS-Helper-Memory/.tmp/product-design/task-routing-comparison-1680x938.png`
- 桌面实测：`G:/vue/SS-Helpers/SS-Helper-Memory/.tmp/product-design/task-routing-implementation-1680x938.png`
- 移动实测：`G:/vue/SS-Helpers/SS-Helper-Memory/.tmp/product-design/task-routing-implementation-480x900.png`
- 本地实现：`http://127.0.0.1:8000/`
- 验收日期：2026-08-01
- 版本：Memory / SDK `0.0.1`（未调整版本源）
- 部署证据：`G:/SillyTavern/backups/ss-helper-0.0.1-20260801T044721Z/deployment-evidence.json`
- final result: passed

## 视觉对齐

| 检查项 | 方案 3 基准 | 酒馆实测 | 状态 |
| --- | --- | --- | --- |
| 弹窗比例 | 居中的约 1040×744 px 主从弹窗 | 1680×938 视口实测为 1040×747 px，位置为 x=320、y=95 | passed |
| 信息架构 | 左侧五项任务总览，右侧当前任务详情 | 五项路由、当前资源、Provider / 资源 / 模型、Agent 能力和提示卡均集中在一个视图 | passed |
| 视觉语言 | 炭黑表面、暖白正文、金色选中与能力强调 | 使用 SDK SmartTheme 令牌与公共图标；选中项、状态点、能力值和边框层级一致 | passed |
| 桌面密度 | 五个等节奏任务行、三列路由摘要、纵向能力表、固定底栏 | 主区无横向或纵向溢出；任务栏和详情面板独立成面，底栏固定 | passed |
| 移动布局 | 全屏单列并保留任务切换 | 480×900 实测弹窗为 480×900，工作区 `scrollWidth = clientWidth = 480`；任务栏可横向滑动且隐藏滚动条，详情区无横向溢出 | passed |

## 功能与无障碍验收

| 检查项 | 实测结果 | 状态 |
| --- | --- | --- |
| 任务切换 | 点击“单次提取”后标题、说明、选择框与 `aria-current` 同步更新并恢复键盘焦点 | passed |
| 资源选择 | SDK 顶层选择器显示自动路由与真实 DeepSeek 资源，不撑开或裁切弹窗 | passed |
| 即时保存 | 实际将实体任务切换到 DeepSeek，出现热加载状态与成功 Toast；Provider、资源、模型和能力快照同步刷新；随后恢复自动选择并再次保存成功 | passed |
| 能力呈现 | 已绑定资源时展示“重新验证”、工具调用、严格 Schema、流式工具与 Agent 可用提示；真实 Provider 探测未在视觉验收中触发，定向测试校验了公共 Bus 请求和刷新流程 | passed |
| 恢复确认 | “全部恢复自动选择”调用 SDK 确认框；实测取消不会修改现有配置 | passed |
| 响应式与焦点 | 桌面和移动均可通过语义按钮、页签、组合框与对话框访问；移动端单列、无页面级横向溢出 | passed |
| 控制台 | 完整交互后的浏览器 `error` 为 0；仅保留页面启动时既有的 LLM 路由重声明与 SillyTavern 宏弃用 warning，没有新增弹窗交互 warning | passed |

## 自动验证与部署

Memory `lint`、定向 3 项路由弹窗测试和生产构建通过；根目录三件套发布构建、版本策略和 workspace 一致性检查通过。最终产物经过 dry-run，停止 SillyTavern 后以 `--apply --preserveData` 部署；备份、暂存和已部署目录的文件清单与 content digest 均由脚本核验，随后 127.0.0.1:8000 监听、插件加载和真实浏览器交互通过。

---

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

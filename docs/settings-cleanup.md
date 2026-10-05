# 设置精简与验收

## 设置到执行路径

| 设置组 | 保存 / 读取 | 实际用途与本次处理 |
| --- | --- | --- |
| LLM 启用、流式、请求速率、超时、风格 | LLM settings adapter → LlmWorkspaceRepository → llm-service-runtime | 保留；超时界面使用秒，存储使用毫秒，请求细节折叠 |
| 输出长度 | 同上 → resolveTaskMaxTokens → resolveMaxTokens | 保留全局优先级；仅手动模式显示上限，隐藏不删除已有值 |
| 日志 | adapter → requestLogging → repository.appendRequestLog | 单一记录范围控件同步 enabled/detailMode；保留条数、天数、容量高级设置 |
| 资源连接 | ResourceWizardController → saveResource → Provider 构造 | 名称选填；协议、路径、维度和思考策略可展开，编辑已有资源不重置覆盖值 |
| 默认资源 | configuration-popups → globalAssignments → Router | 按生成/向量/重排分别选择；只更新选中类型，保留任务分配与其他配置 |
| 调用方额度 | configuration-popups → budgets → BudgetManager | 表单替代 JSON；显示已注册与已有未知调用方，支持留空和清除 |
| Memory 启用、聊天覆盖 | settings adapter → MemoryApplication.saveSettings/loadSettings → getEffectiveSettings | 保留全局和当前聊天各自语义 |
| 自动整理、提取模式、只读工具 | 同上 → capture/extraction pipeline | 保留；只读工具仍可在启用 Agent 前预先设置，避免能力校验死锁 |
| 批次模式、字符/楼层上限、间隔、重叠 | 同上 → summary-strategy | 折叠；字符和楼层模式均使用楼层上限，各层统一限制 1–16 |
| 选角模式、窗口、在场、阈值和角色权限 | 同上 → GenerationCastPlanner / SceneStateReducer / 角色召回 | 保留有效参数；调用上限折算为快速/混合/导演，置信度仅混合模式显示 |
| 临时人物 | 同上 → GenerationCastPlanner.newActorProposals | 两个开关以 AND 显示为一个，保存时同步两个现有字段 |
| 召回数量、字符预算、检索方式、重排 | 同上 → recall pipeline / prompt builder | 保留日常操作；资源不足继续沿用现有阻止或降级提示 |
| 提取前参考、结构修复、关系图谱 | 同上 → pre-extract reference / repair / graph service | 折叠分组，关闭功能后隐藏子项，已保存参数不变 |
| 八类任务路由 | Memory task-routing-popup → LLM_TASK_ROUTE_SET_V0 | 独立配置继续保留，不进入通用默认资源编辑器 |

## 删除与边界

- 删除队列占位弹窗；任务查看入口集中在请求日志。
- 删除整份设置的高级路由 JSON 编辑和覆盖函数；配置导入导出保留。
- 删除没有实现重生成的意外角色策略、恒定 `mentionedActorRecall` 传递及失实风险标记。意外/缺席角色仍记录到 CastPlanAudit，私密记忆范围不变。
- SDK 新增可选 `SectionField.collapsible` 和 `SettingsFieldStateSnapshot.hidden`，使用原生 details/summary。隐藏不修改值，搜索不揭示模式不适用项，搜索可展开匹配分组，关闭设置中心后重置折叠状态。
- 未新增依赖、未提高版本；旧数据没有被重置，废弃键不再被生产代码读取或写入。已有备份和历史审计记录不做破坏性改写。

## 回归范围

- SDK：隐藏与搜索、状态订阅、折叠保持、原有保存回滚和生命周期测试。
- LLM：日志双状态合并、秒/毫秒精度、隐藏参数保留、可选名称与协议覆盖、路由隔离、未知调用方、额度清除与失败回滚。
- Memory：完整测试套件，另覆盖字符批次楼层上限、组合开关映射、局部保存保留参数、参考模式恢复自动。
- 真实酒馆使用同一安装的插件和独立测试目录，不对正式聊天、资源和密钥进行验收写入。

## 实际验收结果（2026-10-05）

- SDK 全量测试 145 项通过；最后的折叠状态和移动布局修正后，受影响测试再次通过。LLM 193 项通过；Memory 564 项通过、2 项跳过，参考模式修正后设置适配器 8 项再次通过。
- 三个项目类型检查、lint、统一构建、版本检查和 workspace / 统一错误规范检查通过。版本仍为 0.0.1。
- LLM、Memory 旧链路扫描通过。SDK 扫描仍报告两处既有测试夹具：`tests/bridge-startup.test.mjs` 的旧错误字符串字段、`tests/fixtures/compile/negative.ts` 的旧路由字符串字段；两文件相对 HEAD 无修改，本次没有改写夹具或放宽扫描规则。
- 已执行保留数据部署：`node scripts/deploy-sillytavern.mjs --apply --preserveData`。部署编号 `ss-helper-0.0.1-20261004T193438Z`，备份位于 `G:/SillyTavern/backups/ss-helper-0.0.1-20261004T193438Z`。
- 在 `http://localhost:8001/` 的真实 SillyTavern 1.18.0 验证了插件健康状态、手动输出长度字段显示、超时秒数保存与刷新持久化、三类默认资源表单、额度秒数保存和清除、字符分批时楼层上限可编辑、键盘展开高级分组，以及资源名称选填和高级连接选项展开。测试修改的输出模式、超时和分批模式已恢复，额度已清除；未保存新资源或修改密钥。
- 桌面及 390×844 移动视口检查通过；修复了标签栏撑宽表单导致的手机横向裁切，最终内容区宽度与 scrollWidth 均为 390px。最终页面未捕获到控制台 error。
- 浏览器验收使用 `G:/vue/SS-Helpers/.tmp/tavern-live-data-20261002` 独立测试数据。未进行新的付费模型调用；普通 / Agent / Memory 输出长度优先级、保存失败回滚及未知调用方配置保留由自动回归覆盖。

截图：

- [桌面设置中心](../../.tmp/real-tavern-evidence/settings-desktop.jpg)
- [移动设置中心](../../.tmp/real-tavern-evidence/settings-mobile.jpg)

构建、部署及测试日志保存在工作区 `.tmp/settings-*`。

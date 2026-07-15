# SDK 迁移历史基线（G0/G5C，2026-07-14 存档）

> **历史证据，不是当前集成说明。** 本文只保留 2026-07-14 G0/G5C 审计时记录的迁移边界、输入和验证结果；其中的路径、导入、宿主 API、挂载方式、版本和测试结论均不描述当前检出版本。
>
> 当前 SDK/Core 集成、固定构建输入和所有权边界以 [sdk-integration.md](sdk-integration.md) 为准。需要现状时，请查阅该文档和对应源码，而不要引用本存档。

## G0 审计边界（历史）

G0 当时冻结了行为和所有权：不提供兼容层、不创建 sibling SDK 镜像，并要求 SQLite schema、服务端协议和版本策略保持不变。以下记录用于解释该阶段的审计范围，而非指导后续实现。

## 当时观察到的旧 SDK 耦合（历史）

Historical audit evidence records a former sibling SDK path and now-removed host integration boundaries. This archival note is not a current integration contract; consult [sdk-integration.md](sdk-integration.md) for the authoritative guide.

G0 的测试配置在当时把缺失宿主 import 映射到最小中性 fixture，以便独立仓收集测试。该记录不代表当前生产解析路径，也不授权使用 SDK mirror。

## SQLite、server 与版本边界（历史）

审计要求曾明确：浏览器不拥有 SQLite 业务数据；服务端拥有 schema、备份恢复和每用户数据库路径；协议/schema 技术编号不等同于插件发布版本。该边界的当前契约请以 [sdk-integration.md](sdk-integration.md) 和当前 server 源码为准。

## G0 回归审计范围（历史）

当时的回归矩阵覆盖版本元数据、SQLite/server、capture 生命周期、召回链、数据校验、宿主适配和 UI。测试文件名及计数会随仓库演进，不是当前质量状态的证据。

## 已知迁移风险（历史）

该阶段识别出的风险包括宿主全局耦合、普通设置与 popup workbench 的边界，以及迁移过程中不得改变 SQLite/server 协议。风险是否仍适用必须由当前集成文档和测试确认。

## G5C 冻结 SDK 输入（G012，历史/已替代）

- Vendored path: `vendor/ss-helper-sdk-1.0.0.tgz`
- SDK SHA-256: `425e5509fdff5c73cdc7cf1200f969359caa76de9645199dd00fdda0fd9524ad`
- SDK package version: `1.0.0`
- Runtime API: `1.1`
- Upstream Core archive SHA-256（历史/已替代）: `e4e62fe04552623a53e03128084cb89dd9e016d7b22ad04e40e199299aa5cf6a`
- Upstream Core contentDigest（历史/已替代）: `2155e4ad49ee03a98e981a32da1e45b7eacaf1691844d6e6128f599e4e70fc46`
- Dependency boundary: only the repository-relative `file:vendor/ss-helper-sdk-1.0.0.tgz` package was permitted in that snapshot; workspace, link, absolute, sibling-source, or SDK source imports were prohibited.

These hashes and constraints are archived G5C evidence. Consult [sdk-integration.md](sdk-integration.md) before making or validating any current dependency decision.

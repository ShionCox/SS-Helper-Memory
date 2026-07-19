export type MemoryErrorStage = 'startup' | 'chat-bind' | 'health' | 'workbench-load' | 'workbench-page' | 'operation';

export interface MemoryErrorDiagnostic {
  code: string;
  title: string;
  reason: string;
  action: string;
  retryable: boolean;
}

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/u;

function errorCode(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code ?? '').toUpperCase();
    if (CODE_PATTERN.test(code)) return code;
  }
  if (error && typeof error === 'object' && 'details' in error) {
    const details = (error as { details?: { reasonCode?: unknown } }).details;
    const code = String(details?.reasonCode ?? '').toUpperCase();
    if (CODE_PATTERN.test(code)) return code;
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const embedded = message.match(/\b(?:WORKSPACE|SQLITE|MEMORY)_[A-Z0-9_]{2,63}\b/u)?.[0];
  return embedded ?? fallback;
}

export function describeMemoryError(
  error: unknown,
  fallbackCode = 'MEMORY_RUNTIME_ERROR',
  stage: MemoryErrorStage = 'operation',
): MemoryErrorDiagnostic {
  const code = errorCode(error, fallbackCode);
  const bindingTitle = stage === 'chat-bind' ? '当前聊天的记忆工作区初始化失败' : 'Memory 数据服务不可用';
  switch (code) {
    case 'WORKSPACE_NOT_FOUND':
      return {
        code,
        title: bindingTitle,
        reason: '当前角色或群组的工作区、数据集合尚未创建，或初始化过程被聊天切换打断。',
        action: '插件会自动补建工作区；如果仍未恢复，请点击“重新检查”。',
        retryable: true,
      };
    case 'WORKSPACE_CONFLICT':
      return {
        code,
        title: '记忆数据发生并发冲突',
        reason: '同一条记忆数据在当前操作期间已被其他任务更新。',
        action: '重新读取最新数据后再执行该操作。',
        retryable: true,
      };
    case 'WORKSPACE_ACCESS_DENIED':
      return {
        code,
        title: 'Memory 无权访问当前工作区',
        reason: '当前插件会话与该工作区的所有者或授权信息不一致。',
        action: '请重启 SillyTavern；若仍出现，请确认 SDK Core 与 Memory 安装产物一致。',
        retryable: false,
      };
    case 'WORKSPACE_SECRET_UNAVAILABLE':
      return {
        code,
        title: 'Memory 加密密钥不可用',
        reason: 'SDK Core 无法读取或创建工作区加密密钥，因此不能安全打开 SQLite 数据。',
        action: '请检查 SillyTavern 数据目录权限并重启服务。',
        retryable: false,
      };
    case 'WORKSPACE_UNAVAILABLE':
    case 'SQLITE_SERVICE_UNAVAILABLE':
      return {
        code,
        title: 'SQLite 工作区服务未连接',
        reason: 'SDK Core 的工作区接口当前没有响应，Memory 已暂停读写以避免数据不一致。',
        action: '请确认服务端 SS-Helper SDK 插件已加载，然后点击“重新检查”。',
        retryable: true,
      };
    case 'WORKSPACE_INDEX_REQUIRED':
      return {
        code,
        title: '记忆索引定义不完整',
        reason: 'Memory 查询使用的字段尚未在当前工作区中建立索引。',
        action: '点击“重新检查”让插件补建数据集合；若仍失败，请重新部署当前版本。',
        retryable: true,
      };
    case 'PAYLOAD_INVALID':
      return {
        code,
        title: 'LLM 请求数据格式不兼容',
        reason: 'LLM 与 SDK 的公共数据边界拒绝了请求或响应，通常是可选字段携带了空值，或插件产物并非来自同一次构建。',
        action: '请更新并重启 SDK、LLM 与 Memory；若仍出现，请保留此错误码和当前任务名称用于诊断。',
        retryable: false,
      };
    case 'INVALID_JSON':
      return {
        code,
        title: '模型返回内容不是有效 JSON',
        reason: '模型输出未形成完整、可解析的结构化数据，因此 Memory 没有写入任何事实。',
        action: '可以重试一次；如果持续出现，请更换更稳定的模型或提高输出长度。',
        retryable: true,
      };
    case 'SCHEMA_VALIDATION_FAILED':
      return {
        code,
        title: '模型返回内容不符合记忆结构',
        reason: '模型返回了 JSON，但字段、类型或必填项没有满足 Memory 的事实结构。',
        action: '可以重试一次；如果持续出现，请更换结构化输出能力更好的模型。',
        retryable: true,
      };
    case 'MEMORY_SLOT_MIGRATION_READ_FAILED':
    case 'MEMORY_SLOT_MIGRATION_WRITE_FAILED':
    case 'MEMORY_SLOT_MIGRATION_CLEANUP_FAILED':
      return {
        code,
        title: '旧记忆槽位整理未完成',
        reason: error instanceof Error ? error.message : '聊天级槽位迁移在当前步骤失败，已有事实尚未被修改。',
        action: '请点击“重新检查”；若仍失败，请保留此错误码及其底层错误码。',
        retryable: true,
      };
    case 'PROVIDER_UNAVAILABLE':
      return {
        code,
        title: '当前大语言模型资源不可用',
        reason: 'LLM 无法路由到可用的生成资源，或当前酒馆连接已断开。',
        action: '请先在 LLM 设置中确认来源和模型可用，然后重新初始化。',
        retryable: true,
      };
    case 'CALL_TIMEOUT':
    case 'TIMEOUT':
      return {
        code,
        title: '记忆提炼请求超时',
        reason: '模型在限定时间内没有返回完整结果，当前批次未写入数据库。',
        action: '请检查模型连接后重试；较慢的模型可适当减少单批来源内容。',
        retryable: true,
      };
    default:
      return {
        code,
        title: stage === 'workbench-page' ? '当前页面读取失败' : stage === 'operation' ? '记忆操作执行失败' : bindingTitle,
        reason: 'Memory 在当前步骤遇到未识别的运行时异常，相关读写已安全停止。',
        action: '点击“重新检查”重试；如果错误持续出现，请保留错误码用于诊断。',
        retryable: true,
      };
  }
}

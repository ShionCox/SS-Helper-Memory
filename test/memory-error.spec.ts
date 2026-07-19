import { describe, expect, it } from 'vitest';
import { describeMemoryError } from '../src/diagnostics/memory-error';

describe('Memory error diagnostics', () => {
  it('preserves the workspace error code and explains a new-chat initialization failure', () => {
    const error = Object.assign(new Error('Collection facts does not exist'), { code: 'WORKSPACE_NOT_FOUND' });
    expect(describeMemoryError(error, 'MEMORY_CHAT_BIND_FAILED', 'chat-bind')).toEqual(expect.objectContaining({
      code: 'WORKSPACE_NOT_FOUND',
      title: '当前聊天的记忆工作区初始化失败',
      reason: expect.stringContaining('尚未创建'),
      action: expect.stringContaining('自动补建'),
      retryable: true,
    }));
  });

  it('does not expose an unknown raw error payload in the workbench reason', () => {
    const diagnostic = describeMemoryError(new Error('credential=sk-secret prompt=private'), 'MEMORY_OPERATION_FAILED', 'operation');
    expect(diagnostic.code).toBe('MEMORY_OPERATION_FAILED');
    expect(diagnostic.reason).not.toContain('sk-secret');
    expect(diagnostic.reason).not.toContain('private');
  });

  it('explains an SDK public boundary rejection instead of hiding it behind an initialize error', () => {
    const error = Object.assign(new Error('The public data boundary rejected a value'), { code: 'PAYLOAD_INVALID' });
    expect(describeMemoryError(error, 'MEMORY_INITIALIZE_FAILED', 'operation')).toEqual(expect.objectContaining({
      code: 'PAYLOAD_INVALID',
      title: 'LLM 请求数据格式不兼容',
      reason: expect.stringContaining('公共数据边界'),
      retryable: false,
    }));
  });

  it('reports the exact chat-slot migration stage without exposing record contents', () => {
    const error = Object.assign(new Error('写入聊天级槽位失败（底层错误码：PAYLOAD_INVALID）。'), {
      code: 'MEMORY_SLOT_MIGRATION_WRITE_FAILED',
    });
    expect(describeMemoryError(error, 'MEMORY_CHAT_BIND_FAILED', 'chat-bind')).toEqual(expect.objectContaining({
      code: 'MEMORY_SLOT_MIGRATION_WRITE_FAILED',
      title: '旧记忆槽位整理未完成',
      reason: expect.stringContaining('底层错误码：PAYLOAD_INVALID'),
      retryable: true,
    }));
  });
});

import { describe, expect, it } from 'vitest';
import { createSSHelperError } from '@ss-helper/sdk';
import { describeMemoryError } from '../src/diagnostics/memory-error';

describe('Memory error diagnostics', () => {
  it('uses the SDK catalog for workspace failures', () => {
    const error = createSSHelperError('WORKSPACE_NOT_FOUND', { stage: 'memory.chat-bind', requestId: 'req-1' });
    expect(describeMemoryError(error, 'MEMORY_CHAT_BIND_FAILED', 'chat-bind')).toEqual(expect.objectContaining({
      reasonCode: 'WORKSPACE_NOT_FOUND',
      title: '工作区数据不存在',
      requestId: 'req-1',
      retryable: true,
    }));
  });

  it('does not expose an unknown raw error payload', () => {
    const diagnostic = describeMemoryError(
      new Error('credential=sk-secret prompt=private'),
      'INTERNAL_ERROR',
      'operation',
    );
    expect(diagnostic.reasonCode).toBe('INTERNAL_ERROR');
    expect(diagnostic.reason).not.toContain('sk-secret');
    expect(diagnostic.reason).not.toContain('private');
  });

  it('preserves a structured public-boundary root reason', () => {
    const error = createSSHelperError('PUBLIC_DATA_NOT_PLAIN', {
      stage: 'memory.capture.request',
      requestId: 'req-2',
    });
    expect(describeMemoryError(error, 'INTERNAL_ERROR', 'operation')).toEqual(expect.objectContaining({
      reasonCode: 'PUBLIC_DATA_NOT_PLAIN',
      requestId: 'req-2',
      retryable: false,
    }));
  });

  it('fails closed when retired Memory storage is detected', () => {
    const error = createSSHelperError('MEMORY_RETIRED_STORAGE_DETECTED', { stage: 'memory.startup' });
    expect(describeMemoryError(error, 'MEMORY_CHAT_BIND_FAILED', 'chat-bind')).toEqual(expect.objectContaining({
      reasonCode: 'MEMORY_RETIRED_STORAGE_DETECTED',
      title: '检测到已退休的 Memory 数据',
      retryable: false,
    }));
  });
});

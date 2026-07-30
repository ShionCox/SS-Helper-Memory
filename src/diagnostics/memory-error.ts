import {
  describeSSHelperFailure,
  type SSHelperDiagnostic,
  type SSHelperReasonCode,
} from '@ss-helper/sdk';

export type MemoryErrorStage = 'startup' | 'chat-bind' | 'health' | 'workbench-load' | 'workbench-page' | 'operation';
export type MemoryErrorDiagnostic = SSHelperDiagnostic;

export function describeMemoryError(
  error: unknown,
  fallbackReasonCode: SSHelperReasonCode = 'INTERNAL_ERROR',
  stage: MemoryErrorStage = 'operation',
): MemoryErrorDiagnostic {
  return describeSSHelperFailure(error, {
    reasonCode: fallbackReasonCode,
    stage: `memory.${stage}`,
  });
}

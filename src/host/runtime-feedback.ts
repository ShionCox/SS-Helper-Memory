import {
  readSSHelperFailure,
  startSSHelperPerformanceSpan,
  traceSSHelperPerformance,
  type SSHelperFailureContext,
} from '@ss-helper/sdk';

export function safeMemoryFailure(
  error: unknown,
  fallback: Pick<SSHelperFailureContext, 'reasonCode' | 'stage'>
    & Partial<Omit<SSHelperFailureContext, 'reasonCode' | 'stage'>>,
): SSHelperFailureContext {
  return readSSHelperFailure(error, fallback)!;
}

function write(level: 'info' | 'warn' | 'error', message: string, detail?: unknown): void {
  const method = console[level];
  if (detail === undefined) method(`[Memory] ${message}`);
  else {
    const safeDetail = safeMemoryFailure(detail, {
      reasonCode: 'INTERNAL_ERROR',
      stage: 'memory.runtime.log',
    });
    method(`[Memory] ${message} [${safeDetail.reasonCode}]`, safeDetail);
  }
}

export const logger = Object.freeze({
  info: (message: string, detail?: unknown) => write('info', message, detail),
  success: (message: string, detail?: unknown) => write('info', message, detail),
  warn: (message: string, detail?: unknown) => write('warn', message, detail),
  error: (message: string, detail?: unknown) => write('error', message, detail),
});

/** Test-only, opt-in startup breadcrumbs. Never includes host data or settings. */
export function traceMemoryStartup(stage: string): void {
  const entry = traceSSHelperPerformance('memory', stage);
  const traceEnabled = (globalThis as typeof globalThis & { __SSHelperMemoryStartupTrace?: unknown }).__SSHelperMemoryStartupTrace === true;
  if (traceEnabled) logger.info(`启动检查点：${stage}${entry ? `（+${entry.deltaMs.toFixed(1)}ms / ${entry.elapsedMs.toFixed(1)}ms）` : ''}`);
}

export const startMemoryPerformanceSpan = (stage: string) => startSSHelperPerformanceSpan('memory', stage);

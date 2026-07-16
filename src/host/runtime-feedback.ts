function write(level: 'info' | 'warn' | 'error', message: string, detail?: unknown): void {
  const method = console[level];
  if (detail === undefined) method(`[Memory] ${message}`);
  else {
    const safeDetail = detail instanceof Error
      ? { name: detail.name, code: String((detail as Error & { code?: unknown }).code ?? 'MEMORY_ERROR') }
      : detail && typeof detail === 'object' && 'code' in detail
        ? { code: String((detail as { code?: unknown }).code ?? 'MEMORY_ERROR') }
        : { code: 'MEMORY_DIAGNOSTIC' };
    method(`[Memory] ${message}`, safeDetail);
  }
}

export const logger = Object.freeze({
  info: (message: string, detail?: unknown) => write('info', message, detail),
  success: (message: string, detail?: unknown) => write('info', message, detail),
  warn: (message: string, detail?: unknown) => write('warn', message, detail),
  error: (message: string, detail?: unknown) => write('error', message, detail),
});

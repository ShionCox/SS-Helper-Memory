function write(level: 'info' | 'warn' | 'error', message: string, detail?: unknown): void {
  const method = console[level];
  if (detail === undefined) method(`[Memory] ${message}`);
  else method(`[Memory] ${message}`, detail);
}

export const logger = Object.freeze({
  info: (message: string, detail?: unknown) => write('info', message, detail),
  success: (message: string, detail?: unknown) => write('info', message, detail),
  warn: (message: string, detail?: unknown) => write('warn', message, detail),
  error: (message: string, detail?: unknown) => write('error', message, detail),
});

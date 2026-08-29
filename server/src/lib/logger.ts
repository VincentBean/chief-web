type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const configured = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
const threshold = LEVELS[configured as Level] ?? LEVELS.info;

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, message, ...meta };
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  stream(JSON.stringify(line));
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => emit('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => emit('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit('error', message, meta),
};

/** Supported log levels, in ascending order of severity. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Minimal structured-logging contract so the logger can be swapped or mocked. */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/** Keys that must never be written to logs. */
const REDACTED_KEYS = ['password', 'passwordhash', 'token', 'authorization', 'apikey', 'code', 'secret'];

/**
 * Redacts sensitive keys from a log context (shallow and one level deep).
 * @param {Record<string, unknown>} context - The raw context.
 * @returns {Record<string, unknown>} A sanitised copy.
 */
function redact(context: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (REDACTED_KEYS.includes(key.toLowerCase())) {
      clean[key] = '[REDACTED]';
    } else if (value instanceof Error) {
      clean[key] = { name: value.name, message: value.message, stack: value.stack };
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      clean[key] = redact(value as Record<string, unknown>);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

/**
 * Creates a JSON-lines logger writing to stdout/stderr.
 * @param {LogLevel} [level='info'] - The minimum level to emit.
 * @returns {Logger} The logger.
 */
export function createLogger(level: LogLevel = 'info'): Logger {
  const write = (target: LogLevel, message: string, context: Record<string, unknown> = {}): void => {
    if (ORDER[target] < ORDER[level]) return;
    const line = JSON.stringify({ level: target, time: new Date().toISOString(), message, ...redact(context) });
    (target === 'error' || target === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
  };
}

/** A logger that discards everything. Used in tests. */
export const silentLogger: Logger = createLogger('silent');

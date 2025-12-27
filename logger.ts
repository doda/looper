import pino from "pino";

const workerSlot = process.env.LOOPER_WORKER_SLOT;
const workerSuffix = workerSlot ? ` worker ${workerSlot}` : "";
const logLevel = process.env.LOOPER_LOG_LEVEL ?? process.env.LOG_LEVEL ?? "info";
const logFormat = (process.env.LOOPER_LOG_FORMAT ?? "pretty").toLowerCase();
const usePretty = logFormat !== "json";

const logger = pino({
  level: logLevel,
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: usePretty
    ? {
        target: "pino-pretty",
        options: {
          colorize: process.stdout.isTTY,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname",
        },
      }
    : undefined,
});

function tagFor(prefix: string): string {
  return `${prefix}${workerSuffix}`;
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === "string") return new Error(err);
  try {
    return new Error(JSON.stringify(err));
  } catch {
    return new Error(String(err));
  }
}

export function logInfo(prefix: string, message: string): void {
  const tag = tagFor(prefix);
  if (usePretty) {
    logger.info(`[${tag}] ${message}`);
    return;
  }
  logger.info({ tag }, message);
}

export function logDebug(prefix: string, message: string): void {
  const tag = tagFor(prefix);
  if (usePretty) {
    logger.debug(`[${tag}] ${message}`);
    return;
  }
  logger.debug({ tag }, message);
}

export function logWarn(prefix: string, message: string, err?: unknown): void {
  const tag = tagFor(prefix);
  if (usePretty) {
    if (err) {
      logger.warn({ err: toError(err) }, `[${tag}] ${message}`);
      return;
    }
    logger.warn(`[${tag}] ${message}`);
    return;
  }
  if (err) {
    logger.warn({ tag, err: toError(err) }, message);
    return;
  }
  logger.warn({ tag }, message);
}

export function logError(prefix: string, message: string, err?: unknown): void {
  const tag = tagFor(prefix);
  if (usePretty) {
    if (err) {
      logger.error({ err: toError(err) }, `[${tag}] ${message}`);
      return;
    }
    logger.error(`[${tag}] ${message}`);
    return;
  }
  if (err) {
    logger.error({ tag, err: toError(err) }, message);
    return;
  }
  logger.error({ tag }, message);
}

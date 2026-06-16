type LogContext = Record<string, unknown>;

function writeLog(level: "debug" | "info" | "warn" | "error", message: string, context?: LogContext) {
  const payload = {
    level,
    message,
    context,
    timestamp: new Date().toISOString()
  };

  const line = JSON.stringify(payload);

  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}

export const logger = {
  debug: (message: string, context?: LogContext) => writeLog("debug", message, context),
  info: (message: string, context?: LogContext) => writeLog("info", message, context),
  warn: (message: string, context?: LogContext) => writeLog("warn", message, context),
  error: (message: string, context?: LogContext) => writeLog("error", message, context)
};

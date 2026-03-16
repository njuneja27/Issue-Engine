import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { ensureDir, nowIso } from "./utils.js";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface LoggerOptions {
  rootDir: string;
  logFileName?: string;
  level?: "debug" | "info" | "warn" | "error";
}

const levelRank: Record<NonNullable<LoggerOptions["level"]>, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? "info";
  const logDir = join(options.rootDir, "logs");
  const logPath = join(logDir, options.logFileName ?? "issue-engine.log");
  ensureDir(logDir);

  function log(kind: keyof typeof levelRank, message: string): void {
    if (levelRank[kind] < levelRank[level]) {
      return;
    }

    const line = `[${nowIso()}] ${kind.toUpperCase()} ${message}`;
    const write = kind === "error" ? console.error : console.log;
    write(line);
    appendFileSync(logPath, `${line}\n`, "utf8");
  }

  return {
    info: (message) => log("info", message),
    warn: (message) => log("warn", message),
    error: (message) => log("error", message),
    debug: (message) => log("debug", message),
  };
}

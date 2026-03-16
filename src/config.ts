import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { config as loadDotenv } from "dotenv";

import { capacityCheckSchema } from "./capacity-config.js";
import { type CapacityCheckConfigInput } from "./capacity-config.js";
import { repoProfileSchema } from "./repo-profile.js";
import type { RepoProfile } from "./types.js";
import { ensureDir } from "./utils.js";

export interface AppPaths {
  rootDir: string;
  dbPath: string;
  logDir: string;
  runLogDir: string;
  configDir: string;
  profilesDir: string;
  promptsDir: string;
  schemasDir: string;
  stateDir: string;
  capacityConfigPath: string;
  capacityLocalConfigPath: string;
}

export interface AppConfig {
  paths: AppPaths;
  defaultLockLeaseMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  capacityCheck?: {
    enabled: boolean;
    command: CapacityCheckConfigInput["command"];
    cwd?: string | undefined;
    minRemainingPercent: number;
    blockNewWork?: boolean | undefined;
    failOpen?: boolean | undefined;
    remainingPercentPatterns?: string[] | undefined;
    usedPercentPatterns?: string[] | undefined;
    windowLabel?: string | undefined;
  } | undefined;
}

export function loadAppConfig(cwd = process.cwd()): AppConfig {
  loadDotenv({ quiet: true });

  const rootDir = resolve(process.env.ISSUE_ENGINE_HOME ?? cwd);
  const stateDir = resolve(rootDir, "state");
  const logDir = resolve(rootDir, "logs");
  const dbPath = resolve(
    rootDir,
    process.env.ISSUE_ENGINE_DB_PATH ?? "./state/orchestrator.sqlite",
  );

  const config: AppConfig = {
    paths: {
      rootDir,
      dbPath,
      logDir,
      runLogDir: join(logDir, "runs"),
      configDir: join(rootDir, "config"),
      profilesDir: join(rootDir, "config", "repos"),
      promptsDir: join(rootDir, "prompts"),
      schemasDir: join(rootDir, "schemas"),
      stateDir,
      capacityConfigPath: join(rootDir, "config", "capacity.json"),
      capacityLocalConfigPath: join(rootDir, "config", "capacity.local.json"),
    },
    defaultLockLeaseMs: Number(process.env.ISSUE_ENGINE_LOCK_LEASE_MS ?? 15 * 60_000),
    logLevel: parseLogLevel(process.env.ISSUE_ENGINE_LOG_LEVEL),
    capacityCheck: undefined,
  };

  const capacityConfigPath = resolveCapacityConfigPath(config.paths);
  if (capacityConfigPath) {
    const raw = readFileSync(capacityConfigPath, "utf8");
    config.capacityCheck = capacityCheckSchema.parse(JSON.parse(raw));
  }

  return config;
}

function parseLogLevel(input: string | undefined): AppConfig["logLevel"] {
  if (input === "debug" || input === "info" || input === "warn" || input === "error") {
    return input;
  }
  return "info";
}

export function ensureProjectStructure(appConfig: AppConfig): void {
  ensureDir(appConfig.paths.configDir);
  ensureDir(appConfig.paths.profilesDir);
  ensureDir(appConfig.paths.promptsDir);
  ensureDir(appConfig.paths.schemasDir);
  ensureDir(appConfig.paths.stateDir);
  ensureDir(appConfig.paths.logDir);
  ensureDir(appConfig.paths.runLogDir);
}

export function profilePath(appConfig: AppConfig, profileName: string): string {
  return resolveProfilePath(appConfig, profileName) ?? join(appConfig.paths.profilesDir, `${profileName}.json`);
}

export function loadRepoProfile(
  appConfig: AppConfig,
  profileName: string,
): RepoProfile {
  const path = resolveProfilePath(appConfig, profileName);
  if (!path) {
    throw new Error(
      `Repo profile not found: expected ${join(appConfig.paths.profilesDir, `${profileName}.json`)} or ${join(appConfig.paths.profilesDir, `${profileName}.local.json`)}`,
    );
  }

  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  return repoProfileSchema.parse(parsed);
}

export function listRepoProfiles(appConfig: AppConfig): string[] {
  if (!existsSync(appConfig.paths.profilesDir)) {
    return [];
  }

  return readdirSync(appConfig.paths.profilesDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.local\.json$/, "").replace(/\.json$/, ""))
    .filter((name, index, values) => values.indexOf(name) === index)
    .sort();
}

function resolveProfilePath(appConfig: AppConfig, profileName: string): string | undefined {
  const localPath = join(appConfig.paths.profilesDir, `${profileName}.local.json`);
  if (existsSync(localPath)) {
    return localPath;
  }

  const defaultPath = join(appConfig.paths.profilesDir, `${profileName}.json`);
  if (existsSync(defaultPath)) {
    return defaultPath;
  }

  return undefined;
}

function resolveCapacityConfigPath(paths: AppPaths): string | undefined {
  if (existsSync(paths.capacityLocalConfigPath)) {
    return paths.capacityLocalConfigPath;
  }

  if (existsSync(paths.capacityConfigPath)) {
    return paths.capacityConfigPath;
  }

  return undefined;
}

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "issue";
}

export function interpolateTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = values[key];
    return value === undefined ? "" : String(value);
  });
}

export function writeTextFile(path: string, contents: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, contents, "utf8");
}

export function readTextFile(path: string): string {
  return readFileSync(path, "utf8");
}

export function projectPath(rootDir: string, ...parts: string[]): string {
  return join(rootDir, ...parts);
}

export function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

export function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

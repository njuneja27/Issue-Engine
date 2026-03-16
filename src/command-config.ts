import { z } from "zod";

export interface StructuredCommand {
  command: string;
  args?: string[] | undefined;
}

export type CommandInput = string | StructuredCommand;

export interface ParsedCommand {
  command: string;
  args: string[];
}

const FORBIDDEN_COMMAND_PATTERNS = [
  /[;&|<>]/,
  /`/,
  /\$\(/,
  /\$\{/,
  /\n|\r/,
];

const safeCommandText = z
  .string()
  .min(1)
  .transform((value) => value.trim())
  .superRefine((value, ctx) => {
    try {
      validateCommandText(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Command contains unsupported shell syntax",
      });
    }
  });

export const commandInputSchema: z.ZodType<CommandInput> = z.union([
  safeCommandText,
  z.object({
    command: safeCommandText,
    args: z.array(safeCommandText).optional(),
  }),
]);

function validateCommandText(text: string): void {
  if (!text.length) {
    throw new Error("Command is empty");
  }

  for (const forbidden of FORBIDDEN_COMMAND_PATTERNS) {
    if (forbidden.test(text)) {
      throw new Error(`Command contains unsafe shell syntax: ${text}`);
    }
  }
}

function stripQuotes(token: string): string {
  if (
    (token.startsWith("\"") && token.endsWith("\"")) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }

  return token;
}

function splitCommandText(command: string): string[] {
  const tokens = command.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+/g);
  if (!tokens || tokens.length === 0) {
    throw new Error(`Unable to parse command: ${command}`);
  }

  return tokens.map((token) => {
    const trimmed = stripQuotes(token);
    validateCommandText(trimmed);
    return trimmed;
  });
}

export function parseCommandInput(input: CommandInput): ParsedCommand {
  if (typeof input === "string") {
    const tokens = splitCommandText(input);
    if (tokens.length === 0) {
      throw new Error("Command is missing");
    }

    return {
      command: tokens[0] ?? "",
      args: tokens.slice(1),
    };
  }

  const command = input.command.trim();
  validateCommandText(command);
  const args = input.args?.map((arg) => {
    const trimmedArg = arg.trim();
    validateCommandText(trimmedArg);
    return trimmedArg;
  }) ?? [];

  return {
    command,
    args,
  };
}

function quoteToken(token: string): string {
  if (/\s/.test(token) || token.includes('"')) {
    return JSON.stringify(token);
  }

  return token;
}

export function commandToString(command: CommandInput): string {
  const parsed = parseCommandInput(command);
  return [parsed.command, ...parsed.args].map(quoteToken).join(" ");
}

export function commandFingerprint(command: CommandInput): string {
  const parsed = parseCommandInput(command);
  return JSON.stringify([parsed.command, ...parsed.args]);
}

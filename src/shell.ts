import { spawn } from "node:child_process";

export interface CommandOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  onStdout?: ((chunk: string) => void) | undefined;
  onStderr?: ((chunk: string) => void) | undefined;
}

export interface CommandResult {
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class MissingCommandError extends Error {
  constructor(command: string) {
    super(`Missing required command: ${command}. Install it and ensure it is on your PATH.`);
    this.name = "MissingCommandError";
  }
}

export interface CommandRunner {
  run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
}

export class ShellError extends Error {
  constructor(public readonly result: CommandResult) {
    super(
      `Command failed (${result.exitCode}): ${result.command} ${result.args.join(" ")}\n${result.stderr || result.stdout}`,
    );
  }
}

export class NodeCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    const cwd = options.cwd ?? process.cwd();

    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          ...options.env,
        },
        stdio: "pipe",
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        const text = String(chunk);
        stdout += text;
        options.onStdout?.(text);
      });

      child.stderr.on("data", (chunk) => {
        const text = String(chunk);
        stderr += text;
        options.onStderr?.(text);
      });

      child.on("error", (error) => {
        if (
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          reject(new MissingCommandError(command));
          return;
        }

        reject(error);
      });

      child.on("close", (code) => {
        const result: CommandResult = {
          command,
          args,
          cwd,
          stdout,
          stderr,
          exitCode: code ?? 1,
        };

        if ((code ?? 1) !== 0 && !options.allowFailure) {
          reject(new ShellError(result));
          return;
        }

        resolve(result);
      });

      if (options.input) {
        child.stdin.write(options.input);
      }
      child.stdin.end();
    });
  }
}

import { spawn } from "node:child_process";

export interface CommandOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
}

export interface CommandResult {
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
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
        stdout += String(chunk);
      });

      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.on("error", reject);

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

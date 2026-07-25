import { fileURLToPath } from "node:url";

import {
  loadRunnerConfig,
  runConfiguredAssignmentCycle,
} from "./runner-config.js";
import type { NitelyCommandRunner } from "./local-nitely-executor.js";

export interface RunnerCliTextStream {
  write(chunk: string): unknown;
}

export interface RunRunnerCliOptions {
  stdout?: RunnerCliTextStream;
  stderr?: RunnerCliTextStream;
  runCommand?: NitelyCommandRunner;
  now?: () => Date;
  createId?: (kind: string) => string;
}

export async function runRunnerCli(
  argv = process.argv.slice(2),
  options: RunRunnerCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    stdout.write(usage());
    return 0;
  }

  const command = argv[0];
  if (command !== "run-once") {
    stderr.write(`unknown command: ${command}\n\n${usage()}`);
    return 2;
  }

  const parsed = parseRunOnceArgs(argv.slice(1));
  if (parsed.status === "help") {
    stdout.write(usage());
    return 0;
  }
  if (parsed.status === "error") {
    stderr.write(`${parsed.message}\n\n${usage()}`);
    return 2;
  }

  try {
    const config = await loadRunnerConfig(parsed.configPath);
    const result = await runConfiguredAssignmentCycle({
      config,
      runCommand: options.runCommand,
      now: options.now,
      createId: options.createId,
    });

    if (result.status === "idle") {
      stdout.write("runner cycle idle\n");
      return 0;
    }

    const rejected = result.report.rejectedEvents.length;
    stdout.write(
      `runner cycle handled task=${result.assignment.taskId} status=${result.projection.status} events=${result.reportedEvents.length} rejected=${rejected}\n`,
    );
    if (result.projection.runId) {
      stdout.write(`runner cycle run=${result.projection.runId}\n`);
    }
    for (const event of result.report.rejectedEvents) {
      stderr.write(
        `rejected event ${event.eventId} kind=${event.kind}: ${event.reason}\n`,
      );
    }
    return rejected > 0 || result.projection.status === "failed" ? 1 : 0;
  } catch (error) {
    stderr.write(`runner cycle failed: ${safeErrorMessage(error)}\n`);
    return 1;
  }
}

function parseRunOnceArgs(
  argv: string[],
):
  | { status: "ok"; configPath: string }
  | { status: "help" }
  | { status: "error"; message: string } {
  let configPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { status: "help" };
    }
    if (arg === "--config" || arg === "-c") {
      configPath = argv[index + 1];
      index += 1;
      if (!configPath) {
        return { status: "error", message: "missing value for --config" };
      }
      continue;
    }
    return { status: "error", message: `unknown run-once option: ${arg}` };
  }
  if (!configPath) {
    return { status: "error", message: "missing required --config <path>" };
  }
  return { status: "ok", configPath };
}

function usage(): string {
  return [
    "Usage:",
    "  nitely-runner run-once --config <path>",
    "",
    "Commands:",
    "  run-once    Poll one assignment, execute it, and report events.",
    "",
  ].join("\n");
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.split("\n")[0]!.slice(0, 500);
  }
  return "unknown error";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runRunnerCli();
}

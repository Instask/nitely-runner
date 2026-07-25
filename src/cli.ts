import { fileURLToPath } from "node:url";

import {
  loadRunnerConfig,
  registerConfiguredRunner,
  runConfiguredRunnerLoop,
  runConfiguredRunnerOnce,
} from "./runner-config.js";
import type { RunnerFetch } from "./http-control-plane.js";
import type { NitelyCommandRunner } from "./local-nitely-executor.js";

export interface RunnerCliTextStream {
  write(chunk: string): unknown;
}

export interface RunRunnerCliOptions {
  stdout?: RunnerCliTextStream;
  stderr?: RunnerCliTextStream;
  runCommand?: NitelyCommandRunner;
  fetch?: RunnerFetch;
  now?: () => Date;
  createId?: (kind: string) => string;
  sleep?: (durationMs: number) => Promise<void>;
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
  if (command !== "run-once" && command !== "run-loop" && command !== "register") {
    stderr.write(`unknown command: ${command}\n\n${usage()}`);
    return 2;
  }

  const parsed = parseConfigCommandArgs(command, argv.slice(1));
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
    if (command === "register") {
      const result = await registerConfiguredRunner({
        config,
        fetch: options.fetch,
      });
      stdout.write(
        `runner registered tenant=${result.runner.tenantId} runner=${result.runner.runnerId} policy=${result.runner.policy.policyVersion}\n`,
      );
      return 0;
    }
    if (command === "run-loop") {
      let exitCode = 0;
      const loop = await runConfiguredRunnerLoop({
        config,
        runCommand: options.runCommand,
        fetch: options.fetch,
        now: options.now,
        createId: options.createId,
        sleep: options.sleep,
        ...(parsed.maxCycles !== undefined
          ? { maxCycles: parsed.maxCycles }
          : {}),
        ...(parsed.pollIntervalMs !== undefined
          ? { pollIntervalMs: parsed.pollIntervalMs }
          : {}),
        onCycle: (result, cycleIndex) => {
          stdout.write(`runner loop cycle=${cycleIndex}\n`);
          exitCode = Math.max(exitCode, writeCycleResult(result, stdout, stderr));
        },
      });
      stdout.write(`runner loop stopped cycles=${loop.cycles.length}\n`);
      return exitCode;
    }

    const result = await runConfiguredRunnerOnce({
      config,
      runCommand: options.runCommand,
      fetch: options.fetch,
      now: options.now,
      createId: options.createId,
    });
    return writeCycleResult(result, stdout, stderr);
  } catch (error) {
    stderr.write(`runner ${command} failed: ${safeErrorMessage(error)}\n`);
    return 1;
  }
}

function parseConfigCommandArgs(
  command: string,
  argv: string[],
):
  | {
      status: "ok";
      configPath: string;
      maxCycles?: number;
      pollIntervalMs?: number;
    }
  | { status: "help" }
  | { status: "error"; message: string } {
  let configPath: string | undefined;
  let maxCycles: number | undefined;
  let pollIntervalMs: number | undefined;
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
    if (arg === "--max-cycles" && command === "run-loop") {
      const parsed = parsePositiveInteger(argv[index + 1], "--max-cycles");
      if (parsed.status === "error") {
        return parsed;
      }
      maxCycles = parsed.value;
      index += 1;
      continue;
    }
    if (arg === "--poll-interval-ms" && command === "run-loop") {
      const parsed = parsePositiveInteger(argv[index + 1], "--poll-interval-ms");
      if (parsed.status === "error") {
        return parsed;
      }
      pollIntervalMs = parsed.value;
      index += 1;
      continue;
    }
    return { status: "error", message: `unknown ${command} option: ${arg}` };
  }
  if (!configPath) {
    return { status: "error", message: "missing required --config <path>" };
  }
  return {
    status: "ok",
    configPath,
    ...(maxCycles !== undefined ? { maxCycles } : {}),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
  };
}

function usage(): string {
  return [
    "Usage:",
    "  nitely-runner register --config <path>",
    "  nitely-runner run-once --config <path>",
    "  nitely-runner run-loop --config <path> [--poll-interval-ms <ms>] [--max-cycles <n>]",
    "",
    "Commands:",
    "  register    Register this runner identity with the configured control plane.",
    "  run-once    Poll one assignment, execute it, and report events.",
    "  run-loop    Keep polling assignments until interrupted or max cycles is reached.",
    "",
  ].join("\n");
}

function writeCycleResult(
  result: Awaited<ReturnType<typeof runConfiguredRunnerOnce>>,
  stdout: RunnerCliTextStream,
  stderr: RunnerCliTextStream,
): number {
  const heartbeatRejected = result.heartbeatReports.flatMap(
    (report) => report.rejectedEvents,
  );

  if (result.cycle.status === "idle") {
    stdout.write("runner cycle idle\n");
    for (const event of heartbeatRejected) {
      stderr.write(
        `rejected heartbeat ${event.eventId} kind=${event.kind}: ${event.reason}\n`,
      );
    }
    return heartbeatRejected.length > 0 ? 1 : 0;
  }

  const rejected = result.cycle.report.rejectedEvents.length;
  stdout.write(
    `runner cycle handled task=${result.cycle.assignment.taskId} status=${result.cycle.projection.status} events=${result.cycle.reportedEvents.length} rejected=${rejected}\n`,
  );
  if (result.cycle.projection.runId) {
    stdout.write(`runner cycle run=${result.cycle.projection.runId}\n`);
  }
  for (const event of heartbeatRejected) {
    stderr.write(
      `rejected heartbeat ${event.eventId} kind=${event.kind}: ${event.reason}\n`,
    );
  }
  for (const event of result.cycle.report.rejectedEvents) {
    stderr.write(
      `rejected event ${event.eventId} kind=${event.kind}: ${event.reason}\n`,
    );
  }
  return heartbeatRejected.length > 0 ||
    rejected > 0 ||
    result.cycle.projection.status === "failed"
    ? 1
    : 0;
}

function parsePositiveInteger(
  value: string | undefined,
  name: string,
): { status: "ok"; value: number } | { status: "error"; message: string } {
  if (!value) {
    return { status: "error", message: `missing value for ${name}` };
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { status: "error", message: `${name} must be a positive integer` };
  }
  return { status: "ok", value: parsed };
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

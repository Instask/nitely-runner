import { spawn } from "node:child_process";

import type {
  RunnerAssignmentExecutor,
  RunnerAssignmentPayload,
  RunnerExecutionResult,
  RunnerIdentity,
} from "./assignment-runner.js";

export interface NitelyCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  cancelled?: boolean;
}

export interface NitelyCommandInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => Promise<void> | void;
  onStderr?: (chunk: string) => Promise<void> | void;
}

export type NitelyCommandRunner = (
  invocation: NitelyCommandInvocation,
) => Promise<NitelyCommandResult>;

export interface LocalNitelyCliExecutorOptions {
  command?: string;
  repositoryPaths: Record<string, string>;
  flowPaths?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  runCommand?: NitelyCommandRunner;
}

export class LocalNitelyCliExecutor implements RunnerAssignmentExecutor {
  readonly #command: string;
  readonly #repositoryPaths: Record<string, string>;
  readonly #flowPaths: Record<string, string>;
  readonly #env: NodeJS.ProcessEnv;
  readonly #runCommand: NitelyCommandRunner;

  constructor(options: LocalNitelyCliExecutorOptions) {
    this.#command = options.command ?? "nitely";
    this.#repositoryPaths = options.repositoryPaths;
    this.#flowPaths = options.flowPaths ?? {};
    this.#env = options.env ?? process.env;
    this.#runCommand = options.runCommand ?? defaultCommandRunner;
  }

  async execute(input: {
    identity: RunnerIdentity;
    assignment: RunnerAssignmentPayload;
    signal?: AbortSignal;
    onRunStarted?: (runId: string) => Promise<void> | void;
  }): Promise<RunnerExecutionResult> {
    const repoPath = this.#repositoryPaths[input.assignment.repoId];
    if (!repoPath) {
      return {
        status: "failed",
        failureCategory: "missing_repository_path",
        safeMessage: `runner has no local path for repository ${input.assignment.repoId}`,
      };
    }

    const flowPath = this.#resolveFlowPath(input.assignment);
    const cliInputs = buildCliInputs(input.assignment.inputs ?? {});
    if (cliInputs.status === "failed") {
      return cliInputs.result;
    }

    const args = ["run", flowPath, "--repo", repoPath];
    for (const cliInput of cliInputs.inputs) {
      args.push("--input", cliInput);
    }

    const runStartObserver = createRunStartObserver(input.onRunStarted);
    const result = await this.#runCommand({
      command: this.#command,
      args,
      cwd: repoPath,
      env: {
        ...this.#env,
        NITELY_RUNNER_ID: input.identity.runnerId,
        NITELY_RUNNER_TASK_ID: input.assignment.taskId,
        ...(input.assignment.sourceRevision
          ? { NITELY_RUNNER_SOURCE_REVISION: input.assignment.sourceRevision }
          : {}),
      },
      ...(input.signal ? { signal: input.signal } : {}),
      onStdout: runStartObserver.observe,
    });
    await runStartObserver.flush();

    const runId = parseRunId(result.stdout) ?? runStartObserver.runId();
    if (result.cancelled || input.signal?.aborted) {
      return {
        status: "cancelled",
        ...(runId ? { runId } : {}),
        safeMessage: "cancelled by control-plane request",
      };
    }
    if (result.exitCode !== 0) {
      return {
        status: "failed",
        failureCategory: "nitely_cli_failed",
        safeMessage: safeCommandFailure(result),
      };
    }

    if (!runId) {
      return {
        status: "failed",
        failureCategory: "missing_run_id",
        safeMessage: "nitely CLI completed without printing a run id",
      };
    }

    const changeRequestUrl = parseChangeRequestUrl(result.stdout);
    return {
      status: "succeeded",
      runId,
      ...(changeRequestUrl ? { changeRequestUrl } : {}),
      evidenceSummary: {
        sourceRevision: input.assignment.sourceRevision,
        flowId: input.assignment.flowId,
        flowPath,
      },
    };
  }

  #resolveFlowPath(assignment: RunnerAssignmentPayload): string {
    return assignment.flowPath ?? this.#flowPaths[assignment.flowId] ?? assignment.flowId;
  }
}

function buildCliInputs(inputs: Record<string, unknown>):
  | { status: "ok"; inputs: string[] }
  | { status: "failed"; result: RunnerExecutionResult } {
  const cliInputs: string[] = [];
  for (const [name, value] of Object.entries(inputs)) {
    const path = localInputPath(value);
    if (!path) {
      return {
        status: "failed",
        result: {
          status: "failed",
          failureCategory: "unsupported_assignment_input",
          safeMessage: `assignment input ${name} is not a local-file path`,
        },
      };
    }
    cliInputs.push(`${name}=${path}`);
  }
  return { status: "ok", inputs: cliInputs };
}

function localInputPath(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.path === "string" && record.path.length > 0) {
    return record.path;
  }
  if (typeof record.uri === "string" && record.uri.length > 0) {
    return record.uri;
  }
  return undefined;
}

function parseRunId(stdout: string): string | undefined {
  return parseObservedRunId(stdout);
}

function parseChangeRequestUrl(stdout: string): string | undefined {
  return stdout.match(/^Change request:\s+(\S+)$/m)?.[1];
}

function safeCommandFailure(result: NitelyCommandResult): string {
  const text = [result.stderr, result.stdout]
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (text ?? `nitely CLI exited with ${result.exitCode}`).slice(0, 500);
}

async function defaultCommandRunner(
  invocation: NitelyCommandInvocation,
): Promise<NitelyCommandResult> {
  return await new Promise((resolve, reject) => {
    if (invocation.signal?.aborted) {
      resolve({ exitCode: 130, stdout: "", stderr: "", cancelled: true });
      return;
    }
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    let closed = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const callbackPromises: Promise<void>[] = [];
    const enqueueCallback = (callback: Promise<void> | void): void => {
      if (callback instanceof Promise) {
        callbackPromises.push(callback);
      }
    };
    const abort = (): void => {
      cancelled = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!closed) {
          child.kill("SIGKILL");
        }
      }, 5_000);
      forceKillTimer.unref();
    };
    invocation.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      enqueueCallback(invocation.onStdout?.(chunk));
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      enqueueCallback(invocation.onStderr?.(chunk));
    });
    child.on("error", reject);
    child.on("close", async (code) => {
      closed = true;
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      invocation.signal?.removeEventListener("abort", abort);
      await Promise.all(callbackPromises);
      resolve({ exitCode: cancelled ? 130 : code ?? 1, stdout, stderr, cancelled });
    });
  });
}

function createRunStartObserver(
  onRunStarted: ((runId: string) => Promise<void> | void) | undefined,
): {
  observe: (chunk: string) => Promise<void>;
  flush: () => Promise<void>;
  runId: () => string | undefined;
} {
  let stdout = "";
  let observedRunId: string | undefined;
  const callbacks: Promise<void>[] = [];
  const reportRunId = (runId: string): void => {
    if (observedRunId) {
      return;
    }
    observedRunId = runId;
    const callback = onRunStarted?.(runId);
    if (callback instanceof Promise) {
      callbacks.push(callback);
    }
  };
  return {
    observe: async (chunk: string) => {
      stdout += chunk;
      const runId = parseObservedRunId(stdout);
      if (runId) {
        reportRunId(runId);
      }
    },
    flush: async () => {
      const runId = parseObservedRunId(stdout);
      if (runId) {
        reportRunId(runId);
      }
      await Promise.all(callbacks);
    },
    runId: () => observedRunId,
  };
}

function parseObservedRunId(stdout: string): string | undefined {
  return (
    stdout.match(/^RUN\s+(\S+)\s+(?:created|started|running|completed)$/m)?.[1] ??
    stdout.match(/^Run ID:\s+(\S+)$/im)?.[1]
  );
}

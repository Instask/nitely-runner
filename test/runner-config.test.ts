import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  RUNNER_CONTROL_PLANE_SCHEMA_VERSION,
  type RunnerAssignmentEvent,
  type RunnerIdentity,
} from "../src/assignment-runner.js";
import { readFileRunnerControlPlaneState } from "../src/file-control-plane.js";
import {
  loadRunnerConfig,
  parseRunnerConfig,
  runConfiguredAssignmentCycle,
  runConfiguredRunnerLoop,
  runConfiguredRunnerOnce,
} from "../src/runner-config.js";
import type { RunnerFetch } from "../src/http-control-plane.js";
import { readFileRunnerLocalState } from "../src/local-state.js";
import type { NitelyCommandInvocation } from "../src/local-nitely-executor.js";

const fixedNow = () => new Date("2026-07-25T01:02:03.000Z");
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const identity: RunnerIdentity = {
  tenantId: "tenant-1",
  runnerId: "runner-1",
  policyVersion: "policy-1",
  allowedRepositories: ["repo-1"],
  version: "0.1.0",
};

describe("runner config", () => {
  it("loads config and runs one file-backed assignment cycle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nitely-runner-config-"));
    const repoPath = join(dir, "repo");
    const statePath = join(dir, "state", "control-plane.json");
    const runnerStatePath = join(dir, "state", "runner-state.json");
    const configPath = join(dir, "runner.json");
    await mkdir(repoPath, { recursive: true });
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(statePath, JSON.stringify(fileState(), null, 2), "utf8");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          identity,
          controlPlane: { type: "file", path: "state/control-plane.json" },
          runnerStatePath: "state/runner-state.json",
          nitelyCommand: "nitely",
          repositoryPaths: { "repo-1": "repo" },
          flowPaths: { "flow-1": "flows/implement.json" },
          env: { PATH: "/bin" },
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = await loadRunnerConfig(configPath);
    const calls: NitelyCommandInvocation[] = [];
    const result = await runConfiguredAssignmentCycle({
      config,
      now: fixedNow,
      createId: (kind) => `configured-${kind}`,
      runCommand: async (invocation) => {
        calls.push(invocation);
        return {
          exitCode: 0,
          stdout:
            "RUN run-configured completed\nChange request: https://github.com/Instask/example/pull/2\n",
          stderr: "",
        };
      },
    });

    expect(result.status).toBe("handled");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "nitely",
      cwd: repoPath,
      args: [
        "run",
        "flows/implement.json",
        "--repo",
        repoPath,
        "--input",
        "spec=docs/spec.md",
      ],
      env: {
        PATH: "/bin",
        NITELY_RUNNER_ID: "runner-1",
        NITELY_RUNNER_TASK_ID: "task-1",
        NITELY_RUNNER_SOURCE_REVISION: "abc123",
      },
    });

    const state = await readFileRunnerControlPlaneState(statePath);
    expect(state.assignments["tenant-1:task-1"]).toMatchObject({
      status: "completed",
      latestRunId: "run-configured",
      changeRequestUrl: "https://github.com/Instask/example/pull/2",
      flowPath: "flows/implement.json",
    });
    expect(state.runnerEvents.map((event) => event.kind)).toEqual([
      "task.accepted",
      "run.preparing",
      "run.started",
      "run.completed",
    ]);
    const runnerState = await readFileRunnerLocalState(runnerStatePath);
    expect(runnerState.assignments["task-1"]).toMatchObject({
      taskId: "task-1",
      status: "succeeded",
      runId: "run-configured",
      lastSequence: 4,
    });
  });

  it("runs one HTTP-backed assignment cycle from config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nitely-runner-http-config-"));
    const repoPath = join(dir, "repo");
    await mkdir(repoPath, { recursive: true });
    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const commandCalls: NitelyCommandInvocation[] = [];
    const config = parseRunnerConfig(
      {
        identity,
        controlPlane: {
          type: "http",
          baseUrl: "https://control.example/api",
          runnerToken: "runner-token",
          headers: { "x-runner-region": "local" },
        },
        repositoryPaths: { "repo-1": repoPath },
      },
      dir,
    );

    const result = await runConfiguredAssignmentCycle({
      config,
      now: fixedNow,
      createId: (kind) => `http-${kind}`,
      fetch: fakeFetch(fetchCalls),
      runCommand: async (invocation) => {
        commandCalls.push(invocation);
        return { exitCode: 0, stdout: "RUN run-http completed\n", stderr: "" };
      },
    });

    expect(result.status).toBe("handled");
    expect(commandCalls).toHaveLength(1);
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://control.example/api/runner/assignments?tenantId=tenant-1&runnerId=runner-1",
      "https://control.example/api/runner/events",
      "https://control.example/api/runner/events",
    ]);
    expect(fetchCalls[0]?.init).toMatchObject({
      headers: {
        authorization: "Bearer runner-token",
        "x-runner-region": "local",
      },
    });
    expect(JSON.parse(String(fetchCalls[1]?.init?.body)).events).toHaveLength(2);
    expect(JSON.parse(String(fetchCalls[2]?.init?.body)).events).toHaveLength(2);
  });

  it("reports heartbeat around one HTTP-backed runner cycle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nitely-runner-http-once-"));
    const repoPath = join(dir, "repo");
    await mkdir(repoPath, { recursive: true });
    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const config = parseRunnerConfig(
      {
        identity,
        controlPlane: {
          type: "http",
          baseUrl: "https://control.example/api",
        },
        repositoryPaths: { "repo-1": repoPath },
      },
      dir,
    );

    const result = await runConfiguredRunnerOnce({
      config,
      now: fixedNow,
      createId: (kind) => `http-once-${kind}`,
      fetch: fakeFetch(fetchCalls),
      runCommand: async () => ({
        exitCode: 0,
        stdout: "RUN run-http-once completed\n",
        stderr: "",
      }),
    });

    expect(result.cycle.status).toBe("handled");
    expect(result.heartbeatReports).toHaveLength(2);
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://control.example/api/runner/events",
      "https://control.example/api/runner/assignments?tenantId=tenant-1&runnerId=runner-1",
      "https://control.example/api/runner/events",
      "https://control.example/api/runner/events",
      "https://control.example/api/runner/events",
    ]);
    expect(JSON.parse(String(fetchCalls[0]?.init?.body)).events).toMatchObject([
      { kind: "runner.heartbeat", payload: { status: "idle" } },
    ]);
    expect(JSON.parse(String(fetchCalls[2]?.init?.body)).events).toHaveLength(2);
    expect(JSON.parse(String(fetchCalls[3]?.init?.body)).events).toHaveLength(2);
    expect(JSON.parse(String(fetchCalls[4]?.init?.body)).events).toMatchObject([
      { kind: "runner.heartbeat", payload: { status: "idle" } },
    ]);
  });

  it("runs a bounded file-backed runner loop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nitely-runner-loop-config-"));
    const repoPath = join(dir, "repo");
    const statePath = join(dir, "state", "control-plane.json");
    await mkdir(repoPath, { recursive: true });
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(statePath, JSON.stringify(fileState(), null, 2), "utf8");
    const config = parseRunnerConfig(
      {
        identity,
        controlPlane: { type: "file", path: statePath },
        repositoryPaths: { "repo-1": repoPath },
        flowPaths: { "flow-1": "flows/implement.json" },
      },
      dir,
    );
    const calls: NitelyCommandInvocation[] = [];

    const result = await runConfiguredRunnerLoop({
      config,
      maxCycles: 2,
      pollIntervalMs: 1,
      sleep: async () => {},
      now: fixedNow,
      createId: (kind) => `loop-${kind}`,
      runCommand: async (invocation) => {
        calls.push(invocation);
        return { exitCode: 0, stdout: "RUN run-loop completed\n", stderr: "" };
      },
    });

    expect(result.cycles.map((cycle) => cycle.cycle.status)).toEqual([
      "handled",
      "idle",
    ]);
    expect(calls).toHaveLength(1);
  });

  it("can continue a bounded runner loop after transient cycle errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nitely-runner-loop-retry-"));
    const repoPath = join(dir, "repo");
    await mkdir(repoPath, { recursive: true });
    const config = parseRunnerConfig(
      {
        identity,
        controlPlane: {
          type: "http",
          baseUrl: "https://control.example/api",
        },
        repositoryPaths: { "repo-1": repoPath },
        flowPaths: { "flow-1": "flows/implement.json" },
      },
      dir,
    );
    let fetchCount = 0;
    const cycleErrors: string[] = [];

    const result = await runConfiguredRunnerLoop({
      config,
      maxCycles: 2,
      pollIntervalMs: 1,
      continueOnError: true,
      sleep: async () => {},
      now: fixedNow,
      createId: (kind) => `retry-${kind}`,
      fetch: async (url, init) => {
        fetchCount += 1;
        if (fetchCount === 1) {
          throw new Error("control plane unavailable");
        }
        return fakeFetch([])(url, init);
      },
      onCycleError: (error) => {
        cycleErrors.push(error instanceof Error ? error.message : String(error));
      },
      runCommand: async () => ({
        exitCode: 0,
        stdout: "RUN run-loop-retry completed\n",
        stderr: "",
      }),
    });

    expect(result.attemptedCycles).toBe(2);
    expect(result.failures).toEqual([
      { cycleIndex: 1, safeMessage: "control plane unavailable" },
    ]);
    expect(result.cycles.map((cycle) => cycle.cycle.status)).toEqual(["handled"]);
    expect(cycleErrors).toEqual(["control plane unavailable"]);
  });

  it("rejects unsupported control-plane types", () => {
    expect(() =>
      parseRunnerConfig({
        identity,
        controlPlane: { type: "queue", path: "state.json" },
        repositoryPaths: { "repo-1": "/repo" },
      }),
    ).toThrow("controlPlane.type must be file or http");
  });

  it("rejects ambiguous runner token and authorization header config", () => {
    expect(() =>
      parseRunnerConfig({
        identity,
        controlPlane: {
          type: "http",
          baseUrl: "https://control.example/api",
          runnerToken: "runner-token",
          headers: { Authorization: "Bearer other-token" },
        },
        repositoryPaths: { "repo-1": "/repo" },
      }),
    ).toThrow(
      "controlPlane.runnerToken must not be combined with controlPlane.headers authorization",
    );
  });

  it("rejects unsupported identity protocol versions", () => {
    expect(() =>
      parseRunnerConfig({
        identity: { ...identity, protocolVersion: "runner-control-plane.v0" },
        controlPlane: { type: "http", baseUrl: "https://control.example/api" },
        repositoryPaths: { "repo-1": "/repo" },
      }),
    ).toThrow("identity.protocolVersion must be runner-control-plane.v1");
  });

  it("keeps the example HTTP config parseable", async () => {
    const config = await loadRunnerConfig(
      join(repoRoot, "examples", "http-runner.config.example.json"),
    );

    expect(config).toMatchObject({
      identity: {
        tenantId: "tenant-1",
        runnerId: "runner-1",
        protocolVersion: "runner-control-plane.v1",
      },
      controlPlane: {
        type: "http",
        baseUrl: "http://127.0.0.1:8787",
        runnerToken: "runner-dev-token",
      },
      repositoryPaths: {
        "repo-1": "/absolute/path/to/customer/repo",
      },
    });
  });
});

function fileState() {
  const assignedEvent = assignmentEvent();
  return {
    version: 1,
    runners: {
      "tenant-1:runner-1": {
        tenantId: identity.tenantId,
        runnerId: identity.runnerId,
        policy: {
          tenantId: identity.tenantId,
          runnerId: identity.runnerId,
          policyVersion: identity.policyVersion,
          allowedRepositories: identity.allowedRepositories,
        },
        activeRunIds: [],
        createdAt: "2026-07-25T01:00:00.000Z",
        updatedAt: "2026-07-25T01:00:00.000Z",
      },
    },
    assignments: {
      "tenant-1:task-1": {
        tenantId: identity.tenantId,
        runnerId: identity.runnerId,
        taskId: "task-1",
        repoId: "repo-1",
        repository: { repoId: "repo-1", name: "Instask/example" },
        sourceRevision: "abc123",
        flowId: "flow-1",
        flowPath: "flows/implement.json",
        inputs: { spec: "docs/spec.md" },
        policyVersion: identity.policyVersion,
        status: "assigned",
        assignedEvent,
        createdAt: assignedEvent.createdAt,
        updatedAt: assignedEvent.createdAt,
      },
    },
    controlPlaneEvents: [],
    runnerEvents: [],
  };
}

function assignmentEvent(): RunnerAssignmentEvent {
  return {
    eventId: "assigned-1",
    schemaVersion: RUNNER_CONTROL_PLANE_SCHEMA_VERSION,
    tenantId: identity.tenantId,
    runnerId: identity.runnerId,
    taskId: "task-1",
    sequence: 0,
    createdAt: "2026-07-25T01:00:00.000Z",
    kind: "task.assigned",
    redactionStatus: "metadata_only",
    policyVersion: identity.policyVersion,
    payload: {
      taskId: "task-1",
      repoId: "repo-1",
      repository: { repoId: "repo-1", name: "Instask/example" },
      sourceRevision: "abc123",
      flowId: "flow-1",
      flowPath: "flows/implement.json",
      inputs: { spec: "docs/spec.md" },
      policyVersion: identity.policyVersion,
    },
  };
}

function fakeFetch(
  calls: Array<{ url: string; init: RequestInit | undefined }>,
): RunnerFetch {
  return async (url, init) => {
    calls.push({ url: url.toString(), init });
    if (init?.method === "GET") {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ assignments: [assignmentEvent()] }),
      };
    }
    return {
      ok: true,
      status: 202,
      statusText: "Accepted",
      json: async () => ({
        acceptedEventIds: [
          "http-task.accepted",
          "http-run.preparing",
          "http-run.started",
          "http-run.completed",
        ],
        duplicateEventIds: [],
        rejectedEvents: [],
      }),
    };
  };
}

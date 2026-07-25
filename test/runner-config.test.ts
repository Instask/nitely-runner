import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
} from "../src/runner-config.js";
import type { RunnerFetch } from "../src/http-control-plane.js";
import type { NitelyCommandInvocation } from "../src/local-nitely-executor.js";

const fixedNow = () => new Date("2026-07-25T01:02:03.000Z");

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
          headers: { authorization: "Bearer runner-token" },
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
    ]);
    expect(fetchCalls[0]?.init).toMatchObject({
      headers: { authorization: "Bearer runner-token" },
    });
    expect(JSON.parse(String(fetchCalls[1]?.init?.body)).events).toHaveLength(4);
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

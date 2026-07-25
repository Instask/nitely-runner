import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RUNNER_CONTROL_PLANE_SCHEMA_VERSION,
  type RunnerAssignmentEvent,
  type RunnerIdentity,
} from "../src/assignment-runner.js";
import { runRunnerCli } from "../src/cli.js";
import {
  readFileRunnerControlPlaneState,
  writeFileRunnerControlPlaneState,
  type FileRunnerControlPlaneState,
} from "../src/file-control-plane.js";
import type { NitelyCommandInvocation } from "../src/local-nitely-executor.js";

const fixedNow = () => new Date("2026-07-25T01:02:03.000Z");

const identity: RunnerIdentity = {
  tenantId: "tenant-1",
  runnerId: "runner-1",
  policyVersion: "policy-1",
  allowedRepositories: ["repo-1"],
  version: "0.1.0",
};

describe("runner CLI", () => {
  it("runs one configured assignment cycle", async () => {
    const { configPath, repoPath, statePath } = await fixture();
    const stdout = textWriter();
    const stderr = textWriter();
    const calls: NitelyCommandInvocation[] = [];

    const code = await runRunnerCli(["run-once", "--config", configPath], {
      stdout,
      stderr,
      now: fixedNow,
      createId: (kind) => `cli-${kind}`,
      runCommand: async (invocation) => {
        calls.push(invocation);
        return { exitCode: 0, stdout: "RUN run-cli completed\n", stderr: "" };
      },
    });

    expect(code).toBe(0);
    expect(stdout.text).toContain(
      "runner cycle handled task=task-1 status=succeeded events=4 rejected=0",
    );
    expect(stdout.text).toContain("runner cycle run=run-cli");
    expect(stderr.text).toBe("");
    expect(calls[0]).toMatchObject({
      cwd: repoPath,
      args: ["run", "flows/implement.json", "--repo", repoPath],
    });
    const state = await readFileRunnerControlPlaneState(statePath);
    expect(state.runnerEvents.map((event) => event.kind)).toEqual([
      "runner.heartbeat",
      "task.accepted",
      "run.preparing",
      "run.started",
      "run.completed",
      "runner.heartbeat",
    ]);
  });

  it("returns usage errors without running a cycle", async () => {
    const stdout = textWriter();
    const stderr = textWriter();

    const code = await runRunnerCli(["run-once"], { stdout, stderr });

    expect(code).toBe(2);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("missing required --config <path>");
  });
});

async function fixture(): Promise<{
  configPath: string;
  repoPath: string;
  statePath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "nitely-runner-cli-"));
  const repoPath = join(dir, "repo");
  const statePath = join(dir, "state", "control-plane.json");
  const configPath = join(dir, "runner.json");
  await mkdir(repoPath, { recursive: true });
  await writeFileRunnerControlPlaneState(statePath, fileState());
  await writeFile(
    configPath,
    JSON.stringify(
      {
        identity,
        controlPlane: { type: "file", path: "state/control-plane.json" },
        repositoryPaths: { "repo-1": "repo" },
        flowPaths: { "flow-1": "flows/implement.json" },
      },
      null,
      2,
    ),
    "utf8",
  );
  return { configPath, repoPath, statePath };
}

function fileState(): FileRunnerControlPlaneState {
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
        sourceRevision: "abc123",
        flowId: "flow-1",
        flowPath: "flows/implement.json",
        inputs: {},
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
      sourceRevision: "abc123",
      flowId: "flow-1",
      flowPath: "flows/implement.json",
      inputs: {},
      policyVersion: identity.policyVersion,
    },
  };
}

function textWriter(): { text: string; write(chunk: string): void } {
  return {
    text: "",
    write(chunk: string) {
      this.text += chunk;
    },
  };
}

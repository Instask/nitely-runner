import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RUNNER_CONTROL_PLANE_SCHEMA_VERSION,
  type RunnerIdentity,
  type RunnerOutboundEvent,
} from "../src/assignment-runner.js";
import {
  FileRunnerControlPlaneClient,
  readFileRunnerControlPlaneState,
  writeFileRunnerControlPlaneState,
  type FileRunnerControlPlaneState,
} from "../src/file-control-plane.js";

const identity: RunnerIdentity = {
  tenantId: "tenant-1",
  runnerId: "runner-1",
  policyVersion: "policy-1",
  allowedRepositories: ["repo-1"],
  version: "0.1.0",
};

describe("FileRunnerControlPlaneClient", () => {
  it("registers runner identity in file state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nitely-file-control-plane-register-"));
    const path = join(dir, "control-plane.json");
    const client = new FileRunnerControlPlaneClient({ path });

    await expect(client.registerRunner(identity)).resolves.toMatchObject({
      runner: {
        tenantId: "tenant-1",
        runnerId: "runner-1",
        policy: {
          tenantId: "tenant-1",
          runnerId: "runner-1",
          policyVersion: "policy-1",
          allowedRepositories: ["repo-1"],
        },
        status: "registered",
        version: "0.1.0",
        activeRunIds: [],
      },
    });
    await expect(readFileRunnerControlPlaneState(path)).resolves.toMatchObject({
      runners: {
        "tenant-1:runner-1": {
          status: "registered",
          version: "0.1.0",
        },
      },
      assignments: {},
      runnerEvents: [],
    });
  });

  it("polls assigned tasks and records runner events", async () => {
    const { path } = await fixture();
    const client = new FileRunnerControlPlaneClient({ path });

    await expect(client.pollAssignments(identity)).resolves.toMatchObject([
      {
        kind: "task.assigned",
        payload: {
          taskId: "task-1",
          repoId: "repo-1",
          flowPath: "flows/implement.json",
        },
      },
    ]);

    const accepted = runnerEvent("task.accepted", {
      eventId: "accepted-1",
      payload: {
        taskId: "task-1",
        repoId: "repo-1",
        flowId: "flow-1",
        flowPath: "flows/implement.json",
        policyVersion: "policy-1",
      },
    });
    const report = await client.reportEvents([accepted]);

    expect(report).toEqual({
      acceptedEventIds: ["accepted-1"],
      duplicateEventIds: [],
      rejectedEvents: [],
    });
    await expect(readFileRunnerControlPlaneState(path)).resolves.toMatchObject({
      assignments: {
        "tenant-1:task-1": { status: "accepted" },
      },
      runnerEvents: [{ eventId: "accepted-1" }],
    });
  });

  it("deduplicates identical event replays", async () => {
    const { path } = await fixture();
    const client = new FileRunnerControlPlaneClient({ path });
    const accepted = runnerEvent("task.accepted", {
      eventId: "accepted-1",
      payload: { taskId: "task-1", repoId: "repo-1", flowId: "flow-1" },
    });

    await client.reportEvents([accepted]);
    await expect(client.reportEvents([accepted])).resolves.toEqual({
      acceptedEventIds: ["accepted-1"],
      duplicateEventIds: ["accepted-1"],
      rejectedEvents: [],
    });
  });

  it("rejects raw payload keys for metadata-only events", async () => {
    const { path } = await fixture();
    const client = new FileRunnerControlPlaneClient({ path });
    const unsafe = runnerEvent("run.failed", {
      eventId: "failed-1",
      runId: "run-1",
      payload: {
        taskId: "task-1",
        runId: "run-1",
        failureCategory: "executor_error",
        stdout: "secret output",
      },
    });

    await expect(client.reportEvents([unsafe])).resolves.toMatchObject({
      acceptedEventIds: [],
      rejectedEvents: [
        {
          eventId: "failed-1",
          reason:
            "metadata-only runner event contains disallowed raw fields: payload.stdout",
        },
      ],
    });
  });
});

async function fixture(): Promise<{ path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "nitely-file-control-plane-"));
  const path = join(dir, "control-plane.json");
  await writeFileRunnerControlPlaneState(path, state());
  return { path };
}

function state(): FileRunnerControlPlaneState {
  const assignedEvent = {
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
      inputs: { spec: "docs/spec.md" },
      policyVersion: identity.policyVersion,
    },
  } as const;
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

function runnerEvent(
  kind: RunnerOutboundEvent["kind"],
  input: {
    eventId: string;
    runId?: string;
    payload: Record<string, unknown>;
  },
): RunnerOutboundEvent {
  return {
    eventId: input.eventId,
    schemaVersion: RUNNER_CONTROL_PLANE_SCHEMA_VERSION,
    tenantId: identity.tenantId,
    runnerId: identity.runnerId,
    taskId: "task-1",
    ...(input.runId ? { runId: input.runId } : {}),
    sequence: 1,
    createdAt: "2026-07-25T01:02:03.000Z",
    kind,
    payload: input.payload,
    redactionStatus: "metadata_only",
    policyVersion: identity.policyVersion,
  };
}

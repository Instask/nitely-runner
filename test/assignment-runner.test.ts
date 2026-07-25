import { describe, expect, it } from "vitest";

import {
  RUNNER_CONTROL_PLANE_SCHEMA_VERSION,
  runOneAssignmentCycle,
  type RunnerAssignmentEvent,
  type RunnerControlPlaneClient,
  type RunnerIdentity,
  type RunnerInboundEvent,
  type RunnerOutboundEvent,
} from "../src/assignment-runner.js";
import { LocalNitelyCliExecutor } from "../src/local-nitely-executor.js";
import { MemoryRunnerControlPlaneClient } from "../src/memory-control-plane.js";

const fixedNow = () => new Date("2026-07-25T01:02:03.000Z");

const identity: RunnerIdentity = {
  tenantId: "tenant-1",
  runnerId: "runner-1",
  policyVersion: "policy-1",
  allowedRepositories: ["repo-1"],
  version: "0.1.0",
};

function assignment(
  input: Partial<RunnerAssignmentEvent["payload"]> = {},
): RunnerAssignmentEvent {
  return {
    eventId: "assigned-1",
    schemaVersion: RUNNER_CONTROL_PLANE_SCHEMA_VERSION,
    tenantId: identity.tenantId,
    runnerId: identity.runnerId,
    taskId: input.taskId ?? "task-1",
    sequence: 0,
    createdAt: "2026-07-25T01:00:00.000Z",
    kind: "task.assigned",
    redactionStatus: "metadata_only",
    policyVersion: input.policyVersion ?? identity.policyVersion,
    payload: {
      taskId: input.taskId ?? "task-1",
      repoId: input.repoId ?? "repo-1",
      repository: input.repository ?? {
        repoId: input.repoId ?? "repo-1",
        name: "Instask/example",
        cloneUrl: "https://github.com/Instask/example.git",
      },
      sourceRevision: input.sourceRevision ?? "abc123",
      flowId: input.flowId ?? "flow-1",
      flowPath: input.flowPath ?? "flows/flow-1.json",
      policyVersion: input.policyVersion ?? identity.policyVersion,
      inputs: input.inputs ?? { spec: "docs/spec.md" },
    },
  };
}

function fakeClient(assignments: RunnerAssignmentEvent[]): {
  client: RunnerControlPlaneClient;
  reports: RunnerOutboundEvent[][];
} {
  const reports: RunnerOutboundEvent[][] = [];
  return {
    reports,
    client: {
      pollAssignments: async () => assignments,
      pollControlPlaneEvents: async () => [],
      reportEvents: async (events) => {
        reports.push(events);
        return {
          acceptedEventIds: events.map((event) => event.eventId),
          duplicateEventIds: [],
          rejectedEvents: [],
        };
      },
    },
  };
}

describe("runOneAssignmentCycle", () => {
  it("returns idle when no assignment is available", async () => {
    const { client, reports } = fakeClient([]);

    const result = await runOneAssignmentCycle({
      identity,
      client,
      executor: {
        execute: async () => {
          throw new Error("executor should not run");
        },
      },
    });

    expect(result).toEqual({ status: "idle", reportedEvents: [] });
    expect(reports).toEqual([]);
  });

  it("accepts and completes one assignment", async () => {
    const { client, reports } = fakeClient([assignment()]);

    const result = await runOneAssignmentCycle({
      identity,
      client,
      now: fixedNow,
      createId: (kind) => `event-${kind}`,
      executor: {
        execute: async ({ assignment: task }) => ({
          status: "succeeded",
          runId: `run-${task.taskId}`,
          changeRequestUrl: "https://github.com/Instask/example/pull/1",
          evidenceSummary: { artifacts: 2 },
          evidenceArtifacts: [
            {
              artifactId: "artifact-1",
              kind: "test-summary",
              name: "unit test summary",
              uri: "nitely://runs/run-task-1/artifacts/unit-test-summary",
            },
          ],
        }),
      },
    });

    expect(result.status).toBe("handled");
    if (result.status !== "handled") {
      throw new Error("expected handled result");
    }
    expect(result.projection).toMatchObject({
      taskId: "task-1",
      status: "succeeded",
      runId: "run-task-1",
      lastSequence: 5,
    });
    expect(result.reportedEvents.map((event) => event.kind)).toEqual([
      "task.accepted",
      "run.preparing",
      "run.started",
      "evidence.reported",
      "run.completed",
    ]);
    expect(result.reportedEvents.every((event) => event.redactionStatus === "metadata_only"))
      .toBe(true);
    expect(result.reportedEvents[0]?.payload).toMatchObject({
      sourceRevision: "abc123",
      flowPath: "flows/flow-1.json",
    });
    expect(result.reportedEvents[1]?.payload).toMatchObject({
      flowPath: "flows/flow-1.json",
    });
    expect(result.reportedEvents[2]?.payload).toMatchObject({
      flowPath: "flows/flow-1.json",
    });
    expect(result.reportedEvents[3]).toMatchObject({
      kind: "evidence.reported",
      runId: "run-task-1",
      payload: {
        runId: "run-task-1",
        artifacts: [
          {
            artifactId: "artifact-1",
            kind: "test-summary",
          },
        ],
      },
    });
    expect(reports).toHaveLength(2);
  });

  it("runs against the reusable in-memory control-plane client", async () => {
    const client = new MemoryRunnerControlPlaneClient([assignment()]);

    const result = await runOneAssignmentCycle({
      identity,
      client,
      now: fixedNow,
      createId: (kind) => `memory-${kind}`,
      executor: {
        execute: async () => ({
          status: "succeeded",
          runId: "run-memory",
        }),
      },
    });

    expect(result.status).toBe("handled");
    expect(client.listAssignments()).toEqual([]);
    expect(client.listEvents().map((event) => event.kind)).toEqual([
      "task.accepted",
      "run.preparing",
      "run.started",
      "run.completed",
    ]);
  });

  it("rejects assignment metadata with credentials or runner-local paths before execution", async () => {
    const cases: Array<{
      name: string;
      assignment: RunnerAssignmentEvent;
      expectedPath: string;
    }> = [
      {
        name: "credentialed clone URL",
        assignment: assignment({
          repository: {
            repoId: "repo-1",
            cloneUrl:
              "https://x-access-token:runner-secret@github.com/Instask/example.git",
          },
        }),
        expectedPath: "assignment.repository.cloneUrl",
      },
      {
        name: "authorization input",
        assignment: assignment({
          inputs: { authorization: "Bearer runner-secret" },
        }),
        expectedPath: "assignment.inputs.authorization",
      },
      {
        name: "runner-local checkout path",
        assignment: {
          ...assignment(),
          payload: {
            ...assignment().payload,
            localCheckoutPath: "/tmp/customer/repo",
          },
        },
        expectedPath: "assignment.localCheckoutPath",
      },
    ];

    for (const testCase of cases) {
      const { client, reports } = fakeClient([testCase.assignment]);

      const result = await runOneAssignmentCycle({
        identity,
        client,
        now: fixedNow,
        createId: (kind) => `${testCase.name}-${kind}`,
        executor: {
          execute: async () => {
            throw new Error("executor should not run");
          },
        },
      });

      expect(result.status).toBe("handled");
      if (result.status !== "handled") {
        throw new Error("expected handled result");
      }
      expect(result.reportedEvents).toHaveLength(1);
      expect(result.reportedEvents[0]).toMatchObject({
        kind: "task.rejected",
        payload: {
          reason: "assignment_metadata_boundary",
          safeMessage: expect.stringContaining(testCase.expectedPath),
        },
      });
      expect(JSON.stringify(result.reportedEvents[0])).not.toContain(
        "runner-secret",
      );
      expect(reports).toHaveLength(1);
    }
  });

  it("aborts an active assignment when a cancellation request is polled", async () => {
    const client = new MemoryRunnerControlPlaneClient([assignment()]);
    let observedSignal: AbortSignal | undefined;

    const result = await runOneAssignmentCycle({
      identity,
      client,
      now: fixedNow,
      createId: (kind) => `cancel-${kind}`,
      cancellationPollIntervalMs: 1,
      sleep: async () => {},
      executor: {
        execute: async ({ signal, onRunStarted }) => {
          observedSignal = signal;
          await onRunStarted?.("run-cancel");
          client.enqueueControlPlaneEvent(
            cancellationRequest({
              sequence: 4,
              runId: "run-cancel",
            }),
          );
          await waitForAbort(signal);
          return {
            status: "cancelled",
            runId: "run-cancel",
            safeMessage: "cancelled after operator request",
          };
        },
      },
    });

    expect(observedSignal?.aborted).toBe(true);
    expect(result.status).toBe("handled");
    if (result.status !== "handled") {
      throw new Error("expected handled result");
    }
    expect(result.projection).toMatchObject({
      status: "cancelled",
      runId: "run-cancel",
      lastSequence: 5,
    });
    expect(result.reportedEvents.map((event) => event.kind)).toEqual([
      "task.accepted",
      "run.preparing",
      "run.started",
      "run.cancelled",
    ]);
    expect(result.report.acceptedEventIds).toEqual([
      "cancel-task.accepted",
      "cancel-run.preparing",
      "cancel-run.started",
      "cancel-run.cancelled",
    ]);
  });

  it("rehearses one assignment through the local Nitely CLI executor", async () => {
    const client = new MemoryRunnerControlPlaneClient([assignment()]);
    const executor = new LocalNitelyCliExecutor({
      command: "nitely",
      repositoryPaths: { "repo-1": "/work/repo" },
      runCommand: async () => ({
        exitCode: 0,
        stdout:
          "RUN run-cli completed\nBranch: nitely/run-cli\nWorktree: /work/repo/.nitely/runs/run-cli/worktree\n",
        stderr: "",
      }),
    });

    const result = await runOneAssignmentCycle({
      identity,
      client,
      executor,
      now: fixedNow,
      createId: (kind) => `cli-${kind}`,
    });

    expect(result.status).toBe("handled");
    if (result.status !== "handled") {
      throw new Error("expected handled result");
    }
    expect(result.projection).toMatchObject({
      status: "succeeded",
      runId: "run-cli",
    });
    expect(client.listEvents().map((event) => event.kind)).toEqual([
      "task.accepted",
      "run.preparing",
      "run.started",
      "run.completed",
    ]);
    expect(client.listEvents().at(-1)?.payload).toMatchObject({
      runId: "run-cli",
    });
  });

  it("rejects assignments outside repository scope without executing", async () => {
    const { client } = fakeClient([assignment({ repoId: "repo-2" })]);
    let executorCalls = 0;

    const result = await runOneAssignmentCycle({
      identity,
      client,
      now: fixedNow,
      createId: (kind) => `event-${kind}`,
      executor: {
        execute: async () => {
          executorCalls += 1;
          return { status: "succeeded", runId: "run-1" };
        },
      },
    });

    expect(executorCalls).toBe(0);
    expect(result.status).toBe("handled");
    if (result.status !== "handled") {
      throw new Error("expected handled result");
    }
    expect(result.projection.status).toBe("rejected");
    expect(result.reportedEvents).toHaveLength(1);
    expect(result.reportedEvents[0]).toMatchObject({
      kind: "task.rejected",
      payload: { reason: "repository_not_allowed" },
    });
  });

  it("reports blocked execution as safe metadata", async () => {
    const { client } = fakeClient([assignment()]);

    const result = await runOneAssignmentCycle({
      identity,
      client,
      now: fixedNow,
      createId: (kind) => `event-${kind}`,
      executor: {
        execute: async () => ({
          status: "blocked",
          runId: "run-1",
          stageId: "implement",
          blockerCategory: "agent_usage_limit",
          safeMessage: "provider usage limit; retry later",
        }),
      },
    });

    expect(result.status).toBe("handled");
    if (result.status !== "handled") {
      throw new Error("expected handled result");
    }
    expect(result.projection.status).toBe("blocked");
    expect(result.reportedEvents.at(-1)).toMatchObject({
      kind: "run.blocked",
      redactionStatus: "metadata_only",
      payload: {
        blockerCategory: "agent_usage_limit",
        safeMessage: "provider usage limit; retry later",
      },
    });
  });

  it("turns executor exceptions into failed terminal events", async () => {
    const { client } = fakeClient([assignment()]);

    const result = await runOneAssignmentCycle({
      identity,
      client,
      now: fixedNow,
      createId: (kind) => `event-${kind}`,
      executor: {
        execute: async () => {
          throw new Error("command failed without raw logs\nTOKEN=secret");
        },
      },
    });

    expect(result.status).toBe("handled");
    if (result.status !== "handled") {
      throw new Error("expected handled result");
    }
    expect(result.projection.status).toBe("failed");
    expect(result.reportedEvents.at(-1)).toMatchObject({
      kind: "run.failed",
      payload: {
        failureCategory: "executor_error",
        safeMessage: "command failed without raw logs",
      },
    });
  });
});

function cancellationRequest(input: {
  runId: string;
  sequence: number;
}): RunnerInboundEvent {
  return {
    eventId: "cancel-request-1",
    schemaVersion: RUNNER_CONTROL_PLANE_SCHEMA_VERSION,
    tenantId: identity.tenantId,
    runnerId: identity.runnerId,
    taskId: "task-1",
    runId: input.runId,
    sequence: input.sequence,
    createdAt: "2026-07-25T01:02:04.000Z",
    kind: "task.cancel_requested",
    payload: {
      taskId: "task-1",
      runId: input.runId,
      reason: "operator_requested",
      safeMessage: "cancelled after operator request",
    },
    redactionStatus: "metadata_only",
    policyVersion: identity.policyVersion,
  };
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

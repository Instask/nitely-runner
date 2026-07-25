import { describe, expect, it } from "vitest";

import {
  applyRunnerLifecycleEvent,
  createAssignmentProjection,
  isTerminalRunnerStatus,
  projectRunnerAssignment,
  type RunnerLifecycleEvent,
} from "../src/lifecycle.js";

function event(
  kind: RunnerLifecycleEvent["kind"],
  input: Partial<RunnerLifecycleEvent> = {},
): RunnerLifecycleEvent {
  return {
    eventId: input.eventId ?? `${kind}-${input.sequence ?? 0}`,
    kind,
    taskId: input.taskId ?? "task-1",
    createdAt: input.createdAt ?? "2026-07-25T00:00:00.000Z",
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
    ...(input.payload ? { payload: input.payload } : {}),
  };
}

describe("runner lifecycle projection", () => {
  it("projects assignment acceptance through blocked resume and success", () => {
    const projection = projectRunnerAssignment([
      event("task.assigned", { sequence: 0 }),
      event("task.accepted", { sequence: 1 }),
      event("run.started", { runId: "run-1", sequence: 2 }),
      event("run.blocked", { runId: "run-1", sequence: 3 }),
      event("run.started", {
        eventId: "run-resumed",
        runId: "run-1",
        sequence: 4,
      }),
      event("run.completed", { runId: "run-1", sequence: 5 }),
    ]);

    expect(projection).toMatchObject({
      taskId: "task-1",
      status: "succeeded",
      runId: "run-1",
      lastSequence: 5,
    });
    expect(projection.history).toHaveLength(6);
    expect(isTerminalRunnerStatus(projection.status)).toBe(true);
  });

  it("projects cooperative cancellation", () => {
    const projection = projectRunnerAssignment([
      event("task.assigned", { sequence: 0 }),
      event("task.accepted", { sequence: 1 }),
      event("run.started", { runId: "run-1", sequence: 2 }),
      event("task.cancel_requested", { runId: "run-1", sequence: 3 }),
      event("run.cancelled", { runId: "run-1", sequence: 4 }),
    ]);

    expect(projection.status).toBe("cancelled");
    expect(projection.runId).toBe("run-1");
  });

  it("treats duplicate event ids as idempotent replay", () => {
    const assigned = event("task.assigned", { eventId: "assign", sequence: 0 });
    const accepted = event("task.accepted", { eventId: "accept", sequence: 1 });
    const projection = createAssignmentProjection(assigned);

    const once = applyRunnerLifecycleEvent(projection, accepted);
    const twice = applyRunnerLifecycleEvent(once, accepted);

    expect(twice).toBe(once);
    expect(twice.status).toBe("accepted");
    expect(twice.history).toHaveLength(2);
  });

  it("rejects sequence regressions", () => {
    expect(() =>
      projectRunnerAssignment([
        event("task.assigned", { sequence: 1 }),
        event("task.accepted", { sequence: 1 }),
      ]),
    ).toThrow(/greater than 1/);
  });

  it("rejects invalid transitions", () => {
    expect(() =>
      projectRunnerAssignment([
        event("task.assigned", { sequence: 0 }),
        event("run.completed", { runId: "run-1", sequence: 1 }),
      ]),
    ).toThrow(/cannot apply run.completed/);
  });

  it("rejects events after terminal status", () => {
    expect(() =>
      projectRunnerAssignment([
        event("task.assigned", { sequence: 0 }),
        event("task.rejected", { sequence: 1 }),
        event("task.accepted", { sequence: 2 }),
      ]),
    ).toThrow(/terminal status rejected/);
  });

  it("rejects events for the wrong task", () => {
    expect(() =>
      projectRunnerAssignment([
        event("task.assigned", { sequence: 0 }),
        event("task.accepted", { taskId: "task-2", sequence: 1 }),
      ]),
    ).toThrow(/expected task-1/);
  });
});

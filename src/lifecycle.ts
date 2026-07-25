export type RunnerAssignmentStatus =
  | "assigned"
  | "accepted"
  | "preparing"
  | "running"
  | "blocked"
  | "cancelling"
  | "cancelled"
  | "succeeded"
  | "failed"
  | "rejected";

export type RunnerLifecycleEventKind =
  | "task.assigned"
  | "task.accepted"
  | "task.rejected"
  | "task.cancel_requested"
  | "run.preparing"
  | "run.started"
  | "stage.updated"
  | "run.blocked"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";

export interface RunnerLifecycleEvent {
  eventId: string;
  kind: RunnerLifecycleEventKind;
  taskId: string;
  createdAt: string;
  runId?: string;
  sequence?: number;
  payload?: Record<string, unknown>;
}

export interface RunnerAssignmentProjection {
  taskId: string;
  status: RunnerAssignmentStatus;
  updatedAt: string;
  runId?: string;
  lastSequence?: number;
  appliedEventIds: string[];
  history: RunnerLifecycleEvent[];
}

export class RunnerLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerLifecycleError";
  }
}

export function isTerminalRunnerStatus(
  status: RunnerAssignmentStatus,
): boolean {
  return (
    status === "cancelled" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "rejected"
  );
}

export function createAssignmentProjection(
  event: RunnerLifecycleEvent,
): RunnerAssignmentProjection {
  if (event.kind !== "task.assigned") {
    throw new RunnerLifecycleError(
      `first runner lifecycle event must be task.assigned, got ${event.kind}`,
    );
  }
  validateSequence(undefined, event);
  return {
    taskId: event.taskId,
    status: "assigned",
    updatedAt: event.createdAt,
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.sequence !== undefined ? { lastSequence: event.sequence } : {}),
    appliedEventIds: [event.eventId],
    history: [event],
  };
}

export function applyRunnerLifecycleEvent(
  projection: RunnerAssignmentProjection,
  event: RunnerLifecycleEvent,
): RunnerAssignmentProjection {
  if (projection.appliedEventIds.includes(event.eventId)) {
    return projection;
  }
  if (event.taskId !== projection.taskId) {
    throw new RunnerLifecycleError(
      `event ${event.eventId} belongs to task ${event.taskId}, expected ${projection.taskId}`,
    );
  }
  validateSequence(projection.lastSequence, event);
  if (isTerminalRunnerStatus(projection.status)) {
    throw new RunnerLifecycleError(
      `cannot apply ${event.kind} after terminal status ${projection.status}`,
    );
  }

  const nextStatus = nextRunnerStatus(projection.status, event);
  return {
    ...projection,
    status: nextStatus,
    updatedAt: event.createdAt,
    runId: event.runId ?? projection.runId,
    ...(event.sequence !== undefined ? { lastSequence: event.sequence } : {}),
    appliedEventIds: [...projection.appliedEventIds, event.eventId],
    history: [...projection.history, event],
  };
}

export function projectRunnerAssignment(
  events: readonly RunnerLifecycleEvent[],
): RunnerAssignmentProjection {
  if (events.length === 0) {
    throw new RunnerLifecycleError("runner lifecycle requires at least one event");
  }
  let projection = createAssignmentProjection(events[0]!);
  for (const event of events.slice(1)) {
    projection = applyRunnerLifecycleEvent(projection, event);
  }
  return projection;
}

function nextRunnerStatus(
  current: RunnerAssignmentStatus,
  event: RunnerLifecycleEvent,
): RunnerAssignmentStatus {
  switch (event.kind) {
    case "task.assigned":
      throw new RunnerLifecycleError("task.assigned cannot be applied twice");
    case "task.accepted":
      return requireCurrent(event, current, ["assigned"], "accepted");
    case "task.rejected":
      return requireCurrent(event, current, ["assigned"], "rejected");
    case "run.preparing":
      return requireCurrent(
        event,
        current,
        ["accepted", "assigned"],
        "preparing",
      );
    case "run.started":
      return requireCurrent(
        event,
        current,
        ["accepted", "preparing", "blocked"],
        "running",
      );
    case "stage.updated":
      return requireCurrent(
        event,
        current,
        ["preparing", "running", "blocked"],
        current,
      );
    case "run.blocked":
      return requireCurrent(
        event,
        current,
        ["accepted", "preparing", "running"],
        "blocked",
      );
    case "task.cancel_requested":
      return requireCurrent(
        event,
        current,
        ["assigned", "accepted", "preparing", "running", "blocked"],
        "cancelling",
      );
    case "run.cancelled":
      return requireCurrent(
        event,
        current,
        ["assigned", "accepted", "preparing", "running", "blocked", "cancelling"],
        "cancelled",
      );
    case "run.completed":
      return requireCurrent(
        event,
        current,
        ["accepted", "preparing", "running", "blocked"],
        "succeeded",
      );
    case "run.failed":
      return requireCurrent(
        event,
        current,
        ["accepted", "preparing", "running", "blocked", "cancelling"],
        "failed",
      );
  }
}

function requireCurrent<T extends RunnerAssignmentStatus>(
  event: RunnerLifecycleEvent,
  current: RunnerAssignmentStatus,
  allowed: readonly RunnerAssignmentStatus[],
  next: T,
): T {
  if (!allowed.includes(current)) {
    throw new RunnerLifecycleError(
      `cannot apply ${event.kind} while assignment is ${current}`,
    );
  }
  return next;
}

function validateSequence(
  lastSequence: number | undefined,
  event: RunnerLifecycleEvent,
): void {
  if (event.sequence === undefined) {
    return;
  }
  if (!Number.isInteger(event.sequence) || event.sequence < 0) {
    throw new RunnerLifecycleError(
      `event ${event.eventId} sequence must be a non-negative integer`,
    );
  }
  if (lastSequence !== undefined && event.sequence <= lastSequence) {
    throw new RunnerLifecycleError(
      `event ${event.eventId} sequence ${event.sequence} must be greater than ${lastSequence}`,
    );
  }
}

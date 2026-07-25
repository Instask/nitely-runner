import { randomUUID } from "node:crypto";

import {
  applyRunnerLifecycleEvent,
  createAssignmentProjection,
  type RunnerAssignmentProjection,
  type RunnerLifecycleEvent,
} from "./lifecycle.js";

export const RUNNER_CONTROL_PLANE_SCHEMA_VERSION =
  "runner-control-plane.v1" as const;

export type RunnerRedactionStatus =
  | "metadata_only"
  | "sanitized"
  | "explicit_raw_upload";

export interface RunnerIdentity {
  tenantId: string;
  runnerId: string;
  policyVersion: string;
  allowedRepositories: string[];
  version: string;
}

export interface RunnerPolicySnapshot {
  tenantId: string;
  runnerId: string;
  policyVersion: string;
  allowedRepositories: string[];
  allowedUploadRedactionStatuses?: RunnerRedactionStatus[];
}

export interface RunnerRegistration {
  tenantId: string;
  runnerId: string;
  policy: RunnerPolicySnapshot;
  status: string;
  version?: string;
  activeRunIds: string[];
  lastSeenAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunnerRegistrationResult {
  runner: RunnerRegistration;
  event?: RunnerProtocolEvent<"runner.register.accepted">;
}

export interface RunnerRegistrationClient {
  registerRunner(identity: RunnerIdentity): Promise<RunnerRegistrationResult>;
}

export interface RunnerAssignmentPayload {
  [key: string]: unknown;
  taskId: string;
  repoId: string;
  repository?: RunnerRepositoryRef;
  sourceRevision?: string;
  flowId: string;
  flowPath?: string;
  policyVersion: string;
  inputs?: Record<string, unknown>;
}

export interface RunnerRepositoryRef {
  repoId: string;
  name?: string;
  cloneUrl?: string;
  defaultBranch?: string;
}

export type RunnerOutboundEventKind =
  | "runner.heartbeat"
  | "task.accepted"
  | "task.rejected"
  | "run.preparing"
  | "run.started"
  | "run.blocked"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "evidence.reported"
  | "runner.error";

export type RunnerInboundEventKind =
  | "runner.register.accepted"
  | "task.assigned"
  | "task.cancel_requested"
  | "policy.updated"
  | "evidence.upload_requested";

export interface RunnerProtocolEvent<
  Kind extends string = string,
  Payload extends Record<string, unknown> = Record<string, unknown>,
> {
  eventId: string;
  schemaVersion: typeof RUNNER_CONTROL_PLANE_SCHEMA_VERSION;
  tenantId: string;
  runnerId: string;
  taskId?: string;
  runId?: string;
  sequence?: number;
  createdAt: string;
  kind: Kind;
  payload: Payload;
  redactionStatus: RunnerRedactionStatus;
  policyVersion: string;
}

export type RunnerAssignmentEvent = RunnerProtocolEvent<
  "task.assigned",
  RunnerAssignmentPayload
>;

export type RunnerInboundEvent = RunnerProtocolEvent<RunnerInboundEventKind>;

export type RunnerOutboundEvent = RunnerProtocolEvent<RunnerOutboundEventKind>;

export interface RunnerEventReportResult {
  acceptedEventIds: string[];
  duplicateEventIds: string[];
  rejectedEvents: Array<{
    eventId: string;
    kind: string;
    reason: string;
  }>;
}

export interface RunnerControlPlaneClient {
  pollAssignments(identity: RunnerIdentity): Promise<RunnerAssignmentEvent[]>;
  pollControlPlaneEvents(identity: RunnerIdentity): Promise<RunnerInboundEvent[]>;
  reportEvents(events: RunnerOutboundEvent[]): Promise<RunnerEventReportResult>;
}

export interface RunnerEvidenceArtifactMetadata {
  [key: string]: unknown;
  artifactId: string;
  kind?: string;
  name?: string;
  uri?: string;
}

export type RunnerExecutionResult =
  | {
      status: "succeeded";
      runId: string;
      changeRequestUrl?: string;
      evidenceSummary?: unknown;
      evidenceArtifacts?: RunnerEvidenceArtifactMetadata[];
    }
  | {
      status: "blocked";
      runId: string;
      stageId?: string;
      blockerCategory: string;
      safeMessage: string;
    }
  | {
      status: "failed";
      runId?: string;
      failureCategory: string;
      safeMessage: string;
    }
  | {
      status: "cancelled";
      runId?: string;
      safeMessage: string;
    };

export interface RunnerAssignmentExecutor {
  execute(input: {
    identity: RunnerIdentity;
    assignment: RunnerAssignmentPayload;
  }): Promise<RunnerExecutionResult>;
}

export type RunnerCycleResult =
  | {
      status: "idle";
      reportedEvents: [];
    }
  | {
      status: "handled";
      assignment: RunnerAssignmentPayload;
      projection: RunnerAssignmentProjection;
      reportedEvents: RunnerOutboundEvent[];
      report: RunnerEventReportResult;
    };

export interface RunOneAssignmentCycleInput {
  identity: RunnerIdentity;
  client: RunnerControlPlaneClient;
  executor: RunnerAssignmentExecutor;
  now?: () => Date;
  createId?: (kind: RunnerOutboundEventKind) => string;
}

export class RunnerAssignmentCycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerAssignmentCycleError";
  }
}

export async function runOneAssignmentCycle(
  input: RunOneAssignmentCycleInput,
): Promise<RunnerCycleResult> {
  const assignments = await input.client.pollAssignments(input.identity);
  if (assignments.length === 0) {
    return { status: "idle", reportedEvents: [] };
  }

  const assignmentEvent = assignments[0]!;
  const assignment = parseAssignmentEvent(assignmentEvent, input.identity);
  let projection = createAssignmentProjection(toLifecycleEvent(assignmentEvent));
  const events: RunnerOutboundEvent[] = [];
  let nextSequence = (assignmentEvent.sequence ?? 0) + 1;

  const reject = assignmentRejection(input.identity, assignment);
  if (reject) {
    const rejected = createRunnerEvent({
      identity: input.identity,
      kind: "task.rejected",
      taskId: assignment.taskId,
      sequence: nextSequence,
      now: input.now,
      createId: input.createId,
      payload: {
        taskId: assignment.taskId,
        reason: reject.reason,
        safeMessage: reject.safeMessage,
      },
    });
    projection = applyRunnerLifecycleEvent(projection, toLifecycleEvent(rejected));
    events.push(rejected);
    return await reportHandled(input.client, assignment, projection, events);
  }

  const accepted = createRunnerEvent({
    identity: input.identity,
    kind: "task.accepted",
    taskId: assignment.taskId,
    sequence: nextSequence++,
    now: input.now,
    createId: input.createId,
    payload: {
      taskId: assignment.taskId,
      repoId: assignment.repoId,
      ...(assignment.sourceRevision
        ? { sourceRevision: assignment.sourceRevision }
        : {}),
      flowId: assignment.flowId,
      ...(assignment.flowPath ? { flowPath: assignment.flowPath } : {}),
      policyVersion: input.identity.policyVersion,
    },
  });
  events.push(accepted);
  projection = applyRunnerLifecycleEvent(projection, toLifecycleEvent(accepted));

  const preparing = createRunnerEvent({
    identity: input.identity,
    kind: "run.preparing",
    taskId: assignment.taskId,
    sequence: nextSequence++,
    now: input.now,
    createId: input.createId,
    payload: {
      taskId: assignment.taskId,
      repoId: assignment.repoId,
      ...(assignment.sourceRevision
        ? { sourceRevision: assignment.sourceRevision }
        : {}),
      flowId: assignment.flowId,
      ...(assignment.flowPath ? { flowPath: assignment.flowPath } : {}),
    },
  });
  events.push(preparing);
  projection = applyRunnerLifecycleEvent(projection, toLifecycleEvent(preparing));

  let execution: RunnerExecutionResult;
  try {
    execution = await input.executor.execute({
      identity: input.identity,
      assignment,
    });
  } catch (error) {
    execution = {
      status: "failed",
      failureCategory: "executor_error",
      safeMessage: safeErrorMessage(error),
    };
  }

  const started = createStartedEvent({
    identity: input.identity,
    assignment,
    execution,
    sequence: nextSequence++,
    now: input.now,
    createId: input.createId,
  });
  if (started) {
    events.push(started);
    projection = applyRunnerLifecycleEvent(projection, toLifecycleEvent(started));
  }

  const evidence = createEvidenceReportedEvent({
    identity: input.identity,
    assignment,
    execution,
    sequence: nextSequence,
    now: input.now,
    createId: input.createId,
  });
  if (evidence) {
    events.push(evidence);
    nextSequence += 1;
  }

  const terminal = createTerminalEvent({
    identity: input.identity,
    assignment,
    execution,
    sequence: nextSequence,
    now: input.now,
    createId: input.createId,
  });
  events.push(terminal);
  projection = applyRunnerLifecycleEvent(projection, toLifecycleEvent(terminal));

  return await reportHandled(input.client, assignment, projection, events);
}

function parseAssignmentEvent(
  event: RunnerAssignmentEvent,
  identity: RunnerIdentity,
): RunnerAssignmentPayload {
  if (event.schemaVersion !== RUNNER_CONTROL_PLANE_SCHEMA_VERSION) {
    throw new RunnerAssignmentCycleError(
      `unsupported runner protocol schema ${event.schemaVersion}`,
    );
  }
  if (event.kind !== "task.assigned") {
    throw new RunnerAssignmentCycleError(
      `expected task.assigned event, got ${event.kind}`,
    );
  }
  if (event.tenantId !== identity.tenantId || event.runnerId !== identity.runnerId) {
    throw new RunnerAssignmentCycleError("assignment identity mismatch");
  }
  const payload = event.payload;
  for (const key of ["taskId", "repoId", "flowId", "policyVersion"] as const) {
    if (typeof payload[key] !== "string" || payload[key].length === 0) {
      throw new RunnerAssignmentCycleError(
        `assignment payload missing ${key}`,
      );
    }
  }
  return {
    taskId: payload.taskId,
    repoId: payload.repoId,
    ...(isRecord(payload.repository)
      ? { repository: parseRepositoryRef(payload.repository, payload.repoId) }
      : {}),
    ...(typeof payload.sourceRevision === "string" && payload.sourceRevision
      ? { sourceRevision: payload.sourceRevision }
      : {}),
    flowId: payload.flowId,
    ...(typeof payload.flowPath === "string" && payload.flowPath
      ? { flowPath: payload.flowPath }
      : {}),
    policyVersion: payload.policyVersion,
    ...(payload.inputs && isRecord(payload.inputs)
      ? { inputs: payload.inputs }
      : {}),
  };
}

function assignmentRejection(
  identity: RunnerIdentity,
  assignment: RunnerAssignmentPayload,
): { reason: string; safeMessage: string } | undefined {
  if (assignment.policyVersion !== identity.policyVersion) {
    return {
      reason: "policy_version_mismatch",
      safeMessage: `assignment policy ${assignment.policyVersion} does not match runner policy ${identity.policyVersion}`,
    };
  }
  if (!identity.allowedRepositories.includes(assignment.repoId)) {
    return {
      reason: "repository_not_allowed",
      safeMessage: `repository ${assignment.repoId} is not allowed for runner ${identity.runnerId}`,
    };
  }
  return undefined;
}

function createStartedEvent(input: {
  identity: RunnerIdentity;
  assignment: RunnerAssignmentPayload;
  execution: RunnerExecutionResult;
  sequence: number;
  now?: () => Date;
  createId?: (kind: RunnerOutboundEventKind) => string;
}): RunnerOutboundEvent | undefined {
  if (!("runId" in input.execution) || !input.execution.runId) {
    return undefined;
  }
  return createRunnerEvent({
    identity: input.identity,
    kind: "run.started",
    taskId: input.assignment.taskId,
    runId: input.execution.runId,
    sequence: input.sequence,
    now: input.now,
    createId: input.createId,
    payload: {
      runId: input.execution.runId,
      taskId: input.assignment.taskId,
      repoId: input.assignment.repoId,
      ...(input.assignment.sourceRevision
        ? { sourceRevision: input.assignment.sourceRevision }
        : {}),
      flowId: input.assignment.flowId,
      ...(input.assignment.flowPath
        ? { flowPath: input.assignment.flowPath }
        : {}),
    },
  });
}

function createEvidenceReportedEvent(input: {
  identity: RunnerIdentity;
  assignment: RunnerAssignmentPayload;
  execution: RunnerExecutionResult;
  sequence: number;
  now?: () => Date;
  createId?: (kind: RunnerOutboundEventKind) => string;
}): RunnerOutboundEvent | undefined {
  if (
    input.execution.status !== "succeeded" ||
    input.execution.evidenceArtifacts === undefined ||
    input.execution.evidenceArtifacts.length === 0
  ) {
    return undefined;
  }
  return createRunnerEvent({
    identity: input.identity,
    kind: "evidence.reported",
    taskId: input.assignment.taskId,
    runId: input.execution.runId,
    sequence: input.sequence,
    now: input.now,
    createId: input.createId,
    payload: {
      runId: input.execution.runId,
      taskId: input.assignment.taskId,
      artifacts: input.execution.evidenceArtifacts,
    },
  });
}

function createTerminalEvent(input: {
  identity: RunnerIdentity;
  assignment: RunnerAssignmentPayload;
  execution: RunnerExecutionResult;
  sequence: number;
  now?: () => Date;
  createId?: (kind: RunnerOutboundEventKind) => string;
}): RunnerOutboundEvent {
  const runId = "runId" in input.execution ? input.execution.runId : undefined;
  if (input.execution.status === "succeeded") {
    return createRunnerEvent({
      identity: input.identity,
      kind: "run.completed",
      taskId: input.assignment.taskId,
      runId,
      sequence: input.sequence,
      now: input.now,
      createId: input.createId,
      payload: {
        runId,
        taskId: input.assignment.taskId,
        ...(input.execution.changeRequestUrl
          ? { changeRequestUrl: input.execution.changeRequestUrl }
          : {}),
        ...(input.execution.evidenceSummary !== undefined
          ? { evidenceSummary: input.execution.evidenceSummary }
          : {}),
      },
    });
  }
  if (input.execution.status === "blocked") {
    return createRunnerEvent({
      identity: input.identity,
      kind: "run.blocked",
      taskId: input.assignment.taskId,
      runId,
      sequence: input.sequence,
      now: input.now,
      createId: input.createId,
      payload: {
        runId,
        taskId: input.assignment.taskId,
        ...(input.execution.stageId ? { stageId: input.execution.stageId } : {}),
        blockerCategory: input.execution.blockerCategory,
        safeMessage: input.execution.safeMessage,
      },
    });
  }
  if (input.execution.status === "cancelled") {
    return createRunnerEvent({
      identity: input.identity,
      kind: "run.cancelled",
      taskId: input.assignment.taskId,
      runId,
      sequence: input.sequence,
      now: input.now,
      createId: input.createId,
      payload: {
        runId,
        taskId: input.assignment.taskId,
        safeMessage: input.execution.safeMessage,
      },
    });
  }
  return createRunnerEvent({
    identity: input.identity,
    kind: "run.failed",
    taskId: input.assignment.taskId,
    runId,
    sequence: input.sequence,
    now: input.now,
    createId: input.createId,
    payload: {
      runId,
      taskId: input.assignment.taskId,
      failureCategory: input.execution.failureCategory,
      safeMessage: input.execution.safeMessage,
    },
  });
}

function createRunnerEvent(input: {
  identity: RunnerIdentity;
  kind: RunnerOutboundEventKind;
  payload: Record<string, unknown>;
  taskId?: string;
  runId?: string;
  sequence?: number;
  redactionStatus?: RunnerRedactionStatus;
  now?: () => Date;
  createId?: (kind: RunnerOutboundEventKind) => string;
}): RunnerOutboundEvent {
  return {
    eventId: input.createId?.(input.kind) ?? randomUUID(),
    schemaVersion: RUNNER_CONTROL_PLANE_SCHEMA_VERSION,
    tenantId: input.identity.tenantId,
    runnerId: input.identity.runnerId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
    createdAt: (input.now?.() ?? new Date()).toISOString(),
    kind: input.kind,
    payload: input.payload,
    redactionStatus: input.redactionStatus ?? "metadata_only",
    policyVersion: input.identity.policyVersion,
  };
}

function parseRepositoryRef(
  value: Record<string, unknown>,
  repoId: string,
): RunnerRepositoryRef {
  const resolvedRepoId =
    typeof value.repoId === "string" && value.repoId ? value.repoId : repoId;
  return {
    repoId: resolvedRepoId,
    ...(typeof value.name === "string" && value.name ? { name: value.name } : {}),
    ...(typeof value.cloneUrl === "string" && value.cloneUrl
      ? { cloneUrl: value.cloneUrl }
      : {}),
    ...(typeof value.defaultBranch === "string" && value.defaultBranch
      ? { defaultBranch: value.defaultBranch }
      : {}),
  };
}

function toLifecycleEvent(event: RunnerProtocolEvent): RunnerLifecycleEvent {
  if (!isLifecycleKind(event.kind)) {
    throw new RunnerAssignmentCycleError(
      `event ${event.kind} cannot be projected into runner lifecycle`,
    );
  }
  if (!event.taskId) {
    throw new RunnerAssignmentCycleError(
      `event ${event.eventId} is missing taskId`,
    );
  }
  return {
    eventId: event.eventId,
    kind: event.kind,
    taskId: event.taskId,
    createdAt: event.createdAt,
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
    payload: event.payload,
  };
}

function isLifecycleKind(kind: string): kind is RunnerLifecycleEvent["kind"] {
  return (
    kind === "task.assigned" ||
    kind === "task.accepted" ||
    kind === "task.rejected" ||
    kind === "task.cancel_requested" ||
    kind === "run.preparing" ||
    kind === "run.started" ||
    kind === "stage.updated" ||
    kind === "run.blocked" ||
    kind === "run.completed" ||
    kind === "run.failed" ||
    kind === "run.cancelled"
  );
}

async function reportHandled(
  client: RunnerControlPlaneClient,
  assignment: RunnerAssignmentPayload,
  projection: RunnerAssignmentProjection,
  events: RunnerOutboundEvent[],
): Promise<RunnerCycleResult> {
  const report = await client.reportEvents(events);
  return {
    status: "handled",
    assignment,
    projection,
    reportedEvents: events,
    report,
  };
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.split("\n")[0]!.slice(0, 500);
  }
  return "runner executor failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

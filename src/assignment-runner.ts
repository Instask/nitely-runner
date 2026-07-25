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
  protocolVersion?: typeof RUNNER_CONTROL_PLANE_SCHEMA_VERSION;
  policyVersion: string;
  allowedRepositories: string[];
  version: string;
}

export interface RunnerPolicySnapshot {
  tenantId: string;
  runnerId: string;
  protocolVersion?: typeof RUNNER_CONTROL_PLANE_SCHEMA_VERSION;
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

const runnerInboundEventKinds = new Set<RunnerInboundEventKind>([
  "runner.register.accepted",
  "task.assigned",
  "task.cancel_requested",
  "policy.updated",
  "evidence.upload_requested",
]);

const runnerRedactionStatuses = new Set<RunnerRedactionStatus>([
  "metadata_only",
  "sanitized",
  "explicit_raw_upload",
]);

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
    signal?: AbortSignal;
    onRunStarted?: (runId: string) => Promise<void> | void;
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
  cancellationPollIntervalMs?: number;
  sleep?: (durationMs: number) => Promise<void>;
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
  const reports: RunnerEventReportResult[] = [];
  let nextSequence = (assignmentEvent.sequence ?? 0) + 1;

  const reportBatch = async (
    batch: RunnerOutboundEvent[],
  ): Promise<RunnerEventReportResult> => {
    if (batch.length === 0) {
      return emptyReport();
    }
    const report = await input.client.reportEvents(batch);
    reports.push(report);
    return report;
  };

  const reject = assignmentRejection(
    input.identity,
    assignment,
    assignmentEvent.payload,
  );
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
    await reportBatch([rejected]);
    return reportHandled(assignment, projection, events, reports);
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
  const preparationReport = await reportBatch([accepted, preparing]);
  if (preparationReport.rejectedEvents.length > 0) {
    return reportHandled(assignment, projection, events, reports);
  }

  let execution: RunnerExecutionResult;
  const abortController = new AbortController();
  let executionDone = false;
  let cancellationEvent: RunnerInboundEvent | undefined;
  let startedReported = false;
  const reportRunStarted = async (runId: string): Promise<void> => {
    if (startedReported) {
      return;
    }
    startedReported = true;
    const started = createRunnerEvent({
      identity: input.identity,
      kind: "run.started",
      taskId: assignment.taskId,
      runId,
      sequence: nextSequence++,
      now: input.now,
      createId: input.createId,
      payload: {
        runId,
        taskId: assignment.taskId,
        repoId: assignment.repoId,
        ...(assignment.sourceRevision
          ? { sourceRevision: assignment.sourceRevision }
          : {}),
        flowId: assignment.flowId,
        ...(assignment.flowPath ? { flowPath: assignment.flowPath } : {}),
      },
    });
    events.push(started);
    projection = applyRunnerLifecycleEvent(projection, toLifecycleEvent(started));
    const report = await reportBatch([started]);
    if (report.rejectedEvents.length > 0) {
      abortController.abort();
    }
  };
  const cancellationWatcher = watchCancellationRequests({
    identity: input.identity,
    assignment,
    client: input.client,
    signal: abortController.signal,
    isDone: () => executionDone,
    currentRunId: () => projection.runId,
    sleep: input.sleep ?? sleep,
    pollIntervalMs: input.cancellationPollIntervalMs ?? 1_000,
    onCancel: (event) => {
      cancellationEvent = event;
      projection = applyRunnerLifecycleEvent(projection, toLifecycleEvent(event));
      if (event.sequence !== undefined && event.sequence >= nextSequence) {
        nextSequence = event.sequence + 1;
      }
      abortController.abort();
    },
  });
  try {
    execution = await input.executor.execute({
      identity: input.identity,
      assignment,
      signal: abortController.signal,
      onRunStarted: reportRunStarted,
    });
  } catch (error) {
    execution = cancellationEvent
      ? {
          status: "cancelled",
          runId: projection.runId,
          safeMessage: cancellationSafeMessage(cancellationEvent),
        }
      : {
          status: "failed",
          failureCategory: "executor_error",
          safeMessage: safeErrorMessage(error),
        };
  } finally {
    executionDone = true;
    abortController.abort();
    await cancellationWatcher;
  }

  if (execution.status === "cancelled" && !execution.runId && projection.runId) {
    execution = {
      ...execution,
      runId: projection.runId,
    };
  }

  const finalEvents: RunnerOutboundEvent[] = [];
  if (!startedReported) {
    const started = createStartedEvent({
      identity: input.identity,
      assignment,
      execution,
      sequence: nextSequence,
      now: input.now,
      createId: input.createId,
    });
    if (started) {
      nextSequence += 1;
      events.push(started);
      finalEvents.push(started);
      projection = applyRunnerLifecycleEvent(projection, toLifecycleEvent(started));
    }
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
    finalEvents.push(evidence);
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
  finalEvents.push(terminal);
  projection = applyRunnerLifecycleEvent(projection, toLifecycleEvent(terminal));
  await reportBatch(finalEvents);

  return reportHandled(assignment, projection, events, reports);
}

function parseAssignmentEvent(
  event: RunnerAssignmentEvent,
  identity: RunnerIdentity,
): RunnerAssignmentPayload {
  const envelopeError = invalidInboundControlPlaneEventReason(event, identity, {
    requirePolicyMatch: false,
  });
  if (envelopeError) {
    throw new RunnerAssignmentCycleError(
      `invalid assignment event envelope: ${envelopeError}`,
    );
  }
  if (event.kind !== "task.assigned") {
    throw new RunnerAssignmentCycleError(
      `expected task.assigned event, got ${event.kind}`,
    );
  }
  const payload = event.payload;
  for (const key of ["taskId", "repoId", "flowId", "policyVersion"] as const) {
    if (typeof payload[key] !== "string" || payload[key].length === 0) {
      throw new RunnerAssignmentCycleError(
        `assignment payload missing ${key}`,
      );
    }
  }
  if (event.taskId !== payload.taskId) {
    throw new RunnerAssignmentCycleError("assignment event task id mismatch");
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
  rawPayload: Record<string, unknown>,
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
  const boundaryViolations = findAssignmentBoundaryViolations(rawPayload);
  if (boundaryViolations.length > 0) {
    return {
      reason: "assignment_metadata_boundary",
      safeMessage: `assignment metadata contains disallowed fields: ${boundaryViolations.join(", ")}`,
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

function reportHandled(
  assignment: RunnerAssignmentPayload,
  projection: RunnerAssignmentProjection,
  events: RunnerOutboundEvent[],
  reports: RunnerEventReportResult[],
): RunnerCycleResult {
  return {
    status: "handled",
    assignment,
    projection,
    reportedEvents: events,
    report: mergeReports(reports),
  };
}

async function watchCancellationRequests(input: {
  identity: RunnerIdentity;
  assignment: RunnerAssignmentPayload;
  client: RunnerControlPlaneClient;
  signal: AbortSignal;
  isDone: () => boolean;
  currentRunId: () => string | undefined;
  pollIntervalMs: number;
  sleep: (durationMs: number) => Promise<void>;
  onCancel: (event: RunnerInboundEvent) => void;
}): Promise<void> {
  while (!input.isDone() && !input.signal.aborted) {
    const runId = input.currentRunId();
    if (runId) {
      try {
        const events = await input.client.pollControlPlaneEvents(input.identity);
        const cancellation = events.find((event) =>
          isMatchingCancellationRequest(
            event,
            input.identity,
            input.assignment,
            runId,
          ),
        );
        if (cancellation) {
          input.onCancel(cancellation);
          return;
        }
      } catch {
        if (input.isDone() || input.signal.aborted) {
          return;
        }
      }
    }
    await sleepUntilNextPoll(input.sleep, input.pollIntervalMs, input.signal);
  }
}

function isMatchingCancellationRequest(
  event: RunnerInboundEvent,
  identity: RunnerIdentity,
  assignment: RunnerAssignmentPayload,
  runId: string,
): boolean {
  return (
    isValidInboundControlPlaneEvent(event, identity) &&
    event.kind === "task.cancel_requested" &&
    event.taskId === assignment.taskId &&
    (event.runId === undefined || event.runId === runId)
  );
}

function isValidInboundControlPlaneEvent(
  event: RunnerInboundEvent,
  identity: RunnerIdentity,
): boolean {
  return invalidInboundControlPlaneEventReason(event, identity) === undefined;
}

function invalidInboundControlPlaneEventReason(
  event: RunnerProtocolEvent,
  identity: RunnerIdentity,
  options: { requirePolicyMatch?: boolean } = {},
): string | undefined {
  if (event.schemaVersion !== RUNNER_CONTROL_PLANE_SCHEMA_VERSION) {
    return `unsupported runner protocol schema ${event.schemaVersion}`;
  }
  if (!runnerInboundEventKinds.has(event.kind as RunnerInboundEventKind)) {
    return `unsupported control-plane event kind ${event.kind}`;
  }
  if (event.tenantId !== identity.tenantId || event.runnerId !== identity.runnerId) {
    return "control-plane event identity mismatch";
  }
  if (!isProtocolSegment(event.policyVersion)) {
    return `invalid policy version: ${String(event.policyVersion)}`;
  }
  if (
    options.requirePolicyMatch !== false &&
    event.policyVersion !== identity.policyVersion
  ) {
    return "control-plane event policy mismatch";
  }
  if (!isProtocolSegment(event.eventId)) {
    return `invalid event id: ${String(event.eventId)}`;
  }
  if (event.taskId !== undefined && !isProtocolSegment(event.taskId)) {
    return `invalid task id: ${String(event.taskId)}`;
  }
  if (event.runId !== undefined && !isProtocolSegment(event.runId)) {
    return `invalid run id: ${String(event.runId)}`;
  }
  if (
    event.sequence !== undefined &&
    (!Number.isInteger(event.sequence) || event.sequence < 0)
  ) {
    return "runner protocol sequence must be a non-negative integer";
  }
  if (
    typeof event.createdAt !== "string" ||
    Number.isNaN(Date.parse(event.createdAt))
  ) {
    return "control-plane event createdAt must be a valid timestamp";
  }
  if (!runnerRedactionStatuses.has(event.redactionStatus)) {
    return `unsupported redaction status ${event.redactionStatus}`;
  }
  if (!isRecord(event.payload)) {
    return "control-plane event payload must be an object";
  }
  return undefined;
}

function isProtocolSegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,160}$/.test(value)
  );
}

function cancellationSafeMessage(event: RunnerInboundEvent): string {
  const safeMessage = event.payload.safeMessage;
  if (typeof safeMessage === "string" && safeMessage.length > 0) {
    return safeMessage;
  }
  const reason = event.payload.reason;
  return typeof reason === "string" && reason.length > 0
    ? `cancelled after ${reason}`
    : "cancelled by control-plane request";
}

function mergeReports(
  reports: RunnerEventReportResult[],
): RunnerEventReportResult {
  return {
    acceptedEventIds: reports.flatMap((report) => report.acceptedEventIds),
    duplicateEventIds: reports.flatMap((report) => report.duplicateEventIds),
    rejectedEvents: reports.flatMap((report) => report.rejectedEvents),
  };
}

function emptyReport(): RunnerEventReportResult {
  return { acceptedEventIds: [], duplicateEventIds: [], rejectedEvents: [] };
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.split("\n")[0]!.slice(0, 500);
  }
  return "runner executor failed";
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function sleepUntilNextPoll(
  sleeper: (durationMs: number) => Promise<void>,
  durationMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await Promise.race([
    sleeper(durationMs),
    new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }),
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const sensitiveAssignmentKeys = new Set([
  "accessToken",
  "adminToken",
  "apiKey",
  "auth",
  "authorization",
  "bearerToken",
  "cookie",
  "credential",
  "credentials",
  "password",
  "privateKey",
  "refreshToken",
  "registrationSecret",
  "runnerToken",
  "secret",
  "sessionCookie",
  "sessionToken",
  "token",
]);

function findAssignmentBoundaryViolations(
  payload: Record<string, unknown>,
): string[] {
  const violations: string[] = [];
  for (const key of Object.keys(payload)) {
    if (isRunnerLocalPathKey(key) || sensitiveAssignmentKeys.has(key)) {
      violations.push(`assignment.${key}`);
    }
  }
  if (isRecord(payload.repository)) {
    for (const key of Object.keys(payload.repository)) {
      if (isRunnerLocalPathKey(key) || sensitiveAssignmentKeys.has(key)) {
        violations.push(`assignment.repository.${key}`);
      }
    }
    if (
      typeof payload.repository.cloneUrl === "string" &&
      isCredentialedUrl(payload.repository.cloneUrl)
    ) {
      violations.push("assignment.repository.cloneUrl");
    }
  }
  if (isRecord(payload.inputs)) {
    violations.push(
      ...findSensitivePayloadPaths(payload.inputs, "assignment.inputs"),
    );
  }
  return violations;
}

function findSensitivePayloadPaths(value: unknown, path: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findSensitivePayloadPaths(item, `${path}[${index}]`),
    );
  }
  if (typeof value === "string") {
    return looksLikeSecret(value) ? [path] : [];
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = `${path}.${key}`;
    if (sensitiveAssignmentKeys.has(key)) {
      return [childPath];
    }
    return findSensitivePayloadPaths(child, childPath);
  });
}

function isRunnerLocalPathKey(key: string): boolean {
  return [
    "absolutePath",
    "checkoutPath",
    "localCheckoutPath",
    "localPath",
    "repositoryPath",
    "repoPath",
    "worktreePath",
  ].includes(key);
}

function isCredentialedUrl(value: string): boolean {
  if (looksLikeSecret(value)) {
    return true;
  }
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      return true;
    }
    for (const key of url.searchParams.keys()) {
      if (
        sensitiveAssignmentKeys.has(key) ||
        /token|secret|password|auth/i.test(key)
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return /https?:\/\/[^/\s]+@/.test(value);
  }
}

function looksLikeSecret(value: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) ||
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/.test(value) ||
    /\bsk-[A-Za-z0-9_-]{20,}\b/.test(value)
  );
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  RUNNER_CONTROL_PLANE_SCHEMA_VERSION,
  type RunnerAssignmentEvent,
  type RunnerControlPlaneClient,
  type RunnerEventReportResult,
  type RunnerIdentity,
  type RunnerOutboundEvent,
  type RunnerRedactionStatus,
} from "./assignment-runner.js";

export type FileRunnerAssignmentStatus =
  | "assigned"
  | "accepted"
  | "rejected"
  | "preparing"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface FileRunnerPolicySnapshot {
  tenantId: string;
  runnerId: string;
  policyVersion: string;
  allowedRepositories: string[];
  allowedUploadRedactionStatuses?: RunnerRedactionStatus[];
}

export interface FileRunnerRegistration {
  tenantId: string;
  runnerId: string;
  policy: FileRunnerPolicySnapshot;
  lastSeenAt?: string;
  status?: string;
  version?: string;
  activeRunIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FileRunnerAssignment {
  tenantId: string;
  runnerId: string;
  taskId: string;
  repoId: string;
  repository?: unknown;
  sourceRevision?: string;
  flowId: string;
  flowPath?: string;
  title?: string;
  inputs: Record<string, unknown>;
  policyVersion: string;
  status: FileRunnerAssignmentStatus;
  latestRunId?: string;
  rejection?: {
    reason: string;
    safeMessage: string;
  };
  blocker?: {
    runId?: string;
    stageId?: string;
    category?: string;
    safeMessage?: string;
  };
  failure?: {
    runId?: string;
    category?: string;
    safeMessage?: string;
  };
  cancellation?: {
    runId?: string;
    safeMessage?: string;
  };
  changeRequestUrl?: string;
  evidenceSummary?: unknown;
  assignedEvent: RunnerAssignmentEvent;
  createdAt: string;
  updatedAt: string;
}

export interface FileRunnerControlPlaneState {
  version: 1;
  runners: Record<string, FileRunnerRegistration>;
  assignments: Record<string, FileRunnerAssignment>;
  runnerEvents: RunnerOutboundEvent[];
}

export interface FileRunnerControlPlaneClientOptions {
  path: string;
}

export class FileRunnerControlPlaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileRunnerControlPlaneError";
  }
}

export class FileRunnerControlPlaneClient implements RunnerControlPlaneClient {
  readonly #path: string;

  constructor(options: FileRunnerControlPlaneClientOptions) {
    this.#path = options.path;
  }

  async pollAssignments(
    identity: RunnerIdentity,
  ): Promise<RunnerAssignmentEvent[]> {
    const state = await readFileRunnerControlPlaneState(this.#path);
    requireRunner(state, identity.tenantId, identity.runnerId);
    return Object.values(state.assignments)
      .filter(
        (assignment) =>
          assignment.tenantId === identity.tenantId &&
          assignment.runnerId === identity.runnerId &&
          assignment.status === "assigned",
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((assignment) => assignment.assignedEvent);
  }

  async reportEvents(
    events: RunnerOutboundEvent[],
  ): Promise<RunnerEventReportResult> {
    const state = await readFileRunnerControlPlaneState(this.#path);
    const result: RunnerEventReportResult = {
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejectedEvents: [],
    };

    for (const event of events) {
      const existing = state.runnerEvents.find(
        (candidate) => candidate.eventId === event.eventId,
      );
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(event)) {
          result.acceptedEventIds.push(event.eventId);
          result.duplicateEventIds.push(event.eventId);
        } else {
          result.rejectedEvents.push({
            eventId: event.eventId,
            kind: event.kind,
            reason: "event id collision",
          });
        }
        continue;
      }

      const runner = state.runners[runnerKey(event.tenantId, event.runnerId)];
      if (!runner) {
        result.rejectedEvents.push({
          eventId: event.eventId,
          kind: event.kind,
          reason: "unknown runner identity",
        });
        continue;
      }

      const rejection = validateRunnerEvent(state, runner.policy, event);
      if (rejection) {
        result.rejectedEvents.push({
          eventId: event.eventId,
          kind: event.kind,
          reason: rejection,
        });
        continue;
      }

      state.runnerEvents.push(event);
      applyRunnerEvent(state, event);
      result.acceptedEventIds.push(event.eventId);
    }

    await writeFileRunnerControlPlaneState(this.#path, state);
    return result;
  }
}

export async function readFileRunnerControlPlaneState(
  path: string,
): Promise<FileRunnerControlPlaneState> {
  const raw = await readJsonFile(path);
  if (raw === undefined) {
    return emptyState();
  }
  if (!isRecord(raw) || raw.version !== 1) {
    throw new FileRunnerControlPlaneError(
      "invalid runner control-plane state: version must be 1",
    );
  }
  return {
    version: 1,
    runners: isRecord(raw.runners)
      ? (raw.runners as Record<string, FileRunnerRegistration>)
      : {},
    assignments: isRecord(raw.assignments)
      ? (raw.assignments as Record<string, FileRunnerAssignment>)
      : {},
    runnerEvents: Array.isArray(raw.runnerEvents)
      ? (raw.runnerEvents as RunnerOutboundEvent[])
      : [],
  };
}

export async function writeFileRunnerControlPlaneState(
  path: string,
  state: FileRunnerControlPlaneState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, path);
}

function applyRunnerEvent(
  state: FileRunnerControlPlaneState,
  event: RunnerOutboundEvent,
): void {
  const runner = requireRunner(state, event.tenantId, event.runnerId);
  runner.updatedAt = event.createdAt;

  if (event.kind === "runner.heartbeat") {
    runner.lastSeenAt = event.createdAt;
    runner.status = stringPayload(event.payload, "status");
    runner.version = stringPayload(event.payload, "version");
    runner.activeRunIds = stringArrayPayload(event.payload, "activeRunIds");
    return;
  }

  if (!event.taskId) {
    return;
  }
  const assignment = requireAssignment(state, event.tenantId, event.taskId);
  assignment.updatedAt = event.createdAt;

  if (event.kind === "task.accepted") {
    assignment.status = "accepted";
    return;
  }
  if (event.kind === "task.rejected") {
    assignment.status = "rejected";
    assignment.rejection = {
      reason: stringPayload(event.payload, "reason") ?? "rejected",
      safeMessage: stringPayload(event.payload, "safeMessage") ?? "rejected",
    };
    return;
  }
  if (event.kind === "run.preparing") {
    assignment.status = "preparing";
    assignment.latestRunId = event.runId ?? stringPayload(event.payload, "runId");
    return;
  }
  if (event.kind === "run.started") {
    assignment.status = "running";
    assignment.latestRunId = event.runId ?? stringPayload(event.payload, "runId");
    return;
  }
  if (event.kind === "run.blocked") {
    assignment.status = "blocked";
    assignment.latestRunId =
      event.runId ?? stringPayload(event.payload, "runId") ?? assignment.latestRunId;
    assignment.blocker = {
      runId: assignment.latestRunId,
      stageId: stringPayload(event.payload, "stageId"),
      category: stringPayload(event.payload, "blockerCategory"),
      safeMessage: stringPayload(event.payload, "safeMessage"),
    };
    return;
  }
  if (event.kind === "run.cancelled") {
    assignment.status = "cancelled";
    assignment.latestRunId =
      event.runId ?? stringPayload(event.payload, "runId") ?? assignment.latestRunId;
    assignment.cancellation = {
      runId: assignment.latestRunId,
      safeMessage: stringPayload(event.payload, "safeMessage"),
    };
    return;
  }
  if (event.kind === "run.completed") {
    assignment.status = "completed";
    assignment.latestRunId =
      event.runId ?? stringPayload(event.payload, "runId") ?? assignment.latestRunId;
    assignment.changeRequestUrl =
      stringPayload(event.payload, "changeRequestUrl") ??
      stringPayload(event.payload, "prUrl");
    assignment.evidenceSummary = event.payload.evidenceSummary;
    return;
  }
  if (event.kind === "run.failed") {
    assignment.status = "failed";
    assignment.latestRunId =
      event.runId ?? stringPayload(event.payload, "runId") ?? assignment.latestRunId;
    assignment.failure = {
      runId: assignment.latestRunId,
      category: stringPayload(event.payload, "failureCategory"),
      safeMessage: stringPayload(event.payload, "safeMessage"),
    };
  }
}

function validateRunnerEvent(
  state: FileRunnerControlPlaneState,
  policy: FileRunnerPolicySnapshot,
  event: RunnerOutboundEvent,
): string | undefined {
  if (event.schemaVersion !== RUNNER_CONTROL_PLANE_SCHEMA_VERSION) {
    return `unsupported runner protocol schema ${event.schemaVersion}`;
  }
  if (event.tenantId !== policy.tenantId) {
    return "runner event tenant mismatch";
  }
  if (event.runnerId !== policy.runnerId) {
    return "runner event identity mismatch";
  }
  if (event.policyVersion !== policy.policyVersion) {
    return "runner event policy mismatch";
  }
  const allowed = policy.allowedUploadRedactionStatuses ?? [
    "metadata_only",
    "sanitized",
  ];
  if (!allowed.includes(event.redactionStatus)) {
    return `redaction status ${event.redactionStatus} is not allowed by policy ${policy.policyVersion}`;
  }
  if (event.redactionStatus !== "explicit_raw_upload") {
    const violations = findSensitivePayloadPaths(event.payload);
    if (violations.length > 0) {
      return `metadata-only runner event contains disallowed raw fields: ${violations.join(", ")}`;
    }
  }
  if (event.taskId) {
    requireAssignment(state, event.tenantId, event.taskId);
  }
  return undefined;
}

function emptyState(): FileRunnerControlPlaneState {
  return { version: 1, runners: {}, assignments: {}, runnerEvents: [] };
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function runnerKey(tenantId: string, runnerId: string): string {
  return `${tenantId}:${runnerId}`;
}

function assignmentKey(tenantId: string, taskId: string): string {
  return `${tenantId}:${taskId}`;
}

function requireRunner(
  state: FileRunnerControlPlaneState,
  tenantId: string,
  runnerId: string,
): FileRunnerRegistration {
  const runner = state.runners[runnerKey(tenantId, runnerId)];
  if (!runner) {
    throw new FileRunnerControlPlaneError(`unknown runner: ${tenantId}/${runnerId}`);
  }
  return runner;
}

function requireAssignment(
  state: FileRunnerControlPlaneState,
  tenantId: string,
  taskId: string,
): FileRunnerAssignment {
  const assignment = state.assignments[assignmentKey(tenantId, taskId)];
  if (!assignment) {
    throw new FileRunnerControlPlaneError(
      `unknown runner assignment: ${tenantId}/${taskId}`,
    );
  }
  return assignment;
}

function stringPayload(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function stringArrayPayload(
  payload: Record<string, unknown>,
  key: string,
): string[] {
  const value = payload[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

const sensitivePayloadKeys = new Set([
  "accessToken",
  "apiKey",
  "artifactContent",
  "content",
  "diff",
  "fileContent",
  "fullLog",
  "log",
  "logs",
  "patch",
  "prompt",
  "rawArtifact",
  "rawLog",
  "rawPrompt",
  "rawSource",
  "secret",
  "sourceCode",
  "stderr",
  "stdout",
  "token",
]);

function findSensitivePayloadPaths(value: unknown, path = "payload"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findSensitivePayloadPaths(item, `${path}[${index}]`),
    );
  }
  if (typeof value === "string") {
    return looksLikeSecret(value) ? [path] : [];
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const violations: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (sensitivePayloadKeys.has(key)) {
      violations.push(childPath);
      continue;
    }
    violations.push(...findSensitivePayloadPaths(child, childPath));
  }
  return violations;
}

function looksLikeSecret(value: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) ||
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/.test(value) ||
    /\bsk-[A-Za-z0-9_-]{20,}\b/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { randomUUID } from "node:crypto";

import {
  RUNNER_CONTROL_PLANE_SCHEMA_VERSION,
  type RunnerControlPlaneClient,
  type RunnerEventReportResult,
  type RunnerIdentity,
  type RunnerOutboundEvent,
  type RunnerRedactionStatus,
} from "./assignment-runner.js";

export interface RunnerHeartbeatInput {
  status: "idle" | "busy" | "draining" | "offline";
  activeRunIds?: string[];
  capacity?: {
    maxConcurrentRuns: number;
    availableSlots: number;
  };
  redactionStatus?: RunnerRedactionStatus;
  now?: () => Date;
  createId?: () => string;
}

export interface ReportRunnerHeartbeatInput extends RunnerHeartbeatInput {
  identity: RunnerIdentity;
  client: RunnerControlPlaneClient;
}

export function createRunnerHeartbeatEvent(input: {
  identity: RunnerIdentity;
  heartbeat: RunnerHeartbeatInput;
}): RunnerOutboundEvent {
  const activeRunIds = input.heartbeat.activeRunIds ?? [];
  return {
    eventId: input.heartbeat.createId?.() ?? randomUUID(),
    schemaVersion: RUNNER_CONTROL_PLANE_SCHEMA_VERSION,
    tenantId: input.identity.tenantId,
    runnerId: input.identity.runnerId,
    createdAt: (input.heartbeat.now?.() ?? new Date()).toISOString(),
    kind: "runner.heartbeat",
    payload: {
      status: input.heartbeat.status,
      activeRunIds,
      version: input.identity.version,
      ...(input.heartbeat.capacity
        ? { capacity: input.heartbeat.capacity }
        : {}),
    },
    redactionStatus: input.heartbeat.redactionStatus ?? "metadata_only",
    policyVersion: input.identity.policyVersion,
  };
}

export async function reportRunnerHeartbeat(
  input: ReportRunnerHeartbeatInput,
): Promise<RunnerEventReportResult> {
  const event = createRunnerHeartbeatEvent({
    identity: input.identity,
    heartbeat: input,
  });
  return await input.client.reportEvents([event]);
}

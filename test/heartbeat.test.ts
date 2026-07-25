import { describe, expect, it } from "vitest";

import { MemoryRunnerControlPlaneClient } from "../src/memory-control-plane.js";
import {
  createRunnerHeartbeatEvent,
  reportRunnerHeartbeat,
} from "../src/heartbeat.js";
import type { RunnerIdentity } from "../src/assignment-runner.js";

const fixedNow = () => new Date("2026-07-25T01:02:03.000Z");

const identity: RunnerIdentity = {
  tenantId: "tenant-1",
  runnerId: "runner-1",
  policyVersion: "policy-1",
  allowedRepositories: ["repo-1"],
  version: "0.1.0",
};

describe("runner heartbeat", () => {
  it("creates metadata-only heartbeat events", () => {
    expect(
      createRunnerHeartbeatEvent({
        identity,
        heartbeat: {
          status: "busy",
          activeRunIds: ["run-1"],
          capacity: { maxConcurrentRuns: 2, availableSlots: 1 },
          now: fixedNow,
          createId: () => "heartbeat-1",
        },
      }),
    ).toEqual({
      eventId: "heartbeat-1",
      schemaVersion: "runner-control-plane.v1",
      tenantId: "tenant-1",
      runnerId: "runner-1",
      createdAt: "2026-07-25T01:02:03.000Z",
      kind: "runner.heartbeat",
      payload: {
        status: "busy",
        activeRunIds: ["run-1"],
        version: "0.1.0",
        capacity: { maxConcurrentRuns: 2, availableSlots: 1 },
      },
      redactionStatus: "metadata_only",
      policyVersion: "policy-1",
    });
  });

  it("reports heartbeat through any runner control-plane client", async () => {
    const client = new MemoryRunnerControlPlaneClient();

    await expect(
      reportRunnerHeartbeat({
        identity,
        client,
        status: "idle",
        activeRunIds: [],
        now: fixedNow,
        createId: () => "heartbeat-1",
      }),
    ).resolves.toEqual({
      acceptedEventIds: ["heartbeat-1"],
      duplicateEventIds: [],
      rejectedEvents: [],
    });
    expect(client.listEvents()).toHaveLength(1);
    expect(client.listEvents()[0]).toMatchObject({
      kind: "runner.heartbeat",
      payload: { status: "idle" },
    });
  });
});

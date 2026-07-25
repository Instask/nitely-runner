import { describe, expect, it } from "vitest";

import {
  RUNNER_CONTROL_PLANE_SCHEMA_VERSION,
  type RunnerAssignmentEvent,
  type RunnerIdentity,
  type RunnerInboundEvent,
  type RunnerOutboundEvent,
} from "../src/assignment-runner.js";
import { HttpRunnerControlPlaneClient } from "../src/http-control-plane.js";
import type { RunnerFetch } from "../src/http-control-plane.js";

const identity: RunnerIdentity = {
  tenantId: "tenant-1",
  runnerId: "runner-1",
  policyVersion: "policy-1",
  allowedRepositories: ["repo-1"],
  version: "0.1.0",
};

describe("HttpRunnerControlPlaneClient", () => {
  it("registers the runner identity with the control plane", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = new HttpRunnerControlPlaneClient({
      baseUrl: "https://control.example/api/",
      headers: { authorization: "Bearer token" },
      fetch: fakeFetch(calls, {
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
          createdAt: "2026-07-25T01:00:00.000Z",
          updatedAt: "2026-07-25T01:00:00.000Z",
        },
        event: { kind: "runner.register.accepted" },
      }),
    });

    await expect(client.registerRunner(identity)).resolves.toMatchObject({
      runner: {
        tenantId: "tenant-1",
        runnerId: "runner-1",
        status: "registered",
      },
      event: { kind: "runner.register.accepted" },
    });
    expect(calls[0]?.url).toBe("https://control.example/api/runner/register");
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
      },
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(identity);
  });

  it("polls assignments with runner identity query parameters", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = new HttpRunnerControlPlaneClient({
      baseUrl: "https://control.example/api/",
      headers: { authorization: "Bearer token" },
      fetch: fakeFetch(calls, {
        assignments: [assignmentEvent()],
      }),
    });

    await expect(client.pollAssignments(identity)).resolves.toMatchObject([
      {
        kind: "task.assigned",
        payload: { flowPath: "flows/implement.json" },
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://control.example/api/runner/assignments?tenantId=tenant-1&runnerId=runner-1",
    );
    expect(calls[0]?.init).toMatchObject({
      method: "GET",
      headers: { authorization: "Bearer token" },
    });
  });

  it("reports runner events as a protocol event batch", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const event = runnerEvent();
    const client = new HttpRunnerControlPlaneClient({
      baseUrl: "https://control.example/api",
      fetch: fakeFetch(calls, {
        acceptedEventIds: ["completed-1"],
        duplicateEventIds: [],
        rejectedEvents: [],
      }),
    });

    await expect(client.reportEvents([event])).resolves.toEqual({
      acceptedEventIds: ["completed-1"],
      duplicateEventIds: [],
      rejectedEvents: [],
    });
    expect(calls[0]?.url).toBe("https://control.example/api/runner/events");
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      events: [event],
    });
  });

  it("polls queued control-plane events with runner identity query parameters", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = new HttpRunnerControlPlaneClient({
      baseUrl: "https://control.example/api/",
      headers: { authorization: "Bearer token" },
      fetch: fakeFetch(calls, {
        events: [controlPlaneEvent()],
      }),
    });

    await expect(client.pollControlPlaneEvents(identity)).resolves.toMatchObject([
      {
        kind: "task.cancel_requested",
        payload: { reason: "operator_requested" },
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://control.example/api/runner/events?tenantId=tenant-1&runnerId=runner-1",
    );
    expect(calls[0]?.init).toMatchObject({
      method: "GET",
      headers: { authorization: "Bearer token" },
    });
  });

  it("raises a safe error for non-2xx responses", async () => {
    const client = new HttpRunnerControlPlaneClient({
      baseUrl: "https://control.example",
      fetch: fakeFetch([], { message: "runner event policy mismatch" }, {
        ok: false,
        status: 400,
        statusText: "Bad Request",
      }),
    });

    await expect(client.pollAssignments(identity)).rejects.toThrow(
      "control-plane request failed 400 Bad Request: runner event policy mismatch",
    );
  });
});

function fakeFetch(
  calls: Array<{ url: string; init: RequestInit | undefined }>,
  body: unknown,
  response: Partial<Pick<Response, "ok" | "status" | "statusText">> = {},
): RunnerFetch {
  return async (url, init) => {
    calls.push({ url: url.toString(), init });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      statusText: response.statusText ?? "OK",
      json: async () => body,
    };
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
      inputs: { spec: "docs/spec.md" },
      policyVersion: identity.policyVersion,
    },
  };
}

function controlPlaneEvent(): RunnerInboundEvent {
  return {
    eventId: "cancel-request-1",
    schemaVersion: RUNNER_CONTROL_PLANE_SCHEMA_VERSION,
    tenantId: identity.tenantId,
    runnerId: identity.runnerId,
    taskId: "task-1",
    runId: "run-1",
    sequence: 3,
    createdAt: "2026-07-25T01:03:00.000Z",
    kind: "task.cancel_requested",
    payload: {
      taskId: "task-1",
      runId: "run-1",
      reason: "operator_requested",
    },
    redactionStatus: "metadata_only",
    policyVersion: identity.policyVersion,
  };
}

function runnerEvent(): RunnerOutboundEvent {
  return {
    eventId: "completed-1",
    schemaVersion: RUNNER_CONTROL_PLANE_SCHEMA_VERSION,
    tenantId: identity.tenantId,
    runnerId: identity.runnerId,
    taskId: "task-1",
    runId: "run-1",
    sequence: 4,
    createdAt: "2026-07-25T01:05:00.000Z",
    kind: "run.completed",
    payload: { taskId: "task-1", runId: "run-1" },
    redactionStatus: "metadata_only",
    policyVersion: identity.policyVersion,
  };
}

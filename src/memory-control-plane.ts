import type {
  RunnerAssignmentEvent,
  RunnerControlPlaneClient,
  RunnerEventReportResult,
  RunnerIdentity,
  RunnerInboundEvent,
  RunnerOutboundEvent,
  RunnerRegistration,
  RunnerRegistrationClient,
  RunnerRegistrationResult,
} from "./assignment-runner.js";

export class MemoryRunnerControlPlaneClient
  implements RunnerControlPlaneClient, RunnerRegistrationClient
{
  readonly #assignments: RunnerAssignmentEvent[] = [];
  readonly #controlPlaneEvents: RunnerInboundEvent[] = [];
  readonly #events: RunnerOutboundEvent[] = [];
  readonly #runners = new Map<string, RunnerRegistration>();

  constructor(
    assignments: RunnerAssignmentEvent[] = [],
    controlPlaneEvents: RunnerInboundEvent[] = [],
  ) {
    this.#assignments.push(...assignments);
    this.#controlPlaneEvents.push(...controlPlaneEvents);
  }

  enqueueAssignment(assignment: RunnerAssignmentEvent): void {
    this.#assignments.push(assignment);
  }

  enqueueControlPlaneEvent(event: RunnerInboundEvent): void {
    this.#controlPlaneEvents.push(event);
  }

  async registerRunner(
    identity: RunnerIdentity,
  ): Promise<RunnerRegistrationResult> {
    const now = new Date().toISOString();
    const key = runnerKey(identity.tenantId, identity.runnerId);
    const existing = this.#runners.get(key);
    const runner: RunnerRegistration = {
      tenantId: identity.tenantId,
      runnerId: identity.runnerId,
      policy: {
        tenantId: identity.tenantId,
        runnerId: identity.runnerId,
        policyVersion: identity.policyVersion,
        allowedRepositories: [...identity.allowedRepositories],
      },
      status: "registered",
      version: identity.version,
      activeRunIds: existing?.activeRunIds ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.#runners.set(key, runner);
    return { runner };
  }

  async pollAssignments(
    identity: RunnerIdentity,
  ): Promise<RunnerAssignmentEvent[]> {
    return this.#assignments.filter(
      (assignment) =>
        assignment.tenantId === identity.tenantId &&
        assignment.runnerId === identity.runnerId,
    );
  }

  async pollControlPlaneEvents(
    identity: RunnerIdentity,
  ): Promise<RunnerInboundEvent[]> {
    return this.#controlPlaneEvents.filter(
      (event) =>
        event.tenantId === identity.tenantId &&
        event.runnerId === identity.runnerId,
    );
  }

  async reportEvents(
    events: RunnerOutboundEvent[],
  ): Promise<RunnerEventReportResult> {
    const result: RunnerEventReportResult = {
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejectedEvents: [],
    };

    for (const event of events) {
      const existing = this.#events.find(
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

      this.#events.push(event);
      result.acceptedEventIds.push(event.eventId);
      if (event.kind === "task.accepted" || event.kind === "task.rejected") {
        this.#removeAssignment(event.tenantId, event.runnerId, event.taskId);
      }
      if (
        event.kind === "task.rejected" ||
        event.kind === "run.cancelled" ||
        event.kind === "run.failed" ||
        event.kind === "run.completed"
      ) {
        this.#removeControlPlaneEvents(event.tenantId, event.runnerId, event.taskId);
      }
    }

    return result;
  }

  listAssignments(): RunnerAssignmentEvent[] {
    return [...this.#assignments];
  }

  listEvents(): RunnerOutboundEvent[] {
    return [...this.#events];
  }

  listControlPlaneEvents(): RunnerInboundEvent[] {
    return [...this.#controlPlaneEvents];
  }

  listRunners(): RunnerRegistration[] {
    return [...this.#runners.values()];
  }

  #removeAssignment(
    tenantId: string,
    runnerId: string,
    taskId: string | undefined,
  ): void {
    if (!taskId) {
      return;
    }
    const index = this.#assignments.findIndex(
      (assignment) =>
        assignment.tenantId === tenantId &&
        assignment.runnerId === runnerId &&
        assignment.taskId === taskId,
    );
    if (index >= 0) {
      this.#assignments.splice(index, 1);
    }
  }

  #removeControlPlaneEvents(
    tenantId: string,
    runnerId: string,
    taskId: string | undefined,
  ): void {
    if (!taskId) {
      return;
    }
    for (let index = this.#controlPlaneEvents.length - 1; index >= 0; index -= 1) {
      const event = this.#controlPlaneEvents[index]!;
      if (
        event.tenantId === tenantId &&
        event.runnerId === runnerId &&
        event.taskId === taskId
      ) {
        this.#controlPlaneEvents.splice(index, 1);
      }
    }
  }
}

function runnerKey(tenantId: string, runnerId: string): string {
  return `${tenantId}:${runnerId}`;
}

import type {
  RunnerAssignmentEvent,
  RunnerControlPlaneClient,
  RunnerEventReportResult,
  RunnerIdentity,
  RunnerOutboundEvent,
} from "./assignment-runner.js";

export class MemoryRunnerControlPlaneClient implements RunnerControlPlaneClient {
  readonly #assignments: RunnerAssignmentEvent[] = [];
  readonly #events: RunnerOutboundEvent[] = [];

  constructor(assignments: RunnerAssignmentEvent[] = []) {
    this.#assignments.push(...assignments);
  }

  enqueueAssignment(assignment: RunnerAssignmentEvent): void {
    this.#assignments.push(assignment);
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
    }

    return result;
  }

  listAssignments(): RunnerAssignmentEvent[] {
    return [...this.#assignments];
  }

  listEvents(): RunnerOutboundEvent[] {
    return [...this.#events];
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
}

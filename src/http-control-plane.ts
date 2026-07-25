import type {
  RunnerAssignmentEvent,
  RunnerControlPlaneClient,
  RunnerEventReportResult,
  RunnerIdentity,
  RunnerOutboundEvent,
  RunnerRegistrationClient,
  RunnerRegistrationResult,
} from "./assignment-runner.js";

export type RunnerFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Pick<Response, "json" | "ok" | "status" | "statusText">>;

export interface HttpRunnerControlPlaneClientOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  fetch?: RunnerFetch;
}

export class HttpRunnerControlPlaneClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpRunnerControlPlaneClientError";
  }
}

export class HttpRunnerControlPlaneClient
  implements RunnerControlPlaneClient, RunnerRegistrationClient
{
  readonly #baseUrl: URL;
  readonly #headers: Record<string, string>;
  readonly #fetch: RunnerFetch;

  constructor(options: HttpRunnerControlPlaneClientOptions) {
    this.#baseUrl = new URL(
      options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`,
    );
    this.#headers = options.headers ?? {};
    this.#fetch = options.fetch ?? fetch;
  }

  async registerRunner(
    identity: RunnerIdentity,
  ): Promise<RunnerRegistrationResult> {
    const url = new URL("runner/register", this.#baseUrl);
    const body = await this.#requestJson(url, {
      method: "POST",
      headers: {
        ...this.#headers,
        "content-type": "application/json",
      },
      body: JSON.stringify(identity),
    });
    if (!isRecord(body) || !isRecord(body.runner)) {
      throw new HttpRunnerControlPlaneClientError(
        "runner registration response must be { runner }",
      );
    }
    return {
      runner: body.runner as unknown as RunnerRegistrationResult["runner"],
      ...(isRecord(body.event)
        ? {
            event: body.event as unknown as RunnerRegistrationResult["event"],
          }
        : {}),
    };
  }

  async pollAssignments(
    identity: RunnerIdentity,
  ): Promise<RunnerAssignmentEvent[]> {
    const url = new URL("runner/assignments", this.#baseUrl);
    url.searchParams.set("tenantId", identity.tenantId);
    url.searchParams.set("runnerId", identity.runnerId);

    const body = await this.#requestJson(url, {
      method: "GET",
      headers: this.#headers,
    });
    if (!isRecord(body) || !Array.isArray(body.assignments)) {
      throw new HttpRunnerControlPlaneClientError(
        "runner assignments response must be { assignments }",
      );
    }
    return body.assignments as RunnerAssignmentEvent[];
  }

  async reportEvents(
    events: RunnerOutboundEvent[],
  ): Promise<RunnerEventReportResult> {
    const url = new URL("runner/events", this.#baseUrl);
    const body = await this.#requestJson(url, {
      method: "POST",
      headers: {
        ...this.#headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({ events }),
    });
    if (
      !isRecord(body) ||
      !Array.isArray(body.acceptedEventIds) ||
      !Array.isArray(body.duplicateEventIds) ||
      !Array.isArray(body.rejectedEvents)
    ) {
      throw new HttpRunnerControlPlaneClientError(
        "runner event report response has invalid shape",
      );
    }
    return {
      acceptedEventIds: body.acceptedEventIds.filter(isString),
      duplicateEventIds: body.duplicateEventIds.filter(isString),
      rejectedEvents: body.rejectedEvents as RunnerEventReportResult["rejectedEvents"],
    };
  }

  async #requestJson(url: URL, init: RequestInit): Promise<unknown> {
    const response = await this.#fetch(url, init);
    const body = await response.json();
    if (!response.ok) {
      throw new HttpRunnerControlPlaneClientError(
        `control-plane request failed ${response.status} ${response.statusText}: ${safeMessage(body)}`,
      );
    }
    return body;
  }
}

function safeMessage(body: unknown): string {
  if (isRecord(body) && typeof body.message === "string" && body.message) {
    return body.message.slice(0, 500);
  }
  return "request failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

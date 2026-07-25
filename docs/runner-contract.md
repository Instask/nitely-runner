# Runner Contract

The Nitely runner is a customer-hosted process that executes work assigned by a
control plane. The contract must be narrow: the control plane coordinates work,
and the runner executes local Nitely runtime behavior with customer-owned
credentials.

## Trust Boundary

The runner is inside the customer environment. It may access repositories,
local agent CLIs, package managers, language toolchains, and provider
credentials configured by the customer.

The control plane is outside that execution boundary. It may request work and
receive status/evidence, but it must not require raw secrets or unrestricted
filesystem access.

## Runner Identity

A runner identity should include:

- `runnerId`: stable id assigned during registration.
- `organizationId`: owning organization.
- `repositoryScopes`: explicit repositories or repository groups it can serve.
- `capabilities`: supported OS, execution backend, agent runtimes, toolchains,
  network policy, and artifact limits.
- `version`: runner protocol/runtime version.

## Run Assignment

A run assignment should include:

- `taskId`
- `repoId`
- `flowId`
- `inputs`
- `policyVersion`

Assignments must be immutable after acceptance. Changes should create a new
assignment or an explicit cancellation/retry instruction.

## Lifecycle

```text
registered -> idle -> assigned -> accepted -> preparing -> running
  -> blocked | cancelling | failed | succeeded
blocked -> running | cancelled
cancelling -> cancelled | failed
```

The runner should report monotonic lifecycle events. Control-plane projection
can derive dashboards from those events, but the runner remains the source of
execution truth.

## Event Streams

Minimum event families:

- `runner.heartbeat`
- `task.assigned`
- `task.accepted`
- `task.rejected`
- `task.cancel_requested`
- `run.started`
- `stage.updated`
- `run.blocked`
- `run.completed`
- `run.failed`
- `run.cancelled`
- `evidence.reported`
- `runner.error`

The public protocol starts in `nitely-oss` as
`nitely/runner-control-plane/protocol` and
`nitely/runner-control-plane/file-stub`. This repository owns the runner daemon
and local lifecycle behavior that consumes that contract.

The first executable runner layer uses a small registration client and an
abstract poll/report client:

- `registerRunner(identity)`: register the runner identity and scoped policy.
- `pollAssignments(identity)`: return ordered `task.assigned` protocol events.
- `pollControlPlaneEvents(identity)`: return follow-up control-plane events such
  as `task.cancel_requested`.
- `reportEvents(events)`: append runner-to-control-plane events and return
  accepted, duplicate, and rejected event ids.

This keeps the runner independent from a specific transport while preserving
the protocol shape required by HTTP polling, websocket, queue, or file-backed
development stubs.

`createRunnerHeartbeatEvent` and `reportRunnerHeartbeat` produce and send
metadata-only `runner.heartbeat` events through the same client interface. The
heartbeat payload includes status, active run ids, runner version, and optional
capacity metadata, never raw logs, prompts, source, or local environment dumps.

`MemoryRunnerControlPlaneClient` is the initial local rehearsal client. It keeps
pending assignments in memory, records reported runner events, deduplicates by
event id, and removes assignments after `task.accepted` or `task.rejected`.

`FileRunnerControlPlaneClient` consumes the same JSON state shape as the
`nitely-oss` file-backed protocol stub. It polls assigned tasks, records runner
events, applies assignment status projection, deduplicates replayed event ids,
and rejects metadata-only events that contain raw logs, prompts, source, or
secret-like payload fields.

`HttpRunnerControlPlaneClient` uses the same runner client interface against
the first control-plane HTTP skeleton:

- `POST /runner/register`
- `GET /runner/assignments?tenantId=...&runnerId=...`
- `GET /runner/events?tenantId=...&runnerId=...`
- `POST /runner/events`

It keeps transport details outside the executor and preserves the poll/report
shape used by memory and file-backed rehearsal.

`LocalNitelyCliExecutor` is the initial OSS runtime bridge. It invokes
`nitely run <flow> --repo <path> --input <name>=<path>` after resolving:

- repository path from runner-local `repoId -> path` configuration, not from
  assignment-controlled fields;
- flow path from `assignment.flowPath`, runner-local `flowId -> path`
  configuration, or `flowId` itself;
- local-file inputs from string values or `{ path | uri }` objects.

Structured remote inputs are intentionally rejected until a connector-specific
materialization step exists. The executor reports only safe metadata: run id,
change request URL, flow id/path, and source revision.

The assignment cycle reports accepted/preparing events before execution. When
the executor observes a run id from streamed CLI output, the runner immediately
reports `run.started`, then polls `pollControlPlaneEvents(identity)` while the
subprocess remains active.

Executors may return `evidenceArtifacts` when they have artifact metadata that
is safe to share. The runner reports those entries as a metadata-only
`evidence.reported` event before terminal completion, while keeping raw logs,
prompts, diffs, source, and artifact bytes out of the default upload boundary.

`loadRunnerConfig` normalizes local runner configuration from JSON. It supports
file-backed control-plane state and HTTP control-plane endpoints. Relative
file-backed state paths and repository paths resolve from the config file
directory; flow paths stay repo-relative so `nitely run` resolves them inside
the target checkout. `runConfiguredRunnerOnce` and the `run-once` CLI send a
heartbeat before and after the assignment cycle. `registerConfiguredRunner` and
the `register` CLI register the same identity before polling for work.
`runConfiguredRunnerLoop` and `run-loop` reuse the same one-cycle behavior in a
bounded or long-running poll loop.

Raw command logs and artifact bytes should be uploaded only when policy allows
it. Metadata-first streaming is the default.

## Cancellation

Cancellation is cooperative first and forceful second:

1. Control plane sends cancellation intent.
2. Runner receives it through `pollControlPlaneEvents(identity)`.
3. Runner asks active subprocesses to terminate.
4. Runner force-kills after a bounded grace period.
5. Runner records terminal cancellation evidence.

`runOneAssignmentCycle` and `run-once` pass an `AbortSignal` into the executor.
`LocalNitelyCliExecutor` sends `SIGTERM` to the active `nitely run` subprocess
and escalates to `SIGKILL` after a bounded grace period. A daemon loop can reuse
the same cycle and cancellation behavior when it is added.

## Secrets

The runner must not send raw provider tokens, local credential store contents,
environment dumps, or full prompt payloads by default. If a hosted product needs
evidence export, the export policy must be explicit and auditable.

## Compatibility

The first implementation can use a simple HTTPS polling transport. The contract
should not assume websockets, queues, Kubernetes, or a specific cloud provider.

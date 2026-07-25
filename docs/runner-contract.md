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

Raw command logs and artifact bytes should be uploaded only when policy allows
it. Metadata-first streaming is the default.

## Cancellation

Cancellation is cooperative first and forceful second:

1. Control plane sends cancellation intent.
2. Runner records cancellation received.
3. Runner asks active subprocesses to terminate.
4. Runner force-kills after a bounded grace period.
5. Runner records terminal cancellation evidence.

## Secrets

The runner must not send raw provider tokens, local credential store contents,
environment dumps, or full prompt payloads by default. If a hosted product needs
evidence export, the export policy must be explicit and auditable.

## Compatibility

The first implementation can use a simple HTTPS polling transport. The contract
should not assume websockets, queues, Kubernetes, or a specific cloud provider.

# Runner MVP Roadmap

## M0: Contract Freeze

- Define runner identity, run assignment, lifecycle, cancellation, and event
  envelopes.
- Implement lifecycle projection tests locally before adding transport.
- Implement a single-assignment poll/execute/report rehearsal with an injected
  executor and mock control-plane client.
- Provide an in-memory control-plane client for deterministic local rehearsal.
- Add a local Nitely CLI executor that invokes `nitely run` from runner-local
  repository mapping, flow path, source revision, and local-file input metadata.
- Add a file-backed control-plane client and config loader for deterministic
  local runner loops.
- Add an HTTP control-plane client for registration, assignment polling, and
  event reporting against the first runner-facing API skeleton.
- Consume the public `nitely/runner-control-plane/*` contract once the OSS
  package is published or available as a workspace dependency.
- Decide whether the first transport is polling, websocket, or queue-backed.
- Keep execution delegated to `nitely-oss`.

## M1: Local Development Runner

- Start a runner process from the command line. (`register --config` and
  `run-once --config` exist.)
- Load a local config file. (Library and CLI support exist.)
- Register against a mock or HTTP control plane. (File-backed and HTTP clients
  support `registerRunner`.)
- Accept one assignment. (File-backed library loop exists.)
- Report accepted, preparing, started, blocked, completed, failed, cancelled,
  and rejected events through the protocol client.
- Execute an OSS Flow locally through `nitely run`.
- Persist local run state and emit lifecycle events.

## M2: Customer-Hosted Preview

- Use a real control-plane endpoint.
- Support one organization and scoped repositories.
- Stream heartbeat, status, logs metadata, artifact metadata, and terminal
  evidence.
- Support cancellation.
- Add version compatibility checks.

## M3: Hardened Runner

- Signed assignment envelope.
- Runner upgrade strategy.
- Backpressure and retry policy.
- Explicit artifact upload policy.
- Audit-ready local logs.
- Optional service installation scripts.

## Do Not Build Yet

- Multi-tenant execution on one runner host.
- Hosted secret custody.
- Arbitrary cloud worker pools.
- Complex scheduler logic inside the runner.

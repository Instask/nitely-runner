# Runner MVP Roadmap

## M0: Contract Freeze

- Define runner identity, run assignment, lifecycle, cancellation, and event
  envelopes.
- Decide whether the first transport is polling, websocket, or queue-backed.
- Keep execution delegated to `nitely-oss`.

## M1: Local Development Runner

- Start a runner process from the command line.
- Load a local config file.
- Register against a mock control plane.
- Accept one assignment.
- Execute an OSS Flow locally.
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

# Nitely Runner

Customer-hosted runner daemon for Nitely.

This repository is for the process that runs inside a customer's environment
and executes authorized Nitely work while preserving local repository and secret
boundaries.

The runner should build on the open source Nitely runtime rather than
reimplementing Flow execution. It adds the network protocol and operational
supervision needed to coordinate with a control plane.

## Responsibilities

- Register with a control plane using a scoped runner identity.
- Receive authorized run assignments.
- Prepare a customer-owned checkout/worktree.
- Execute Nitely OSS Flow runtime stages locally.
- Stream status, logs, evidence metadata, and artifact metadata.
- Preserve customer-controlled credentials and repository access.
- Support cancellation, heartbeat, retry handoff, and terminal reporting.

## Non-Responsibilities

- Owning team task queues or approval policy.
- Hosting organization dashboards.
- Storing long-term evidence indexes.
- Executing code outside the customer's runner boundary.
- Hiding prompt, context, evidence, or redaction behavior from `nitely-oss`.

## Current Status

Protocol and MVP planning. Start with docs before daemon code.

- [docs/runner-contract.md](docs/runner-contract.md)
- [docs/mvp-roadmap.md](docs/mvp-roadmap.md)

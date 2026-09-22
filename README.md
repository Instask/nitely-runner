# Nitely Runner

Customer-hosted runner for Nitely.

This repository contains the customer-hosted runner boundary: reproducible OCI
images, the first file-backed runner/control-plane protocol stub, and the
operational contracts needed to keep source code and credentials customer-side.

## Intended Role

The next daemon can:

- connect to a Nitely control plane;
- receive authorized run work;
- execute Nitely core flows inside a customer-owned environment;
- stream status, logs, evidence, and artifacts back to the coordinator;
- preserve local repository, credential, and network boundaries;
- support policy-controlled upgrades and health checks.

## Trust Boundary

The runner should make it possible for teams to use hosted coordination without
handing their source code, local agent credentials, or private runtime context
to the hosted service.

That implies:

- source checkout and agent execution stay customer-side;
- credentials are resolved locally;
- prompts, logs, artifacts, and evidence follow the same semantics as the open
  source core;
- the control plane receives only the data the runner is configured to send;
- failure, retry, resume, and approval behavior remains inspectable.

## Included Now

- OCI runner image family: [docker/runner/README.md](docker/runner/README.md)
- Protocol and local file stub: [src/runner-control-plane](src/runner-control-plane)
- Boundary: [docs/customer-hosted-runner-boundary.md](docs/customer-hosted-runner-boundary.md)
- Pilot setup: [docs/customer-hosted-runner-onboarding.md](docs/customer-hosted-runner-onboarding.md)
- Typecheck and protocol tests: `pnpm install && pnpm run check && pnpm run test:run`

The stub intentionally does not execute tasks or expose a network API. It
provides a narrow, testable seam for:

1. register a runner with a control plane;
2. receive one authorized task;
3. report metadata-only status and evidence;
4. buffer events while the control plane is unavailable;
5. preserve enough local state to resume safely.

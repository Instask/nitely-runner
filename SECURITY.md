# Security Policy

Nitely Runner executes local Nitely flows, agent CLIs, shell commands, and Git
operations with the permissions of the customer host that starts it. Treat a
runner assignment as execution of untrusted generated code until a human has
reviewed the resulting changes and evidence.

## Reporting Vulnerabilities

Do not open a public issue for vulnerabilities that expose secrets, repository
contents, authentication material, private prompts, customer paths, or bypasses
of runner/control-plane boundaries.

Use GitHub private vulnerability reporting or a private maintainer channel for:

- runner token, provider credential, or prompt disclosure;
- assignment metadata that can smuggle credentials or runner-local paths;
- unintended file access outside configured customer checkouts;
- unsafe subprocess execution or cancellation handling;
- evidence metadata upload boundary bypasses;
- dependency supply-chain issues that affect runner execution.

If no private channel is available yet, open a public issue with only a short
request for a security contact and no exploit details.

## Supported Versions

This repository is pre-1.0. Security fixes target the current `main` branch
until tagged releases exist. After public release, supported release lines will
be documented here.

## Security Boundaries

The runner is responsible for:

- validating runner-visible assignment metadata before local execution;
- keeping customer checkout paths and local credentials out of control-plane
  payloads;
- using runner-scoped transport credentials only for runner routes;
- reporting status, logs, and evidence metadata without requiring raw customer
  source or provider secrets;
- honoring cooperative cancellation instructions that match the current runner
  identity and assignment.

Hosted services must not weaken these boundaries by requiring raw customer
source, provider credentials, full prompts, or runner-local paths unless an
explicit auditable policy allows it.

# Contributing

Nitely Runner is in bootstrap. The first public contribution path should stay
narrow: small fixes, documentation improvements, tests, runner configuration
examples, and issues that clarify the customer-hosted execution boundary.

## Local Setup

Requirements:

- Node.js 24 or newer.
- npm, or pnpm 11 when available.
- Git.

Install and verify:

```bash
npm install --package-lock=false --ignore-scripts
npm run check
npm run build
npm test -- --run
npm pack --dry-run
```

## Pull Requests

- Keep changes focused and describe the assignment, lifecycle, transport, or
  runner-local execution behavior being changed.
- Add or update tests for behavior changes.
- Do not include local credentials, provider tokens, customer data, generated
  worktrees, `.nitely/runs`, runner state files, or private deployment paths.
- Preserve the runner boundary: the control plane sends metadata and
  instructions; customer checkout paths, local agent credentials, and source
  access remain runner-local.

## Security-Sensitive Changes

Changes touching assignment validation, runner authentication, cancellation,
event reporting, subprocess execution, local state persistence, evidence
metadata, or redaction must describe the boundary being preserved. Follow
[SECURITY.md](SECURITY.md) for vulnerability reporting.

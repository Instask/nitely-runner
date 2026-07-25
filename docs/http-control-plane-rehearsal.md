# HTTP Control-Plane Rehearsal

This rehearsal connects the dependency-free `nitely-control-plane` HTTP
skeleton to `nitely-runner` through the public runner poll/report contract.

It keeps execution local:

- the control plane stores runner and assignment state in memory;
- the runner maps `repoId` to a local checkout path from local config;
- assignments carry repository metadata, source revision, flow id, and flow
  path, but never a runner-local checkout path.

## 1. Start The Control Plane

From `nitely-control-plane`:

```bash
npm start -- --host 127.0.0.1 --port 8787
```

The package binary is equivalent:

```bash
nitely-control-plane serve --host 127.0.0.1 --port 8787
```

## 2. Register A Runner

```bash
curl -sS -X POST http://127.0.0.1:8787/runner/register \
  -H 'content-type: application/json' \
  --data '{
    "tenantId": "tenant-1",
    "runnerId": "runner-1",
    "policyVersion": "policy-1",
    "allowedRepositories": ["repo-1"],
    "version": "0.1.0"
  }'
```

## 3. Seed One Assignment

```bash
curl -sS -X POST http://127.0.0.1:8787/assignments \
  -H 'content-type: application/json' \
  --data '{
    "tenantId": "tenant-1",
    "runnerId": "runner-1",
    "taskId": "task-1",
    "repoId": "repo-1",
    "repository": {
      "repoId": "repo-1",
      "name": "Instask/example",
      "cloneUrl": "https://github.com/Instask/example.git",
      "defaultBranch": "main"
    },
    "sourceRevision": "abc123",
    "flowId": "flow-1",
    "flowPath": "flows/implement.json",
    "inputs": {
      "spec": "docs/spec.md"
    },
    "policyVersion": "policy-1"
  }'
```

## 4. Prepare Runner Config

Copy `examples/http-runner.config.example.json` to a local ignored file such as
`runner.http.local.json`, then replace `/absolute/path/to/customer/repo` with
the local checkout that contains the flow and input files.

The runner config owns the checkout mapping:

```json
{
  "repositoryPaths": {
    "repo-1": "/absolute/path/to/customer/repo"
  }
}
```

## 5. Run One Assignment Cycle

From `nitely-runner`:

```bash
nitely-runner run-once --config runner.http.local.json
```

Expected successful output:

```text
runner cycle handled task=task-1 status=succeeded events=4 rejected=0
runner cycle run=<run-id>
```

`run-once` sends metadata-only heartbeat events before and after the assignment
cycle, then reports accepted/preparing/started/terminal run events for the
assignment itself.

If the control plane rejects an event, the CLI exits non-zero and prints each
rejected event id, kind, and safe reason.

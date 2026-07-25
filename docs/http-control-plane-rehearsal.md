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

## 2. Prepare Runner Config

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

## 3. Register A Runner

From `nitely-runner`:

```bash
nitely-runner register --config runner.http.local.json
```

Expected output:

```text
runner registered tenant=tenant-1 runner=runner-1 policy=policy-1
```

## 4. Seed One Assignment

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

## 5. Run One Assignment Cycle

From `nitely-runner`:

```bash
nitely-runner run-once --config runner.http.local.json
```

For a polling process, use:

```bash
nitely-runner run-loop --config runner.http.local.json
```

`--max-cycles <n>` can bound the loop during local rehearsals and tests.

Expected successful output:

```text
runner cycle handled task=task-1 status=succeeded events=4 rejected=0
runner cycle run=<run-id>
```

`run-once` sends metadata-only heartbeat events before and after the assignment
cycle, then reports accepted/preparing/started/terminal run events for the
assignment itself. The runner reports accepted/preparing before invoking the
local Nitely CLI, reports `run.started` as soon as the executor observes a run
id from stdout, and can abort the active subprocess if
`GET /runner/events?tenantId=...&runnerId=...` returns a matching
`task.cancel_requested` event.

If the control plane rejects an event, the CLI exits non-zero and prints each
rejected event id, kind, and safe reason.

## 6. Verify The Control-Plane Projection

Use the run id printed by `run-once` to verify that the control plane accepted
the terminal runner event and updated its run projection:

```bash
curl -sS "http://127.0.0.1:8787/runs/<run-id>?tenantId=tenant-1"
```

The response should include the run id, task id, repository id, flow path, and a
terminal control-plane status such as `completed`. If the Nitely CLI printed a
change request URL, the projection should include `changeRequestUrl` as well.

import { describe, expect, it } from "vitest";

import { LocalNitelyCliExecutor } from "../src/local-nitely-executor.js";
import type { NitelyCommandInvocation } from "../src/local-nitely-executor.js";

const identity = {
  tenantId: "tenant-1",
  runnerId: "runner-1",
  policyVersion: "policy-1",
  allowedRepositories: ["repo-1"],
  version: "0.1.0",
};

describe("LocalNitelyCliExecutor", () => {
  it("invokes nitely run with runner-local repository mapping, flow, inputs, and env", async () => {
    const calls: NitelyCommandInvocation[] = [];
    const executor = new LocalNitelyCliExecutor({
      command: "node",
      repositoryPaths: { "repo-1": "/work/repo" },
      flowPaths: { "flow-1": "flows/implement.json" },
      env: { PATH: "/bin" },
      runCommand: async (invocation) => {
        calls.push(invocation);
        return {
          exitCode: 0,
          stdout:
            "RUN run-123 completed\nBranch: nitely/run-123\nWorktree: /tmp/worktree\nChange request: https://github.com/Instask/example/pull/1\n",
          stderr: "",
        };
      },
    });

    const result = await executor.execute({
      identity,
      assignment: {
        taskId: "task-1",
        repoId: "repo-1",
        repository: {
          repoId: "repo-1",
          name: "Instask/example",
          cloneUrl: "https://github.com/Instask/example.git",
        },
        sourceRevision: "abc123",
        flowId: "flow-1",
        policyVersion: "policy-1",
        inputs: {
          spec: "docs/spec.md",
          plan: { path: "docs/plan.md" },
        },
      },
    });

    expect(calls).toMatchObject([
      {
        command: "node",
        args: [
          "run",
          "flows/implement.json",
          "--repo",
          "/work/repo",
          "--input",
          "spec=docs/spec.md",
          "--input",
          "plan=docs/plan.md",
        ],
        cwd: "/work/repo",
        env: {
          PATH: "/bin",
          NITELY_RUNNER_ID: "runner-1",
          NITELY_RUNNER_TASK_ID: "task-1",
          NITELY_RUNNER_SOURCE_REVISION: "abc123",
        },
        onStdout: expect.any(Function),
      },
    ]);
    expect(result).toEqual({
      status: "succeeded",
      runId: "run-123",
      changeRequestUrl: "https://github.com/Instask/example/pull/1",
      evidenceSummary: {
        sourceRevision: "abc123",
        flowId: "flow-1",
        flowPath: "flows/implement.json",
      },
    });
  });

  it("uses assignment flowPath but still requires runner-local repository mapping", async () => {
    let call: NitelyCommandInvocation | undefined;
    const executor = new LocalNitelyCliExecutor({
      repositoryPaths: { "repo-1": "/repo/from-runner-config" },
      runCommand: async (invocation) => {
        call = invocation;
        return { exitCode: 0, stdout: "RUN run-local completed\n", stderr: "" };
      },
    });

    await executor.execute({
      identity,
      assignment: {
        taskId: "task-1",
        repoId: "repo-1",
        repository: { repoId: "repo-1", name: "Instask/example" },
        flowId: "flow-1",
        flowPath: ".nitely/flows/flow.json",
        policyVersion: "policy-1",
      },
    });

    expect(call?.args.slice(0, 4)).toEqual([
      "run",
      ".nitely/flows/flow.json",
      "--repo",
      "/repo/from-runner-config",
    ]);
  });

  it("fails safely when repository path is missing", async () => {
    const executor = new LocalNitelyCliExecutor({
      repositoryPaths: {},
      runCommand: async () => {
        throw new Error("must not run");
      },
    });

    await expect(
      executor.execute({
        identity,
        assignment: {
          taskId: "task-1",
          repoId: "repo-1",
          flowId: "flow-1",
          policyVersion: "policy-1",
        },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      failureCategory: "missing_repository_path",
    });
  });

  it("fails safely when assignment inputs are not local-file references", async () => {
    const executor = new LocalNitelyCliExecutor({
      repositoryPaths: { "repo-1": "/work/repo" },
      runCommand: async () => {
        throw new Error("must not run");
      },
    });

    await expect(
      executor.execute({
        identity,
        assignment: {
          taskId: "task-1",
          repoId: "repo-1",
          flowId: "flow-1",
          policyVersion: "policy-1",
          inputs: { issue: { type: "github-issue", id: "275" } },
        },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      failureCategory: "unsupported_assignment_input",
    });
  });

  it("turns a non-zero nitely CLI exit into a safe failed result", async () => {
    const executor = new LocalNitelyCliExecutor({
      repositoryPaths: { "repo-1": "/work/repo" },
      runCommand: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "Missing GitHub token\nTOKEN=secret",
      }),
    });

    await expect(
      executor.execute({
        identity,
        assignment: {
          taskId: "task-1",
          repoId: "repo-1",
          flowId: "flow-1",
          policyVersion: "policy-1",
        },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      failureCategory: "nitely_cli_failed",
      safeMessage: "Missing GitHub token",
    });
  });

  it("observes streamed run start and returns cancelled when aborted", async () => {
    const controller = new AbortController();
    let reportedRunId: string | undefined;
    const executor = new LocalNitelyCliExecutor({
      repositoryPaths: { "repo-1": "/work/repo" },
      runCommand: async (invocation) => {
        await invocation.onStdout?.("RUN run-cancel started\n");
        controller.abort();
        return {
          exitCode: 130,
          stdout: "RUN run-cancel started\n",
          stderr: "",
          cancelled: invocation.signal?.aborted,
        };
      },
    });

    await expect(
      executor.execute({
        identity,
        assignment: {
          taskId: "task-1",
          repoId: "repo-1",
          flowId: "flow-1",
          policyVersion: "policy-1",
        },
        signal: controller.signal,
        onRunStarted: async (runId) => {
          reportedRunId = runId;
        },
      }),
    ).resolves.toEqual({
      status: "cancelled",
      runId: "run-cancel",
      safeMessage: "cancelled by control-plane request",
    });
    expect(reportedRunId).toBe("run-cancel");
  });

  it("fails when the CLI succeeds without a run id", async () => {
    const executor = new LocalNitelyCliExecutor({
      repositoryPaths: { "repo-1": "/work/repo" },
      runCommand: async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }),
    });

    await expect(
      executor.execute({
        identity,
        assignment: {
          taskId: "task-1",
          repoId: "repo-1",
          flowId: "flow-1",
          policyVersion: "policy-1",
        },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      failureCategory: "missing_run_id",
    });
  });
});

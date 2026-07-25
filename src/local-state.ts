import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { RunnerAssignmentStateStore } from "./assignment-runner.js";
import type { RunnerAssignmentProjection } from "./lifecycle.js";

export interface FileRunnerLocalState {
  version: 1;
  assignments: Record<string, RunnerAssignmentProjection>;
  updatedAt?: string;
}

export interface FileRunnerAssignmentStateStoreOptions {
  path: string;
}

export class FileRunnerAssignmentStateStore
  implements RunnerAssignmentStateStore
{
  readonly #path: string;

  constructor(options: FileRunnerAssignmentStateStoreOptions) {
    this.#path = options.path;
  }

  async saveAssignmentProjection(
    projection: RunnerAssignmentProjection,
  ): Promise<void> {
    const state = await readFileRunnerLocalState(this.#path);
    state.assignments[projection.taskId] = projection;
    state.updatedAt = projection.updatedAt;
    await writeFileRunnerLocalState(this.#path, state);
  }
}

export async function readFileRunnerLocalState(
  path: string,
): Promise<FileRunnerLocalState> {
  const raw = await readJsonFile(path);
  if (raw === undefined) {
    return emptyState();
  }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.assignments)) {
    throw new Error("invalid runner local state: version must be 1");
  }
  return {
    version: 1,
    assignments: raw.assignments as Record<string, RunnerAssignmentProjection>,
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
  };
}

async function writeFileRunnerLocalState(
  path: string,
  state: FileRunnerLocalState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function emptyState(): FileRunnerLocalState {
  return { version: 1, assignments: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

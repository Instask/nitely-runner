import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  runOneAssignmentCycle,
  type RunnerCycleResult,
  type RunnerIdentity,
  type RunnerOutboundEventKind,
} from "./assignment-runner.js";
import { FileRunnerControlPlaneClient } from "./file-control-plane.js";
import {
  HttpRunnerControlPlaneClient,
  type RunnerFetch,
} from "./http-control-plane.js";
import {
  LocalNitelyCliExecutor,
  type NitelyCommandRunner,
} from "./local-nitely-executor.js";

export interface FileControlPlaneConfig {
  type: "file";
  path: string;
}

export interface HttpControlPlaneConfig {
  type: "http";
  baseUrl: string;
  headers?: Record<string, string>;
}

export type ControlPlaneConfig =
  | FileControlPlaneConfig
  | HttpControlPlaneConfig;

export interface RunnerConfig {
  identity: RunnerIdentity;
  controlPlane: ControlPlaneConfig;
  nitelyCommand?: string;
  repositoryPaths: Record<string, string>;
  flowPaths: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}

export interface RunConfiguredAssignmentCycleInput {
  config: RunnerConfig;
  now?: () => Date;
  createId?: (kind: RunnerOutboundEventKind) => string;
  runCommand?: NitelyCommandRunner;
  fetch?: RunnerFetch;
}

export interface ConfiguredRunnerComponents {
  identity: RunnerIdentity;
  client: FileRunnerControlPlaneClient | HttpRunnerControlPlaneClient;
  executor: LocalNitelyCliExecutor;
}

export class RunnerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerConfigError";
  }
}

export async function loadRunnerConfig(path: string): Promise<RunnerConfig> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  return parseRunnerConfig(raw, dirname(path));
}

export function parseRunnerConfig(
  value: unknown,
  baseDir = process.cwd(),
): RunnerConfig {
  const root = requireRecord(value, "runner config");
  const identityRecord = requireRecord(root.identity, "identity");
  const controlPlaneRecord = requireRecord(root.controlPlane, "controlPlane");
  const nitelyCommand = optionalString(root, "nitelyCommand");

  const identity: RunnerIdentity = {
    tenantId: requiredString(identityRecord, "tenantId", "identity"),
    runnerId: requiredString(identityRecord, "runnerId", "identity"),
    policyVersion: requiredString(identityRecord, "policyVersion", "identity"),
    allowedRepositories: requiredStringArray(
      identityRecord,
      "allowedRepositories",
      "identity",
    ),
    version: requiredString(identityRecord, "version", "identity"),
  };

  const controlPlaneType = requiredString(
    controlPlaneRecord,
    "type",
    "controlPlane",
  );
  if (controlPlaneType !== "file" && controlPlaneType !== "http") {
    throw new RunnerConfigError(
      `controlPlane.type must be file or http, got ${controlPlaneType}`,
    );
  }

  return {
    identity,
    controlPlane:
      controlPlaneType === "file"
        ? {
            type: "file",
            path: resolvePath(
              baseDir,
              requiredString(controlPlaneRecord, "path", "controlPlane"),
            ),
          }
        : {
            type: "http",
            baseUrl: requiredString(controlPlaneRecord, "baseUrl", "controlPlane"),
            ...(controlPlaneRecord.headers !== undefined
              ? {
                  headers: parseStringMap(
                    controlPlaneRecord.headers,
                    "controlPlane.headers",
                    false,
                  ),
                }
              : {}),
          },
    ...(nitelyCommand !== undefined ? { nitelyCommand } : {}),
    repositoryPaths: parsePathMap(root.repositoryPaths, "repositoryPaths", baseDir),
    flowPaths: parseStringMap(root.flowPaths, "flowPaths", false),
    ...(root.env !== undefined ? { env: parseStringMap(root.env, "env", false) } : {}),
  };
}

export function createConfiguredRunnerComponents(
  input: Pick<
    RunConfiguredAssignmentCycleInput,
    "config" | "runCommand" | "fetch"
  >,
): ConfiguredRunnerComponents {
  const client =
    input.config.controlPlane.type === "file"
      ? new FileRunnerControlPlaneClient({
          path: input.config.controlPlane.path,
        })
      : new HttpRunnerControlPlaneClient({
          baseUrl: input.config.controlPlane.baseUrl,
          headers: input.config.controlPlane.headers,
          fetch: input.fetch,
        });
  const executor = new LocalNitelyCliExecutor({
    command: input.config.nitelyCommand,
    repositoryPaths: input.config.repositoryPaths,
    flowPaths: input.config.flowPaths,
    env: input.config.env,
    runCommand: input.runCommand,
  });
  return { identity: input.config.identity, client, executor };
}

export async function runConfiguredAssignmentCycle(
  input: RunConfiguredAssignmentCycleInput,
): Promise<RunnerCycleResult> {
  const components = createConfiguredRunnerComponents(input);
  return await runOneAssignmentCycle({
    identity: components.identity,
    client: components.client,
    executor: components.executor,
    now: input.now,
    createId: input.createId,
  });
}

function parsePathMap(
  value: unknown,
  name: string,
  baseDir: string,
): Record<string, string> {
  const entries = parseStringMap(value, name, true);
  return Object.fromEntries(
    Object.entries(entries).map(([key, path]) => [key, resolvePath(baseDir, path)]),
  );
}

function parseStringMap(
  value: unknown,
  name: string,
  required: boolean,
): Record<string, string> {
  if (value === undefined) {
    if (required) {
      throw new RunnerConfigError(`${name} is required`);
    }
    return {};
  }
  const record = requireRecord(value, name);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new RunnerConfigError(`${name}.${key} must be a non-empty string`);
    }
    result[key] = entry;
  }
  return result;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  owner: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new RunnerConfigError(`${owner}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new RunnerConfigError(`${key} must be a non-empty string`);
  }
  return value;
}

function requiredStringArray(
  record: Record<string, unknown>,
  key: string,
  owner: string,
): string[] {
  const value = record[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    throw new RunnerConfigError(
      `${owner}.${key} must be a non-empty string array`,
    );
  }
  return value;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RunnerConfigError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function resolvePath(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

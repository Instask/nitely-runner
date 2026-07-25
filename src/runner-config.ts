import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  RUNNER_CONTROL_PLANE_SCHEMA_VERSION,
  runOneAssignmentCycle,
  type RunnerCycleResult,
  type RunnerIdentity,
  type RunnerEventReportResult,
  type RunnerOutboundEventKind,
  type RunnerRegistrationResult,
} from "./assignment-runner.js";
import { FileRunnerControlPlaneClient } from "./file-control-plane.js";
import { reportRunnerHeartbeat } from "./heartbeat.js";
import {
  HttpRunnerControlPlaneClient,
  type RunnerFetch,
} from "./http-control-plane.js";
import { FileRunnerAssignmentStateStore } from "./local-state.js";
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
  runnerToken?: string;
  headers?: Record<string, string>;
}

export type ControlPlaneConfig =
  | FileControlPlaneConfig
  | HttpControlPlaneConfig;

export interface RunnerConfig {
  identity: RunnerIdentity;
  controlPlane: ControlPlaneConfig;
  nitelyCommand?: string;
  runnerStatePath?: string;
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

export interface RunConfiguredRunnerOnceResult {
  cycle: RunnerCycleResult;
  heartbeatReports: RunnerEventReportResult[];
}

export interface RunConfiguredRunnerLoopInput
  extends RunConfiguredAssignmentCycleInput {
  maxCycles?: number;
  pollIntervalMs?: number;
  continueOnError?: boolean;
  sleep?: (durationMs: number) => Promise<void>;
  onCycle?: (
    result: RunConfiguredRunnerOnceResult,
    cycleIndex: number,
  ) => Promise<void> | void;
  onCycleError?: (
    error: unknown,
    cycleIndex: number,
  ) => Promise<void> | void;
}

export interface RunConfiguredRunnerLoopFailure {
  cycleIndex: number;
  safeMessage: string;
}

export interface RunConfiguredRunnerLoopResult {
  cycles: RunConfiguredRunnerOnceResult[];
  failures: RunConfiguredRunnerLoopFailure[];
  attemptedCycles: number;
}

export interface RegisterConfiguredRunnerInput {
  config: RunnerConfig;
  fetch?: RunnerFetch;
}

export interface ConfiguredRunnerComponents {
  identity: RunnerIdentity;
  client: FileRunnerControlPlaneClient | HttpRunnerControlPlaneClient;
  executor: LocalNitelyCliExecutor;
  stateStore?: FileRunnerAssignmentStateStore;
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
  const runnerStatePath = optionalString(root, "runnerStatePath");
  const protocolVersion = parseProtocolVersion(identityRecord);

  const identity: RunnerIdentity = {
    tenantId: requiredString(identityRecord, "tenantId", "identity"),
    runnerId: requiredString(identityRecord, "runnerId", "identity"),
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
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
  const httpRunnerToken =
    controlPlaneType === "http"
      ? optionalString(controlPlaneRecord, "runnerToken")
      : undefined;
  const httpHeaders =
    controlPlaneType === "http" && controlPlaneRecord.headers !== undefined
      ? parseStringMap(controlPlaneRecord.headers, "controlPlane.headers", false)
      : undefined;
  if (httpRunnerToken && httpHeaders && hasAuthorizationHeader(httpHeaders)) {
    throw new RunnerConfigError(
      "controlPlane.runnerToken must not be combined with controlPlane.headers authorization",
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
            ...(httpRunnerToken !== undefined ? { runnerToken: httpRunnerToken } : {}),
            ...(httpHeaders !== undefined ? { headers: httpHeaders } : {}),
          },
    ...(nitelyCommand !== undefined ? { nitelyCommand } : {}),
    ...(runnerStatePath !== undefined
      ? { runnerStatePath: resolvePath(baseDir, runnerStatePath) }
      : {}),
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
          runnerToken: input.config.controlPlane.runnerToken,
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
  const stateStore = input.config.runnerStatePath
    ? new FileRunnerAssignmentStateStore({
        path: input.config.runnerStatePath,
      })
    : undefined;
  return {
    identity: input.config.identity,
    client,
    executor,
    ...(stateStore ? { stateStore } : {}),
  };
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
    stateStore: components.stateStore,
  });
}

export async function registerConfiguredRunner(
  input: RegisterConfiguredRunnerInput,
): Promise<RunnerRegistrationResult> {
  const components = createConfiguredRunnerComponents(input);
  return await components.client.registerRunner(components.identity);
}

export async function runConfiguredRunnerOnce(
  input: RunConfiguredAssignmentCycleInput,
): Promise<RunConfiguredRunnerOnceResult> {
  const components = createConfiguredRunnerComponents(input);
  const heartbeatReports: RunnerEventReportResult[] = [];
  heartbeatReports.push(
    await reportRunnerHeartbeat({
      identity: components.identity,
      client: components.client,
      status: "idle",
      activeRunIds: [],
      now: input.now,
    }),
  );
  const cycle = await runOneAssignmentCycle({
    identity: components.identity,
    client: components.client,
    executor: components.executor,
    now: input.now,
    createId: input.createId,
    stateStore: components.stateStore,
  });
  heartbeatReports.push(
    await reportRunnerHeartbeat({
      identity: components.identity,
      client: components.client,
      status: "idle",
      activeRunIds: [],
      now: input.now,
    }),
  );
  return { cycle, heartbeatReports };
}

export async function runConfiguredRunnerLoop(
  input: RunConfiguredRunnerLoopInput,
): Promise<RunConfiguredRunnerLoopResult> {
  const cycles: RunConfiguredRunnerOnceResult[] = [];
  const failures: RunConfiguredRunnerLoopFailure[] = [];
  let attemptedCycles = 0;
  const maxCycles = input.maxCycles ?? Number.POSITIVE_INFINITY;
  const pollIntervalMs = input.pollIntervalMs ?? 5_000;
  const sleep = input.sleep ?? sleepDuration;
  for (let cycleIndex = 1; cycleIndex <= maxCycles; cycleIndex += 1) {
    attemptedCycles = cycleIndex;
    try {
      const result = await runConfiguredRunnerOnce(input);
      cycles.push(result);
      await input.onCycle?.(result, cycleIndex);
    } catch (error) {
      if (!input.continueOnError) {
        throw error;
      }
      const failure = {
        cycleIndex,
        safeMessage: safeLoopErrorMessage(error),
      };
      failures.push(failure);
      await input.onCycleError?.(error, cycleIndex);
    }
    if (cycleIndex >= maxCycles) {
      break;
    }
    await sleep(pollIntervalMs);
  }
  return { cycles, failures, attemptedCycles };
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

function parseProtocolVersion(
  record: Record<string, unknown>,
): typeof RUNNER_CONTROL_PLANE_SCHEMA_VERSION | undefined {
  const value = optionalString(record, "protocolVersion");
  if (value === undefined) {
    return undefined;
  }
  if (value !== RUNNER_CONTROL_PLANE_SCHEMA_VERSION) {
    throw new RunnerConfigError(
      `identity.protocolVersion must be ${RUNNER_CONTROL_PLANE_SCHEMA_VERSION}`,
    );
  }
  return value;
}

function hasAuthorizationHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
}

async function sleepDuration(durationMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

function safeLoopErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.split("\n")[0]!.slice(0, 500);
  }
  return "runner loop cycle failed";
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

/**
 * spawn_agents — parent-only tool.
 *
 * The default child does not receive this tool, so delegation depth stays at 1.
 * A child whose definition sets `extensions: true` loads the extension and gets
 * this tool too.
 */

import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	defineTool,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { RunRegistry } from "../registry.ts";
import {
	createChildChannel,
	type SpawnContext,
	type SpawnDependencies,
	type SpawnRequest,
	spawnAgents,
} from "../spawn.ts";
import type { RunProgress, SpawnResult } from "../types.ts";
import { childTools } from "./child-tools.ts";

export const DESCRIPTION = "Spawn 1..N child agents in parallel and wait for all results. They can message each other.";

const Task = Type.Object(
	{
		agent: Type.String({ description: "Agent definition name" }),
		task: Type.String({ description: "What that agent should do" }),
		model: Type.Optional(Type.String({ description: "Override model: provider/id" })),
		cwd: Type.Optional(Type.String({ description: "Working directory for that agent" })),
		resume_run_id: Type.Optional(Type.String({ description: "Continue a previous run id" })),
	},
	{ additionalProperties: false },
);

const Parameters = Type.Object(
	{
		tasks: Type.Array(Task, { minItems: 1, description: "Tasks to run concurrently" }),
		context: Type.Optional(
			StringEnum(["fresh", "fork"] as const, {
				description: "fresh: empty context (default); fork: copy this conversation",
			}),
		),
		timeout_seconds: Type.Optional(Type.Number({ description: "Abort every run after this many seconds" })),
	},
	{ additionalProperties: false },
);

export interface SpawnToolOptions {
	registry: RunRegistry;
	/** Injected so tests can run the whole flow without the SDK. */
	dependencies?: (context: { cwd: string; agentDir: string }) => SpawnDependencies;
	nextRunId?: () => string;
}

export function createSpawnAgentsTool(options: SpawnToolOptions) {
	return defineTool({
		name: "spawn_agents",
		label: "Spawn agents",
		description: DESCRIPTION,
		parameters: Parameters,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentDir = getAgentDir();
			const deps = options.dependencies?.({ cwd: ctx.cwd, agentDir }) ?? buildDependencies(options, ctx, agentDir);
			const results = await spawnAgents(spawnRequest(params), spawnContext(ctx, params, signal, onUpdate), deps);
			const usage = totalUsage(results);
			return {
				content: [{ type: "text" as const, text: formatResults(results) }],
				details: { results },
				...(usage === undefined ? {} : { usage }),
			};
		},
	});
}

/** The spawn request as the tool arguments express it. */
export function spawnRequest(params: Static<typeof Parameters>): SpawnRequest {
	return {
		tasks: params.tasks,
		...(params.context === undefined ? {} : { context: params.context }),
		...(params.timeout_seconds === undefined ? {} : { timeoutMs: params.timeout_seconds * 1000 }),
	};
}

/** The spawn context for this turn, including the parent's transcript when forking. */
export function spawnContext(
	ctx: ExtensionContext,
	params: Static<typeof Parameters>,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<SpawnToolDetails> | undefined,
): SpawnContext {
	const parentSessionFile = ctx.sessionManager.getSessionFile();
	return {
		cwd: ctx.cwd,
		...(signal === undefined ? {} : { signal }),
		...(params.context === "fork" ? { parentEntries: [...ctx.sessionManager.getEntries()] } : {}),
		...(parentSessionFile === undefined ? {} : { parentSessionFile }),
		...(onUpdate === undefined ? {} : { onProgress: (progress) => onUpdate(progressResult(progress)) }),
	};
}

/** One readable block per run; failures are labeled, never dropped. */
export function formatResults(results: readonly SpawnResult[]): string {
	return results
		.map((result) => {
			const header = `[${result.agent}] ${result.run_id} (${result.model})`;
			return result.error === undefined ? `${header}\n${result.output ?? ""}` : `${header}\nERROR: ${result.error}`;
		})
		.join("\n\n");
}

/** The tool's structured details: final results, or in-flight progress in the same shape. */
export interface SpawnToolDetails {
	results: SpawnResult[];
}

/** Partial tool result shown while the runs still work. Never reaches the model. */
export function progressResult(progress: readonly RunProgress[]): AgentToolResult<SpawnToolDetails> {
	const results: SpawnResult[] = progress.map((run) => ({
		agent: run.agent,
		run_id: run.run_id,
		model: run.model,
		progress: { activity: run.activity, elapsed_ms: run.elapsed_ms },
		usage: run.usage,
	}));
	return { content: [{ type: "text", text: formatProgress(progress) }], details: { results } };
}

/** One line per live run, for the parent's tool view. */
export function formatProgress(progress: readonly RunProgress[]): string {
	return progress
		.map((run) => `[${run.agent}] ${run.run_id} \u2014 ${run.activity} (${formatElapsed(run.elapsed_ms)})`)
		.join("\n");
}

/** Compact elapsed time: "12s", "2m10s". */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** The full Usage shape the SDK sums into session totals; structural to avoid a pi-ai import. */
export interface ToolUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/**
 * Sum the usage every run reported.
 *
 * Returns undefined when nothing was billed, so a failed call does not add a
 * zero entry to the parent's cost accounting.
 */
export function totalUsage(results: readonly SpawnResult[]): ToolUsage | undefined {
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const result of results) {
		if (result.usage === undefined) continue;
		totals.input += result.usage.input;
		totals.output += result.usage.output;
		totals.cacheRead += result.usage.cacheRead;
		totals.cacheWrite += result.usage.cacheWrite;
		totals.cost += result.usage.cost;
	}
	if (totals.input + totals.output + totals.cacheRead + totals.cacheWrite + totals.cost === 0) return undefined;
	return {
		input: totals.input,
		output: totals.output,
		cacheRead: totals.cacheRead,
		cacheWrite: totals.cacheWrite,
		totalTokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
		// Per-component cost is not reported per run; only the total is summed upstream.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totals.cost },
	};
}

/** The real dependency bundle, bound to the live parent context. */
function buildDependencies(
	options: SpawnToolOptions,
	ctx: { cwd: string; model: unknown; modelRegistry: { getAvailable(): readonly unknown[] } },
	agentDir: string,
): SpawnDependencies {
	const available = ctx.modelRegistry.getAvailable().filter(isModelIdentity);
	const parent = isModelIdentity(ctx.model) ? ctx.model : undefined;
	const sessionDir = join(agentDir, "spawn-sessions");
	return {
		agentDir,
		availableModels: available,
		parentModel: parent,
		registry: options.registry,
		sessionDir,
		findRunSession: (runId, cwd) => findRunSession(sessionDir, cwd, runId),
		nextRunId: options.nextRunId ?? (() => crypto.randomUUID().replaceAll("-", "").slice(0, 8)),
		createChannel: (input) => createChildChannel(input),
		childTools: (input) => childTools(input),
	};
}

/** Find a persisted child transcript by the run id used as its session id. */
export function findRunSession(sessionDir: string, cwd: string, runId: string): string | undefined {
	return SessionManager.findById(cwd, runId, sessionDir);
}

function isModelIdentity(value: unknown): value is { provider: string; id: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"provider" in value &&
		typeof value.provider === "string" &&
		"id" in value &&
		typeof value.id === "string"
	);
}

/**
 * spawn_agents — parent-only tool.
 *
 * The default child does not receive this tool, so delegation depth stays at 1.
 * A child whose definition sets `extensions: true` loads the extension and gets
 * this tool too.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RunRegistry } from "../registry.ts";
import { createChildChannel, type SpawnDependencies, spawnAgents } from "../spawn.ts";
import type { SpawnResult } from "../types.ts";
import { createMessageAgentTool } from "./message-agent.ts";

export const DESCRIPTION = "Spawn 1..N child agents in parallel and wait for all results. They can message each other.";

const Task = Type.Object(
	{
		agent: Type.String({ description: "Agent definition name" }),
		task: Type.String({ description: "What that agent should do" }),
		model: Type.Optional(Type.String({ description: "Override model: provider/id" })),
		cwd: Type.Optional(Type.String({ description: "Working directory for that agent" })),
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
		timeout_ms: Type.Optional(Type.Number({ description: "Abort every run after this many milliseconds" })),
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
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const agentDir = getAgentDir();
			const deps = options.dependencies?.({ cwd: ctx.cwd, agentDir }) ?? buildDependencies(options, ctx, agentDir);
			const entries = ctx.sessionManager.getEntries();
			const results = await spawnAgents(
				{
					tasks: params.tasks,
					...(params.context === undefined ? {} : { context: params.context }),
					...(params.timeout_ms === undefined ? {} : { timeoutMs: params.timeout_ms }),
				},
				{
					cwd: ctx.cwd,
					...(signal === undefined ? {} : { signal }),
					...(params.context === "fork" ? { parentEntries: [...entries] } : {}),
				},
				deps,
			);
			return { content: [{ type: "text" as const, text: formatResults(results) }], details: { results } };
		},
	});
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

/** The real dependency bundle, bound to the live parent context. */
function buildDependencies(
	options: SpawnToolOptions,
	ctx: { model: unknown; modelRegistry: { getAvailable(): readonly unknown[] } },
	agentDir: string,
): SpawnDependencies {
	const available = ctx.modelRegistry.getAvailable().filter(isModelIdentity);
	const parent = isModelIdentity(ctx.model) ? ctx.model : undefined;
	return {
		agentDir,
		availableModels: available,
		parentModel: parent,
		registry: options.registry,
		nextRunId: options.nextRunId ?? (() => crypto.randomUUID().replaceAll("-", "").slice(0, 8)),
		createChannel: (input) => createChildChannel(input),
		childTool: (runId, self, registry) => createMessageAgentTool({ runId, self, registry }),
	};
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

/**
 * spawn_agents — parent-only tool.
 *
 * The default child does not receive this tool, so delegation depth stays at 1.
 * A child whose definition sets `extensions: true` loads the extension and gets
 * this tool too.
 */

import { join } from "node:path";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ContextUsage,
	defineTool,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { definitionRoots } from "../catalog.ts";
import { loadSpawnConfig } from "../config.ts";
import { contextText, formatCost, formatElapsed, formatTokenCount, type TextTheme } from "../format.ts";
import type { RunRegistry } from "../registry.ts";
import {
	createChildChannel,
	displayNames,
	type SpawnContext,
	type SpawnDependencies,
	type SpawnRequest,
	spawnAgents,
} from "../spawn.ts";
import type { RunProgress, RunUsage, SpawnResult } from "../types.ts";
import { childTools } from "./child-tools.ts";

export const DESCRIPTION =
	"Spawn 1..N child agents in parallel and wait for all results. Use for independent subtasks that need no parent input. " +
	"They can message each other.";

/** Output lines one result block shows before the user expands it. */
const RESULT_PREVIEW_LINES = 10;

const Task = Type.Object(
	{
		agent: Type.String({ description: "Agent definition name" }),
		task: Type.String({ description: "What that agent should do" }),
		name: Type.Optional(Type.String({ description: "Short label for this run, shown in progress and results" })),
		model: Type.Optional(Type.String({ description: "Override model: provider/id" })),
		cwd: Type.Optional(Type.String({ description: "Working directory for that agent" })),
		resume_session_id: Type.Optional(Type.String({ description: "Continue a stored session id" })),
		resume_entry_id: Type.Optional(Type.String({ description: "Entry id to continue from in that session" })),
	},
	{ additionalProperties: false },
);

const Parameters = Type.Object(
	{
		tasks: Type.Array(Task, { minItems: 1, description: "Tasks to run concurrently" }),
	},
	{ additionalProperties: false },
);

export interface SpawnToolOptions {
	registry: RunRegistry;
	/** Injected so tests can run the whole flow without the SDK. */
	dependencies?: (context: { cwd: string; agentDir: string; projectTrusted: boolean }) => SpawnDependencies;
	nextSessionId?: () => string;
}

export function createSpawnAgentsTool(options: SpawnToolOptions) {
	const notified = new Set<string>();
	/** Config problems are worth saying once, not on every call. */
	const notifyOnce = (message: string, ctx: ExtensionContext): void => {
		if (notified.has(message) || ctx.hasUI !== true) return;
		notified.add(message);
		ctx.ui.notify(message, "warning");
	};
	return defineTool<typeof Parameters, SpawnToolDetails>({
		name: "spawn_agents",
		label: "Spawn agents",
		description: DESCRIPTION,
		parameters: Parameters,
		renderCall(args, theme) {
			const names = Array.isArray(args.tasks) ? displayNames(args.tasks) : [];
			const label = names.length > 0 ? ` ${names.join(", ")}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("spawn_agents"))}${theme.fg("dim", label)}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			return new Text(renderToolText(result, expanded, isPartial, theme), 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentDir = getAgentDir();
			const projectTrusted = ctx.isProjectTrusted();
			const { config, warnings } = loadSpawnConfig({ cwd: ctx.cwd, agentDir, projectTrusted });
			for (const warning of warnings) notifyOnce(warning, ctx);
			const deps =
				options.dependencies?.({ cwd: ctx.cwd, agentDir, projectTrusted }) ??
				buildDependencies(options, ctx, agentDir, projectTrusted);
			const results = await spawnAgents(
				spawnRequest(params, config.timeoutMs),
				spawnContext(ctx, signal, onUpdate),
				deps,
			);
			const usage = totalUsage(results);
			return {
				content: [{ type: "text" as const, text: formatResults(results) }],
				details: { results },
				...(usage === undefined ? {} : { usage }),
			};
		},
	});
}

/** The spawn request as the tool arguments and the user config express it. */
export function spawnRequest(params: Static<typeof Parameters>, timeoutMs: number): SpawnRequest {
	return {
		tasks: params.tasks,
		...(timeoutMs === 0 ? {} : { timeoutMs }),
	};
}

/** The spawn context for this turn, including a lazy reader for the parent's active branch. */
export function spawnContext(
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<SpawnToolDetails> | undefined,
): SpawnContext {
	const parentSessionFile = ctx.sessionManager.getSessionFile();
	const parentEntryId = ctx.sessionManager.getLeafId() ?? undefined;
	return {
		cwd: ctx.cwd,
		...(signal === undefined ? {} : { signal }),
		// Read only when a definition sets inheritConversation; the closure keeps that cost off the common path.
		// The active branch, not every file entry: abandoned branches are alternative histories.
		parentEntries: () => [...ctx.sessionManager.getBranch()],
		...(parentEntryId === undefined ? {} : { parentEntryId }),
		...(parentSessionFile === undefined ? {} : { parentSessionFile }),
		...(onUpdate === undefined ? {} : { onProgress: (progress) => onUpdate(progressResult(progress)) }),
	};
}

/** One readable block per run; failures are labeled, never dropped. */
export function formatResults(results: readonly SpawnResult[]): string {
	return results
		.map((result) => {
			const header = `[${result.name}] ${sessionKey(result)} (${result.model})`;
			return result.error === undefined ? `${header}\n${result.output ?? ""}` : `${header}\nERROR: ${result.error}`;
		})
		.join("\n\n");
}

/** The model-facing address of a result: session id plus the entry it ended at. */
function sessionKey(result: SpawnResult): string {
	const entry = result.entry_id === undefined ? "" : ` entry_id=${result.entry_id}`;
	return `session_id=${result.session_id}${entry}`;
}

/** The tool's structured details: final results, or in-flight progress in the same shape. */
export interface SpawnToolDetails {
	results: SpawnResult[];
}

/** Partial tool result shown while the runs still work. Never reaches the model. */
export function progressResult(progress: readonly RunProgress[]): AgentToolResult<SpawnToolDetails> {
	const results: SpawnResult[] = progress.map((run) => ({
		name: run.name,
		agent: run.agent,
		session_id: run.session_id,
		model: run.model,
		progress: {
			activity: run.activity,
			elapsed_ms: run.elapsed_ms,
			...(run.preview === undefined ? {} : { preview: run.preview }),
		},
		usage: run.usage,
		...(run.context === undefined ? {} : { context: run.context }),
	}));
	return { content: [{ type: "text", text: formatProgress(progress) }], details: { results } };
}

/** One line per live run, for the parent's tool view: activity, elapsed, stats, then the latest content line. */
export function formatProgress(progress: readonly RunProgress[]): string {
	return progress
		.map((run) => {
			const line = `[${run.name}] session_id=${run.session_id} \u2014 ${run.activity} (${formatElapsed(run.elapsed_ms)})${statsSuffix(run)}`;
			return run.preview === undefined ? line : `${line} \u00b7 ${run.preview}`;
		})
		.join("\n");
}

/** Model, context, and cost for one line. */
function statsSuffix(run: { model: string; usage: RunUsage; context?: ContextUsage }): string {
	const parts = [run.model];
	if (run.context !== undefined) parts.push(contextText(run.context));
	if (run.usage.cost > 0) parts.push(formatCost(run.usage.cost));
	return parts.map((part) => ` \u00b7 ${part}`).join("");
}

/** The UI-only result view: one block per run with output excerpt and the stats the model does not need. */
export function formatResultText(results: readonly SpawnResult[], expanded: boolean, theme: TextTheme): string {
	return results.map((result) => formatResultBlock(result, expanded, theme)).join("\n\n");
}

/** Partial results reuse the one-line progress text; final results get a per-run block. */
function renderToolText(
	result: AgentToolResult<SpawnToolDetails>,
	expanded: boolean,
	isPartial: boolean,
	theme: TextTheme,
): string {
	if (isPartial) {
		const content = result.content.find((part) => part.type === "text");
		return content === undefined ? "" : content.text;
	}
	return formatResultText(result.details.results, expanded, theme);
}

function formatResultBlock(result: SpawnResult, expanded: boolean, theme: TextTheme): string {
	const elapsed = result.elapsed_ms === undefined ? "" : ` \u2014 ${formatElapsed(result.elapsed_ms)}`;
	const header = `${theme.fg("accent", `[${result.name}] session_id=${result.session_id}`)}${theme.fg("dim", ` (${result.model})${elapsed}`)}`;
	const body = result.error === undefined ? excerpt(result.output ?? "", expanded) : `ERROR: ${result.error}`;
	const meta = formatResultMeta(result, theme);
	return [header, body, meta].filter((part) => part.length > 0).join("\n");
}

/** The first lines of a run's output; the full text stays one expansion away. */
function excerpt(text: string, expanded: boolean): string {
	const lines = text.split("\n");
	if (expanded || lines.length <= RESULT_PREVIEW_LINES) return text;
	const hidden = lines.length - RESULT_PREVIEW_LINES;
	return `${lines.slice(0, RESULT_PREVIEW_LINES).join("\n")}\n... (${hidden} more lines)`;
}

/** Tokens, cost, context, transcript, and resume position for one run. */
function formatResultMeta(result: SpawnResult, theme: TextTheme): string {
	const parts: string[] = [];
	if (result.usage !== undefined) {
		const cache = result.usage.cacheRead + result.usage.cacheWrite;
		parts.push(
			`${formatTokenCount(result.usage.input)} in / ${formatTokenCount(result.usage.output)} out` +
				(cache > 0 ? ` / ${formatTokenCount(cache)} cache` : ""),
		);
		if (result.usage.cost > 0) parts.push(formatCost(result.usage.cost));
	}
	if (result.context !== undefined) parts.push(contextText(result.context));
	if (result.entry_id !== undefined) parts.push(`entry ${result.entry_id}`);
	if (result.session_file !== undefined) parts.push(`session ${result.session_file}`);
	return parts.length === 0 ? "" : theme.fg("dim", parts.join(" \u00b7 "));
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
	projectTrusted: boolean,
): SpawnDependencies {
	const available = ctx.modelRegistry.getAvailable().filter(isModelIdentity);
	const parent = isModelIdentity(ctx.model) ? ctx.model : undefined;
	const sessionDir = join(agentDir, "spawn-sessions");
	return {
		definitionRoots: definitionRoots(ctx.cwd, agentDir, projectTrusted),
		agentDir,
		availableModels: available,
		parentModel: parent,
		registry: options.registry,
		sessionDir,
		findRunSession: (sessionId, cwd) => findRunSession(sessionDir, cwd, sessionId),
		sessionHasEntry: (sessionFile, entryId) => hasSessionEntry(sessionFile, entryId),
		nextSessionId: options.nextSessionId ?? (() => crypto.randomUUID().replaceAll("-", "").slice(0, 8)),
		createChannel: (input) => createChildChannel(input),
		childTools: (input) => childTools(input),
	};
}

/** Find a persisted child transcript by the session id its file is named after. */
export function findRunSession(sessionDir: string, cwd: string, sessionId: string): string | undefined {
	return SessionManager.findById(cwd, sessionId, sessionDir);
}

/** Whether a stored transcript contains the entry a resume would branch from. */
export function hasSessionEntry(sessionFile: string, entryId: string): boolean {
	return SessionManager.open(sessionFile).getEntry(entryId) !== undefined;
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

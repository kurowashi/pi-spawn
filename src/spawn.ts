/**
 * Spawning: model resolution, child channel construction, and the concurrent run
 * of one spawn_agents call.
 *
 * Everything the SDK owns sits behind `SpawnDependencies`, so the whole control
 * flow is testable without a model, a network, or a session file.
 */

import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type FileEntry,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./catalog.ts";
import type { RunRegistry } from "./registry.ts";
import type { AgentChannel, AgentDefinition, RunHandle, SpawnResult, SpawnTask } from "./types.ts";

/** The model fields this extension reads. Structurally satisfied by the SDK's Model. */
export interface ModelIdentity {
	provider: string;
	id: string;
}

/** Where the model came from. Reported on every result so an override can never be silent. */
export type ModelSource = "task" | "definition" | "parent";

export type ModelResolution<T> =
	| { model: T; source: ModelSource }
	| { model: undefined; source: undefined; error: string };

/**
 * Resolve the model for one task.
 *
 * Order: task override, then the agent definition, then the parent session.
 * An explicit override that cannot be resolved is an error, never a silent
 * fallback to a different model.
 */
export function resolveModel<T extends ModelIdentity>(input: {
	taskReference: string | undefined;
	definitionReference: string | undefined;
	parent: T | undefined;
	available: readonly T[];
}): ModelResolution<T> {
	if (input.taskReference !== undefined) {
		const model = findModel(input.taskReference, input.available, input.parent?.provider);
		if (model === undefined) return notFound("task model", input.taskReference, input.available);
		return { model, source: "task" };
	}
	if (input.definitionReference !== undefined) {
		const model = findModel(input.definitionReference, input.available, input.parent?.provider);
		if (model === undefined) return notFound("agent model", input.definitionReference, input.available);
		return { model, source: "definition" };
	}
	if (input.parent === undefined) {
		return {
			model: undefined,
			source: undefined,
			error: "no model: the task and the agent definition name none, and the parent session has no current model",
		};
	}
	return { model: input.parent, source: "parent" };
}

/** Match `provider/id` exactly, or a bare id preferring the parent's provider. */
function findModel<T extends ModelIdentity>(
	reference: string,
	available: readonly T[],
	preferredProvider?: string,
): T | undefined {
	const separator = reference.indexOf("/");
	if (separator > 0) {
		const provider = reference.slice(0, separator);
		const id = reference.slice(separator + 1);
		return available.find((model) => model.provider === provider && model.id === id);
	}
	const byId = available.filter((model) => model.id === reference);
	return byId.find((model) => model.provider === preferredProvider) ?? byId[0];
}

function notFound<T extends ModelIdentity>(
	what: string,
	reference: string,
	available: readonly T[],
): ModelResolution<T> {
	const known = available.map((model) => `${model.provider}/${model.id}`).sort();
	return {
		model: undefined,
		source: undefined,
		error: `${what} '${reference}' not found. Available: ${known.join(", ")}`,
	};
}

export interface CreateChannelInput {
	runId: string;
	agent: AgentDefinition;
	cwd: string;
	agentDir: string;
	model: ModelIdentity;
	customTools: ToolDefinition[];
	/** Parent conversation entries when context is "fork". */
	forkEntries?: FileEntry[];
}

/** Mutable ref filled in immediately after the channel exists. */
export interface SelfReference {
	current?: RunHandle;
}

export interface SpawnDependencies {
	agentDir: string;
	availableModels: readonly ModelIdentity[];
	parentModel: ModelIdentity | undefined;
	registry: RunRegistry;
	nextRunId(): string;
	createChannel(input: CreateChannelInput): Promise<AgentChannel>;
	childTool(runId: string, self: SelfReference, registry: RunRegistry): ToolDefinition;
}

export interface SpawnRequest {
	tasks: SpawnTask[];
	context?: "fresh" | "fork";
	timeoutMs?: number;
}

export interface SpawnContext {
	cwd: string;
	signal?: AbortSignal;
	parentEntries?: FileEntry[];
}

interface PlannedRun {
	task: SpawnTask;
	definition: AgentDefinition;
	model: ModelIdentity;
	runId: string;
	cwd: string;
}

/** A run whose channel exists and whose peer list is already known. */
interface StartedRun {
	run: PlannedRun;
	handle: RunHandle;
	briefing: string;
}

/**
 * Run every task concurrently and wait for all of them.
 *
 * Pre-flight failures (unknown agent, unresolvable model) throw before anything
 * starts. A failure during a run is reported in that run's result and does not
 * discard its siblings.
 */
export async function spawnAgents(
	request: SpawnRequest,
	spawnContext: SpawnContext,
	deps: SpawnDependencies,
): Promise<SpawnResult[]> {
	const planned = request.tasks.map((task) => planRun(task, spawnContext.cwd, deps));

	const started = await Promise.all(
		planned.map(async (run) => {
			const self: SelfReference = {};
			const channel = await deps.createChannel({
				runId: run.runId,
				agent: run.definition,
				cwd: run.cwd,
				agentDir: deps.agentDir,
				model: run.model,
				customTools: [deps.childTool(run.runId, self, deps.registry)],
				...(request.context === "fork" && spawnContext.parentEntries !== undefined
					? { forkEntries: spawnContext.parentEntries }
					: {}),
			});
			const handle: RunHandle = {
				runId: run.runId,
				agent: run.definition.name,
				channel,
				hasInboundWait: false,
				induced: new Set(),
				inducedErrors: [],
			};
			self.current = handle;
			deps.registry.add(handle);
			return { run, handle };
		}),
	);

	const abortChildren = (): void => {
		for (const { handle } of started) void handle.channel.abort();
	};
	// One deadline for the whole call: induced turns are work this call caused too.
	const timer = request.timeoutMs === undefined ? undefined : setTimeout(abortChildren, request.timeoutMs);
	spawnContext.signal?.addEventListener("abort", abortChildren, { once: true });

	try {
		const briefed: StartedRun[] = started.map((entry) => ({
			...entry,
			briefing: siblingBriefing(
				entry.handle,
				started.map((candidate) => candidate.handle),
			),
		}));
		const results = await Promise.all(briefed.map((entry) => runOne(entry)));
		await settleInduced(started.map(({ handle }) => handle));
		const errorsByRun = new Map(started.map(({ handle }) => [handle.runId, handle.inducedErrors] as const));
		return results.map((result) => withInducedErrors(result, errorsByRun.get(result.run_id) ?? []));
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		spawnContext.signal?.removeEventListener("abort", abortChildren);
		for (const { handle } of started) deps.registry.remove(handle.runId);
	}
}

/** Wait for every turn a sibling message started, so no child work outlives the call. */
async function settleInduced(handles: readonly RunHandle[]): Promise<void> {
	for (;;) {
		const pending = handles.flatMap((handle) => [...handle.induced]);
		if (pending.length === 0) return;
		await Promise.allSettled(pending);
	}
}

/** Attach induced-turn failures to the run they happened in; failures are labeled, never dropped. */
function withInducedErrors(result: SpawnResult, errors: readonly string[]): SpawnResult {
	if (errors.length === 0) return result;
	const labeled = errors.map((error) => `delivery turn failed: ${error}`);
	if (result.error !== undefined) return { ...result, error: [result.error, ...labeled].join("; ") };
	const output = result.output ?? "";
	return { ...result, output: output.length > 0 ? `${output}\n\n${labeled.join("\n")}` : labeled.join("\n") };
}

/** Resolve definition and model before anything starts. */
function planRun(task: SpawnTask, defaultCwd: string, deps: SpawnDependencies): PlannedRun {
	const definition = findDefinition(task.agent, deps.agentDir);
	const resolution = resolveModel({
		taskReference: task.model,
		definitionReference: definition.model,
		parent: deps.parentModel,
		available: deps.availableModels,
	});
	if (resolution.model === undefined) throw new Error(`agent '${task.agent}': ${resolution.error}`);
	return { task, definition, model: resolution.model, runId: deps.nextRunId(), cwd: task.cwd ?? defaultCwd };
}

function findDefinition(name: string, agentDir: string): AgentDefinition {
	const { agents } = discoverAgents(agentDir);
	const definition = agents.find((agent) => agent.name === name);
	if (definition !== undefined) return definition;
	const known = agents.map((agent) => agent.name).join(", ");
	throw new Error(`unknown agent '${name}'. Defined agents: ${known.length > 0 ? known : "(none)"}`);
}

async function runOne(started: StartedRun): Promise<SpawnResult> {
	const { run, handle, briefing } = started;
	const identity = { agent: run.definition.name, run_id: run.runId, model: `${run.model.provider}/${run.model.id}` };
	try {
		await handle.channel.prompt(`${briefing}${run.task.task}`);
		return { ...identity, output: handle.channel.lastAssistantText() ?? "" };
	} catch (error) {
		return { ...identity, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * The one-line peer list prepended to a run's task when it has siblings.
 *
 * Run ids only exist after the call has been planned, so this is the only way a
 * child can learn them; without it `to: <run id>` would be unusable and two runs
 * of the same agent could not be told apart.
 */
export function siblingBriefing(self: RunHandle, handles: readonly RunHandle[]): string {
	const siblings = handles.filter((handle) => handle.runId !== self.runId);
	if (siblings.length === 0) return "";
	const list = siblings.map((handle) => `${handle.agent} (${handle.runId})`).join(", ");
	return `Siblings you can message with message_agent: ${list}\n\n`;
}

/* ------------------------------------------------------------------ */
/* Real child sessions                                                 */
/* ------------------------------------------------------------------ */

/** Wait budget for a sibling reply before the waiting run gives up. */
const REPLY_TIMEOUT_MS = 120_000;

/** The SDK's session options and model type, named once so the cast stays in one place. */
type SessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
type SessionModel = NonNullable<SessionOptions["model"]>;

/** Create the real in-process child session for one run. */
export async function createChildChannel(input: CreateChannelInput): Promise<AgentChannel> {
	const loader = new DefaultResourceLoader({
		cwd: input.cwd,
		agentDir: input.agentDir,
		noExtensions: true,
		noThemes: true,
		noPromptTemplates: true,
		noSkills: !input.agent.inheritSkills,
		noContextFiles: !input.agent.inheritProjectContext,
		...(input.agent.systemPromptMode === "replace"
			? { systemPrompt: input.agent.body }
			: { appendSystemPrompt: [input.agent.body] }),
	});
	await loader.reload();

	const { session } = await createAgentSession({
		cwd: input.cwd,
		// AgentIdentity is structurally the SDK model; this is the single cast at that boundary.
		model: input.model as SessionModel,
		...(input.agent.thinking === undefined ? {} : { thinkingLevel: input.agent.thinking }),
		customTools: input.customTools,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(input.cwd, undefined, input.forkEntries),
	});

	applyDeclaredTools(
		session,
		input.agent,
		input.customTools.map((tool) => tool.name),
	);
	return wrapSession(session);
}

/** Restrict the child to the definition's tool list, intersected with what the session really has. */
function applyDeclaredTools(session: AgentSession, agent: AgentDefinition, customToolNames: readonly string[]): void {
	if (agent.tools === undefined) return;
	const available = session.getAllTools().map((tool) => tool.name);
	session.setActiveToolsByName(selectActiveTools(agent.tools, customToolNames, available));
}

/**
 * The active tool names for a child whose definition declares a tool list.
 *
 * The declared names are the author's intent and the custom names are the tools
 * this extension injects; both must survive, and neither may name something the
 * session does not actually have. A declared name that the child cannot have
 * (for example a pi-subagents-only tool) is dropped rather than failing the run.
 */
export function selectActiveTools(
	declared: readonly string[],
	customToolNames: readonly string[],
	available: readonly string[],
): string[] {
	const known = new Set(available);
	const wanted = [...declared, ...customToolNames].filter((name) => known.has(name));
	return [...new Set(wanted)];
}

/** Adapt AgentSession to the narrow channel this extension depends on. */
export function wrapSession(session: AgentSession): AgentChannel {
	return {
		prompt: async (text) => {
			await session.prompt(text);
		},
		deliver: async (text) => {
			// The SDK decides turn-vs-queue here: idle starts a turn, running steers.
			await session.sendUserMessage(text, { deliverAs: "steer" });
		},
		abort: async () => {
			await session.abort();
		},
		nextAssistantText: () => waitForAssistantText(session),
		lastAssistantText: () => lastAssistantText(session.messages),
	};
}

function waitForAssistantText(session: AgentSession): Promise<string> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error(`no reply within ${REPLY_TIMEOUT_MS}ms`));
		}, REPLY_TIMEOUT_MS);
		timer.unref();

		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "message_end") return;
			const text = extractAssistantText(event.message);
			if (text === undefined) return;
			clearTimeout(timer);
			unsubscribe();
			resolve(text);
		});
	});
}

/** Text of the last assistant message in a transcript, or undefined when there is none. */
function lastAssistantText(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const text = extractAssistantText(messages[index]);
		if (text !== undefined) return text;
	}
	return undefined;
}

/** Text of an assistant message, or undefined when the message is not assistant text. */
export function extractAssistantText(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	if (!("role" in message) || message.role !== "assistant") return undefined;
	if (!("content" in message)) return undefined;
	const { content } = message;
	if (typeof content === "string") return content.trim() || undefined;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((part): part is { type: "text"; text: string } => isTextPart(part))
		.map((part) => part.text)
		.join("")
		.trim();
	return text.length > 0 ? text : undefined;
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
	if (typeof part !== "object" || part === null) return false;
	if (!("type" in part) || part.type !== "text") return false;
	return "text" in part && typeof part.text === "string";
}

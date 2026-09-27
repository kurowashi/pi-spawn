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
import type {
	AgentChannel,
	AgentDefinition,
	RunHandle,
	RunProgress,
	RunUsage,
	SpawnResult,
	SpawnTask,
} from "./types.ts";

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
		const model = findModel(input.taskReference, input.available);
		if (model === undefined) return notFound("task model", input.taskReference, input.available);
		return { model, source: "task" };
	}
	if (input.definitionReference !== undefined) {
		const model = findModel(input.definitionReference, input.available);
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

/** Match `provider/id` exactly. A bare id names no provider and is not resolved. */
function findModel<T extends ModelIdentity>(reference: string, available: readonly T[]): T | undefined {
	const separator = reference.indexOf("/");
	if (separator <= 0) return undefined;
	const provider = reference.slice(0, separator);
	const id = reference.slice(separator + 1);
	return available.find((model) => model.provider === provider && model.id === id);
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
	/** Directory for persisted child transcripts. Undefined keeps the run in memory. */
	sessionDir?: string;
	/** Parent session file; needed to fork a persisted transcript. */
	parentSessionFile?: string;
	/** Stored transcript to continue instead of starting fresh. */
	resumeSessionFile?: string;
}

/** Everything the child-facing tools need for one run. */
export interface ChildToolInput {
	registry: RunRegistry;
}

export interface SpawnDependencies {
	/** Config roots searched for definitions, highest priority first. */
	definitionRoots: readonly string[];
	agentDir: string;
	availableModels: readonly ModelIdentity[];
	parentModel: ModelIdentity | undefined;
	registry: RunRegistry;
	/** Directory for persisted child transcripts. Fake channels may omit it. */
	sessionDir?: string;
	/** Resolve a persisted run id to its transcript; `cwd` is the working directory the run used. */
	findRunSession(runId: string, cwd: string): string | undefined;
	nextRunId(): string;
	createChannel(input: CreateChannelInput): Promise<AgentChannel>;
	childTools(input: ChildToolInput): ToolDefinition[];
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
	/** Parent session file, when the parent is persisted. */
	parentSessionFile?: string;
	/** Called once immediately, then every interval, with each live run's state. */
	onProgress?: (progress: readonly RunProgress[]) => void;
	/** Progress refresh interval; tests shorten it. Default: 1000ms. */
	progressIntervalMs?: number;
}

interface PlannedRun {
	task: SpawnTask;
	definition: AgentDefinition;
	model: ModelIdentity;
	runId: string;
	cwd: string;
	/** The stored transcript this run continues, when resume_run_id is set. */
	resume?: { from: string; sessionFile: string };
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

	const started = await startRuns(planned, request, spawnContext, deps);

	const abortChildren = (): void => {
		for (const { handle } of started) void handle.channel.abort();
	};
	// One deadline for the whole call: induced turns are work this call caused too.
	const timer = request.timeoutMs === undefined ? undefined : setTimeout(abortChildren, request.timeoutMs);
	spawnContext.signal?.addEventListener("abort", abortChildren, { once: true });

	let stopProgress: (() => void) | undefined;
	try {
		const briefed: StartedRun[] = started.map((entry) => ({
			...entry,
			briefing: siblingBriefing(
				entry.handle,
				started.map((candidate) => candidate.handle),
			),
		}));
		stopProgress = startProgress(briefed, Date.now(), spawnContext);
		const settled = await Promise.all(briefed.map(runWithHandle));
		// Induced turns are this call's work too, so they settle before results are finalized.
		await settleInduced(started.map(({ handle }) => handle));
		const errorsByRun = new Map(started.map(({ handle }) => [handle.runId, handle.inducedErrors] as const));
		return settled.map((entry) => finalizeResult(entry, errorsByRun.get(entry.handle.runId) ?? []));
	} finally {
		stopProgress?.();
		if (timer !== undefined) clearTimeout(timer);
		spawnContext.signal?.removeEventListener("abort", abortChildren);
		for (const { handle } of started) deps.registry.remove(handle.runId);
		await disposeAll(started);
	}
}

/** Create one channel per plan. Nothing this helper created survives a failure inside it. */
async function startRuns(
	planned: readonly PlannedRun[],
	request: SpawnRequest,
	spawnContext: SpawnContext,
	deps: SpawnDependencies,
): Promise<Array<{ run: PlannedRun; handle: RunHandle }>> {
	const started: Array<{ run: PlannedRun; handle: RunHandle }> = [];
	const outcomes = await Promise.allSettled(
		planned.map(async (run) => {
			const channel = await deps.createChannel({
				runId: run.runId,
				agent: run.definition,
				cwd: run.cwd,
				agentDir: deps.agentDir,
				model: run.model,
				customTools: deps.childTools({ registry: deps.registry }),
				...(request.context === "fork" && spawnContext.parentEntries !== undefined
					? { forkEntries: spawnContext.parentEntries }
					: {}),
				...(deps.sessionDir === undefined ? {} : { sessionDir: deps.sessionDir }),
				...(spawnContext.parentSessionFile === undefined ? {} : { parentSessionFile: spawnContext.parentSessionFile }),
				...(run.resume === undefined ? {} : { resumeSessionFile: run.resume.sessionFile }),
			});
			const handle: RunHandle = {
				runId: run.runId,
				agent: run.definition.name,
				channel,
				induced: new Set(),
				inducedErrors: [],
				usageBase: channel.snapshot().usage,
			};
			deps.registry.add(handle);
			started.push({ run, handle });
		}),
	);
	const failure = outcomes.find((outcome) => outcome.status === "rejected");
	if (failure === undefined) return started;
	for (const { handle } of started) deps.registry.remove(handle.runId);
	await disposeAll(started);
	throw failure.reason;
}

/** End every child session; a cleanup failure must not mask the run results. */
async function disposeAll(started: readonly { handle: RunHandle }[]): Promise<void> {
	await Promise.allSettled(started.map(({ handle }) => handle.channel.dispose()));
}

/** Wait for every turn a sibling message started, so no child work outlives the call. */
async function settleInduced(handles: readonly RunHandle[]): Promise<void> {
	for (;;) {
		const pending = handles.flatMap((handle) => [...handle.induced]);
		if (pending.length === 0) return;
		await Promise.allSettled(pending);
	}
}

/** Emit one frame immediately, then every interval, until the returned stop is called. */
function startProgress(briefed: readonly StartedRun[], startedAt: number, spawnContext: SpawnContext): () => void {
	const { onProgress } = spawnContext;
	if (onProgress === undefined) return () => {};
	const report = (): void => onProgress(briefed.map((entry) => runProgress(entry, startedAt)));
	report();
	const timer = setInterval(report, spawnContext.progressIntervalMs ?? PROGRESS_INTERVAL_MS);
	timer.unref();
	return () => clearInterval(timer);
}

/** One frame of progress for a live run. */
function runProgress(entry: StartedRun, startedAt: number): RunProgress {
	const snapshot = entry.handle.channel.snapshot();
	return {
		agent: entry.handle.agent,
		run_id: entry.handle.runId,
		model: modelName(entry.run.model),
		activity: snapshot.activity,
		...(snapshot.preview === undefined ? {} : { preview: snapshot.preview }),
		elapsed_ms: Date.now() - startedAt,
		usage: subtractUsage(snapshot.usage, entry.handle.usageBase),
	};
}

/** `provider/id`, the only model reference this extension produces. */
function modelName(model: ModelIdentity): string {
	return `${model.provider}/${model.id}`;
}

/** Attach induced-turn failures to the run they happened in; failures are labeled, never dropped. */
function withInducedErrors(result: SpawnResult, errors: readonly string[]): SpawnResult {
	if (errors.length === 0) return result;
	const labeled = errors.map((error) => `delivery turn failed: ${error}`);
	if (result.error !== undefined) return { ...result, error: [result.error, ...labeled].join("; ") };
	const output = result.output ?? "";
	return { ...result, output: output.length > 0 ? `${output}\n\n${labeled.join("\n")}` : labeled.join("\n") };
}

/** Resolve definition, model, and any resumed transcript before anything starts. */
function planRun(task: SpawnTask, defaultCwd: string, deps: SpawnDependencies): PlannedRun {
	const definition = findDefinition(task.agent, deps.definitionRoots);
	const resolution = resolveModel({
		taskReference: task.model,
		definitionReference: definition.model,
		parent: deps.parentModel,
		available: deps.availableModels,
	});
	if (resolution.model === undefined) throw new Error(`agent '${task.agent}': ${resolution.error}`);
	const cwd = task.cwd ?? defaultCwd;
	const resume = task.resume_run_id === undefined ? undefined : resolveResume(task.resume_run_id, cwd, deps);
	return {
		task,
		definition,
		model: resolution.model,
		runId: deps.nextRunId(),
		cwd,
		...(resume === undefined ? {} : { resume }),
	};
}

/** The stored transcript for a run id, or a pre-flight error naming the lookup rule. */
function resolveResume(runId: string, cwd: string, deps: SpawnDependencies): { from: string; sessionFile: string } {
	const sessionFile = deps.findRunSession(runId, cwd);
	if (sessionFile !== undefined) return { from: runId, sessionFile };
	throw new Error(
		`unknown run id '${runId}' for cwd '${cwd}'. Resumed runs are found in ${deps.sessionDir ?? "(no session directory)"}`,
	);
}

function findDefinition(name: string, roots: readonly string[]): AgentDefinition {
	const { agents } = discoverAgents(roots);
	const definition = agents.find((agent) => agent.name === name);
	if (definition !== undefined) return definition;
	const known = agents.map((agent) => agent.name).join(", ");
	throw new Error(`unknown agent '${name}'. Defined agents: ${known.length > 0 ? known : "(none)"}`);
}

/** A finished prompt plus the handle it ran on, so results can be finalized after induced turns settle. */
interface SettledRun {
	handle: RunHandle;
	result: SpawnResult;
}

/** Run one prompt and keep its handle for finalization. */
async function runWithHandle(entry: StartedRun): Promise<SettledRun> {
	return { handle: entry.handle, result: await runOne(entry) };
}

/** The caller's view of one run: its latest output, usage, and any induced-turn failure. */
function finalizeResult(entry: SettledRun, inducedErrors: readonly string[]): SpawnResult {
	return withInducedErrors({ ...entry.result, ...latestOutput(entry), ...snapshotFields(entry.handle) }, inducedErrors);
}

/**
 * The run's latest utterance. A sibling-induced turn may have produced text
 * after the first prompt resolved, and that text is what the run concluded.
 */
function latestOutput(entry: SettledRun): Pick<SpawnResult, "output"> {
	if (entry.result.error !== undefined) return {};
	const text = entry.handle.channel.lastAssistantText();
	return text === undefined ? {} : { output: text };
}

async function runOne(started: StartedRun): Promise<SpawnResult> {
	const { run, handle, briefing } = started;
	const identity = {
		agent: run.definition.name,
		run_id: run.runId,
		model: modelName(run.model),
		...(run.resume === undefined ? {} : { resumed_from: run.resume.from }),
	};
	try {
		await handle.channel.prompt(`${briefing}${run.task.task}`);
		return { ...identity, output: handle.channel.lastAssistantText() ?? "" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ...identity, error: message };
	}
}

/** Usage and transcript path as of now; read once the run has stopped for good. */
function snapshotFields(handle: RunHandle): Pick<SpawnResult, "usage" | "session_file"> {
	const snapshot = handle.channel.snapshot();
	return {
		usage: subtractUsage(snapshot.usage, handle.usageBase),
		...(snapshot.sessionFile === undefined ? {} : { session_file: snapshot.sessionFile }),
	};
}

/** The usage billed after the base snapshot; a resumed run already carried earlier turns. */
export function subtractUsage(current: RunUsage, base: RunUsage): RunUsage {
	return {
		input: Math.max(0, current.input - base.input),
		output: Math.max(0, current.output - base.output),
		cacheRead: Math.max(0, current.cacheRead - base.cacheRead),
		cacheWrite: Math.max(0, current.cacheWrite - base.cacheWrite),
		cost: Math.max(0, current.cost - base.cost),
	};
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

/** Refresh interval for the parent's view of live runs. */
const PROGRESS_INTERVAL_MS = 1000;

/** Activity label before the first event arrives. */
const DEFAULT_ACTIVITY = "starting";

/** The SDK's session options and model type, named once so the cast stays in one place. */
type SessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
type SessionModel = NonNullable<SessionOptions["model"]>;

/** Create the real in-process child session for one run. */
export async function createChildChannel(input: CreateChannelInput): Promise<AgentChannel> {
	const loader = new DefaultResourceLoader({
		cwd: input.cwd,
		agentDir: input.agentDir,
		noExtensions: !input.agent.extensions,
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
		sessionManager: createSessionManager(input),
	});

	applyDeclaredTools(
		session,
		input.agent,
		input.customTools.map((tool) => tool.name),
	);
	return wrapSession(session);
}

/**
 * Transcript storage for one run.
 *
 * A resumed run reopens the stored transcript. Otherwise, with a session
 * directory the transcript is persisted under the run id; forked context needs
 * the parent's session file so the forked history lands in the child's file.
 * Without a directory the run stays in memory.
 */
function createSessionManager(input: CreateChannelInput): SessionManager {
	if (input.resumeSessionFile !== undefined) {
		return SessionManager.open(input.resumeSessionFile, input.sessionDir, input.cwd);
	}
	if (input.sessionDir === undefined) return SessionManager.inMemory(input.cwd, undefined, input.forkEntries);
	if (input.forkEntries !== undefined && input.parentSessionFile !== undefined) {
		return SessionManager.forkFrom(input.parentSessionFile, input.cwd, input.sessionDir, { id: input.runId });
	}
	return SessionManager.create(input.cwd, input.sessionDir, { id: input.runId });
}

/** Restrict the child to the definition's tool list plus the injected tools. */
function applyDeclaredTools(session: AgentSession, agent: AgentDefinition, customToolNames: readonly string[]): void {
	if (agent.tools === undefined) return;
	session.setActiveToolsByName(selectActiveTools(agent.tools, customToolNames));
}

/**
 * The active tool names for a child whose definition declares a tool list.
 *
 * The declared names are the author's intent and the custom names are the tools
 * this extension injects; neither should be lost. A name the session has no tool
 * for is dropped by `setActiveToolsByName` itself.
 */
export function selectActiveTools(declared: readonly string[], customToolNames: readonly string[]): string[] {
	return [...new Set([...declared, ...customToolNames])];
}

/** Adapt AgentSession to the narrow channel this extension depends on. */
export function wrapSession(session: AgentSession): AgentChannel {
	const state = trackSessionState(session);
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
		dispose: async () => {
			// The SDK releases extension-scoped resources from `session_shutdown`;
			// dispose() alone only invalidates the runner. The reason union has no
			// child-specific member, and handlers only need "this session is going away".
			try {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			} finally {
				session.dispose();
			}
		},
		lastAssistantText: () => lastAssistantText(session.messages),
		snapshot: () => {
			const sessionFile = session.sessionFile;
			const preview = state.preview();
			return {
				activity: state.activity(),
				...(preview === undefined ? {} : { preview }),
				usage: usageFromStats(session.getSessionStats()),
				...(sessionFile === undefined ? {} : { sessionFile }),
			};
		},
	};
}

/** Longest content preview the parent's one-line progress carries; the full text stays in the child transcript. */
const PREVIEW_MAX_CHARS = 80;

/**
 * Latest activity label and streamed content preview. One subscription serves
 * both; it lives as long as the session does.
 */
function trackSessionState(session: AgentSession): { activity: () => string; preview: () => string | undefined } {
	let activity = DEFAULT_ACTIVITY;
	let line = "";
	let preview: string | undefined;
	session.subscribe((event) => {
		const typed = event as ActivityEvent;
		activity = describeSessionEvent(typed) ?? activity;
		const update = textUpdate(typed);
		if (update === undefined) return;
		if (update.kind === "start") {
			line = "";
			return;
		}
		const segments = update.text.split("\n");
		line = segments.length === 1 ? line + update.text : (segments.at(-1) ?? "");
		const trimmed = line.trim();
		if (trimmed.length > 0) preview = truncatePreview(trimmed);
	});
	return { activity: () => activity, preview: () => preview };
}

/** The slice of a session event this extension turns into a progress label. */
export interface ActivityEvent {
	type: string;
	toolName?: unknown;
	assistantMessageEvent?: unknown;
}

/** What a session event does to the child's current text line. */
export type TextUpdate = { kind: "start" } | { kind: "delta"; text: string };

/**
 * The text-line effect of a session event: a text block starts a new line, a
 * delta extends it, and anything else leaves it alone.
 */
export function textUpdate(event: ActivityEvent): TextUpdate | undefined {
	if (event.type !== "message_update") return undefined;
	const message = event.assistantMessageEvent;
	if (typeof message !== "object" || message === null || !("type" in message)) return undefined;
	if (message.type === "text_start") return { kind: "start" };
	if (message.type !== "text_delta") return undefined;
	return "delta" in message && typeof message.delta === "string" ? { kind: "delta", text: message.delta } : undefined;
}

/** Human-readable activity for events worth reporting; undefined keeps the previous label. */
export function describeSessionEvent(event: ActivityEvent): string | undefined {
	switch (event.type) {
		case "tool_execution_start":
			return typeof event.toolName === "string" ? `tool: ${event.toolName}` : "tool";
		case "message_update":
			return textUpdate(event)?.kind === "delta" ? "writing" : undefined;
		case "turn_start":
			return "thinking";
		default:
			return undefined;
	}
}

/** Bound a preview so one run stays one line in the parent's tool view. */
export function truncatePreview(text: string): string {
	return text.length <= PREVIEW_MAX_CHARS ? text : `${text.slice(0, PREVIEW_MAX_CHARS)}...`;
}

/** Reduce SDK session stats to the usage fields this extension reports. */
export function usageFromStats(stats: {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	cost: number;
}): RunUsage {
	return {
		input: stats.tokens.input,
		output: stats.tokens.output,
		cacheRead: stats.tokens.cacheRead,
		cacheWrite: stats.tokens.cacheWrite,
		cost: stats.cost,
	};
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

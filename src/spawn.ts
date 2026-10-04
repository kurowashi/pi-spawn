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
import { formatElapsed } from "./format.ts";
import type { RunRegistry } from "./registry.ts";
import type {
	AgentChannel,
	AgentDefinition,
	ChannelSnapshot,
	MessageSender,
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
type ModelSource = "task" | "definition" | "parent";

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
	/** Session id for a new run; the stored session's id when resuming. */
	sessionId: string;
	agent: AgentDefinition;
	cwd: string;
	agentDir: string;
	model: ModelIdentity;
	customTools: ToolDefinition[];
	/** Parent conversation entries when the agent definition sets `inheritConversation`. */
	forkEntries?: FileEntry[];
	/** Parent position the copied conversation ends at, when forking a persisted transcript. */
	forkEntryId?: string;
	/** Directory for persisted child transcripts. Undefined keeps the run in memory. */
	sessionDir?: string;
	/** Parent session file; needed to fork a persisted transcript. */
	parentSessionFile?: string;
	/** Stored transcript and branch point to continue instead of starting fresh. */
	resume?: { sessionFile: string; entryId: string };
}

/** Everything the child-facing tools need for one run. */
export interface ChildToolInput {
	registry: RunRegistry;
	/** The child this tool set belongs to, so its messages carry a sender. */
	self: MessageSender;
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
	/** Resolve a persisted session id to its transcript; `cwd` is the working directory the run used. */
	findRunSession(sessionId: string, cwd: string): string | undefined;
	/** Whether the transcript contains the entry a resume would branch from. */
	sessionHasEntry(sessionFile: string, entryId: string): boolean;
	/** Session id for a new run; a resumed run keeps the stored session's id. */
	nextSessionId(): string;
	createChannel(input: CreateChannelInput): Promise<AgentChannel>;
	childTools(input: ChildToolInput): ToolDefinition[];
}

export interface SpawnRequest {
	tasks: SpawnTask[];
	/** Whole-call deadline from the user config; undefined or 0 means no limit. */
	timeoutMs?: number;
}

export interface SpawnContext {
	cwd: string;
	signal?: AbortSignal;
	/** Parent conversation entries, read only when a definition sets `inheritConversation`. */
	parentEntries?: () => FileEntry[];
	/** Parent position the conversation ends at, so a copied transcript resumes on the active branch. */
	parentEntryId?: string;
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
	/** Display label for this run. */
	name: string;
	model: ModelIdentity;
	/** The stored session's id, or a new id for a fresh run. */
	sessionId: string;
	cwd: string;
	/** The stored transcript and branch point this run continues, when resuming. */
	resume?: { sessionId: string; entryId: string; sessionFile: string };
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
	const names = displayNames(request.tasks);
	const planned = request.tasks.map((task, index) => planRun(task, names[index] ?? task.agent, spawnContext.cwd, deps));
	assertDistinctSessions(planned);

	const started = await startRuns(planned, spawnContext, deps);

	const abortRuns = (reason: string): void => {
		for (const { handle } of started) {
			// A settled prompt keeps its own outcome; the abort only cuts a later induced turn.
			if (handle.promptSettled !== true) handle.abortReason = reason;
			void handle.channel.abort();
		}
	};
	const stopWatching = watchAborts(spawnContext.signal, request.timeoutMs, abortRuns);

	let stopProgress: (() => void) | undefined;
	try {
		const briefed: StartedRun[] = started.map((entry) => ({
			...entry,
			briefing: siblingBriefing(
				entry.handle,
				started.map((candidate) => candidate.handle),
			),
		}));
		stopProgress = startProgress(briefed, spawnContext);
		const settled = await Promise.all(briefed.map(runWithHandle));
		// Induced turns are this call's work too, so they settle before results are finalized.
		await settleInduced(started.map(({ handle }) => handle));
		const errorsByRun = new Map(started.map(({ handle }) => [handle.sessionId, handle.inducedErrors] as const));
		return settled.map((entry) => finalizeResult(entry, errorsByRun.get(entry.handle.sessionId) ?? []));
	} finally {
		stopProgress?.();
		stopWatching();
		for (const { handle } of started) deps.registry.remove(handle.sessionId);
		await disposeAll(started);
	}
}

/**
 * Wire the call deadline and the parent's abort signal to one abort callback.
 *
 * One deadline covers the whole call: induced turns are work this call caused
 * too. A signal that already fired aborts immediately, because its event will
 * not fire again. The returned stop removes both, so an event that arrives after
 * the call settled cannot reach channels that were already disposed.
 */
function watchAborts(
	signal: AbortSignal | undefined,
	timeoutMs: number | undefined,
	abort: (reason: string) => void,
): () => void {
	if (signal?.aborted === true) {
		abort("aborted");
		return () => {};
	}
	const onParentAbort = (): void => abort("aborted");
	signal?.addEventListener("abort", onParentAbort, { once: true });
	const timer =
		timeoutMs === undefined || timeoutMs === 0
			? undefined
			: setTimeout(() => abort(`timed out after ${deadlineLabel(timeoutMs)}`), timeoutMs);
	return () => {
		if (timer !== undefined) clearTimeout(timer);
		signal?.removeEventListener("abort", onParentAbort);
	};
}

/** The deadline as the error reports it: milliseconds below one second, else the elapsed form. */
function deadlineLabel(timeoutMs: number): string {
	return timeoutMs < 1000 ? `${timeoutMs}ms` : formatElapsed(timeoutMs);
}

/** Create one channel per plan. Nothing this helper created survives a failure inside it. */
async function startRuns(
	planned: readonly PlannedRun[],
	spawnContext: SpawnContext,
	deps: SpawnDependencies,
): Promise<Array<{ run: PlannedRun; handle: RunHandle }>> {
	const started: Array<{ run: PlannedRun; handle: RunHandle }> = [];
	const outcomes = await Promise.allSettled(
		planned.map(async (run) => {
			const channel = await deps.createChannel({
				sessionId: run.sessionId,
				agent: run.definition,
				cwd: run.cwd,
				agentDir: deps.agentDir,
				model: run.model,
				customTools: deps.childTools({ registry: deps.registry, self: { sessionId: run.sessionId, name: run.name } }),
				...(run.definition.inheritConversation && spawnContext.parentEntries !== undefined
					? { forkEntries: spawnContext.parentEntries() }
					: {}),
				...(run.definition.inheritConversation && spawnContext.parentEntryId !== undefined
					? { forkEntryId: spawnContext.parentEntryId }
					: {}),
				...(deps.sessionDir === undefined ? {} : { sessionDir: deps.sessionDir }),
				...(spawnContext.parentSessionFile === undefined ? {} : { parentSessionFile: spawnContext.parentSessionFile }),
				...(run.resume === undefined
					? {}
					: { resume: { sessionFile: run.resume.sessionFile, entryId: run.resume.entryId } }),
			});
			const handle: RunHandle = {
				sessionId: run.sessionId,
				name: run.name,
				agent: run.definition.name,
				model: modelName(run.model),
				startedAt: Date.now(),
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
	for (const { handle } of started) deps.registry.remove(handle.sessionId);
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
function startProgress(briefed: readonly StartedRun[], spawnContext: SpawnContext): () => void {
	const { onProgress } = spawnContext;
	if (onProgress === undefined) return () => {};
	const report = (): void => onProgress(briefed.map((entry) => runProgress(entry)));
	report();
	const timer = setInterval(report, spawnContext.progressIntervalMs ?? PROGRESS_INTERVAL_MS);
	timer.unref();
	return () => clearInterval(timer);
}

/** One frame of progress for a live run. */
function runProgress(entry: StartedRun): RunProgress {
	const snapshot = entry.handle.channel.snapshot();
	return {
		name: entry.handle.name,
		agent: entry.handle.agent,
		session_id: entry.handle.sessionId,
		model: entry.handle.model,
		activity: snapshot.activity,
		...(snapshot.preview === undefined ? {} : { preview: snapshot.preview }),
		// A settled run's clock stops, so its line keeps the time the run actually took.
		elapsed_ms: runElapsed(entry.handle, snapshot),
		usage: subtractUsage(snapshot.usage, entry.handle.usageBase),
		...(snapshot.context === undefined ? {} : { context: snapshot.context }),
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

/**
 * Display labels for one spawn call: the task's `name`, or the agent name when
 * the call runs that agent once, `agent-1`, `agent-2`, ... when it repeats.
 * Labels are for reading; session ids stay the only addressing key.
 */
export function displayNames(tasks: readonly SpawnTask[]): string[] {
	const counts = new Map<string, number>();
	for (const task of tasks) counts.set(task.agent, (counts.get(task.agent) ?? 0) + 1);
	const seen = new Map<string, number>();
	return tasks.map((task) => {
		// The renderer runs on streamed arguments, which may not match the schema yet.
		const explicit = typeof task.name === "string" ? task.name.trim() : "";
		if (explicit.length > 0) return explicit;
		const index = (seen.get(task.agent) ?? 0) + 1;
		seen.set(task.agent, index);
		return (counts.get(task.agent) ?? 0) > 1 ? `${task.agent}-${index}` : task.agent;
	});
}

/** Resolve definition, model, and any resumed transcript before anything starts. */
function planRun(task: SpawnTask, name: string, defaultCwd: string, deps: SpawnDependencies): PlannedRun {
	const definition = findDefinition(task.agent, deps.definitionRoots);
	const resolution = resolveModel({
		taskReference: task.model,
		definitionReference: definition.model,
		parent: deps.parentModel,
		available: deps.availableModels,
	});
	if (resolution.model === undefined) throw new Error(`agent '${task.agent}': ${resolution.error}`);
	const cwd = task.cwd ?? defaultCwd;
	const resume = resolveResume(task, cwd, deps);
	return {
		task,
		definition,
		name,
		model: resolution.model,
		sessionId: resume?.sessionId ?? deps.nextSessionId(),
		cwd,
		...(resume === undefined ? {} : { resume }),
	};
}

/**
 * The stored session and branch point a task resumes, or a pre-flight error.
 * Both fields are required together, so a resume can never silently continue
 * the abandoned tip of a branched transcript.
 */
function resolveResume(
	task: SpawnTask,
	cwd: string,
	deps: SpawnDependencies,
): { sessionId: string; entryId: string; sessionFile: string } | undefined {
	const sessionId = task.resume_session_id;
	const entryId = task.resume_entry_id;
	if (sessionId === undefined && entryId === undefined) return undefined;
	if (sessionId === undefined) throw new Error(bothResumeFieldsError("resume_session_id"));
	if (entryId === undefined) throw new Error(bothResumeFieldsError("resume_entry_id"));
	const sessionFile = deps.findRunSession(sessionId, cwd);
	if (sessionFile === undefined) throw new Error(unknownSessionError(sessionId, cwd, deps));
	if (!deps.sessionHasEntry(sessionFile, entryId)) {
		throw new Error(`unknown entry '${entryId}' in session '${sessionId}'`);
	}
	return { sessionId, entryId, sessionFile };
}

function unknownSessionError(sessionId: string, cwd: string, deps: SpawnDependencies): string {
	return `unknown session id '${sessionId}' for cwd '${cwd}'. Resumed sessions are found in ${
		deps.sessionDir ?? "(no session directory)"
	}`;
}

function bothResumeFieldsError(missing: string): string {
	return `resume needs both resume_session_id and resume_entry_id (missing ${missing})`;
}

/** One live run per session: two tasks sharing a transcript would corrupt it with concurrent appends. */
function assertDistinctSessions(planned: readonly PlannedRun[]): void {
	const seen = new Set<string>();
	for (const run of planned) {
		if (seen.has(run.sessionId)) throw new Error(`duplicate session id '${run.sessionId}' in one spawn call`);
		seen.add(run.sessionId);
	}
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
	const result = await runOne(entry);
	entry.handle.promptSettled = true;
	return { handle: entry.handle, result };
}

/** The caller's view of one run: its latest output, usage, and any failure. */
function finalizeResult(entry: SettledRun, inducedErrors: readonly string[]): SpawnResult {
	const snapshot = entry.handle.channel.snapshot();
	const result = withInducedErrors(
		{ ...entry.result, ...latestOutput(entry), ...snapshotFields(entry.handle, snapshot) },
		inducedErrors,
	);
	if (result.error !== undefined) return result;
	const failure = failureLabel(entry.handle, snapshot);
	return failure === undefined ? result : { ...result, error: failure };
}

/** Why the run did not finish: an abort this call caused, or the model's own error. */
export function failureLabel(handle: RunHandle, snapshot: ChannelSnapshot): string | undefined {
	if (handle.abortReason !== undefined) return handle.abortReason;
	if (snapshot.outcome?.stopReason === "error") return snapshot.outcome.errorMessage ?? "the model run failed";
	if (snapshot.outcome?.stopReason === "aborted") return "aborted";
	return undefined;
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
		name: run.name,
		agent: run.definition.name,
		session_id: run.sessionId,
		model: modelName(run.model),
	};
	try {
		await handle.channel.prompt(`${briefing}${run.task.task}`);
		return { ...identity, output: handle.channel.lastAssistantText() ?? "" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ...identity, error: message };
	}
}

/** Usage, elapsed time, context, and transcript position as of the given snapshot. */
function snapshotFields(
	handle: RunHandle,
	snapshot: ChannelSnapshot,
): Pick<SpawnResult, "usage" | "context" | "elapsed_ms" | "session_file" | "entry_id"> {
	return {
		usage: subtractUsage(snapshot.usage, handle.usageBase),
		elapsed_ms: runElapsed(handle, snapshot),
		...(snapshot.context === undefined ? {} : { context: snapshot.context }),
		...(snapshot.sessionFile === undefined ? {} : { session_file: snapshot.sessionFile }),
		...(snapshot.entryId === undefined || snapshot.sessionFile === undefined ? {} : { entry_id: snapshot.entryId }),
	};
}

/** A run's elapsed time; a settled run keeps the time it settled at. */
export function runElapsed(handle: RunHandle, snapshot: ChannelSnapshot): number {
	return (snapshot.settledAt ?? Date.now()) - handle.startedAt;
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
 * The peer list prepended to a run's task when it has siblings.
 *
 * Session ids only exist after the call has been planned, so this is the only
 * way a child can learn them; without it `target_session_id` would be unusable
 * and two runs of the same agent could not be told apart. Every line carries
 * the same keys the `message_agent` result uses: session id first, labels as
 * annotations.
 */
function siblingBriefing(self: RunHandle, handles: readonly RunHandle[]): string {
	const siblings = handles.filter((handle) => handle.sessionId !== self.sessionId);
	if (siblings.length === 0) return "";
	const list = siblings
		.map(
			(handle) =>
				`- target_session_id=${handle.sessionId} name=${JSON.stringify(handle.name)} agent=${JSON.stringify(handle.agent)}`,
		)
		.join("\n");
	return `Siblings you can message with message_agent:\n${list}\n\n`;
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
 * A resumed run reopens the stored transcript and moves the leaf to the
 * recorded entry, so later turns become a sibling branch of the abandoned one
 * instead of silently extending it. Otherwise, with a session directory the
 * transcript is persisted under the session id; inherited context copies the
 * parent's active branch (and ends it at the parent's leaf). Without a
 * directory the run stays in memory.
 */
export function createSessionManager(input: CreateChannelInput): SessionManager {
	if (input.resume !== undefined) {
		const manager = SessionManager.open(input.resume.sessionFile, input.sessionDir, input.cwd);
		manager.branch(input.resume.entryId);
		return manager;
	}
	if (input.sessionDir === undefined) {
		return SessionManager.inMemory(input.cwd, { id: input.sessionId }, input.forkEntries);
	}
	if (input.forkEntries !== undefined && input.parentSessionFile !== undefined) {
		const manager = SessionManager.forkFrom(input.parentSessionFile, input.cwd, input.sessionDir, {
			id: input.sessionId,
		});
		// forkFrom copies every entry and leaves the pointer on the last line, which
		// may be an abandoned branch; the parent's leaf is the active branch.
		if (input.forkEntryId !== undefined) manager.branch(input.forkEntryId);
		return manager;
	}
	return SessionManager.create(input.cwd, input.sessionDir, { id: input.sessionId });
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
			const preview = state.preview();
			const settledAt = state.settledAt();
			const context = session.getContextUsage();
			const outcome = lastAssistantOutcome(session.messages);
			return {
				activity: state.activity(),
				...(preview === undefined ? {} : { preview }),
				...(settledAt === undefined ? {} : { settledAt }),
				usage: usageFromStats(session.getSessionStats()),
				...(context === undefined ? {} : { context }),
				...sessionLocation(session),
				...(outcome === undefined ? {} : { outcome }),
			};
		},
	};
}

/** Where the run is persisted and where in that transcript it currently is; both absent in memory. */
function sessionLocation(session: AgentSession): Pick<ChannelSnapshot, "sessionFile" | "entryId"> {
	const sessionFile = session.sessionFile;
	if (sessionFile === undefined) return {};
	const entryId = session.sessionManager.getLeafId() ?? undefined;
	return {
		sessionFile,
		...(entryId === undefined ? {} : { entryId }),
	};
}

/** Longest content preview the parent's one-line progress carries; the full text stays in the child transcript. */
const PREVIEW_MAX_CHARS = 80;

/**
 * Latest activity label and streamed content preview. One subscription serves
 * both; it lives as long as the session does.
 */
function trackSessionState(session: AgentSession): {
	activity: () => string;
	preview: () => string | undefined;
	settledAt: () => number | undefined;
} {
	let activity = DEFAULT_ACTIVITY;
	let line = "";
	let preview: string | undefined;
	let settledAt: number | undefined;
	session.subscribe((event) => {
		const typed = event as ActivityEvent;
		activity = describeSessionEvent(typed) ?? activity;
		settledAt = settledAtAfter(settledAt, typed);
		line = textLineAfter(line, typed);
		const trimmed = line.trim();
		if (trimmed.length > 0) preview = truncatePreview(trimmed);
	});
	return { activity: () => activity, preview: () => preview, settledAt: () => settledAt };
}

/** The settle time after one event: settling sets it, and the next turn clears it. */
function settledAtAfter(settledAt: number | undefined, event: ActivityEvent): number | undefined {
	if (event.type === "agent_settled") return Date.now();
	if (event.type === "turn_start") return undefined;
	return settledAt;
}

/** The current text line after one event; a new text block resets it and a delta extends it. */
function textLineAfter(line: string, event: ActivityEvent): string {
	const update = textUpdate(event);
	if (update === undefined) return line;
	if (update.kind === "start") return "";
	const segments = update.text.split("\n");
	return segments.length === 1 ? line + update.text : (segments.at(-1) ?? "");
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
		case "agent_settled":
			return "done";
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

/** Stop reason and error of the last assistant message, or undefined before one completes. */
export function lastAssistantOutcome(
	messages: readonly unknown[],
): { stopReason: string; errorMessage?: string } | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!isAssistantMessage(message)) continue;
		if (typeof message.stopReason !== "string") return undefined;
		return { stopReason: message.stopReason, ...errorField(message.errorMessage) };
	}
	return undefined;
}

function isAssistantMessage(
	message: unknown,
): message is { role: "assistant"; stopReason?: unknown; errorMessage?: unknown } {
	return typeof message === "object" && message !== null && "role" in message && message.role === "assistant";
}

function errorField(value: unknown): { errorMessage?: string } {
	return typeof value === "string" ? { errorMessage: value } : {};
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

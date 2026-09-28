/**
 * Internal vocabulary. One name per concept, used identically everywhere:
 *
 *   agent   — a definition discovered from `<agentDir>/agents/*.md`
 *   run     — one live child session created by spawn_agents
 *   sibling — a run that shares the same spawn call
 *   task    — the prompt text and overrides for one run
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ContextUsage } from "@earendil-works/pi-coding-agent";

/** A parsed agent definition. Unknown frontmatter keys are reported, not kept. */
export interface AgentDefinition {
	name: string;
	description: string;
	/** Markdown body, used as the child system prompt when systemPromptMode is "replace". */
	body: string;
	/** Declared tool allowlist. Names the child session cannot provide are dropped. */
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	/** "append" (default) keeps Pi's system prompt and adds the body; "replace" uses the body alone. */
	systemPromptMode: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	/** Start the child from a copy of the parent's conversation (default false). */
	inheritConversation: boolean;
	/** Load the configured extensions inside the child session (default false). */
	extensions: boolean;
	path: string;
}

/** Who sent a sibling message: the addressing key and the display label. */
export interface MessageSender {
	sessionId: string;
	name: string;
}

/** One unit of work inside a spawn_agents call. */
export interface SpawnTask {
	agent: string;
	task: string;
	/** Display label for this run. Falls back to the agent name, numbered when the call repeats an agent. */
	name?: string;
	model?: string;
	cwd?: string;
	/** Persisted session to continue instead of starting fresh. */
	resume_session_id?: string;
	/** Entry in that session to continue from; required together with resume_session_id. */
	resume_entry_id?: string;
}

/** Token and cost totals billed to one run. The SDK's Usage, reduced to the fields a child reports. */
export interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Total cost for the run, in the provider's currency. */
	cost: number;
}

/** Everything a live run can report without being stopped. */
export interface ChannelSnapshot {
	/** Short label for the latest activity: "starting", "thinking", "writing", "tool: bash", "done". */
	activity: string;
	/** Last non-empty line of the text the run has streamed, truncated; it stays until the run writes a new line. */
	preview?: string;
	/**
	 * When the session last settled (`agent_settled`); undefined while a run is in flight.
	 * A settled run can still be woken by a sibling message, which clears this again.
	 */
	settledAt?: number;
	usage: RunUsage;
	/** Current context window usage of the child session. */
	context?: ContextUsage;
	/** Persisted transcript path, when the run is file-backed. */
	sessionFile?: string;
	/** Current position in the transcript, when the session has entries. */
	entryId?: string;
	/** How the last assistant message ended; absent before the first message completes. */
	outcome?: { stopReason: string; errorMessage?: string };
}

/** One live run's state, as reported to the parent while a spawn call is in flight. */
export interface RunProgress {
	/** Display label: the task's `name`, or the agent name with a number when the call repeats an agent. */
	name: string;
	agent: string;
	session_id: string;
	model: string;
	activity: string;
	/** Last streamed content line, when the run has written text. */
	preview?: string;
	/** This run's elapsed time; a settled run keeps the value it settled at. */
	elapsed_ms: number;
	usage: RunUsage;
	context?: ContextUsage;
}

/** The result of one run. Failures are reported per run, never as a whole-call failure. */
export interface SpawnResult {
	/** Display label: the task's `name`, or the agent name with a number when the call repeats an agent. */
	name: string;
	agent: string;
	/** Persisted child session; stable across resumes. */
	session_id: string;
	model: string;
	output?: string;
	error?: string;
	/** Partial results only: the run is still working. */
	progress?: { activity: string; elapsed_ms: number; preview?: string };
	/** This run's elapsed time; a settled run keeps the value it settled at. */
	elapsed_ms?: number;
	/** Tokens and cost billed to this run, including sibling-induced turns. */
	usage?: RunUsage;
	/** Current context window usage at the end of the run. */
	context?: ContextUsage;
	/** Persisted child transcript, when the run was file-backed. */
	session_file?: string;
	/** Where the run ended in the transcript; pass it with session_id to resume. */
	entry_id?: string;
}

/**
 * The slice of AgentSession this extension actually uses.
 *
 * Depending on an interface instead of the concrete class keeps unit and
 * integration tests free of the SDK, and keeps the SDK surface we depend on
 * visible in one file.
 */
export interface AgentChannel {
	/** Run one turn to completion. Resolves when the child is idle again. */
	prompt(text: string): Promise<void>;
	/**
	 * Deliver a sibling message as a user turn: starts a turn when the child is
	 * idle, interrupts at the next safe point when it is already running.
	 * Resolves when that turn (or the queueing) is complete.
	 */
	deliver(text: string): Promise<void>;
	abort(): Promise<void>;
	/**
	 * End the child session: emit `session_shutdown` so extensions release their
	 * resources, then dispose the session itself.
	 */
	dispose(): Promise<void>;
	/** Text of the last assistant message, or undefined when there is none. */
	lastAssistantText(): string | undefined;
	/** Current activity, billed usage, and transcript path. Safe to call while the run works. */
	snapshot(): ChannelSnapshot;
}

/** A live child session plus its addressing keys. */
export interface RunHandle {
	/** Persisted session id; the only live address and the resume key. */
	sessionId: string;
	/** Display label shown in progress, results, and the /spawn command. */
	name: string;
	agent: string;
	/** `provider/id` of the model this run uses. */
	model: string;
	/** When this run's channel was created; progress reports elapsed from here. */
	startedAt: number;
	channel: AgentChannel;
	/** Turns a sibling message started; the spawn call owns their completion. */
	induced: Set<Promise<void>>;
	/** Failures from induced turns, reported on this run's result. */
	inducedErrors: string[];
	/** True once this run's own prompt settled; a later abort must not relabel it. */
	promptSettled?: boolean;
	/** Why this run was aborted, when the call or the parent stopped it. */
	abortReason?: string;
	/** Usage already billed before this run started; a resumed run reports only the delta. */
	usageBase: RunUsage;
}

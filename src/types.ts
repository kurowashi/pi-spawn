/**
 * Internal vocabulary. One name per concept, used identically everywhere:
 *
 *   agent   — a definition discovered from `<agentDir>/agents/*.md`
 *   run     — one live child session created by spawn_agents
 *   sibling — a run that shares the same spawn call
 *   task    — the prompt text and overrides for one run
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

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
	/** Load the configured extensions inside the child session (default false). */
	extensions: boolean;
	path: string;
}

/** One unit of work inside a spawn_agents call. */
export interface SpawnTask {
	agent: string;
	task: string;
	model?: string;
	cwd?: string;
	/** Run id of a persisted run to continue instead of starting fresh. */
	resume_run_id?: string;
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
	/** Short label for the latest activity: "starting", "thinking", "writing", "tool: bash". */
	activity: string;
	usage: RunUsage;
	/** Persisted transcript path, when the run is file-backed. */
	sessionFile?: string;
}

/** One live run's state, as reported to the parent while a spawn call is in flight. */
export interface RunProgress {
	agent: string;
	run_id: string;
	model: string;
	activity: string;
	elapsed_ms: number;
	usage: RunUsage;
}

/** The result of one run. Failures are reported per run, never as a whole-call failure. */
export interface SpawnResult {
	agent: string;
	run_id: string;
	model: string;
	output?: string;
	error?: string;
	/** Partial results only: the run is still working. */
	progress?: { activity: string; elapsed_ms: number };
	/** Tokens and cost billed to this run, including sibling-induced turns. */
	usage?: RunUsage;
	/** Present when the run continued a previous run's transcript. */
	resumed_from?: string;
	/** Persisted child transcript, when the run was file-backed. */
	session_file?: string;
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
	/** Resolves with the text of the next assistant message. */
	nextAssistantText(): Promise<string>;
	/** Text of the last assistant message, or undefined when there is none. */
	lastAssistantText(): string | undefined;
	/** Current activity, billed usage, and transcript path. Safe to call while the run works. */
	snapshot(): ChannelSnapshot;
}

/** A live child session plus its addressing keys. */
export interface RunHandle {
	runId: string;
	agent: string;
	channel: AgentChannel;
	/** True while a sibling is blocked waiting for this run's reply. */
	hasInboundWait: boolean;
	/** Turns a sibling message started; the spawn call owns their completion. */
	induced: Set<Promise<void>>;
	/** Failures from induced turns, reported on this run's result. */
	inducedErrors: string[];
	/** Usage already billed before this run started; a resumed run reports only the delta. */
	usageBase: RunUsage;
}

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
	/** Declared tool allowlist. Unknown names are dropped with a warning. */
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	/** "append" (default) keeps Pi's system prompt and adds the body; "replace" uses the body alone. */
	systemPromptMode: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	path: string;
}

/** One unit of work inside a spawn_agents call. */
export interface SpawnTask {
	agent: string;
	task: string;
	model?: string;
	cwd?: string;
}

/** The result of one run. Failures are reported per run, never as a whole-call failure. */
export interface SpawnResult {
	agent: string;
	run_id: string;
	model: string;
	output?: string;
	error?: string;
}

/**
 * The slice of AgentSession this extension actually uses.
 *
 * Depending on an interface instead of the concrete class keeps unit and
 * integration tests free of the SDK, and keeps the SDK surface we depend on
 * visible in one file.
 */
export interface AgentChannel {
	isStreaming(): boolean;
	/** Run one turn to completion. Resolves when the child is idle again. */
	prompt(text: string): Promise<void>;
	/** Interrupt the current turn at the next safe point. */
	steer(text: string): Promise<void>;
	/** Queue for the next turn boundary. */
	followUp(text: string): Promise<void>;
	abort(): Promise<void>;
	/** Resolves with the text of the next assistant message. */
	nextAssistantText(): Promise<string>;
	/** Text of the last assistant message, or undefined when there is none. */
	lastAssistantText(): string | undefined;
}

/** A live child session plus its addressing keys. */
export interface RunHandle {
	runId: string;
	agent: string;
	channel: AgentChannel;
	/** True while a sibling is blocked waiting for this run's reply. */
	hasInboundWait: boolean;
}

/** How the receiving run consumes a message. */
export type DeliveryMode = "steer" | "followUp";

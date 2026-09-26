/**
 * Unit: the AgentSession adapter.
 *
 * The adapter is the one piece of real logic between the SDK and this
 * extension, so it is tested against a fake session rather than left to the
 * integration tests, which cannot see event ordering.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describeSessionEvent, usageFromStats, wrapSession } from "../../src/spawn.ts";
import type { AgentChannel } from "../../src/types.ts";

interface Fake {
	channel: AgentChannel;
	calls: string[];
	emit(event: unknown): void;
}

interface FakeStats {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
}

function makeFake(
	options: { messages?: unknown[]; shutdownError?: string; stats?: FakeStats; sessionFile?: string } = {},
): Fake {
	const listeners = new Set<(event: unknown) => void>();
	const calls: string[] = [];
	const stats = options.stats ?? {
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
	};
	const session = {
		messages: options.messages ?? [],
		sessionFile: options.sessionFile,
		getSessionStats: () => stats,
		prompt: async (text: string) => void calls.push(`prompt:${text}`),
		sendUserMessage: async (text: string, sendOptions?: { deliverAs?: string }) =>
			void calls.push(`sendUserMessage:${text}:${sendOptions?.deliverAs}`),
		abort: async () => void calls.push("abort"),
		extensionRunner: {
			emit: async (event: { type: string }) => {
				calls.push(`emit:${event.type}`);
				if (options.shutdownError !== undefined) throw new Error(options.shutdownError);
			},
		},
		dispose: () => void calls.push("dispose"),
		subscribe: (listener: (event: unknown) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		channel: wrapSession(session as unknown as AgentSession),
		calls,
		emit: (event) => {
			for (const listener of [...listeners]) listener(event);
		},
	};
}

test("proxies every session operation", async () => {
	const fake = makeFake();
	await fake.channel.prompt("task");
	await fake.channel.deliver("message");
	await fake.channel.abort();
	assert.deepEqual(fake.calls, ["prompt:task", "sendUserMessage:message:steer", "abort"]);
});

test("reads the last assistant text, skipping later tool traffic", () => {
	const fake = makeFake({
		messages: [
			{ role: "assistant", content: "the answer" },
			{ role: "tool", content: "result" },
			{ role: "user", content: "next" },
		],
	});
	assert.equal(fake.channel.lastAssistantText(), "the answer");
});

test("has no last assistant text before the first turn", () => {
	assert.equal(makeFake({ messages: [{ role: "user", content: "hi" }] }).channel.lastAssistantText(), undefined);
	assert.equal(makeFake().channel.lastAssistantText(), undefined);
});

test("dispose emits session_shutdown before releasing the session", async () => {
	const fake = makeFake();
	await fake.channel.dispose();
	assert.deepEqual(fake.calls, ["emit:session_shutdown", "dispose"]);
});

test("releases the session even when a shutdown handler fails", async () => {
	const fake = makeFake({ shutdownError: "handler exploded" });
	await assert.rejects(() => fake.channel.dispose(), /handler exploded/);
	assert.ok(fake.calls.includes("dispose"));
});

test("snapshot reports billed usage and the transcript path", () => {
	const fake = makeFake({
		sessionFile: "/tmp/child.jsonl",
		stats: { tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 }, cost: 0.5 },
	});
	assert.deepEqual(fake.channel.snapshot(), {
		activity: "starting",
		usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 0.5 },
		sessionFile: "/tmp/child.jsonl",
	});
});

test("snapshot omits the transcript path for an in-memory run", () => {
	const snapshot = makeFake().channel.snapshot();
	assert.equal(snapshot.sessionFile, undefined);
	assert.deepEqual(snapshot.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
});

test("tracks the latest activity from session events", () => {
	const fake = makeFake();
	fake.emit({ type: "turn_start" });
	assert.equal(fake.channel.snapshot().activity, "thinking");
	fake.emit({ type: "tool_execution_start", toolName: "bash" });
	assert.equal(fake.channel.snapshot().activity, "tool: bash");
	fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } });
	assert.equal(fake.channel.snapshot().activity, "writing");
	fake.emit({ type: "message_end", message: { role: "assistant" } });
	assert.equal(fake.channel.snapshot().activity, "writing", "uninteresting events keep the last label");
});

test("labels only the events worth reporting", () => {
	assert.equal(describeSessionEvent({ type: "tool_execution_start" }), "tool");
	assert.equal(describeSessionEvent({ type: "tool_execution_start", toolName: "read" }), "tool: read");
	assert.equal(
		describeSessionEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }),
		undefined,
	);
	assert.equal(describeSessionEvent({ type: "agent_end" }), undefined);
});

test("reduces session stats to the reported usage fields", () => {
	assert.deepEqual(usageFromStats({ tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, cost: 0.25 }), {
		input: 1,
		output: 2,
		cacheRead: 3,
		cacheWrite: 4,
		cost: 0.25,
	});
});

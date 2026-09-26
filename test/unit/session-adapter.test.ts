/**
 * Unit: the AgentSession adapter.
 *
 * The reply-capture path is the one piece of real logic between the SDK and this
 * extension, so it is tested against a fake session rather than left to the
 * integration tests, which cannot see event ordering.
 *
 * The reply timeout is intentionally not tested: it is a wall-clock constant,
 * and a test that sleeps for it would be worse than no test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { wrapSession } from "../../src/spawn.ts";
import type { AgentChannel } from "../../src/types.ts";

interface Fake {
	channel: AgentChannel;
	calls: string[];
	emit(event: unknown): void;
}

function makeFake(options: { messages?: unknown[]; shutdownError?: string } = {}): Fake {
	const listeners = new Set<(event: unknown) => void>();
	const calls: string[] = [];
	const session = {
		messages: options.messages ?? [],
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

test("resolves the waiting run with the first assistant message", async () => {
	const fake = makeFake();
	const reply = fake.channel.nextAssistantText();

	fake.emit({ type: "message_end", message: { role: "tool", content: "not a reply" } });
	fake.emit({ type: "tool_execution_start", toolName: "read" });
	fake.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "the answer" }] } });

	assert.equal(await reply, "the answer");
});

test("stops listening once the reply arrived", async () => {
	const fake = makeFake();
	const reply = fake.channel.nextAssistantText();
	fake.emit({ type: "message_end", message: { role: "assistant", content: "first" } });
	assert.equal(await reply, "first");
	// A second emission must not throw after the subscription was removed.
	fake.emit({ type: "message_end", message: { role: "assistant", content: "second" } });
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

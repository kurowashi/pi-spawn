/**
 * Unit: sibling addressing, delivery, and the wait rules.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverMessage, waitRefusal } from "../../src/deliver.ts";
import { createRunRegistry, resolveTarget } from "../../src/registry.ts";
import type { AgentChannel, RunHandle } from "../../src/types.ts";

function handle(runId: string, agent: string, channel: Partial<AgentChannel> = {}): RunHandle {
	return {
		runId,
		agent,
		hasInboundWait: false,
		induced: new Set(),
		inducedErrors: [],
		channel: {
			prompt: async () => {},
			deliver: async () => {},
			abort: async () => {},
			dispose: async () => {},
			nextAssistantText: () => Promise.resolve("reply"),
			lastAssistantText: () => "output",
			snapshot: () => ({ activity: "idle", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }),
			...channel,
		},
	};
}

test("resolves a run id before a name", () => {
	const runs = [handle("aaa", "reviewer"), handle("bbb", "reviewer")];
	const byId = resolveTarget("bbb", runs);
	assert.ok(byId.ok);
	assert.equal(byId.handle.runId, "bbb");
});

test("resolves a unique agent name", () => {
	const result = resolveTarget("writer", [handle("aaa", "reviewer"), handle("bbb", "writer")]);
	assert.ok(result.ok);
	assert.equal(result.handle.runId, "bbb");
});

test("reports an ambiguous name with its candidates", () => {
	const result = resolveTarget("reviewer", [handle("aaa", "reviewer"), handle("bbb", "reviewer")]);
	assert.equal(result.ok, false);
	assert.ok(!result.ok && result.reason === "ambiguous" && result.candidates.length === 2);
});

test("reports an unknown target", () => {
	const result = resolveTarget("nope", [handle("aaa", "reviewer")]);
	assert.ok(!result.ok && result.reason === "not_found");
});

test("the registry only exposes live runs", () => {
	const registry = createRunRegistry();
	registry.add(handle("aaa", "reviewer"));
	registry.remove("aaa");
	assert.equal(registry.resolve("aaa").ok, false);
});

test("a run cannot wait on itself or on a busy recipient", () => {
	const self = handle("aaa", "reviewer");
	assert.ok(waitRefusal(self, self)?.includes("itself"));

	const busy = handle("bbb", "writer");
	busy.hasInboundWait = true;
	assert.ok(waitRefusal(self, busy)?.includes("already answering"));

	const free = handle("ccc", "writer");
	assert.equal(waitRefusal(self, free), undefined);
});

test("delivery always uses the one primitive, whatever the recipient is doing", async () => {
	const calls: string[] = [];
	const target = handle("bbb", "writer", { deliver: async (text) => void calls.push(`deliver:${text}`) });
	await deliverMessage({ waiter: handle("aaa", "reviewer"), target, text: "hi", wait: false });
	assert.deepEqual(calls, ["deliver:hi"]);
});

test("fire-and-forget returns before the turn it started settles", async () => {
	let settle!: () => void;
	const turn = new Promise<void>((resolve) => {
		settle = resolve;
	});
	const target = handle("bbb", "writer", {
		deliver: () => turn,
		nextAssistantText: () => Promise.reject(new Error("must not be called")),
	});
	const outcome = await deliverMessage({ waiter: handle("aaa", "reviewer"), target, text: "hi", wait: false });
	assert.deepEqual(outcome, { delivered: true });
	assert.equal(target.induced.size, 1, "the turn is tracked for the spawn call");
	settle();
	await turn;
});

test("wait returns the reply, not the end of the turn", async () => {
	const target = handle("bbb", "writer", {
		deliver: () => new Promise<void>(() => undefined),
		nextAssistantText: () => Promise.resolve("pong"),
	});
	const outcome = await deliverMessage({ waiter: handle("aaa", "reviewer"), target, text: "ping", wait: true });
	assert.deepEqual(outcome, { delivered: true, reply: "pong" });
	assert.equal(target.hasInboundWait, false);
});

test("a delivery that fails before the reply is reported to the waiter", async () => {
	const target = handle("bbb", "writer", {
		deliver: async () => {
			throw new Error("session is closed");
		},
		nextAssistantText: () => new Promise<string>(() => undefined),
	});
	const outcome = await deliverMessage({ waiter: handle("aaa", "reviewer"), target, text: "hi", wait: true });
	assert.deepEqual(outcome, { delivered: false, error: "session is closed" });
	assert.equal(target.hasInboundWait, false);
});

test("a failed turn started without waiting is recorded on the target", async () => {
	const target = handle("bbb", "writer", {
		deliver: async () => {
			throw new Error("session is closed");
		},
	});
	const outcome = await deliverMessage({ waiter: handle("aaa", "reviewer"), target, text: "hi", wait: false });
	assert.deepEqual(outcome, { delivered: true });
	assert.deepEqual(target.inducedErrors, ["session is closed"]);
});

test("wait is refused while the target is already answering, and the flag is left alone", async () => {
	const target = handle("bbb", "writer");
	target.hasInboundWait = true;
	const outcome = await deliverMessage({ waiter: handle("aaa", "reviewer"), target, text: "ping", wait: true });
	assert.equal(outcome.delivered, false);
	assert.ok(!outcome.delivered && outcome.error.includes("already answering"));
	assert.equal(target.hasInboundWait, true, "a refused wait must not steal a flag it never set");
});

test("a failing reply clears the inbound flag", async () => {
	const target = handle("bbb", "writer", { nextAssistantText: () => Promise.reject(new Error("timeout")) });
	const outcome = await deliverMessage({ waiter: handle("aaa", "reviewer"), target, text: "hi", wait: true });
	assert.equal(outcome.delivered, false);
	assert.equal(target.hasInboundWait, false);
});

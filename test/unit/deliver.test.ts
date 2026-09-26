/**
 * Unit: sibling addressing and the delivery/deadlock rules.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverMessage, deliveryMode, waitRefusal } from "../../src/deliver.ts";
import { createRunRegistry, resolveTarget } from "../../src/registry.ts";
import type { AgentChannel, RunHandle } from "../../src/types.ts";

function handle(runId: string, agent: string, channel: Partial<AgentChannel> = {}): RunHandle {
	return {
		runId,
		agent,
		hasInboundWait: false,
		channel: {
			isStreaming: () => false,
			prompt: async () => {},
			steer: async () => {},
			followUp: async () => {},
			abort: async () => {},
			nextAssistantText: () => Promise.resolve("reply"),
			lastAssistantText: () => "output",
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

test("delivery mode follows the recipient state", () => {
	assert.equal(deliveryMode(true), "steer");
	assert.equal(deliveryMode(false), "followUp");
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

test("fire-and-forget does not touch the reply path", async () => {
	const calls: string[] = [];
	const target = handle("bbb", "writer", {
		isStreaming: () => true,
		steer: async (text) => {
			calls.push(`steer:${text}`);
		},
		nextAssistantText: () => Promise.reject(new Error("must not be called")),
	});
	const outcome = await deliverMessage({ waiter: handle("aaa", "reviewer"), target, text: "hi", wait: false });
	assert.deepEqual(outcome, { delivered: true });
	assert.deepEqual(calls, ["steer:hi"]);
});

test("an idle recipient is queued instead of interrupted", async () => {
	const calls: string[] = [];
	const target = handle("bbb", "writer", {
		isStreaming: () => false,
		followUp: async (text) => {
			calls.push(`followUp:${text}`);
		},
	});
	await deliverMessage({ waiter: handle("aaa", "reviewer"), target, text: "hi", wait: false });
	assert.deepEqual(calls, ["followUp:hi"]);
});

test("wait returns the recipient reply and clears the inbound flag", async () => {
	const target = handle("bbb", "writer", { nextAssistantText: () => Promise.resolve("pong") });
	const outcome = await deliverMessage({ waiter: handle("aaa", "reviewer"), target, text: "ping", wait: true });
	assert.deepEqual(outcome, { delivered: true, reply: "pong" });
	assert.equal(target.hasInboundWait, false);
});

test("wait is refused while the target is already answering, and the flag is left alone", async () => {
	const target = handle("bbb", "writer");
	target.hasInboundWait = true;
	const outcome = await deliverMessage({ waiter: handle("aaa", "reviewer"), target, text: "ping", wait: true });
	assert.equal(outcome.delivered, false);
	assert.ok(!outcome.delivered && outcome.error.includes("already answering"));
	assert.equal(target.hasInboundWait, true, "a refused wait must not steal a flag it never set");
});

test("a failing delivery is reported, not thrown", async () => {
	const target = handle("bbb", "writer", {
		followUp: async () => {
			throw new Error("session is closed");
		},
	});
	const outcome = await deliverMessage({ waiter: handle("aaa", "reviewer"), target, text: "hi", wait: false });
	assert.deepEqual(outcome, { delivered: false, error: "session is closed" });
});

test("a failing reply clears the inbound flag", async () => {
	const target = handle("bbb", "writer", { nextAssistantText: () => Promise.reject(new Error("timeout")) });
	const outcome = await deliverMessage({ waiter: handle("aaa", "reviewer"), target, text: "hi", wait: true });
	assert.equal(outcome.delivered, false);
	assert.equal(target.hasInboundWait, false);
});

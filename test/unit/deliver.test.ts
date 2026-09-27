/**
 * Unit: sibling addressing and one-way delivery.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverMessage } from "../../src/deliver.ts";
import { createRunRegistry, resolveTarget } from "../../src/registry.ts";
import type { AgentChannel, RunHandle } from "../../src/types.ts";

function handle(runId: string, agent: string, channel: Partial<AgentChannel> = {}): RunHandle {
	return {
		runId,
		agent,
		startedAt: 0,
		induced: new Set(),
		inducedErrors: [],
		usageBase: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		channel: {
			prompt: async () => {},
			deliver: async () => {},
			abort: async () => {},
			dispose: async () => {},
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

test("delivery is one-way, whatever the recipient is doing", async () => {
	const calls: string[] = [];
	const target = handle("bbb", "writer", { deliver: async (text) => void calls.push(`deliver:${text}`) });
	const outcome = await deliverMessage({ target, text: "hi" });
	assert.deepEqual(outcome, { delivered: true });
	assert.deepEqual(calls, ["deliver:hi"]);
});

test("delivery returns before the turn it started settles", async () => {
	let settle!: () => void;
	const turn = new Promise<void>((resolve) => {
		settle = resolve;
	});
	const target = handle("bbb", "writer", { deliver: () => turn });
	const outcome = await deliverMessage({ target, text: "hi" });
	assert.deepEqual(outcome, { delivered: true });
	assert.equal(target.induced.size, 1, "the turn is tracked for the spawn call");
	settle();
	await turn;
});

test("a synchronous delivery failure is reported to the sender", async () => {
	const target = handle("bbb", "writer", {
		deliver: () => {
			throw new Error("session is closed");
		},
	});
	const outcome = await deliverMessage({ target, text: "hi" });
	assert.deepEqual(outcome, { delivered: false, error: "session is closed" });
});

test("a failed turn is recorded on the target, not thrown to the sender", async () => {
	const target = handle("bbb", "writer", {
		deliver: async () => {
			throw new Error("session is closed");
		},
	});
	const outcome = await deliverMessage({ target, text: "hi" });
	assert.deepEqual(outcome, { delivered: true });
	assert.deepEqual(target.inducedErrors, ["session is closed"]);
});

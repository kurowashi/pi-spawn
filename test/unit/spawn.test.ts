/**
 * Unit: model resolution order and reply text extraction.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createAskQueue,
	extractAssistantText,
	resolveModel,
	selectActiveTools,
	subtractUsage,
} from "../../src/spawn.ts";

const available = [
	{ provider: "fixture", id: "parent" },
	{ provider: "fixture", id: "worker" },
	{ provider: "other", id: "worker" },
];

test("the task override wins and is reported as the source", () => {
	const resolution = resolveModel({
		taskReference: "other/worker",
		definitionReference: "fixture/worker",
		parent: available[0],
		available,
	});
	assert.ok(resolution.model);
	assert.equal(resolution.source, "task");
	assert.equal(resolution.model.provider, "other");
});

test("the definition wins over the parent", () => {
	const resolution = resolveModel({
		taskReference: undefined,
		definitionReference: "fixture/worker",
		parent: available[0],
		available,
	});
	assert.equal(resolution.source, "definition");
	assert.equal(resolution.model?.id, "worker");
});

test("the parent model is the last resort and is reported as such", () => {
	const resolution = resolveModel({
		taskReference: undefined,
		definitionReference: undefined,
		parent: available[0],
		available,
	});
	assert.equal(resolution.source, "parent");
	assert.equal(resolution.model?.id, "parent");
});

test("a bare id is not resolved: provider/id is required", () => {
	const resolution = resolveModel({
		taskReference: "worker",
		definitionReference: undefined,
		parent: available[0],
		available,
	});
	assert.equal(resolution.model, undefined);
	assert.ok(resolution.error.includes("worker"));
});

test("an unresolvable override is an error, never a silent fallback", () => {
	const resolution = resolveModel({
		taskReference: "fixture/missing",
		definitionReference: undefined,
		parent: available[0],
		available,
	});
	assert.equal(resolution.model, undefined);
	assert.ok(resolution.error.includes("fixture/missing"));
	assert.ok(resolution.error.includes("fixture/parent"), "the error lists what is available");
});

test("an unresolvable definition model is an error too", () => {
	const resolution = resolveModel({
		taskReference: undefined,
		definitionReference: "ghost/model",
		parent: available[0],
		available,
	});
	assert.equal(resolution.model, undefined);
	assert.ok(resolution.error.includes("ghost/model"));
});

test("no model anywhere is an error", () => {
	const resolution = resolveModel({
		taskReference: undefined,
		definitionReference: undefined,
		parent: undefined,
		available,
	});
	assert.equal(resolution.model, undefined);
	assert.ok(resolution.error.includes("no model"));
});

test("reads assistant text from both content shapes", () => {
	assert.equal(extractAssistantText({ role: "assistant", content: "  hello  " }), "hello");
	assert.equal(
		extractAssistantText({
			role: "assistant",
			content: [
				{ type: "text", text: "a" },
				{ type: "image", data: "..." },
				{ type: "text", text: "b" },
			],
		}),
		"ab",
	);
});

test("ignores anything that is not assistant text", () => {
	assert.equal(extractAssistantText({ role: "user", content: "hi" }), undefined);
	assert.equal(extractAssistantText({ role: "assistant", content: [] }), undefined);
	assert.equal(extractAssistantText({ role: "assistant", content: "   " }), undefined);
	assert.equal(extractAssistantText(undefined), undefined);
	assert.equal(extractAssistantText("text"), undefined);
});

test("a declared tool list always keeps the injected child tool", () => {
	// The session drops names it has no tool for; this merge must not drop the
	// child's own message tool along with them.
	assert.deepEqual(selectActiveTools(["read", "contact_supervisor"], ["message_agent"]), [
		"read",
		"contact_supervisor",
		"message_agent",
	]);
});

test("a declared tool list is deduplicated", () => {
	assert.deepEqual(selectActiveTools(["read", "read"], ["message_agent"]), ["read", "message_agent"]);
	assert.deepEqual(selectActiveTools([], ["message_agent"]), ["message_agent"]);
});

test("the ask queue runs one question at a time", async () => {
	const events: string[] = [];
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ask = createAskQueue(async (question) => {
		events.push(`start:${question}`);
		if (question === "one") await gate;
		events.push(`end:${question}`);
		return question;
	});

	const first = ask("one");
	const second = ask("two");
	await Promise.resolve();
	assert.deepEqual(events, ["start:one"], "the second question waits for the first");

	release?.();
	assert.equal(await first, "one");
	assert.equal(await second, "two");
	assert.deepEqual(events, ["start:one", "end:one", "start:two", "end:two"]);
});

test("a failed question does not block the next one", async () => {
	const ask = createAskQueue(async (question) => {
		if (question === "bad") throw new Error("dialog failed");
		return question;
	});

	await assert.rejects(() => ask("bad"), /dialog failed/);
	assert.equal(await ask("good"), "good");
});

test("subtracts the base usage so a resumed run reports only its own turns", () => {
	assert.deepEqual(
		subtractUsage(
			{ input: 15, output: 25, cacheRead: 5, cacheWrite: 7, cost: 0.75 },
			{ input: 10, output: 20, cacheRead: 2, cacheWrite: 3, cost: 0.5 },
		),
		{ input: 5, output: 5, cacheRead: 3, cacheWrite: 4, cost: 0.25 },
	);
	// A stored session never bills less than its base; a negative delta is clamped to zero.
	assert.deepEqual(
		subtractUsage(
			{ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, cost: 0.1 },
			{ input: 2, output: 2, cacheRead: 2, cacheWrite: 2, cost: 0.2 },
		),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	);
});

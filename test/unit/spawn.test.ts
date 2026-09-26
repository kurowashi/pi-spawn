/**
 * Unit: model resolution order and reply text extraction.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { extractAssistantText, resolveModel, selectActiveTools } from "../../src/spawn.ts";

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

test("a bare id prefers the parent provider", () => {
	const resolution = resolveModel({
		taskReference: "worker",
		definitionReference: undefined,
		parent: available[0],
		available,
	});
	assert.equal(resolution.model?.provider, "fixture");
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
	// A definition written for pi-subagents declares a tool this extension does not
	// provide; it must be dropped without dropping the child's own message tool.
	assert.deepEqual(
		selectActiveTools(["read", "contact_supervisor"], ["message_agent"], ["read", "bash", "message_agent"]),
		["read", "message_agent"],
	);
});

test("a declared tool list is deduplicated and value-independent", () => {
	assert.deepEqual(selectActiveTools(["read", "read"], ["message_agent"], ["read", "message_agent"]), [
		"read",
		"message_agent",
	]);
	assert.deepEqual(selectActiveTools([], ["message_agent"], ["message_agent"]), ["message_agent"]);
	assert.deepEqual(selectActiveTools(["ghost"], [], ["read"]), []);
});

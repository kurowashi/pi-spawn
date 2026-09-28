/**
 * Contract: the model-facing surface stays exactly what the ADRs decided.
 *
 * The parent registers one tool. A child always receives the messaging tool.
 * Every tool is checked here, because the session that sees it pays for it on
 * every request.
 *
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRunRegistry } from "../../src/registry.ts";
import { childTools } from "../../src/tools/child-tools.ts";
import { loadSpawnExtension, loadSpawnTools } from "../helpers/extension.ts";

/** The parent-facing surface. Adding a tool is a decision that updates this list. */
const EXPECTED_PARENT_TOOLS = ["spawn_agents"];

/** The user-facing command surface. Commands cost no tool tokens, but stay intentional. */
const EXPECTED_COMMANDS = ["spawn"];

/** A tool description must earn its place in every request. */
const MAX_DESCRIPTION_CHARS = 160;

/** Top-level parameters per tool. A tool needing more is probably two tools. */
const MAX_TOP_LEVEL_PARAMETERS = 3;

/** The exact top-level parameter names per tool; a rename is a model-facing surface change. */
const EXPECTED_PARAMETERS: Record<string, string[]> = {
	spawn_agents: ["tasks"],
	message_agent: ["target_session_id", "text"],
};

/** The child-facing surface, built exactly as spawn_agents builds it. */
function childToolsForTest(): ToolDefinition[] {
	return childTools({ registry: createRunRegistry(), self: { sessionId: "run-1", name: "self" } });
}

/** The subset of JSON Schema this contract reads from a TypeBox schema. */
interface SchemaShape {
	type?: string;
	properties?: Record<string, unknown>;
	additionalProperties?: unknown;
}

function schemaOf(tool: ToolDefinition): SchemaShape {
	return tool.parameters as SchemaShape;
}

test("the parent registers exactly one delegation tool", async () => {
	const tools = await loadSpawnTools();
	assert.deepEqual([...tools.keys()].sort(), EXPECTED_PARENT_TOOLS);
});

test("the extension registers exactly the decided commands", async () => {
	const extension = await loadSpawnExtension();
	assert.deepEqual([...extension.commands.keys()].sort(), EXPECTED_COMMANDS);
	for (const command of extension.commands.values()) {
		assert.ok(command.description, `${command.name} needs a description for the command menu`);
	}
});

test("children receive only the messaging tool", () => {
	assert.deepEqual(
		childToolsForTest().map((tool) => tool.name),
		["message_agent"],
	);
	for (const tool of childToolsForTest()) {
		assert.ok(!tool.name.includes("spawn"), "a child must never be able to spawn a grandchild");
	}
});

test("every tool has label, description, and schema", async () => {
	const tools = [...(await loadSpawnTools()).values(), ...childToolsForTest()];
	for (const tool of tools) {
		assert.ok(tool.label.length > 0, `${tool.name} needs a label`);
		assert.ok(tool.description.length > 0, `${tool.name} needs a description`);
		assert.equal(schemaOf(tool).type, "object", `${tool.name} parameters must be an object schema`);
	}
});

test("descriptions stay within the per-tool character cap", async () => {
	const tools = [...(await loadSpawnTools()).values(), ...childToolsForTest()];
	for (const tool of tools) {
		assert.ok(
			tool.description.length <= MAX_DESCRIPTION_CHARS,
			`${tool.name} description is ${tool.description.length} chars, cap is ${MAX_DESCRIPTION_CHARS}`,
		);
	}
});

test("schemas are closed and stay within the parameter cap", async () => {
	const tools = [...(await loadSpawnTools()).values(), ...childToolsForTest()];
	for (const tool of tools) {
		const schema = schemaOf(tool);
		assert.equal(schema.additionalProperties, false, `${tool.name} must reject unknown parameters`);
		const count = Object.keys(schema.properties ?? {}).length;
		assert.ok(
			count <= MAX_TOP_LEVEL_PARAMETERS,
			`${tool.name} has ${count} parameters, cap is ${MAX_TOP_LEVEL_PARAMETERS}`,
		);
	}
});

test("every tool exposes exactly the decided parameter names", async () => {
	const tools = [...(await loadSpawnTools()).values(), ...childToolsForTest()];
	for (const tool of tools) {
		const expected = EXPECTED_PARAMETERS[tool.name];
		assert.ok(expected, `${tool.name} has no expected parameter list`);
		assert.deepEqual(Object.keys(schemaOf(tool).properties ?? {}).sort(), [...expected].sort());
	}
});

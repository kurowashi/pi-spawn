/**
 * Contract: the model-facing surface stays exactly what v1 decided.
 *
 * See docs/adr/0002-two-tools-and-token-budget.md and AGENTS.md.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadSpawnTools } from "../helpers/extension.ts";

/** v1 surface. Adding a tool is a decision that must update this list. */
const EXPECTED_TOOLS = ["message_agent", "spawn_agent"];

/** A tool description must earn its place in every request. */
const MAX_DESCRIPTION_CHARS = 160;

/** Top-level parameters per tool. A tool needing more is probably two tools. */
const MAX_TOP_LEVEL_PARAMETERS = 6;

/** The subset of JSON Schema this contract reads from a TypeBox schema. */
interface SchemaShape {
	type?: string;
	properties?: Record<string, unknown>;
	additionalProperties?: unknown;
}

function schemaOf(tool: ToolDefinition): SchemaShape {
	return tool.parameters as SchemaShape;
}

test("registers exactly the v1 tools", async () => {
	const tools = await loadSpawnTools();
	assert.deepEqual([...tools.keys()].sort(), EXPECTED_TOOLS);
});

test("every tool has label, description, and schema", async () => {
	const tools = await loadSpawnTools();
	for (const [name, tool] of tools) {
		assert.ok(tool.label.length > 0, `${name} needs a label`);
		assert.ok(tool.description.length > 0, `${name} needs a description`);
		assert.equal(schemaOf(tool).type, "object", `${name} parameters must be an object schema`);
	}
});

test("descriptions stay within the per-tool character cap", async () => {
	const tools = await loadSpawnTools();
	for (const [name, tool] of tools) {
		assert.ok(
			tool.description.length <= MAX_DESCRIPTION_CHARS,
			`${name} description is ${tool.description.length} chars, cap is ${MAX_DESCRIPTION_CHARS}`,
		);
	}
});

test("schemas are closed and stay within the parameter cap", async () => {
	const tools = await loadSpawnTools();
	for (const [name, tool] of tools) {
		const schema = schemaOf(tool);
		assert.equal(schema.additionalProperties, false, `${name} must reject unknown parameters`);
		const count = Object.keys(schema.properties ?? {}).length;
		assert.ok(count <= MAX_TOP_LEVEL_PARAMETERS, `${name} has ${count} parameters, cap is ${MAX_TOP_LEVEL_PARAMETERS}`);
	}
});

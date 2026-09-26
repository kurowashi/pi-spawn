/**
 * The load-bearing regression test of this repository.
 *
 * A tool definition is re-sent to the model on every request, so its size is a
 * permanent context tax. This test converts the registered surface to tokens
 * and refuses growth past the budget. It replaces the need for a lazy-loading
 * gate: the surface is small enough to be always-on.
 *
 * See docs/adr/0002-two-tools-and-token-budget.md.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSpawnTools } from "../helpers/extension.ts";

/**
 * Combined budget for every tool description plus parameter schema.
 *
 * Measured baseline when the budget was set: ~180 tokens. The cap is loose
 * enough not to fight small rewording of descriptions and tight enough that a
 * second tool or an option bag fails the build, as intended.
 */
const TOKEN_BUDGET = 400;

/** Cheap, dependency-free estimate. Provider tokenizers do not change the verdict. */
const CHARS_PER_TOKEN = 4;

test("model-facing tool surface stays inside the token budget", async () => {
	const tools = await loadSpawnTools();

	let total = 0;
	const perTool: string[] = [];
	for (const [name, tool] of tools) {
		const surface = `${name}\n${tool.description}\n${JSON.stringify(tool.parameters)}`;
		const tokens = Math.ceil(surface.length / CHARS_PER_TOKEN);
		total += tokens;
		perTool.push(`${name}=${tokens}`);
	}

	assert.ok(
		total <= TOKEN_BUDGET,
		`tool surface is ${total} tokens (${perTool.join(", ")}), budget is ${TOKEN_BUDGET}. ` +
			"Shrink the descriptions or delete a tool before raising the budget.",
	);
});

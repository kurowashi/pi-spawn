/**
 * The load-bearing regression test of this repository.
 *
 * A tool definition is re-sent to the model on every request, so its size is a
 * permanent context tax. This test converts the whole registered surface — the
 * parent tool and the child tool — into tokens and refuses growth past the
 * budget. It replaces the need for a lazy-loading gate: the surface is small
 * enough to be always-on.
 *
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRunRegistry } from "../../src/registry.ts";
import { childTools } from "../../src/tools/child-tools.ts";
import { loadSpawnTools } from "../helpers/extension.ts";

/**
 * Combined budget for every tool description plus parameter schema.
 *
 * Measured baseline when the budget was set: 308 tokens
 * (spawn_agents 218, message_agent 90). The cap leaves room for wording changes
 * and fails a new tool or a new option bag, which is the point.
 *
 * After ADR 0001 (resume) and ADR 0002 (ask_user): 381 tokens
 * (spawn_agents 234, message_agent 95, ask_user 52).
 */
const TOKEN_BUDGET = 400;

const CHARS_PER_TOKEN = 4;

function tokensOf(name: string, tool: ToolDefinition): number {
	return Math.ceil(`${name}\n${tool.description}\n${JSON.stringify(tool.parameters)}`.length / CHARS_PER_TOKEN);
}

test("model-facing tool surface stays inside the token budget", async () => {
	const tools = [
		...(await loadSpawnTools()).values(),
		...childTools({ runId: "t", self: {}, registry: createRunRegistry(), askUser: async (question) => question }),
	];

	let total = 0;
	const perTool: string[] = [];
	for (const tool of tools) {
		const tokens = tokensOf(tool.name, tool);
		total += tokens;
		perTool.push(`${tool.name}=${tokens}`);
	}

	assert.ok(
		total <= TOKEN_BUDGET,
		`tool surface is ${total} tokens (${perTool.join(", ")}), budget is ${TOKEN_BUDGET}. ` +
			"Shrink the descriptions or delete a tool before raising the budget.",
	);
});

/**
 * The load-bearing regression test of this repository.
 *
 * A tool definition is re-sent to the model on every request, so its size is a
 * permanent context tax. This test converts the whole registered surface — the
 * parent tool and the child tool — into tokens and refuses growth past the
 * budget. It replaces the need for a lazy-loading gate: the surface is small
 * enough to be always-on.
 *
 * See docs/adr/0002-two-tools-and-token-budget.md.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRunRegistry } from "../../src/registry.ts";
import { createMessageAgentTool } from "../../src/tools/message-agent.ts";
import { loadSpawnTools } from "../helpers/extension.ts";

/**
 * Combined budget for every tool description plus parameter schema.
 *
 * Measured baseline when the budget was set: 308 tokens
 * (spawn_agents 218, message_agent 90), against about 5,000 for the
 * pi-subagents surface this replaces. The cap leaves room for wording changes
 * and fails a new tool or a new option bag, which is the point.
 */
const TOKEN_BUDGET = 400;

/** Catalog injection is part of the fixed cost, so it is counted too. */
const CATALOG_BUDGET = 120;

/** Cheap, dependency-free estimate. Provider tokenizers do not change the verdict. */
const CHARS_PER_TOKEN = 4;

function tokensOf(name: string, tool: ToolDefinition): number {
	return Math.ceil(`${name}\n${tool.description}\n${JSON.stringify(tool.parameters)}`.length / CHARS_PER_TOKEN);
}

test("model-facing tool surface stays inside the token budget", async () => {
	const tools = [
		...(await loadSpawnTools()).values(),
		createMessageAgentTool({ runId: "t", self: {}, registry: createRunRegistry() }),
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

test("the injected agent catalog stays inside its own budget", async () => {
	// Five agents with descriptions is a realistic ceiling for one user.
	const agents = Array.from({ length: 5 }, (_, index) => ({
		name: `agent-${index + 1}`,
		description: "x".repeat(60),
		body: "",
		inheritProjectContext: true,
		inheritSkills: true,
		extensions: false,
		systemPromptMode: "append" as const,
		path: "p",
	}));
	const { formatCatalog } = await import("../../src/catalog.ts");
	const line = formatCatalog(agents);
	assert.ok(line);
	const tokens = Math.ceil(line.length / CHARS_PER_TOKEN);
	assert.ok(tokens <= CATALOG_BUDGET, `catalog is ${tokens} tokens, budget is ${CATALOG_BUDGET}`);
});

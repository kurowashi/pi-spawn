/**
 * Unit: the child-facing ask tool.
 *
 * The tool is a thin adapter over the dialog, so only two things can go wrong:
 * the question or the answer is lost, or a dialog failure is not reported.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAskUserTool } from "../../src/tools/ask-user.ts";

/** The tool reads no context field; the cast keeps the fake honest. */
const TEST_CONTEXT = {} as ExtensionContext;

async function call(tool: ToolDefinition, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
	return tool.execute("test-call", params as never, undefined, undefined, TEST_CONTEXT);
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

test("returns the answer and passes the question through", async () => {
	const questions: string[] = [];
	const tool = createAskUserTool(async (question) => {
		questions.push(question);
		return "README.md";
	});

	const result = await call(tool, { question: "Which file?" });

	assert.deepEqual(questions, ["Which file?"]);
	assert.equal(textOf(result), "README.md");
	assert.deepEqual(result.details, { question: "Which file?" });
});

test("a dialog failure becomes a tool error the child can read", async () => {
	const tool = createAskUserTool(async () => {
		throw new Error("no dialog");
	});
	await assert.rejects(() => call(tool, { question: "Which file?" }), /no dialog/);
});

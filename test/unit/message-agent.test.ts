/**
 * Unit: the child-facing tool's message routing and error reporting.
 *
 * The tool is what a child actually calls, so every refusal path is spelled out:
 * an agent must be able to recover from a wrong target without guessing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRunRegistry } from "../../src/registry.ts";
import { createMessageAgentTool } from "../../src/tools/message-agent.ts";
import type { AgentChannel, RunHandle } from "../../src/types.ts";

/** The tool reads no context field; the cast keeps the call site honest. */
const TEST_CONTEXT = {} as ExtensionContext;

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
			lastAssistantText: () => "done",
			snapshot: () => ({ activity: "idle", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }),
			...channel,
		},
	};
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function call(tool: ToolDefinition, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
	return tool.execute("test-call", params as never, undefined, undefined, TEST_CONTEXT);
}

function makeTool(targets: RunHandle[]): ToolDefinition {
	const registry = createRunRegistry();
	for (const target of targets) registry.add(target);
	return createMessageAgentTool({ registry });
}

test("a message reports delivery, not a reply", async () => {
	const sent: string[] = [];
	const target = handle("bbb", "writer", { deliver: async (text) => void sent.push(text) });
	const tool = makeTool([target]);

	const result = await call(tool, { to: "writer", text: "status?" });

	assert.equal(textOf(result), "delivered");
	assert.deepEqual(sent, ["status?"]);
	assert.deepEqual(result.details, { to: "bbb", agent: "writer" });
});

test("an ambiguous name lists the run ids to use instead", async () => {
	const tool = makeTool([handle("bbb", "writer"), handle("ccc", "writer")]);

	await assert.rejects(
		() => call(tool, { to: "writer", text: "hi" }),
		(error: Error) => {
			assert.match(error.message, /'bbb', 'ccc' are all live/);
			assert.match(error.message, /run ids/);
			return true;
		},
	);
});

test("an unknown target lists the live runs", async () => {
	const tool = makeTool([handle("bbb", "writer")]);

	await assert.rejects(() => call(tool, { to: "ghost", text: "hi" }), /writer \(bbb\)/);
});

test("an unknown target with nothing live says so", async () => {
	const tool = makeTool([]);

	await assert.rejects(() => call(tool, { to: "ghost", text: "hi" }), /\(none\)/);
});

test("a synchronous delivery failure reaches the sender as a tool error", async () => {
	const target = handle("bbb", "writer", {
		deliver: () => {
			throw new Error("session is closed");
		},
	});
	const tool = makeTool([target]);

	await assert.rejects(() => call(tool, { to: "writer", text: "hi" }), /session is closed/);
});

test("a failed turn is recorded on the target, not thrown to the sender", async () => {
	const target = handle("bbb", "writer", {
		deliver: async () => {
			throw new Error("session is closed");
		},
	});
	const tool = makeTool([target]);

	const result = await call(tool, { to: "writer", text: "hi" });

	assert.equal(textOf(result), "delivered");
	assert.deepEqual(target.inducedErrors, ["session is closed"]);
});

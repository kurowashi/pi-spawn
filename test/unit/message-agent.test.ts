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
		hasInboundWait: false,
		channel: {
			isStreaming: () => false,
			prompt: async () => {},
			steer: async () => {},
			followUp: async () => {},
			abort: async () => {},
			nextAssistantText: () => Promise.resolve("pong"),
			lastAssistantText: () => "done",
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

function makeTool(self: RunHandle | undefined, targets: RunHandle[]): ToolDefinition {
	const registry = createRunRegistry();
	for (const target of targets) registry.add(target);
	return createMessageAgentTool({
		runId: "self",
		self: { ...(self === undefined ? {} : { current: self }) },
		registry,
	});
}

test("a fire-and-forget message reports delivery, not a reply", async () => {
	const sent: string[] = [];
	const target = handle("bbb", "writer", { followUp: async (text) => void sent.push(text) });
	const tool = makeTool(handle("aaa", "reviewer"), [target]);

	const result = await call(tool, { to: "writer", text: "status?", wait: false });

	assert.equal(textOf(result), "delivered");
	assert.deepEqual(sent, ["status?"]);
	assert.deepEqual(result.details, { to: "bbb", agent: "writer", replied: false });
});

test("wait returns the sibling reply to the caller", async () => {
	const target = handle("bbb", "writer");
	const tool = makeTool(handle("aaa", "reviewer"), [target]);

	const result = await call(tool, { to: "bbb", text: "ready?", wait: true });

	assert.equal(textOf(result), "pong");
	assert.deepEqual(result.details, { to: "bbb", agent: "writer", replied: true });
});

test("an ambiguous name lists the run ids to use instead", async () => {
	const tool = makeTool(handle("aaa", "reviewer"), [handle("bbb", "writer"), handle("ccc", "writer")]);

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
	const tool = makeTool(handle("aaa", "reviewer"), [handle("bbb", "writer")]);

	await assert.rejects(() => call(tool, { to: "ghost", text: "hi" }), /writer \(bbb\)/);
});

test("an unknown target with nothing live says so", async () => {
	const tool = makeTool(handle("aaa", "reviewer"), []);

	await assert.rejects(() => call(tool, { to: "ghost", text: "hi" }), /\(none\)/);
});

test("a run that failed to register cannot send", async () => {
	const tool = makeTool(undefined, [handle("bbb", "writer")]);

	await assert.rejects(() => call(tool, { to: "writer", text: "hi" }), /not registered/);
});

test("a delivery failure surfaces as a tool error", async () => {
	const target = handle("bbb", "writer", {
		followUp: async () => {
			throw new Error("session is closed");
		},
	});
	const tool = makeTool(handle("aaa", "reviewer"), [target]);

	await assert.rejects(() => call(tool, { to: "writer", text: "hi" }), /session is closed/);
});

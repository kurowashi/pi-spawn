/**
 * Integration: one spawn_agents call from plan to sibling round trip.
 *
 * The tool definitions crossing into the fake channels are the real ones, so
 * this exercises registry registration, target resolution, delivery, reply
 * capture, timeout handling, and result aggregation without a model or network.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRunRegistry } from "../../src/registry.ts";
import { type CreateChannelInput, type SpawnDependencies, spawnAgents } from "../../src/spawn.ts";
import { createMessageAgentTool } from "../../src/tools/message-agent.ts";
import type { AgentChannel, SpawnResult } from "../../src/types.ts";

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

interface FakeRun {
	channel: AgentChannel;
	/** Messages delivered while the run was streaming. */
	steered: string[];
	/** Messages delivered while the run was idle, each starting a turn. */
	queued: string[];
	output: string;
	streaming: boolean;
	aborted: boolean;
	disposed: boolean;
	/** When true, a delivered message's turn settles only after releaseDelivery(). */
	holdDeliveries: boolean;
	/** True once a held delivery turn settled. */
	deliverySettled: boolean;
	/** When true, every delivery fails. */
	failDeliveries: boolean;
	releaseDelivery(): void;
	/** Set before prompt() runs to make it fail. */
	failure?: string;
	/** Task text as the run received it, including the sibling briefing. */
	received: string[];
	/** Resolves when the run is aborted. Lets a script simulate long work. */
	waitForAbort(): Promise<never>;
}

function createFakeRun(agent: string): FakeRun {
	let abortPrompt: (() => void) | undefined;
	let resolveReply: ((text: string) => void) | undefined;
	let releaseDelivery: (() => void) | undefined;
	const run: FakeRun = {
		steered: [],
		queued: [],
		output: `${agent} finished`,
		streaming: false,
		aborted: false,
		disposed: false,
		holdDeliveries: false,
		deliverySettled: false,
		failDeliveries: false,
		releaseDelivery: () => {
			releaseDelivery?.();
			releaseDelivery = undefined;
		},
		received: [],
		waitForAbort: () =>
			new Promise<never>((_resolve, reject) => {
				abortPrompt = () => reject(new Error("run aborted"));
			}),
		channel: undefined as never,
	};

	const reply = (text: string): void => {
		resolveReply?.(`${agent} replied to "${text}"`);
		resolveReply = undefined;
	};

	run.channel = {
		prompt: async () => {},
		deliver: async (text) => {
			if (run.streaming) run.steered.push(text);
			else run.queued.push(text);
			reply(text);
			if (run.failDeliveries) throw new Error("induced exploded");
			if (run.holdDeliveries) {
				await new Promise<void>((resolve) => {
					releaseDelivery = resolve;
				});
				run.deliverySettled = true;
			}
		},
		abort: async () => {
			run.aborted = true;
			abortPrompt?.();
			run.releaseDelivery();
		},
		dispose: async () => {
			run.disposed = true;
		},
		nextAssistantText: () => new Promise((resolve) => (resolveReply = resolve)),
		lastAssistantText: () => run.output,
	};
	return run;
}

/** The message tool reads no context field; the cast keeps the fake honest. */
const TEST_CONTEXT = {} as ExtensionContext;

async function callTool(tool: ToolDefinition, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
	return tool.execute("test-call", params as never, undefined, undefined, TEST_CONTEXT);
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function makeAgentDir(definitions: Record<string, string>): string {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-spawn-integration-"));
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	for (const [name, content] of Object.entries(definitions)) writeFileSync(join(agentDir, "agents", name), content);
	return agentDir;
}

const DEFINITIONS = {
	"reviewer.md": "---\nname: reviewer\ndescription: Reviews work.\nmodel: fixture/model-x\n---\nReview things.\n",
	"writer.md": "---\nname: writer\ndescription: Writes work.\n---\nWrite things.\n",
};

interface Harness {
	deps: SpawnDependencies;
	runs: Map<string, FakeRun>;
	cwd: string;
}

/** Wire spawnAgents to fake channels that run a scripted prompt per agent. */
function makeHarness(
	definitions: Record<string, string>,
	script: (input: CreateChannelInput, run: FakeRun, tools: ToolDefinition[]) => Promise<void>,
): Harness {
	const registry = createRunRegistry();
	const runs = new Map<string, FakeRun>();
	const cwd = makeAgentDir(definitions);
	let counter = 0;
	const deps: SpawnDependencies = {
		agentDir: cwd,
		availableModels: [
			{ provider: "fixture", id: "model-x" },
			{ provider: "fixture", id: "parent" },
		],
		parentModel: { provider: "fixture", id: "parent" },
		registry,
		nextRunId: () => {
			counter += 1;
			return `run-${counter}`;
		},
		childTool: (runId, self, runRegistry) => createMessageAgentTool({ runId, self, registry: runRegistry }),
		createChannel: async (input) => {
			const run = createFakeRun(input.agent.name);
			run.channel.prompt = async (text) => {
				run.received.push(text);
				if (run.failure !== undefined) throw new Error(run.failure);
				await script(input, run, input.customTools);
			};
			runs.set(input.agent.name, run);
			return run.channel;
		},
	};
	return { deps, runs, cwd };
}

function spawn(harness: Harness, request: Parameters<typeof spawnAgents>[0]): Promise<SpawnResult[]> {
	return spawnAgents(request, { cwd: harness.cwd }, harness.deps);
}

const BOTH_TASKS = {
	tasks: [
		{ agent: "reviewer", task: "review" },
		{ agent: "writer", task: "write" },
	],
};

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

test("a run asks a sibling and returns the reply", async () => {
	const harness = makeHarness(DEFINITIONS, async (input, run, tools) => {
		if (input.agent.name !== "reviewer") return;
		const tool = tools.find((candidate) => candidate.name === "message_agent");
		assert.ok(tool, "the child receives the message tool");
		const reply = textOf(await callTool(tool, { to: "writer", text: "is the draft ready?", wait: true }));
		run.output = `reviewer heard: ${reply}`;
	});

	const results = await spawn(harness, BOTH_TASKS);

	assert.deepEqual(
		results.map((result) => result.agent),
		["reviewer", "writer"],
	);
	assert.equal(results[0]?.error, undefined);
	assert.match(results[0]?.output ?? "", /writer replied to "is the draft ready\?"/);
	assert.deepEqual(harness.runs.get("writer")?.queued, ["is the draft ready?"], "an idle sibling gets a new turn");
	assert.deepEqual(harness.runs.get("writer")?.steered, []);
});

test("a streaming sibling is interrupted instead of queued", async () => {
	const harness = makeHarness(DEFINITIONS, async (input, _run, tools) => {
		if (input.agent.name !== "reviewer") return;
		const writer = harness.runs.get("writer");
		assert.ok(writer, "the sibling channel exists before any prompt runs");
		writer.streaming = true;
		const tool = tools.find((candidate) => candidate.name === "message_agent");
		assert.ok(tool);
		await callTool(tool, { to: "writer", text: "ping", wait: true });
	});

	await spawn(harness, BOTH_TASKS);

	assert.deepEqual(harness.runs.get("writer")?.steered, ["ping"]);
	assert.deepEqual(harness.runs.get("writer")?.queued, []);
});

test("a turn a message started is waited for before the call returns", async () => {
	const harness = makeHarness(DEFINITIONS, async (input, _run, tools) => {
		if (input.agent.name !== "reviewer") return;
		const writer = harness.runs.get("writer");
		assert.ok(writer);
		writer.holdDeliveries = true;
		const tool = tools.find((candidate) => candidate.name === "message_agent");
		assert.ok(tool);
		await callTool(tool, { to: "writer", text: "extra work", wait: false });
		// Release on a later macrotask; the call must still be waiting when it runs.
		setTimeout(() => writer.releaseDelivery(), 0);
	});

	const results = await spawn(harness, BOTH_TASKS);

	assert.equal(harness.runs.get("writer")?.deliverySettled, true, "the induced turn settled inside the call");
	assert.equal(results[1]?.output, "writer finished", "the initial turn's output is kept");
	assert.equal(results[1]?.error, undefined);
});

test("a failed induced turn is reported on the run it happened in", async () => {
	const harness = makeHarness(DEFINITIONS, async (input, _run, tools) => {
		if (input.agent.name !== "reviewer") return;
		const writer = harness.runs.get("writer");
		assert.ok(writer);
		writer.failDeliveries = true;
		const tool = tools.find((candidate) => candidate.name === "message_agent");
		assert.ok(tool);
		await callTool(tool, { to: "writer", text: "extra work", wait: false });
	});

	const results = await spawn(harness, BOTH_TASKS);

	assert.equal(results[0]?.error, undefined, "the sender is not punished for a fire-and-forget failure");
	assert.match(results[1]?.output ?? "", /delivery turn failed: induced exploded/);
});

test("an ambiguous agent name is refused and a run id resolves it", async () => {
	const failures: string[] = [];
	const harness = makeHarness(DEFINITIONS, async (input, _run, tools) => {
		if (input.agent.name !== "reviewer") return;
		const tool = tools.find((candidate) => candidate.name === "message_agent");
		assert.ok(tool);
		try {
			await callTool(tool, { to: "writer", text: "which one?", wait: true });
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
		const reply = textOf(await callTool(tool, { to: "run-3", text: "you", wait: true }));
		assert.match(reply, /writer replied/);
	});

	// Two runs of the same agent in one call are the real source of ambiguity.
	await spawn(harness, {
		tasks: [
			{ agent: "reviewer", task: "review" },
			{ agent: "writer", task: "write one" },
			{ agent: "writer", task: "write two" },
		],
	});

	assert.equal(failures.length, 1, "the ambiguous name is refused once");
	assert.match(failures[0] ?? "", /are all live/);
	assert.match(failures[0] ?? "", /run-3/);
});

test("every run is told which siblings it can message", async () => {
	const harness = makeHarness(DEFINITIONS, async () => {});
	await spawn(harness, BOTH_TASKS);

	assert.match(
		harness.runs.get("reviewer")?.received[0] ?? "",
		/^Siblings you can message with message_agent: writer \(run-2\)\n\nreview$/,
	);
	assert.match(harness.runs.get("writer")?.received[0] ?? "", /reviewer \(run-1\)/);
});

test("a lone run is not told about siblings", async () => {
	const harness = makeHarness(DEFINITIONS, async () => {});
	await spawn(harness, { tasks: [{ agent: "writer", task: "solo" }] });
	assert.equal(harness.runs.get("writer")?.received[0], "solo");
});

test("a failure is reported per run and does not discard its sibling", async () => {
	const harness = makeHarness(DEFINITIONS, async (input) => {
		if (input.agent.name === "reviewer") throw new Error("reviewer exploded");
	});

	const results = await spawn(harness, BOTH_TASKS);

	assert.equal(results[0]?.error, "reviewer exploded");
	assert.equal(results[1]?.error, undefined);
	assert.equal(results[1]?.output, "writer finished");
});

test("the reported model is the resolved one", async () => {
	const harness = makeHarness(DEFINITIONS, async () => {});
	const results = await spawn(harness, BOTH_TASKS);
	assert.equal(results[0]?.model, "fixture/model-x", "the definition model");
	assert.equal(results[1]?.model, "fixture/parent", "the parent model");
});

test("an unknown agent fails the whole call before anything starts", async () => {
	const harness = makeHarness(DEFINITIONS, async () => {});
	await assert.rejects(() => spawn(harness, { tasks: [{ agent: "ghost", task: "x" }] }), /unknown agent 'ghost'/);
	assert.equal(harness.runs.size, 0);
});

test("an unresolvable model override fails the whole call", async () => {
	const harness = makeHarness(DEFINITIONS, async () => {});
	await assert.rejects(
		() => spawn(harness, { tasks: [{ agent: "writer", task: "x", model: "fixture/ghost" }] }),
		/fixture\/ghost/,
	);
});

test("runs are unregistered when the call settles", async () => {
	const harness = makeHarness(DEFINITIONS, async () => {});
	await spawn(harness, { tasks: [{ agent: "writer", task: "x" }] });
	assert.deepEqual(harness.deps.registry.list(), []);
	assert.equal(harness.runs.get("writer")?.disposed, true);
});

test("a channel failure during setup disposes the sibling it already created", async () => {
	const harness = makeHarness(DEFINITIONS, async () => {});
	const create = harness.deps.createChannel;
	harness.deps.createChannel = async (input) => {
		if (input.agent.name === "reviewer") throw new Error("channel exploded");
		return create(input);
	};

	await assert.rejects(() => spawn(harness, BOTH_TASKS), /channel exploded/);
	assert.equal(harness.runs.get("writer")?.disposed, true);
	assert.deepEqual(harness.deps.registry.list(), []);
});

test("a timeout aborts the run and reports it", async () => {
	const harness = makeHarness(DEFINITIONS, async (_input, run) => {
		await run.waitForAbort();
	});
	const results = await spawn(harness, { tasks: [{ agent: "writer", task: "x" }], timeoutMs: 5 });

	assert.equal(harness.runs.get("writer")?.aborted, true);
	assert.equal(harness.runs.get("writer")?.disposed, true);
	assert.match(results[0]?.error ?? "", /aborted/);
	assert.deepEqual(harness.deps.registry.list(), []);
});

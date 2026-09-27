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
import { childTools } from "../../src/tools/child-tools.ts";
import type { AgentChannel, RunProgress, SpawnResult } from "../../src/types.ts";

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
	/** Latest activity label the parent would see. */
	activity: string;
	/** Latest content preview the parent would see. */
	preview?: string;
	/** Session settle time, set by a script to simulate a finished turn. */
	settledAt?: number;
	/** Usage the parent would count after the run. */
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	/** Persisted transcript path, when the run is file-backed. */
	sessionFile?: string;
	/** Resolves when the run is aborted. Lets a script simulate long work. */
	waitForAbort(): Promise<never>;
}

function createFakeRun(agent: string): FakeRun {
	let abortPrompt: (() => void) | undefined;
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
		activity: "starting",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		waitForAbort: () =>
			new Promise<never>((_resolve, reject) => {
				abortPrompt = () => reject(new Error("run aborted"));
			}),
		channel: undefined as never,
	};

	run.channel = {
		prompt: async () => {},
		deliver: async (text) => {
			if (run.streaming) run.steered.push(text);
			else run.queued.push(text);
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
		lastAssistantText: () => run.output,
		snapshot: () => ({
			activity: run.activity,
			...(run.preview === undefined ? {} : { preview: run.preview }),
			...(run.settledAt === undefined ? {} : { settledAt: run.settledAt }),
			usage: run.usage,
			...(run.sessionFile === undefined ? {} : { sessionFile: run.sessionFile }),
		}),
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
	inputs: CreateChannelInput[];
	cwd: string;
}

/** Wire spawnAgents to fake channels that run a scripted prompt per agent. */
function makeHarness(
	definitions: Record<string, string>,
	script: (input: CreateChannelInput, run: FakeRun, tools: ToolDefinition[]) => Promise<void>,
	globalRoot?: string,
): Harness {
	const registry = createRunRegistry();
	const runs = new Map<string, FakeRun>();
	const inputs: CreateChannelInput[] = [];
	const cwd = makeAgentDir(definitions);
	let counter = 0;
	const deps: SpawnDependencies = {
		definitionRoots: globalRoot === undefined ? [cwd] : [cwd, globalRoot],
		agentDir: cwd,
		availableModels: [
			{ provider: "fixture", id: "model-x" },
			{ provider: "fixture", id: "parent" },
		],
		parentModel: { provider: "fixture", id: "parent" },
		registry,
		findRunSession: (runId) => (runId.startsWith("stored-") ? `/sessions/${runId}.jsonl` : undefined),
		nextRunId: () => {
			counter += 1;
			return `run-${counter}`;
		},
		childTools: (input) => childTools(input),
		createChannel: async (input) => {
			const run = createFakeRun(input.agent.name);
			run.channel.prompt = async (text) => {
				run.received.push(text);
				if (run.failure !== undefined) throw new Error(run.failure);
				await script(input, run, input.customTools);
			};
			runs.set(input.agent.name, run);
			inputs.push(input);
			return run.channel;
		},
	};
	return { deps, runs, inputs, cwd };
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

test("a message starts a turn on an idle sibling", async () => {
	const harness = makeHarness(DEFINITIONS, async (input, _run, tools) => {
		if (input.agent.name !== "reviewer") return;
		const tool = tools.find((candidate) => candidate.name === "message_agent");
		assert.ok(tool, "the child receives the message tool");
		await callTool(tool, { to: "writer", text: "is the draft ready?" });
	});

	const results = await spawn(harness, BOTH_TASKS);

	assert.deepEqual(
		results.map((result) => result.agent),
		["reviewer", "writer"],
	);
	assert.equal(results[0]?.error, undefined);
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
		await callTool(tool, { to: "writer", text: "ping" });
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
		await callTool(tool, { to: "writer", text: "extra work" });
		// Release on a later macrotask; the call must still be waiting when it runs.
		setTimeout(() => writer.releaseDelivery(), 0);
	});

	const results = await spawn(harness, BOTH_TASKS);

	assert.equal(harness.runs.get("writer")?.deliverySettled, true, "the induced turn settled inside the call");
	assert.equal(results[1]?.output, "writer finished", "the initial turn's output is kept");
	assert.equal(results[1]?.error, undefined);
});

test("a run's result is its latest utterance, not its first", async () => {
	const harness = makeHarness(DEFINITIONS, async (input, _run, tools) => {
		if (input.agent.name !== "reviewer") return;
		const writer = harness.runs.get("writer");
		assert.ok(writer, "the sibling channel exists before any prompt runs");
		const deliver = writer.channel.deliver;
		writer.channel.deliver = async (text) => {
			await deliver(text);
			writer.output = `writer answered: ${text}`;
		};
		const tool = tools.find((candidate) => candidate.name === "message_agent");
		assert.ok(tool);
		await callTool(tool, { to: "writer", text: "final question" });
	});

	const results = await spawn(harness, BOTH_TASKS);

	assert.equal(results[1]?.output, "writer answered: final question");
});

test("a failed induced turn is reported on the run it happened in", async () => {
	const harness = makeHarness(DEFINITIONS, async (input, _run, tools) => {
		if (input.agent.name !== "reviewer") return;
		const writer = harness.runs.get("writer");
		assert.ok(writer);
		writer.failDeliveries = true;
		const tool = tools.find((candidate) => candidate.name === "message_agent");
		assert.ok(tool);
		await callTool(tool, { to: "writer", text: "extra work" });
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
			await callTool(tool, { to: "writer", text: "which one?" });
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
		const result = await callTool(tool, { to: "run-3", text: "you" });
		assert.equal(textOf(result), "delivered");
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

test("a project root definition wins over the global one", async () => {
	const globalRoot = makeAgentDir({
		"reviewer.md": "---\nname: reviewer\ndescription: Global.\n---\nGlobal body.\n",
	});
	const harness = makeHarness(
		{ "reviewer.md": "---\nname: reviewer\ndescription: Project.\n---\nProject body.\n" },
		async () => {},
		globalRoot,
	);

	await spawn(harness, { tasks: [{ agent: "reviewer", task: "review" }] });

	assert.equal(harness.inputs[0]?.agent.body, "Project body.");
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

test("results carry billed usage and the transcript path", async () => {
	const usage = { input: 10, output: 20, cacheRead: 2, cacheWrite: 3, cost: 0.25 };
	const harness = makeHarness(DEFINITIONS, async (input, run) => {
		run.usage = usage;
		run.sessionFile = `/tmp/${input.agent.name}.jsonl`;
	});

	const results = await spawn(harness, BOTH_TASKS);

	assert.deepEqual(
		results.map((result) => result.usage),
		[usage, usage],
	);
	assert.equal(results[0]?.session_file, "/tmp/reviewer.jsonl");
});

test("a failed run still reports what it was billed", async () => {
	const harness = makeHarness(DEFINITIONS, async (input, run) => {
		if (input.agent.name !== "reviewer") return;
		run.usage = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1 };
		throw new Error("reviewer exploded");
	});

	const results = await spawn(harness, BOTH_TASKS);

	assert.equal(results[0]?.error, "reviewer exploded");
	assert.equal(results[0]?.usage?.input, 1);
});

test("usage from a sibling-induced turn is included in the final result", async () => {
	const harness = makeHarness(DEFINITIONS, async (input, _run, tools) => {
		if (input.agent.name !== "reviewer") return;
		const writer = harness.runs.get("writer");
		assert.ok(writer);
		const tool = tools.find((candidate) => candidate.name === "message_agent");
		assert.ok(tool);
		writer.usage = { input: 99, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5 };
		await callTool(tool, { to: "writer", text: "extra work" });
	});

	const results = await spawn(harness, BOTH_TASKS);

	assert.equal(results[1]?.usage?.input, 99, "the induced turn's billing is counted");
});

test("a resumed task continues the stored transcript", async () => {
	const harness = makeHarness(DEFINITIONS, async () => {});
	const results = await spawn(harness, {
		tasks: [{ agent: "writer", task: "continue", resume_run_id: "stored-1" }],
	});

	assert.equal(harness.inputs[0]?.resumeSessionFile, "/sessions/stored-1.jsonl");
	assert.equal(results[0]?.resumed_from, "stored-1");
});

test("an unknown run id fails the whole call before anything starts", async () => {
	const harness = makeHarness(DEFINITIONS, async () => {});
	await assert.rejects(
		() => spawn(harness, { tasks: [{ agent: "writer", task: "continue", resume_run_id: "ghost" }] }),
		/unknown run id 'ghost'/,
	);
	assert.equal(harness.runs.size, 0);
});

test("a resumed run reports only the usage billed after it resumed", async () => {
	const history = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 1 };
	const added = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.25 };
	const harness = makeHarness(DEFINITIONS, async (_input, run) => {
		run.usage = { input: 110, output: 55, cacheRead: 0, cacheWrite: 0, cost: 1.25 };
	});
	const create = harness.deps.createChannel;
	harness.deps.createChannel = async (input) => {
		const channel = await create(input);
		const run = harness.runs.get(input.agent.name);
		assert.ok(run);
		run.usage = history;
		return channel;
	};

	const results = await spawn(harness, {
		tasks: [{ agent: "writer", task: "continue", resume_run_id: "stored-1" }],
	});

	assert.deepEqual(results[0]?.usage, added);
});

test("progress frames report every live run until the call returns", async () => {
	const frames: RunProgress[][] = [];
	const harness = makeHarness(DEFINITIONS, async (input, run) => {
		run.activity = `tool: ${input.agent.name}`;
		run.preview = `draft: ${input.agent.name}`;
		await new Promise((resolve) => setTimeout(resolve, 50));
	});

	await spawnAgents(
		BOTH_TASKS,
		{
			cwd: harness.cwd,
			progressIntervalMs: 5,
			onProgress: (progress) => frames.push([...progress]),
		},
		harness.deps,
	);

	assert.ok(frames.length > 1, "the immediate frame is followed by interval frames");
	assert.deepEqual(
		frames[0]?.map((run) => run.agent),
		["reviewer", "writer"],
	);
	assert.deepEqual(
		frames[0]?.map((run) => run.activity),
		["starting", "starting"],
	);
	assert.ok(
		frames.some((frame) => frame.every((run) => run.activity.startsWith("tool: "))),
		"interval frames see each run's latest activity",
	);
	assert.ok(
		frames.some((frame) => frame.every((run) => run.preview?.startsWith("draft: "))),
		"interval frames carry each run's preview",
	);
	assert.equal(typeof frames.at(-1)?.[0]?.elapsed_ms, "number");
});

test("a settled run reports done with a stopped clock while a sibling still works", async () => {
	const frames: RunProgress[][] = [];
	let releaseWriter: () => void = () => {};
	const writerReleased = new Promise<void>((resolve) => {
		releaseWriter = resolve;
	});
	const harness = makeHarness(DEFINITIONS, async (input, run) => {
		if (input.agent.name !== "reviewer") {
			await writerReleased;
			return;
		}
		run.activity = "done";
		run.settledAt = Date.now();
	});

	let overlappingFrames = 0;
	await spawnAgents(
		BOTH_TASKS,
		{
			cwd: harness.cwd,
			progressIntervalMs: 5,
			onProgress: (progress) => {
				frames.push([...progress]);
				if (progress[0]?.activity !== "done" || progress[1]?.activity === "done") return;
				overlappingFrames += 1;
				// Keep the sibling working until two frames have observed the settled one.
				if (overlappingFrames === 2) releaseWriter();
			},
		},
		harness.deps,
	);

	const overlapping = frames.filter((frame) => frame[0]?.activity === "done" && frame[1]?.activity !== "done");
	assert.ok(overlapping.length >= 2, "frames keep arriving while the sibling works");
	const elapsed = overlapping.map((frame) => frame[0]?.elapsed_ms);
	assert.equal(typeof elapsed[0], "number");
	assert.equal(new Set(elapsed).size, 1, "the settled run's clock does not advance");
});

/**
 * Unit: the /spawn command's routing.
 *
 * The command is the user's only view into a running child, so each routing
 * path (no runs, unknown target, picker, direct target) is pinned here without
 * a terminal.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createRunRegistry } from "../../src/registry.ts";
import { describeRun, runSpawnCommand, spawnTarget, statusOf } from "../../src/tools/spawn-command.ts";
import type { AgentChannel, RunHandle } from "../../src/types.ts";

function handle(runId: string, agent: string, channel: Partial<AgentChannel> = {}): RunHandle {
	return {
		runId,
		name: agent,
		agent,
		model: "fixture/model",
		startedAt: 1000,
		induced: new Set(),
		inducedErrors: [],
		usageBase: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		channel: {
			prompt: async () => {},
			deliver: async () => {},
			abort: async () => {},
			dispose: async () => {},
			lastAssistantText: () => undefined,
			snapshot: () => ({
				activity: "writing",
				settledAt: 3000,
				usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.03 },
				context: { tokens: 1000, contextWindow: 200_000, percent: 0.5 },
			}),
			...channel,
		},
	};
}

function makeContext(
	mode: string,
	select: (title: string, options: string[]) => Promise<string | undefined> = async () => undefined,
) {
	const notified: Array<{ message: string; type: string | undefined }> = [];
	const panels: number[] = [];
	const ctx = {
		mode,
		ui: {
			notify: (message: string, type?: string) => void notified.push({ message, type }),
			select,
			custom: async () => void panels.push(1),
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notified, panels };
}

test("a run line carries identity, activity, model, context, and cost", () => {
	assert.equal(
		describeRun(handle("run-1", "writer")),
		"writer (writer, run-1) · writing (2s) · fixture/model · ctx 1k/200k (1%) · $0.03",
	);
});

test("logs and a bare target mean the same argument", () => {
	assert.equal(spawnTarget("logs run-1"), "run-1");
	assert.equal(spawnTarget("run-1"), "run-1");
	assert.equal(spawnTarget("logs"), "", "a missing target falls back to the picker");
	assert.equal(spawnTarget(""), "");
});

test("statusOf returns undefined when the run can no longer report", () => {
	const broken = handle("run-1", "writer", {
		snapshot: () => {
			throw new Error("session is closed");
		},
	});
	assert.equal(statusOf(broken), undefined);
});

test("the command says so when nothing is live", async () => {
	const { ctx, notified } = makeContext("tui");
	await runSpawnCommand("", ctx, createRunRegistry());
	assert.deepEqual(notified, [{ message: "No live spawn runs", type: "info" }]);
});

test("an unknown target is refused with the live runs listed", async () => {
	const registry = createRunRegistry();
	registry.add(handle("run-1", "writer"));
	const { ctx, notified } = makeContext("tui");

	await runSpawnCommand("ghost", ctx, registry);

	assert.equal(notified[0]?.type, "error");
	assert.match(notified[0]?.message ?? "", /no live run has target_run_id 'ghost'/);
	assert.match(notified[0]?.message ?? "", /Live run_ids: run-1/);
});

test("/spawn logs <run> summarises the run outside the terminal UI", async () => {
	const registry = createRunRegistry();
	registry.add(handle("run-1", "writer"));
	const { ctx, notified } = makeContext("print");

	await runSpawnCommand("logs run-1", ctx, registry);

	assert.match(notified[0]?.message ?? "", /writer \(writer, run-1\)/);
	assert.equal(notified[0]?.type, "info");
});

test("an agent name is refused; the run id addresses the run", async () => {
	const registry = createRunRegistry();
	registry.add(handle("run-1", "reviewer"));
	registry.add(handle("run-2", "writer"));
	const { ctx, notified } = makeContext("print");

	await runSpawnCommand("writer", ctx, registry);

	assert.equal(notified[0]?.type, "error");
	assert.match(notified[0]?.message ?? "", /no live run has target_run_id 'writer'/);
	assert.match(notified[0]?.message ?? "", /Live run_ids: run-1, run-2/);

	await runSpawnCommand("run-2", ctx, registry);

	assert.match(notified[1]?.message ?? "", /writer \(writer, run-2\)/);
});

test("no argument picks from the live runs", async () => {
	const registry = createRunRegistry();
	registry.add(handle("run-1", "reviewer"));
	registry.add(handle("run-2", "writer"));
	const { ctx, notified } = makeContext("print", async (_title, options) => options[1]);

	await runSpawnCommand("", ctx, registry);

	assert.match(notified[0]?.message ?? "", /writer \(writer, run-2\)/);
});

test("cancelling the picker does nothing", async () => {
	const registry = createRunRegistry();
	registry.add(handle("run-1", "writer"));
	const { ctx, notified, panels } = makeContext("tui", async () => undefined);

	await runSpawnCommand("", ctx, registry);

	assert.deepEqual(notified, []);
	assert.equal(panels.length, 0);
});

test("the terminal UI opens the live view for a resolved run", async () => {
	const registry = createRunRegistry();
	registry.add(handle("run-1", "writer"));
	const { ctx, notified, panels } = makeContext("tui");

	await runSpawnCommand("run-1", ctx, registry);

	assert.deepEqual(notified, []);
	assert.equal(panels.length, 1);
});

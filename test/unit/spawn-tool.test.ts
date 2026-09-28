/**
 * Unit: the parent tool's usage aggregation and rendering (progress lines and
 * the UI-only result blocks).
 *
 * The aggregation feeds the SDK's session totals, so a wrong sum is invisible
 * in a normal run and only shows up as a wrong cost. It is pinned here.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { formatElapsed } from "../../src/format.ts";
import { createRunRegistry } from "../../src/registry.ts";
import {
	createSpawnAgentsTool,
	findRunSession,
	formatProgress,
	formatResults,
	formatResultText,
	progressResult,
	spawnContext,
	spawnRequest,
	totalUsage,
} from "../../src/tools/spawn-agents.ts";
import type { RunProgress, SpawnResult } from "../../src/types.ts";

const USAGE = { input: 10, output: 20, cacheRead: 2, cacheWrite: 3, cost: 0.25 };

/** Progress-line tests assert the line shape, so the default run costs nothing. */
const FREE_USAGE = { ...USAGE, cost: 0 };

/** The renderers' theme hooks collapse to identity, so the text assertions stay readable. */
const identityTheme = {
	fg: (_color: string, text: string): string => text,
	bold: (text: string): string => text,
};

function result(overrides: Partial<SpawnResult> = {}): SpawnResult {
	return { name: "writer", agent: "writer", run_id: "run-1", model: "fixture/model", ...overrides };
}

function progress(overrides: Partial<RunProgress> = {}): RunProgress {
	return {
		name: "writer",
		agent: "writer",
		run_id: "run-1",
		model: "fixture/model",
		activity: "tool: bash",
		elapsed_ms: 1000,
		usage: FREE_USAGE,
		...overrides,
	};
}

test("sums the usage of every run", () => {
	const totals = totalUsage([result({ usage: USAGE }), result({ run_id: "run-2", usage: USAGE })]);
	assert.deepEqual(totals, {
		input: 20,
		output: 40,
		cacheRead: 4,
		cacheWrite: 6,
		totalTokens: 70,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
	});
});

test("a call with no billed tokens adds nothing to the session totals", () => {
	assert.equal(totalUsage([result()]), undefined);
	assert.equal(
		totalUsage([result({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } })]),
		undefined,
	);
});

test("a run billed only for cache writes still reports usage", () => {
	const totals = totalUsage([result({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 5, cost: 0 } })]);
	assert.equal(totals?.totalTokens, 5);
});

test("progress lines show each run, its activity, the elapsed time, and the model", () => {
	const lines = formatProgress([
		progress(),
		progress({ name: "reviewer", agent: "reviewer", run_id: "run-2", activity: "writing", elapsed_ms: 130_000 }),
	]);
	assert.equal(
		lines,
		"[writer] run_id=run-1 — tool: bash (1s) · fixture/model\n[reviewer] run_id=run-2 — writing (2m10s) · fixture/model",
	);
});

test("a progress line shows context usage and cost when the run reports them", () => {
	const lines = formatProgress([
		progress({
			context: { tokens: 12_345, contextWindow: 200_000, percent: 6.2 },
			usage: { ...USAGE, cost: 0.0312 },
		}),
	]);
	assert.equal(lines, "[writer] run_id=run-1 — tool: bash (1s) · fixture/model · ctx 12.3k/200k (6%) · $0.03");
});

test("a progress line carries the latest content line when there is one", () => {
	const lines = formatProgress([
		progress({ preview: "checking the README" }),
		progress({ name: "reviewer", agent: "reviewer", run_id: "run-2", elapsed_ms: 2000 }),
	]);
	assert.equal(
		lines,
		"[writer] run_id=run-1 — tool: bash (1s) · fixture/model · checking the README\n" +
			"[reviewer] run_id=run-2 — tool: bash (2s) · fixture/model",
	);
});

test("a final result block carries the stats the model does not see", () => {
	const text = formatResultText(
		[
			result({
				output: "first\nsecond",
				elapsed_ms: 34_000,
				usage: { ...USAGE, cost: 0.25 },
				context: { tokens: 45_000, contextWindow: 200_000, percent: 22.5 },
				session_file: "/spawn-sessions/run-1.jsonl",
			}),
		],
		false,
		identityTheme,
	);
	assert.equal(
		text,
		"[writer] run_id=run-1 (fixture/model) — 34s\nfirst\nsecond\n" +
			"10 in / 20 out / 5 cache · $0.25 · ctx 45k/200k (23%) · session /spawn-sessions/run-1.jsonl",
	);
});

test("a result block hides output past the preview until it is expanded", () => {
	const long = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
	const collapsed = formatResultText([result({ output: long })], false, identityTheme);
	assert.ok(collapsed.includes("line 9"));
	assert.ok(!collapsed.includes("line 10"));
	assert.ok(collapsed.includes("... (2 more lines)"));

	const expanded = formatResultText([result({ output: long })], true, identityTheme);
	assert.ok(expanded.includes("line 11"));
	assert.ok(!expanded.includes("more lines"));
});

test("elapsed time is compact and never negative", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(-5), "0s");
	assert.equal(formatElapsed(59_999), "59s");
	assert.equal(formatElapsed(60_000), "1m00s");
	assert.equal(formatElapsed(3_600_000), "60m00s");
});

test("a progress result reuses the final details shape", () => {
	const partial = progressResult([progress()]);
	assert.equal(partial.content[0]?.type, "text");
	assert.deepEqual(partial.details.results, [
		{
			name: "writer",
			agent: "writer",
			run_id: "run-1",
			model: "fixture/model",
			progress: { activity: "tool: bash", elapsed_ms: 1000 },
			usage: FREE_USAGE,
		},
	]);
});

test("a progress result carries the preview in the structured details", () => {
	const partial = progressResult([progress({ preview: "drafting the answer" })]);
	assert.deepEqual(partial.details.results[0]?.progress, {
		activity: "tool: bash",
		elapsed_ms: 1000,
		preview: "drafting the answer",
	});
});

test("tool arguments map to the spawn request", () => {
	assert.deepEqual(spawnRequest({ tasks: [{ agent: "writer", task: "write" }] }, 60_000), {
		tasks: [{ agent: "writer", task: "write" }],
		timeoutMs: 60_000,
	});
});

test("a zero timeout means no deadline and stays out of the request", () => {
	assert.deepEqual(spawnRequest({ tasks: [{ agent: "writer", task: "write" }] }, 0), {
		tasks: [{ agent: "writer", task: "write" }],
	});
});

test("the spawn context carries a lazy parent transcript reader", () => {
	const entries = [{ type: "message" }];
	const controller = new AbortController();
	const ctx = {
		cwd: "/work",
		sessionManager: { getEntries: () => entries, getSessionFile: () => "/sessions/parent.jsonl" },
	} as unknown as ExtensionContext;

	const context = spawnContext(ctx, controller.signal, undefined);

	assert.deepEqual(
		{ ...context, parentEntries: undefined },
		{ cwd: "/work", signal: controller.signal, parentSessionFile: "/sessions/parent.jsonl", parentEntries: undefined },
	);
	assert.deepEqual(context.parentEntries?.(), entries);
});

test("the spawn context streams progress through the tool update callback", () => {
	const updates: unknown[] = [];
	const ctx = {
		cwd: "/work",
		sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
	} as unknown as ExtensionContext;
	const context = spawnContext(ctx, undefined, (result) => void updates.push(result));

	assert.ok(context.onProgress);
	context.onProgress([progress()]);
	assert.equal(updates.length, 1);
});

test("the model-facing result keeps the header, output, and errors", () => {
	assert.equal(formatResults([result({ output: "answer" })]), "[writer] run_id=run-1 (fixture/model)\nanswer");
	assert.equal(formatResults([result({ error: "boom" })]), "[writer] run_id=run-1 (fixture/model)\nERROR: boom");
});

/** A flushed session needs one assistant message, matching Pi's own write policy. */
function assistantMessage(): Parameters<SessionManager["appendMessage"]>[0] {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "anthropic-messages",
		provider: "fixture",
		model: "fixture/model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

test("findRunSession resolves the run id recorded as the session id", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-spawn-lookup-"));
	const cwd = process.cwd();
	const manager = SessionManager.create(cwd, dir, { id: "deadbeef" });
	manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
	manager.appendMessage(assistantMessage());
	try {
		assert.equal(findRunSession(dir, cwd, "deadbeef"), manager.getSessionFile());
		assert.equal(findRunSession(dir, join(cwd, "elsewhere"), "deadbeef"), undefined, "lookup is cwd-scoped");
		assert.equal(findRunSession(dir, cwd, "cafebabe"), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the call renderer lists the run labels before anything runs", () => {
	const tool = createSpawnAgentsTool({ registry: createRunRegistry() });
	const component = tool.renderCall?.(
		{
			tasks: [
				{ agent: "writer", task: "x", name: "intro" },
				{ agent: "writer", task: "y" },
			],
		},
		identityTheme as never,
		{} as never,
	);
	assert.ok(component, "the tool defines a call renderer");
	assert.ok(component.render(80).join("\n").includes("intro, writer-1"));
});

test("the result renderer shows the live line while running and the stats block when done", () => {
	const tool = createSpawnAgentsTool({ registry: createRunRegistry() });
	const partial = tool.renderResult?.(
		{ content: [{ type: "text", text: "live line" }], details: { results: [] } },
		{ expanded: false, isPartial: true },
		identityTheme as never,
		{} as never,
	);
	assert.ok(partial?.render(80).join("\n").includes("live line"));

	const done = tool.renderResult?.(
		{
			content: [{ type: "text", text: "model-facing" }],
			details: { results: [result({ output: "answer", elapsed_ms: 5000, usage: { ...USAGE, cost: 0.25 } })] },
		},
		{ expanded: false, isPartial: false },
		identityTheme as never,
		{} as never,
	);
	const text = done?.render(80).join("\n") ?? "";
	assert.ok(text.includes("[writer] run_id=run-1"));
	assert.ok(text.includes("$0.25"));
	assert.ok(!text.includes("model-facing"), "the model-facing text is not the UI view");
});

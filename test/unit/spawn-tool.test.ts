/**
 * Unit: the parent tool's usage aggregation and progress rendering.
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
import {
	findRunSession,
	formatElapsed,
	formatProgress,
	progressResult,
	spawnContext,
	spawnRequest,
	totalUsage,
} from "../../src/tools/spawn-agents.ts";
import type { RunProgress, SpawnResult } from "../../src/types.ts";

const USAGE = { input: 10, output: 20, cacheRead: 2, cacheWrite: 3, cost: 0.25 };

function result(overrides: Partial<SpawnResult> = {}): SpawnResult {
	return { agent: "writer", run_id: "run-1", model: "fixture/model", ...overrides };
}

function progress(overrides: Partial<RunProgress> = {}): RunProgress {
	return {
		agent: "writer",
		run_id: "run-1",
		model: "fixture/model",
		activity: "tool: bash",
		elapsed_ms: 1000,
		usage: USAGE,
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

test("progress lines show each run, its activity, and the elapsed time", () => {
	const lines = formatProgress([
		progress(),
		progress({ agent: "reviewer", run_id: "run-2", activity: "writing", elapsed_ms: 130_000 }),
	]);
	assert.equal(lines, "[writer] run-1 — tool: bash (1s)\n[reviewer] run-2 — writing (2m10s)");
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
			agent: "writer",
			run_id: "run-1",
			model: "fixture/model",
			progress: { activity: "tool: bash", elapsed_ms: 1000 },
			usage: USAGE,
		},
	]);
});

test("tool arguments map to the spawn request", () => {
	assert.deepEqual(spawnRequest({ tasks: [{ agent: "writer", task: "write" }] }), {
		tasks: [{ agent: "writer", task: "write" }],
	});
	assert.deepEqual(spawnRequest({ tasks: [{ agent: "writer", task: "write" }], context: "fork", timeout_seconds: 5 }), {
		tasks: [{ agent: "writer", task: "write" }],
		context: "fork",
		timeoutMs: 5000,
	});
});

test("the spawn context carries the parent transcript only when forking", () => {
	const entries = [{ type: "message" }];
	const controller = new AbortController();
	const ctx = {
		cwd: "/work",
		sessionManager: { getEntries: () => entries, getSessionFile: () => "/sessions/parent.jsonl" },
	} as unknown as ExtensionContext;
	const params = { tasks: [{ agent: "writer", task: "write" }] };

	assert.deepEqual(spawnContext(ctx, params, controller.signal, undefined), {
		cwd: "/work",
		signal: controller.signal,
		parentSessionFile: "/sessions/parent.jsonl",
	});
	assert.deepEqual(spawnContext(ctx, { ...params, context: "fork" }, undefined, undefined), {
		cwd: "/work",
		parentEntries: entries,
		parentSessionFile: "/sessions/parent.jsonl",
	});
});

test("the spawn context streams progress through the tool update callback", () => {
	const updates: unknown[] = [];
	const ctx = {
		cwd: "/work",
		sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
	} as unknown as ExtensionContext;
	const context = spawnContext(
		ctx,
		{ tasks: [{ agent: "writer", task: "write" }] },
		undefined,
		(result) => void updates.push(result),
	);

	assert.ok(context.onProgress);
	context.onProgress([progress()]);
	assert.equal(updates.length, 1);
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

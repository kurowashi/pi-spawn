/**
 * Unit: session JSONL becomes readable log lines, and the viewer window.
 *
 * The viewer trusts these two pure functions: a parse mistake shows up as a
 * missing line in every live view, and a window mistake scrolls to the wrong
 * place while nobody is looking.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatSessionLog, readSessionTail, windowFromEnd } from "../../src/log.ts";

function entry(value: unknown): string {
	return JSON.stringify(value);
}

test("message entries become tagged log lines and non-log entries are skipped", () => {
	const text = [
		entry({ type: "session", version: 3 }),
		entry({ type: "message", message: { role: "system", content: "prompt" } }),
		entry({ type: "message", message: { role: "user", content: "do the thing" } }),
		entry({
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "working on it" },
					{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
				],
			},
		}),
		entry({
			type: "message",
			message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "file.txt" }] },
		}),
		entry({
			type: "message",
			message: { role: "toolResult", toolName: "read", isError: true, content: [{ type: "text", text: "missing" }] },
		}),
		entry({ type: "compaction", summary: "so far" }),
		entry({ type: "custom_message", content: "note" }),
	].join("\n");

	assert.deepEqual(formatSessionLog(text), [
		"[user] do the thing",
		"[assistant] working on it",
		'[tool:bash] {"command":"ls"}',
		"[result:bash] file.txt",
		"[error:read] missing",
		"[compacted] so far",
		"[custom] note",
	]);
});

test("a partial or malformed line is skipped, not thrown", () => {
	const text = [
		entry({ type: "message", message: { role: "user", content: "kept" } }),
		'{"type":"message","message":{"role":"user","content":"trunc',
		"not json at all",
		"",
		entry({ type: "message", message: { role: "user", content: "also kept" } }),
	].join("\n");

	assert.deepEqual(formatSessionLog(text), ["[user] kept", "[user] also kept"]);
});

test("continuation lines are indented under their tag", () => {
	const text = entry({
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: "first\nsecond" }] },
	});
	assert.deepEqual(formatSessionLog(text), ["[assistant] first", "  second"]);
});

test("one log line is bounded so a huge tool result cannot overwhelm the viewer", () => {
	const text = entry({
		type: "message",
		message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "x".repeat(1000) }] },
	});
	const [line] = formatSessionLog(text);
	assert.equal(line, `[result:bash] ${"x".repeat(400)}...`);
});

test("an empty tool result still names the tool", () => {
	const text = entry({ type: "message", message: { role: "toolResult", toolName: "bash", content: [] } });
	assert.deepEqual(formatSessionLog(text), ["[result:bash]"]);
});

test("the window is anchored to the end unless scrolled", () => {
	const lines = ["a", "b", "c", "d", "e"];
	assert.deepEqual(windowFromEnd(lines, 2, 0), ["d", "e"]);
	assert.deepEqual(windowFromEnd(lines, 2, 1), ["c", "d"]);
	assert.deepEqual(windowFromEnd(lines, 2, 99), ["a", "b"], "the offset clamps to the oldest line");
	assert.deepEqual(windowFromEnd(lines, 10, 0), lines, "a short log fills what it has");
	assert.deepEqual(windowFromEnd([], 3, 0), []);
});

test("the session tail reads the end of the file and tolerates missing files", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-spawn-log-"));
	const path = join(dir, "session.jsonl");
	writeFileSync(path, `${"x".repeat(300 * 1024)}\nlast\n`);
	try {
		const tail = readSessionTail(path);
		assert.ok(tail.length <= 256 * 1024, "the tail is bounded");
		assert.ok(tail.endsWith("\nlast\n"), "the newest line is kept");
		assert.equal(readSessionTail(join(dir, "missing.jsonl")), "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

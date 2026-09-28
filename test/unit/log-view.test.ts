/**
 * Unit: the /spawn live viewer.
 *
 * The viewer owns the only stateful UI in this extension: what is followed,
 * what is kept still while scrolled, and what the keys do. All three are
 * pinned here with a fake reader, so no terminal and no session file is needed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { LogView, type LogViewInput, type LogViewStatus } from "../../src/log-view.ts";

const STATUS: LogViewStatus = {
	activity: "writing",
	elapsedMs: 12_000,
	usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.03 },
};

const identityTheme = { fg: (_color: string, text: string): string => text };

/** User-message entries for a fake transcript. */
function jsonl(...texts: string[]): string {
	return texts
		.map((text, index) =>
			JSON.stringify({ type: "message", id: `e${index}`, message: { role: "user", content: text } }),
		)
		.join("\n");
}

function makeView(
	options: {
		content?: string;
		rows?: number;
		status?: LogViewStatus | undefined;
		sessionFile?: string | undefined;
	} = {},
) {
	let content = options.content ?? "";
	let sessionFile = "sessionFile" in options ? options.sessionFile : "/tmp/child.jsonl";
	let doneCount = 0;
	const view = new LogView(
		{
			name: "intro",
			agent: "writer",
			sessionId: "run-1",
			model: "fixture/model",
			sessionFile: () => sessionFile,
			status: () => ("status" in options ? options.status : STATUS),
			live: () => true,
			rows: () => options.rows ?? 24,
			requestRender: () => {},
			done: () => {
				doneCount += 1;
			},
		} satisfies LogViewInput,
		identityTheme,
		{ read: () => content },
	);
	return {
		view,
		doneCount: () => doneCount,
		setContent: (next: string) => {
			content = next;
		},
		setSessionFile: (next: string | undefined) => {
			sessionFile = next;
		},
	};
}

/** The log area without the title, status, and footer. */
function body(lines: readonly string[]): string[] {
	return lines.slice(2, -1);
}

test("renders the run identity, stats, log body, and footer", () => {
	const { view } = makeView({ content: jsonl("first", "second") });
	const lines = view.render(60);
	assert.ok(lines[0]?.includes("intro (writer, run-1)"));
	assert.ok(lines[1]?.includes("live \u00b7 writing (12s) \u00b7 fixture/model \u00b7 $0.03"));
	assert.ok(body(lines).some((line) => line.includes("[user] first")));
	assert.ok(body(lines).some((line) => line.includes("[user] second")));
	assert.ok(lines.at(-1)?.includes("Esc close"));
	assert.equal(lines.length, 19, "16 viewport lines plus title, status, and footer");
	view.dispose();
});

test("status shows context usage when the run reports it", () => {
	const { view } = makeView({
		status: {
			activity: "thinking",
			elapsedMs: 1000,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			context: { tokens: 1000, contextWindow: 200_000, percent: 0.5 },
		},
	});
	assert.ok(view.render(80)[1]?.includes("ctx 1k/200k (1%)"));
	assert.ok(!view.render(80)[1]?.includes("$"), "a free run shows no cost");
	view.dispose();
});

test("a run without a transcript shows an empty body", () => {
	const { view } = makeView({ sessionFile: undefined });
	assert.ok(body(view.render(60)).some((line) => line.includes("(no output yet)")));
	view.dispose();
});

test("starts at the newest line and scrolls back from there", () => {
	const { view } = makeView({ content: jsonl(...Array.from({ length: 30 }, (_, index) => `line ${index}`)) });
	assert.ok(body(view.render(60)).at(-1)?.includes("line 29"), "starts at the end");
	view.handleInput("k");
	assert.ok(body(view.render(60)).at(-1)?.includes("line 28"), "one line up");
	assert.ok(view.render(60).at(-1)?.includes("1 lines below"), "the footer reports the offset");
	view.handleInput("t");
	assert.ok(body(view.render(60))[0]?.includes("line 0"), "t jumps to the oldest line");
	view.handleInput("f");
	assert.ok(!view.render(60).at(-1)?.includes("lines below"), "f follows the end again");
	view.dispose();
});

test("every scroll key moves the viewport", () => {
	const { view } = makeView({ content: jsonl(...Array.from({ length: 40 }, (_, index) => `line ${index}`)) });
	view.handleInput("k");
	view.handleInput("j");
	assert.ok(!view.render(60).at(-1)?.includes("lines below"), "j returns to the tail");
	view.handleInput("\u001b[5~");
	assert.ok(view.render(60).at(-1)?.includes("16 lines below"), "PgUp moves one viewport");
	view.handleInput("\u001b[6~");
	assert.ok(!view.render(60).at(-1)?.includes("lines below"), "PgDn returns to the tail");
	view.handleInput("\u001b[H");
	assert.ok(body(view.render(60))[0]?.includes("line 0"), "Home jumps to the oldest line");
	view.handleInput("\u001b[F");
	assert.ok(body(view.render(60)).at(-1)?.includes("line 39"), "End follows the newest line");
	view.dispose();
});

test("new lines land below while the user reads scrollback", () => {
	const { view, setContent } = makeView({
		content: jsonl(...Array.from({ length: 30 }, (_, index) => `line ${index}`)),
	});
	view.handleInput("k");
	const before = body(view.render(60)).filter((line) => line.includes("line "));
	setContent(jsonl(...Array.from({ length: 31 }, (_, index) => `line ${index}`)));
	view.tick();
	assert.deepEqual(
		body(view.render(60)).filter((line) => line.includes("line ")),
		before,
		"the view stays put",
	);
	view.dispose();
});

test("a new transcript resets the buffer", () => {
	const { view, setContent, setSessionFile } = makeView({ content: jsonl("old") });
	setContent(jsonl("new"));
	setSessionFile("/tmp/other.jsonl");
	view.tick();
	assert.ok(body(view.render(60)).some((line) => line.includes("new")));
	assert.ok(!body(view.render(60)).some((line) => line.includes("old")));
	view.dispose();
});

test("escape and q close the view", () => {
	const { view, doneCount } = makeView();
	view.handleInput("\u001b");
	view.handleInput("q");
	assert.equal(doneCount(), 2);
	view.dispose();
});

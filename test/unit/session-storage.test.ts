/**
 * Unit: the transcript a run writes into.
 *
 * Resuming must branch at the recorded entry instead of silently extending the
 * transcript tip, because the tip may belong to a branch the parent rewound
 * past with /tree. Inherited context must end at the parent's active leaf for
 * the same reason. Both are pinned here against a real SessionManager.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type CreateChannelInput, createSessionManager } from "../../src/spawn.ts";

function assistantMessage(): Parameters<SessionManager["appendMessage"]>[0] {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
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

function userMessage(text: string): Parameters<SessionManager["appendMessage"]>[0] {
	return { role: "user", content: text, timestamp: Date.now() };
}

test("a resumed session branches at the recorded entry, not the transcript tip", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-spawn-resume-"));
	try {
		const cwd = process.cwd();
		const created = SessionManager.create(cwd, dir, { id: "aaaa1111" });
		created.appendMessage(userMessage("first"));
		const branchPoint = created.appendMessage(assistantMessage());
		created.appendMessage(userMessage("abandoned by a parent /tree rewind"));
		const sessionFile = created.getSessionFile();
		assert.ok(sessionFile, "the fixture session is file-backed");

		const reopened = createSessionManager({
			sessionId: "aaaa1111",
			cwd,
			resume: { sessionFile, entryId: branchPoint },
		} as unknown as CreateChannelInput);

		assert.equal(reopened.getLeafId(), branchPoint, "the recorded entry is the current position");
		const appended = reopened.appendMessage(userMessage("redo"));
		assert.equal(
			reopened.getEntry(appended)?.parentId,
			branchPoint,
			"the new turn is a sibling of the abandoned branch",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resumed session can branch from an entry on an abandoned sibling branch", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-spawn-resume-sibling-"));
	try {
		const cwd = process.cwd();
		const created = SessionManager.create(cwd, dir, { id: "bbbb2222" });
		const first = created.appendMessage(userMessage("first"));
		const abandoned = created.appendMessage(assistantMessage());
		// A second writer (for example `pi --session`) left a sibling branch behind.
		created.branch(first);
		const sideBranch = created.appendMessage(userMessage("side branch"));
		created.branch(abandoned);
		const sessionFile = created.getSessionFile();
		assert.ok(sessionFile, "the fixture session is file-backed");

		const reopened = createSessionManager({
			sessionId: "bbbb2222",
			cwd,
			resume: { sessionFile, entryId: sideBranch },
		} as unknown as CreateChannelInput);

		assert.equal(reopened.getLeafId(), sideBranch, "the sibling branch is addressable by entry id");
		const appended = reopened.appendMessage(userMessage("continue the side branch"));
		assert.equal(reopened.getEntry(appended)?.parentId, sideBranch);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an inherited conversation ends at the parent's active leaf", () => {
	const sourceDir = mkdtempSync(join(tmpdir(), "pi-spawn-fork-src-"));
	const targetDir = mkdtempSync(join(tmpdir(), "pi-spawn-fork-dst-"));
	try {
		const cwd = process.cwd();
		const parent = SessionManager.create(cwd, sourceDir, { id: "parent01" });
		parent.appendMessage(userMessage("one"));
		const activeLeaf = parent.appendMessage(assistantMessage());
		const abandoned = parent.appendMessage(userMessage("abandoned by a parent /tree rewind"));
		const parentFile = parent.getSessionFile();
		assert.ok(parentFile, "the parent session is file-backed");

		const forked = createSessionManager({
			sessionId: "child001",
			cwd,
			sessionDir: targetDir,
			forkEntries: [...parent.getBranch()],
			parentSessionFile: parentFile,
			forkEntryId: activeLeaf,
		} as unknown as CreateChannelInput);

		assert.equal(forked.getLeafId(), activeLeaf, "the copied transcript ends at the active leaf");
		assert.ok(
			!forked.getBranch().some((entry) => entry.id === abandoned),
			"the abandoned branch is not on the inherited path",
		);
	} finally {
		rmSync(sourceDir, { recursive: true, force: true });
		rmSync(targetDir, { recursive: true, force: true });
	}
});

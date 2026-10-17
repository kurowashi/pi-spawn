/**
 * Unit: `@path` imports in an agent definition body.
 *
 * The rules are pi-import's (Claude Code 2.1.287): DFS order, the four-hop
 * limit, global dedup, extension and size limits, and the user/project split.
 * The one difference is the root: a definition body resolves its top-level
 * imports from the child's working directory, not from the definition file.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { expandDefinitionBody, formatMemory, MEMORY_PROMPT } from "../../src/memory-import.ts";

/** Creates a temp directory from `relative path -> content` pairs and returns its root. */
function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "pi-spawn-import-"));
	for (const [relative, content] of Object.entries(files)) {
		const full = join(root, relative);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
	return root;
}

/** Expands a body defined at `<root>/agent/agents/writer.md`, with the child running in `<root>`. */
function expand(root: string, body: string): string {
	return expandDefinitionBody({
		body,
		bodyPath: join(root, "project/.pi/agents/writer.md"),
		cwd: root,
		agentDir: join(root, "agent"),
	});
}

/** The `Contents of <path>` headers in order, so tests can assert the expansion order. */
function headers(text: string): string[] {
	return [...text.matchAll(/^Contents of (.+?) \(/gm)].map((match) => match[1] ?? "");
}

test("keeps a body without imports unchanged apart from trimming", () => {
	const root = tree({});
	assert.equal(expand(root, "  Write tests.\n\n"), "Write tests.");
});

test("appends the imported files after the body in DFS pre-order with dedup", () => {
	const root = tree({
		"x.md": "X\n\n@z.md\n",
		"y.md": "Y\n@z.md\n",
		"z.md": "Z\n",
	});
	const text = expand(root, "Body\n@x.md\n@y.md\n");
	assert.deepEqual(headers(text), [join(root, "x.md"), join(root, "z.md"), join(root, "y.md")]);
	assert.ok(text.startsWith("Body\n@x.md\n@y.md\n\n"));
});

test("stops after four hops below the body", () => {
	const root = tree({
		"a.md": "@b.md\n",
		"b.md": "@c.md\n",
		"c.md": "@d.md\n",
		"d.md": "@e.md\n",
		"e.md": "E\n",
	});
	const text = expand(root, "@a.md\n");
	assert.deepEqual(headers(text), [join(root, "a.md"), join(root, "b.md"), join(root, "c.md"), join(root, "d.md")]);
	assert.ok(!text.includes("E\n"));
});

test("stops cycles and repeated references, including a reference back to the definition", () => {
	const root = tree({
		"project/.pi/agents/writer.md": "@a.md\n@a.md\n",
		"a.md": "@project/.pi/agents/writer.md\n",
	});
	const text = expandDefinitionBody({
		body: "@a.md\n@a.md\n",
		bodyPath: join(root, "project/.pi/agents/writer.md"),
		cwd: root,
		agentDir: join(root, "agent"),
	});
	assert.deepEqual(headers(text), [join(root, "a.md")]);
});

test("resolves top-level imports from cwd and nested imports from the imported file's directory", () => {
	const root = tree({
		"d/a.md": "@b.md\n",
		"d/b.md": "nested\n",
		"b.md": "top level b\n",
	});
	const text = expand(root, "@d/a.md\n@b.md\n");
	assert.deepEqual(headers(text), [join(root, "d/a.md"), join(root, "d/b.md"), join(root, "b.md")]);
	assert.ok(text.includes("nested"));
	assert.ok(text.includes("top level b"));
});

test("skips non-text extensions and accepts extensionless files", () => {
	const root = tree({ "child.png": "png\n", "logo.svg": "svg\n", Makefile: "build:\n" });
	const text = expand(root, "@child.png\n@logo.svg\n@Makefile\n");
	assert.deepEqual(headers(text), [join(root, "Makefile")]);
});

test("skips missing files, directories, and empty files", () => {
	const root = tree({ "empty.md": "", "child.md": "ok\n" });
	mkdirSync(join(root, "adir"));
	const text = expand(root, "@missing.md\n@adir\n@empty.md\n@child.md\n");
	assert.deepEqual(headers(text), [join(root, "child.md")]);
});

test("skips files above the four mebibyte cap", () => {
	const root = tree({ "small.md": "small\n" });
	writeFileSync(join(root, "big.md"), "x".repeat(4 * 1024 * 1024 + 1));
	const text = expand(root, "@big.md\n@small.md\n");
	assert.deepEqual(headers(text), [join(root, "small.md")]);
});

test("describes a definition from the user agent directory as user, and from the project as project", () => {
	const root = tree({ "shared.md": "shared\n" });
	const userText = expandDefinitionBody({
		body: "@shared.md\n",
		bodyPath: join(root, "agent/agents/writer.md"),
		cwd: root,
		agentDir: join(root, "agent"),
	});
	const projectText = expand(root, "@shared.md\n");
	assert.ok(userText.includes(" (user's private global instructions for all projects):"));
	assert.ok(projectText.includes(" (project instructions, checked into the codebase):"));
});

test("deduplicates symlinks by real path", () => {
	const root = tree({ "target.md": "target\n" });
	symlinkSync(join(root, "target.md"), join(root, "link.md"));
	const text = expand(root, "@target.md\n@link.md\n");
	assert.deepEqual(headers(text), [join(root, "target.md")]);
});

test("strips frontmatter and block comments from imported bodies", () => {
	const root = tree({ "child.md": "---\ntitle: y\n---\n<!-- note -->\nbody\n" });
	const text = expand(root, "@child.md\n");
	assert.ok(text.endsWith("\n\nbody"));
	assert.ok(!text.includes("title: y"));
	assert.ok(!text.includes("note"));
});

test("does not expand imports inside code spans and fenced code", () => {
	const root = tree({ "child.md": "child\n" });
	const body = "`@child.md`\n\n```\n@child.md\n```\n";
	assert.equal(expand(root, body), body.trim());
});

test("expands the home directory form", () => {
	const root = tree({ "home/notes.md": "from home\n" });
	const previous = process.env["HOME"];
	process.env["HOME"] = join(root, "home");
	try {
		assert.ok(expand(root, "@~/notes.md\n").includes("from home"));
	} finally {
		if (previous === undefined) delete process.env["HOME"];
		else process.env["HOME"] = previous;
	}
});

test("keeps the fixed preamble identical to Claude Code", () => {
	assert.equal(
		MEMORY_PROMPT,
		"Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.",
	);
});

test("formats one project entry with the project description", () => {
	assert.equal(
		formatMemory([{ path: "/repo/a.md", content: "# Parent\n", type: "project" }]),
		`${MEMORY_PROMPT}\n\nContents of /repo/a.md (project instructions, checked into the codebase):\n\n# Parent`,
	);
});

test("formats one user entry with the user description", () => {
	assert.equal(
		formatMemory([{ path: "/home/me/.pi/agent/a.md", content: "prefs", type: "user" }]),
		`${MEMORY_PROMPT}\n\nContents of /home/me/.pi/agent/a.md (user's private global instructions for all projects):\n\nprefs`,
	);
});

test("joins entries with a blank line in the given order and trims bodies", () => {
	assert.equal(
		formatMemory([
			{ path: "/repo/a.md", content: "a\n\n", type: "project" },
			{ path: "/repo/b.md", content: "\nb", type: "project" },
		]),
		[
			MEMORY_PROMPT,
			"",
			"Contents of /repo/a.md (project instructions, checked into the codebase):",
			"",
			"a",
			"",
			"Contents of /repo/b.md (project instructions, checked into the codebase):",
			"",
			"b",
		].join("\n"),
	);
});

test("returns an empty string for no entries", () => {
	assert.equal(formatMemory([]), "");
});

/**
 * Unit: `@path` extraction and injection stripping match Claude Code 2.1.287 (ported from pi-import).
 *
 * The cases mirror behavior verified against the real Claude Code binary and a
 * captured API request. See DESIGN.md for how the contract was established.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { scanImports, stripForInjection } from "../../src/import-scan.ts";

test("extracts relative, dot, home, and absolute imports in document order", () => {
	const markdown = "See @a.md and @./b/c.md here.\nAlso @~/.claude/x.md and @/etc/hosts.\n";
	assert.deepEqual(scanImports(markdown), ["a.md", "./b/c.md", "~/.claude/x.md", "/etc/hosts."]);
});

test("extracts an import at the start of a line but not after a word character", () => {
	assert.deepEqual(scanImports("@start.md\nfoo @later.md\nfoo@not.md\n"), ["start.md", "later.md"]);
});

test("strips the fragment and unescapes spaces", () => {
	assert.deepEqual(scanImports("@a.md#section\n@Design\\ Docs/api.md\n"), ["a.md", "Design Docs/api.md"]);
});

test("rejects invalid path shapes", () => {
	assert.deepEqual(scanImports('@/ @#frag @@x @%x "@quoted.md"\n'), []);
});

test("keeps trailing punctuation in the path, so the import fails to resolve", () => {
	assert.deepEqual(scanImports("See @child.md. And @other.md here\n"), ["child.md.", "other.md"]);
});

test("skips inline code spans", () => {
	assert.deepEqual(scanImports("See `@a.md` here\n"), []);
});

test("skips fenced code blocks for both fence characters", () => {
	assert.deepEqual(scanImports("```\n@a.md\n```\n@b.md\n"), ["b.md"]);
	assert.deepEqual(scanImports("~~~\n@a.md\n~~~\n@b.md\n"), ["b.md"]);
});

test("does not let a comment inside a fence hide the fence or later imports", () => {
	assert.deepEqual(scanImports("```\n<!-- note\n```\n@child.md\n"), ["child.md"]);
	assert.deepEqual(scanImports("```\n<!-- note\n```\n@child.md\n-->\n"), ["child.md"]);
	assert.equal(stripForInjection("```\n<!-- note -->\n```\n"), "```\n<!-- note -->\n```\n");
});

test("does not let a fence inside a comment open a code block", () => {
	assert.deepEqual(scanImports("<!--\n```\n-->\n@child.md\n"), ["child.md"]);
	assert.equal(stripForInjection("<!--\n```\n-->\n@child.md\n"), "@child.md\n");
});

test("stops scanning after an unclosed comment", () => {
	assert.deepEqual(scanImports("<!-- note\n@hidden.md\n"), []);
});

test("skips everything after an unclosed fence", () => {
	assert.deepEqual(scanImports("```\n@a.md\n"), []);
});

test("skips block comments but scans text after them", () => {
	assert.deepEqual(scanImports("<!-- hidden @hidden.md -->\n@child.md\n"), ["child.md"]);
	assert.deepEqual(scanImports("<!-- note --> @child.md\n"), ["child.md"]);
});

test("skips imports inside frontmatter", () => {
	assert.deepEqual(scanImports("---\ntitle: x\nsecret: @no.md\n---\n@yes.md\n"), ["yes.md"]);
});

test("treats an unclosed frontmatter block as body text", () => {
	assert.deepEqual(scanImports("---\ntitle: @a.md\n"), ["a.md"]);
});

test("returns no candidates when the file has no @ at all", () => {
	assert.deepEqual(scanImports("# Title\n\nplain text\n"), []);
});

test("stripForInjection returns identical content when nothing needs stripping", () => {
	const markdown = "# Title\n\n`@a.md` stays\n";
	assert.equal(stripForInjection(markdown), markdown);
});

test("stripForInjection removes frontmatter and keeps the body", () => {
	assert.equal(stripForInjection("---\ntitle: x\n---\nbody\n"), "body\n");
});

test("stripForInjection removes block comments including multi-line ones", () => {
	assert.equal(stripForInjection("<!-- note -->\nbody\n"), "body\n");
	assert.equal(stripForInjection("<!-- a\nb -->\nbody\n"), "body\n");
});

test("stripForInjection keeps a comment that never closes", () => {
	const markdown = "<!-- a\nbody\n";
	assert.equal(stripForInjection(markdown), markdown);
});

test("stripForInjection keeps inline comments and text after a block comment", () => {
	assert.equal(stripForInjection("text <!-- c --> more\n"), "text <!-- c --> more\n");
	assert.equal(stripForInjection("<!-- n --> @a.md\n"), " @a.md\n");
});

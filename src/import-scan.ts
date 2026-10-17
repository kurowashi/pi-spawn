/**
 * Markdown scanning for Claude Code compatible `@path` imports.
 *
 * Claude Code lexes a memory file with marked and extracts `@path` references
 * from text tokens only: code spans, fenced code blocks, and HTML comments are
 * skipped, and YAML frontmatter is removed before both scanning and injection.
 * This module reproduces that behavior with small line-based rules instead of a
 * Markdown parser dependency.
 *
 * Known divergences from marked, documented in DESIGN.md:
 * - An `@` after emphasis delimiters (`**@file**`) is not extracted because the
 *   character before `@` is not whitespace.
 * - Indented code blocks (4 spaces) are not excluded; only fenced blocks are.
 * - An inline code span that spans lines is not excluded; fenced blocks are.
 * - An unclosed frontmatter block is body text, as in Claude Code.
 */

/** Claude Code's frontmatter rule (`parseFrontmatter`). */
const FRONTMATTER = /^---\s*\n([\s\S]*?)---\s*\n?/;

/** Claude Code's include rule, applied to text outside code and comments. */
const IMPORT = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;

const COMMENT_SPAN = /<!--[\s\S]*?-->/g;

const BLOCK_COMMENT_START = /^[ \t]*<!--/;

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})/;

const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})\s*$/;

const CODE_SPAN = /(`+)[\s\S]*?\1/g;

interface Segment {
	kind: "text" | "fence";
	text: string;
}

interface StrippedComment {
	text: string;
	unclosed: boolean;
}

/**
 * The `@path` references Claude Code would expand from this markdown, in
 * document order, with `#fragment` removed and `\ ` unescaped.
 *
 * Duplicates are not removed here; expansion deduplicates by resolved path.
 */
export function scanImports(content: string): string[] {
	if (!content.includes("@")) return [];
	const text = splitSegments(stripFrontmatter(content), "drop")
		.filter((segment) => segment.kind === "text")
		.map((segment) => segment.text)
		.join("\n");
	const paths: string[] = [];
	for (const line of text.split("\n")) {
		paths.push(...extractCandidates(line.replace(COMMENT_SPAN, " ").replace(CODE_SPAN, " ")));
	}
	return paths;
}

/**
 * The content Claude Code injects for a file: frontmatter and block-level HTML
 * comments removed, everything else left as written.
 */
export function stripForInjection(content: string): string {
	return splitSegments(stripFrontmatter(content), "keep")
		.map((segment) => segment.text)
		.join("\n");
}

/** Removes YAML frontmatter, matching `parseFrontmatter` in Claude Code. */
function stripFrontmatter(content: string): string {
	return content.replace(FRONTMATTER, "");
}

/**
 * Splits content into text and fenced-code segments and drops block-level HTML
 * comments. Whichever construct starts first governs until it ends, so a
 * comment inside a fence stays code and a fence inside a comment stays comment.
 *
 * `unclosed` decides the fate of a comment that never closes: "drop" skips the
 * rest of the file (Claude Code stops scanning an unclosed HTML block there),
 * "keep" leaves the text as written (Claude Code keeps it in the body).
 */
interface SplitState {
	segments: Segment[];
	buffer: string[];
	kind: Segment["kind"];
	fence: string | undefined;
	inComment: boolean;
}

function splitSegments(body: string, unclosed: "drop" | "keep"): Segment[] {
	const state: SplitState = { segments: [], buffer: [], kind: "text", fence: undefined, inComment: false };
	let offset = 0;
	for (const line of body.split("\n")) {
		consumeLine(state, body, line, offset, unclosed);
		offset += line.length + 1;
	}
	flush(state);
	return state.segments;
}

/** Advances the text/fence/comment state machine by one line. */
function consumeLine(state: SplitState, body: string, line: string, offset: number, unclosed: "drop" | "keep"): void {
	if (state.fence !== undefined) {
		state.buffer.push(line);
		if (closesFence(line, state.fence)) closeFence(state);
		return;
	}
	if (state.inComment) {
		const end = line.indexOf("-->");
		if (end === -1) return;
		state.inComment = false;
		appendResidual(state, stripCommentSpans(line.slice(end + 3)));
		return;
	}
	const marker = openingFence(line);
	if (marker !== undefined) {
		flush(state);
		state.kind = "fence";
		state.fence = marker;
		state.buffer.push(line);
		return;
	}
	if (BLOCK_COMMENT_START.test(line)) {
		appendCommentStart(state, body, line, offset, unclosed);
		return;
	}
	state.buffer.push(line);
}

function closeFence(state: SplitState): void {
	flush(state);
	state.fence = undefined;
	state.kind = "text";
}

function appendCommentStart(
	state: SplitState,
	body: string,
	line: string,
	offset: number,
	unclosed: "drop" | "keep",
): void {
	if (unclosed === "keep" && body.indexOf("-->", offset + line.indexOf("<!--") + 4) === -1) {
		state.buffer.push(line);
		return;
	}
	appendResidual(state, stripCommentSpans(line));
}

function appendResidual(state: SplitState, stripped: StrippedComment): void {
	state.inComment = stripped.unclosed;
	if (stripped.text.length > 0) state.buffer.push(stripped.text);
}

function flush(state: SplitState): void {
	if (state.buffer.length === 0) return;
	state.segments.push({ kind: state.kind, text: state.buffer.join("\n") });
	state.buffer = [];
}

function openingFence(line: string): string | undefined {
	return line.match(OPENING_FENCE)?.[1];
}

function closesFence(line: string, fence: string): boolean {
	const marker = line.match(CLOSING_FENCE)?.[1];
	return marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length;
}

/** Removes closed comment spans from text, stopping at an unclosed one. */
function stripCommentSpans(text: string): StrippedComment {
	let result = "";
	let rest = text;
	for (;;) {
		const start = rest.indexOf("<!--");
		if (start === -1) return { text: result + rest, unclosed: false };
		result += rest.slice(0, start);
		const end = rest.indexOf("-->", start + 4);
		if (end === -1) return { text: result, unclosed: true };
		rest = rest.slice(end + 3);
	}
}

/**
 * True for the path shapes Claude Code accepts: `./x`, `~/x`, `/x`, or a bare
 * path starting with a letter, digit, dot, underscore, or hyphen.
 */
function isValidImportPath(path: string): boolean {
	if (path.startsWith("./") || path.startsWith("~/")) return true;
	if (path.startsWith("/") && path !== "/") return true;
	return !path.startsWith("@") && !/^[#%^&*()]+/.test(path) && /^[a-zA-Z0-9._-]/.test(path);
}

function extractCandidates(text: string): string[] {
	const paths: string[] = [];
	for (const match of text.matchAll(new RegExp(IMPORT.source, "g"))) {
		let path = match[1] ?? "";
		path = path.split("#", 1)[0] ?? "";
		path = path.replaceAll("\\ ", " ");
		if (path !== "" && isValidImportPath(path)) paths.push(path);
	}
	return paths;
}

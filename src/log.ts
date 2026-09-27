/**
 * Child session logs for the /spawn command: JSONL lines become readable log
 * lines, and the visible window is derived from a scroll offset counted from
 * the end.
 *
 * Both the parse and the window math are pure, so the live viewer stays a thin
 * renderer and the interesting behavior is testable without a terminal.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Longest text one log line keeps; transcripts truncate here, not in the viewer. */
const MAX_LOG_LINE_CHARS = 400;

/** Transcript bytes read from the end on each refresh. */
const TAIL_BYTES = 256 * 1024;

/** The last `TAIL_BYTES` of a file. Unreadable files read as empty, never as an error. */
export function readSessionTail(path: string): string {
	try {
		const fd = openSync(path, "r");
		try {
			const size = fstatSync(fd).size;
			const start = Math.max(0, size - TAIL_BYTES);
			const buffer = Buffer.alloc(size - start);
			readSync(fd, buffer, 0, buffer.length, start);
			return buffer.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

/** Readable log lines from session JSONL text. Malformed and partial lines are skipped. */
export function formatSessionLog(text: string): string[] {
	const lines: string[] = [];
	for (const raw of text.split("\n")) {
		if (raw.trim().length === 0) continue;
		const entry = parseEntry(raw);
		if (entry !== undefined) lines.push(...formatEntry(entry));
	}
	return lines;
}

/** The window of lines counted from the end: `fromEnd` 0 shows the newest line. */
export function windowFromEnd(lines: readonly string[], height: number, fromEnd: number): string[] {
	const size = Math.max(1, height);
	const offset = Math.min(Math.max(0, fromEnd), Math.max(0, lines.length - size));
	const end = lines.length - offset;
	return lines.slice(Math.max(0, end - size), end);
}

/** The JSON object on one line, or undefined for a partial or malformed line. */
function parseEntry(raw: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function formatEntry(entry: Record<string, unknown>): string[] {
	if (entry["type"] === "message") return formatMessage(entry["message"]);
	if (entry["type"] === "compaction") {
		const summary = entry["summary"];
		return tagged("compacted", typeof summary === "string" ? summary : "");
	}
	if (entry["type"] === "custom_message") return tagged("custom", textOf(entry["content"]));
	return [];
}

function formatMessage(message: unknown): string[] {
	if (!isRecord(message)) return [];
	switch (message["role"]) {
		case "user":
			return tagged("user", textOf(message["content"]));
		case "assistant":
			return Array.isArray(message["content"]) ? message["content"].flatMap(formatAssistantPart) : [];
		case "toolResult": {
			const name = message["toolName"];
			const tag = message["isError"] === true ? "error" : "result";
			return tagged(`${tag}:${typeof name === "string" ? name : "tool"}`, textOf(message["content"]));
		}
		default:
			// System messages carry the prompt and tool loadout, not a log line.
			return [];
	}
}

/** One assistant content part: text, a tool call signature, or nothing for thinking. */
function formatAssistantPart(part: unknown): string[] {
	if (!isRecord(part)) return [];
	if (part["type"] === "text" && typeof part["text"] === "string") return tagged("assistant", part["text"]);
	if (part["type"] === "toolCall") {
		const name = typeof part["name"] === "string" ? part["name"] : "tool";
		return tagged(`tool:${name}`, part["arguments"] === undefined ? "" : JSON.stringify(part["arguments"]));
	}
	return [];
}

/** Text of message content: a string, or the text and image parts of an array. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (!isRecord(part)) return [];
			if (part["type"] === "text" && typeof part["text"] === "string") return [part["text"]];
			if (part["type"] === "image") return ["[image]"];
			return [];
		})
		.join("\n");
}

/** `[tag] first line`, with every continuation line indented under it. */
function tagged(tag: string, text: string): string[] {
	return bound(text)
		.split("\n")
		.map((line, index) => (index === 0 ? (line.length === 0 ? `[${tag}]` : `[${tag}] ${line}`) : `  ${line}`));
}

/** Bound one log line so a huge tool call or result cannot blow up the viewer buffer. */
function bound(text: string): string {
	return text.length <= MAX_LOG_LINE_CHARS ? text : `${text.slice(0, MAX_LOG_LINE_CHARS)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

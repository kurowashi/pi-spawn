/**
 * The live log overlay behind `/spawn`.
 *
 * Refresh reads the child session tail and the run's in-memory status; the
 * viewport follows the newest line until the user scrolls up. Parsing and
 * window math live in log.ts, so this file stays a thin renderer.
 */

import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { contextText, formatCost, formatElapsed, type TextTheme } from "./format.ts";
import { formatSessionLog, readSessionTail, windowFromEnd } from "./log.ts";
import type { RunUsage } from "./types.ts";

/** Refresh cadence for the transcript tail. */
const REFRESH_MS = 700;

/** Newest log lines kept in memory. */
const MAX_LINES = 2000;

/** Title, status, and footer around the viewport. */
const CHROME_LINES = 3;

/** The overlay's share of the terminal height; matches the overlay options. */
const VIEWPORT_FRACTION = 0.8;

/** What the viewer shows about a run beyond its log. */
export interface LogViewStatus {
	activity: string;
	elapsedMs: number;
	usage: RunUsage;
	context?: ContextUsage;
}

export interface LogViewInput {
	name: string;
	agent: string;
	runId: string;
	model: string;
	/** Persisted transcript; undefined while the run has none. */
	sessionFile(): string | undefined;
	/** Live status; undefined once the run cannot report any. */
	status(): LogViewStatus | undefined;
	live(): boolean;
	/** Terminal rows, read per render so a resize is picked up. */
	rows(): number;
	requestRender(): void;
	done(): void;
}

/** Injected so tests can drive the viewer without touching the filesystem. */
export interface LogViewDeps {
	read(path: string): string;
}

export class LogView {
	private readonly input: LogViewInput;
	private readonly theme: TextTheme;
	private readonly deps: LogViewDeps;
	private lines: string[] = [];
	private fromEnd = 0;
	private path: string | undefined;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(input: LogViewInput, theme: TextTheme, deps: LogViewDeps = { read: readSessionTail }) {
		this.input = input;
		this.theme = theme;
		this.deps = deps;
		this.tick();
		this.timer = setInterval(() => this.tick(), REFRESH_MS);
		this.timer.unref();
	}

	dispose(): void {
		clearInterval(this.timer);
	}

	invalidate(): void {
		// Nothing is cached across renders; the next render reads current state.
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.input.done();
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.scrollBy(1);
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.scrollBy(-1);
		} else if (matchesKey(data, "pageUp")) {
			this.scrollBy(this.viewportHeight());
		} else if (matchesKey(data, "pageDown")) {
			this.scrollBy(-this.viewportHeight());
		} else if (matchesKey(data, "home") || matchesKey(data, "t")) {
			this.scrollBy(this.lines.length);
		} else if (matchesKey(data, "end") || matchesKey(data, "f")) {
			this.fromEnd = 0;
			this.input.requestRender();
		}
	}

	render(width: number): string[] {
		const height = this.viewportHeight();
		const body = windowFromEnd(this.lines, height, this.fromEnd);
		const visible = body.length > 0 ? body : [this.theme.fg("dim", "(no output yet)")];
		const lines = [this.title(width), this.status(width), ...visible.map((line) => this.body(line, width))];
		while (lines.length < height + CHROME_LINES - 1) lines.push("");
		lines.push(this.footer(width));
		return lines;
	}

	/** Re-read the transcript and refresh the view. Called on a timer; tests call it directly. */
	tick(): void {
		const path = this.input.sessionFile();
		if (path === undefined) return;
		const previous = this.lines.length;
		if (path !== this.path) {
			this.lines = [];
			this.path = path;
		}
		const parsed = formatSessionLog(this.deps.read(path));
		this.lines = parsed.length > MAX_LINES ? parsed.slice(-MAX_LINES) : parsed;
		// Keep the viewed lines still while scrolled up: new lines land below.
		if (this.fromEnd > 0) this.fromEnd += Math.max(0, this.lines.length - previous);
		this.input.requestRender();
	}

	private scrollBy(lines: number): void {
		const maxFromEnd = Math.max(0, this.lines.length - this.viewportHeight());
		this.fromEnd = Math.min(Math.max(0, this.fromEnd + lines), maxFromEnd);
		this.input.requestRender();
	}

	private viewportHeight(): number {
		const chrome = CHROME_LINES;
		return Math.max(3, Math.floor(this.input.rows() * VIEWPORT_FRACTION) - chrome);
	}

	private title(width: number): string {
		return this.fit(this.theme.fg("accent", `${this.input.name} (${this.input.agent}, ${this.input.runId})`), width);
	}

	private status(width: number): string {
		const status = this.input.status();
		const parts = [this.input.live() ? "live" : "finished"];
		if (status !== undefined) parts.push(`${status.activity} (${formatElapsed(status.elapsedMs)})`);
		parts.push(this.input.model);
		if (status?.context !== undefined) parts.push(contextText(status.context));
		if (status !== undefined && status.usage.cost > 0) parts.push(formatCost(status.usage.cost));
		return this.fit(this.theme.fg("dim", parts.join(" \u00b7 ")), width);
	}

	private footer(width: number): string {
		const offset = this.fromEnd === 0 ? "" : `${this.fromEnd} lines below \u00b7 `;
		return this.fit(
			this.theme.fg("dim", `${offset}Esc close \u00b7 f follow \u00b7 \u2191/k \u2193/j \u00b7 PgUp/PgDn \u00b7 t top`),
			width,
		);
	}

	/** One log line, truncated to the viewport and dimmed by its tag. */
	private body(line: string, width: number): string {
		return this.fit(this.style(line), width);
	}

	private style(line: string): string {
		if (line.startsWith("[user]")) return this.theme.fg("accent", line);
		if (line.startsWith("[tool:")) return this.theme.fg("muted", line);
		if (line.startsWith("[error:")) return this.theme.fg("error", line);
		if (line.startsWith("[result:") || line.startsWith("[compacted]")) return this.theme.fg("dim", line);
		return line;
	}

	/** One rendered line: inset by one column and bounded to the width. */
	private fit(line: string, width: number): string {
		return ` ${truncateToWidth(line, Math.max(1, width - 1), "\u2026")}`;
	}
}

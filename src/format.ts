/**
 * Shared display formatting: elapsed time, token counts, cost, and context
 * window usage.
 *
 * The tool's progress lines and the /spawn viewer describe the same runs, so
 * the vocabulary lives in one place and stays testable without a terminal.
 */

import type { ContextUsage } from "@earendil-works/pi-coding-agent";

/** The smallest Theme surface these formatters use, so tests can pass an identity instead. */
export interface TextTheme {
	fg(color: string, text: string): string;
}

/** Compact elapsed time: "12s", "2m10s". */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** Compact token counts: `999`, `12.3k`, `1.2M`. */
export function formatTokenCount(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${oneDecimal(count / 1000)}k`;
	return `${oneDecimal(count / 1_000_000)}M`;
}

/** Cost with enough precision to stay non-zero for cheap runs: `$0.0025`, `$0.25`. */
export function formatCost(cost: number): string {
	if (cost === 0) return "$0";
	return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

/** Context window usage: `ctx 12.3k/200k (6%)`. */
export function contextText(context: ContextUsage): string {
	const window = formatTokenCount(context.contextWindow);
	if (context.tokens === null) return `ctx ?/${window}`;
	const percent = context.percent === null ? undefined : `${Math.round(context.percent)}%`;
	const suffix = percent === undefined ? "" : ` (${percent})`;
	return `ctx ${formatTokenCount(context.tokens)}/${window}${suffix}`;
}

/** One decimal, with a trailing `.0` dropped: 12.0 -> "12", 12.34 -> "12.3". */
function oneDecimal(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}

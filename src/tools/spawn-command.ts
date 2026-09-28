/**
 * The /spawn command: inspect live runs and open one run's log.
 *
 * The command is user-only, so it costs no model tokens. It exists because
 * spawn_agents blocks the parent's turn: during that window this command is
 * the only way to look inside a child.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { contextText, formatCost, formatElapsed } from "../format.ts";
import { LogView, type LogViewStatus } from "../log-view.ts";
import { explainTarget, type RunRegistry } from "../registry.ts";
import { runElapsed, subtractUsage } from "../spawn.ts";
import type { RunHandle } from "../types.ts";

export const COMMAND_DESCRIPTION = "List or follow live spawned runs";

export function registerSpawnCommand(pi: ExtensionAPI, registry: RunRegistry): void {
	pi.registerCommand("spawn", {
		description: COMMAND_DESCRIPTION,
		handler: (args, ctx) => runSpawnCommand(args, ctx, registry),
	});
}

/** No argument picks a run; `/spawn <target>` and `/spawn logs <target>` open that run's log. */
export async function runSpawnCommand(
	args: string,
	ctx: ExtensionCommandContext,
	registry: RunRegistry,
): Promise<void> {
	const runs = registry.list();
	if (runs.length === 0) {
		ctx.ui.notify("No live spawn runs", "info");
		return;
	}
	const target = spawnTarget(args);
	const handle = target.length > 0 ? resolveRun(target, ctx, registry, runs) : await pickRun(ctx, runs);
	if (handle === undefined) return;
	await followRun(ctx, handle, registry);
}

/** The run argument: `/spawn <target>` and `/spawn logs <target>` mean the same. */
export function spawnTarget(args: string): string {
	const [verb, ...rest] = args.trim().split(/\s+/);
	if (verb !== "logs") return args.trim();
	return rest.join(" ").trim();
}

function resolveRun(
	target: string,
	ctx: ExtensionCommandContext,
	registry: RunRegistry,
	runs: readonly RunHandle[],
): RunHandle | undefined {
	const resolution = registry.resolve(target);
	if (resolution.ok) return resolution.handle;
	ctx.ui.notify(explainTarget(target, resolution, runs), "error");
	return undefined;
}

async function pickRun(ctx: ExtensionCommandContext, runs: readonly RunHandle[]): Promise<RunHandle | undefined> {
	const labels = runs.map(describeRun);
	const choice = await ctx.ui.select("Live spawn runs", labels);
	if (choice === undefined) return undefined;
	return runs[labels.indexOf(choice)];
}

/** One run's line: identity, activity, model, context, and cost. */
export function describeRun(handle: RunHandle): string {
	const status = statusOf(handle);
	const parts = [`${handle.name} (${handle.agent}, ${handle.sessionId})`];
	if (status !== undefined) parts.push(`${status.activity} (${formatElapsed(status.elapsedMs)})`);
	parts.push(handle.model);
	if (status?.context !== undefined) parts.push(contextText(status.context));
	if (status !== undefined && status.usage.cost > 0) parts.push(formatCost(status.usage.cost));
	return parts.join(" \u00b7 ");
}

/** Snapshot plus elapsed time and billed usage, or undefined when the run cannot report. */
export function statusOf(handle: RunHandle): LogViewStatus | undefined {
	try {
		const snapshot = handle.channel.snapshot();
		return {
			activity: snapshot.activity,
			elapsedMs: runElapsed(handle, snapshot),
			usage: subtractUsage(snapshot.usage, handle.usageBase),
			...(snapshot.context === undefined ? {} : { context: snapshot.context }),
		};
	} catch {
		return undefined;
	}
}

function sessionFileOf(handle: RunHandle): string | undefined {
	try {
		return handle.channel.snapshot().sessionFile;
	} catch {
		return undefined;
	}
}

/** Only the terminal can host the live view; other modes get the summary line. */
async function followRun(ctx: ExtensionCommandContext, handle: RunHandle, registry: RunRegistry): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(describeRun(handle), "info");
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) =>
			new LogView(
				{
					name: handle.name,
					agent: handle.agent,
					sessionId: handle.sessionId,
					model: handle.model,
					sessionFile: () => sessionFileOf(handle),
					status: () => statusOf(handle),
					live: () => registry.list().some((candidate) => candidate.sessionId === handle.sessionId),
					rows: () => tui.terminal.rows,
					requestRender: () => tui.requestRender(),
					done,
				},
				theme,
			),
		{ overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" } },
	);
}

/**
 * The only mutable state in this extension: the set of live runs created by one
 * spawn_agents call, so siblings can address each other.
 *
 * Run ids are the only address: one form exists, so no resolution ambiguity can
 * arise. The failure text lists live run ids so the caller can retry verbatim.
 */

import type { RunHandle } from "./types.ts";

export type TargetResolution = { ok: true; handle: RunHandle } | { ok: false };

/** Resolve `target_run_id` against live runs. Exact match only. */
export function resolveTarget(runId: string, handles: readonly RunHandle[]): TargetResolution {
	const handle = handles.find((candidate) => candidate.runId === runId);
	return handle === undefined ? { ok: false } : { ok: true, handle };
}

/** The failure explanation for a rejected resolve, naming every live run id so the caller can retry. */
export function explainTarget(runId: string, resolution: TargetResolution, handles: readonly RunHandle[]): string {
	if (resolution.ok) return "";
	const live = handles.map((handle) => handle.runId).join(", ");
	return `no live run has target_run_id '${runId}'. Live run_ids: ${live.length > 0 ? live : "(none)"}`;
}

export interface RunRegistry {
	add(handle: RunHandle): void;
	remove(runId: string): void;
	resolve(to: string): TargetResolution;
	/** Every live run, so a runner can find its own inbound state. */
	list(): readonly RunHandle[];
}

export function createRunRegistry(): RunRegistry {
	const handles = new Map<string, RunHandle>();
	return {
		add(handle) {
			handles.set(handle.runId, handle);
		},
		remove(runId) {
			handles.delete(runId);
		},
		resolve(to) {
			return resolveTarget(to, [...handles.values()]);
		},
		list() {
			return [...handles.values()];
		},
	};
}

/**
 * The only mutable state in this extension: the set of live runs created by one
 * spawn_agents call, so siblings can address each other.
 *
 * Resolution is a pure function over the handle list, so address ambiguity is
 * decided by a unit test rather than by whichever run happens to be first.
 */

import type { RunHandle } from "./types.ts";

export type TargetResolution =
	| { ok: true; handle: RunHandle }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "ambiguous"; candidates: string[] };

/** Resolve `to` against live runs. Exact run id wins; otherwise the agent name must be unique. */
export function resolveTarget(to: string, handles: readonly RunHandle[]): TargetResolution {
	const byId = handles.find((handle) => handle.runId === to);
	if (byId !== undefined) return { ok: true, handle: byId };

	const byName = handles.filter((handle) => handle.agent === to);
	const [first] = byName;
	if (first === undefined) return { ok: false, reason: "not_found" };
	if (byName.length > 1) {
		return { ok: false, reason: "ambiguous", candidates: byName.map((handle) => handle.runId) };
	}
	return { ok: true, handle: first };
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

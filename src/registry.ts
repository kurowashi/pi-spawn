/**
 * The only mutable state in this extension: the set of live runs created by one
 * spawn_agents call, so siblings can address each other.
 *
 * The persisted session id is the only address: one form exists, so no
 * resolution ambiguity can arise. The failure text lists live session ids so
 * the caller can retry verbatim.
 */

import type { RunHandle } from "./types.ts";

export type TargetResolution = { ok: true; handle: RunHandle } | { ok: false };

/** Resolve `target_session_id` against live runs. Exact match only. */
export function resolveTarget(sessionId: string, handles: readonly RunHandle[]): TargetResolution {
	const handle = handles.find((candidate) => candidate.sessionId === sessionId);
	return handle === undefined ? { ok: false } : { ok: true, handle };
}

/** The failure explanation for a rejected resolve, naming every live session id so the caller can retry. */
export function explainTarget(sessionId: string, resolution: TargetResolution, handles: readonly RunHandle[]): string {
	if (resolution.ok) return "";
	const live = handles.map((handle) => handle.sessionId).join(", ");
	return `no live run has target_session_id '${sessionId}'. Live session_ids: ${live.length > 0 ? live : "(none)"}`;
}

export interface RunRegistry {
	add(handle: RunHandle): void;
	remove(sessionId: string): void;
	resolve(sessionId: string): TargetResolution;
	/** Every live run, so a runner can find its own inbound state. */
	list(): readonly RunHandle[];
}

export function createRunRegistry(): RunRegistry {
	const handles = new Map<string, RunHandle>();
	return {
		add(handle) {
			handles.set(handle.sessionId, handle);
		},
		remove(sessionId) {
			handles.delete(sessionId);
		},
		resolve(sessionId) {
			return resolveTarget(sessionId, [...handles.values()]);
		},
		list() {
			return [...handles.values()];
		},
	};
}

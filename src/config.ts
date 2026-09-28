/**
 * Config discovery and resolution for pi-spawn.
 *
 * Files are merged nearest-last: the global config at
 * `~/.pi/agent/spawn.json` (or `$PI_CODING_AGENT_DIR/spawn.json`) is read first
 * and the project config at `<cwd>/.pi/spawn.json` overrides it. Project configs
 * are ignored when the project is not trusted.
 *
 * Unknown keys are ignored and invalid values fall back to the default with a
 * warning instead of throwing, so a broken config never breaks a session.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const CONFIG_FILE_NAME = "spawn.json";

export interface SpawnConfig {
	/** Whole-call deadline in milliseconds; 0 means no deadline. */
	timeoutMs: number;
}

export const DEFAULT_CONFIG: SpawnConfig = {
	// Covers every run measured so far (max ~44 minutes); raise it per project when needed.
	timeoutMs: 60 * 60 * 1000,
};

export interface LoadedSpawnConfig {
	config: SpawnConfig;
	warnings: string[];
	globalFile: string;
	projectFile: string;
}

export function globalConfigPath(agentDir: string): string {
	return path.join(agentDir, CONFIG_FILE_NAME);
}

export function projectConfigPath(cwd: string): string {
	return path.join(cwd, ".pi", CONFIG_FILE_NAME);
}

function readConfigFile(file: string): { value?: Record<string, unknown>; warning?: string } {
	if (!fs.existsSync(file)) return {};
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		return { warning: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { warning: `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { warning: `${file} must contain a JSON object` };
	}
	return { value: parsed as Record<string, unknown> };
}

/** A deadline in ms: 0 or a positive integer. */
function timeoutOr(value: unknown, key: string, fallback: number, warnings: string[]): number {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
	warnings.push(`spawn: ${key} must be an integer >= 0; using ${fallback}`);
	return fallback;
}

/** Validate raw configs (lowest precedence first) into a complete config. */
export function resolveConfig(raws: Record<string, unknown>[], warnings: string[]): SpawnConfig {
	const raw: Record<string, unknown> = Object.assign({}, ...raws);
	return { timeoutMs: timeoutOr(raw["timeoutMs"], "timeoutMs", DEFAULT_CONFIG.timeoutMs, warnings) };
}

export function loadSpawnConfig(input: { cwd: string; agentDir: string; projectTrusted: boolean }): LoadedSpawnConfig {
	const globalFile = globalConfigPath(input.agentDir);
	const projectFile = projectConfigPath(input.cwd);
	const warnings: string[] = [];
	const raws: Record<string, unknown>[] = [];

	const globalRead = readConfigFile(globalFile);
	if (globalRead.warning) warnings.push(globalRead.warning);
	if (globalRead.value) raws.push(globalRead.value);

	if (fs.existsSync(projectFile)) {
		if (input.projectTrusted) {
			const projectRead = readConfigFile(projectFile);
			if (projectRead.warning) warnings.push(projectRead.warning);
			if (projectRead.value) raws.push(projectRead.value);
		} else {
			warnings.push(`ignoring ${projectFile}: project is not trusted (use /trust to enable project config)`);
		}
	}

	return { config: resolveConfig(raws, warnings), warnings, globalFile, projectFile };
}

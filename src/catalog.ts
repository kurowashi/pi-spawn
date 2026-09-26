/**
 * Agent definition discovery and parsing.
 *
 * Reads `<agentDir>/agents/*.md` with YAML frontmatter. Unknown keys are
 * reported as warnings instead of failing, because a definition file may carry
 * keys this extension deliberately does not implement (`async`, ...).
 * A duplicate agent name resolves to the first file in sorted order.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./types.ts";

/** Keys this extension understands. Everything else is a warning. */
const KNOWN_KEYS = new Set([
	"name",
	"description",
	"tools",
	"model",
	"thinking",
	"systemPromptMode",
	"inheritProjectContext",
	"inheritSkills",
	"extensions",
]);

const THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface Catalog {
	agents: AgentDefinition[];
	warnings: string[];
}

/** Parse one agent markdown file. Returns undefined when the file is not a definition. */
export function parseAgent(
	content: string,
	path: string,
	warn: (message: string) => void,
): AgentDefinition | undefined {
	const { frontmatter, body } = parseFrontmatter(content);
	const name = readString(frontmatter["name"]);
	if (name === undefined) {
		warn(`${path}: missing frontmatter 'name', ignoring`);
		return undefined;
	}
	for (const key of Object.keys(frontmatter)) {
		if (!KNOWN_KEYS.has(key)) warn(`${path}: ignoring unsupported frontmatter key '${key}'`);
	}
	const agent: AgentDefinition = {
		name,
		description: readString(frontmatter["description"]) ?? "",
		body: body.trim(),
		inheritProjectContext: frontmatter["inheritProjectContext"] !== false,
		inheritSkills: frontmatter["inheritSkills"] !== false,
		extensions: frontmatter["extensions"] === true,
		systemPromptMode: readSystemPromptMode(frontmatter["systemPromptMode"], path, warn),
		path,
	};
	const tools = readTools(frontmatter["tools"], path, warn);
	if (tools !== undefined) agent.tools = tools;
	const model = readString(frontmatter["model"]);
	if (model !== undefined) agent.model = model;
	const thinking = readThinking(frontmatter["thinking"], path, warn);
	if (thinking !== undefined) agent.thinking = thinking;
	return agent;
}

/** Discover every definition under `<agentDir>/agents`. Missing directory means no agents. */
export function discoverAgents(agentDir: string): Catalog {
	const directory = join(agentDir, "agents");
	const agents: AgentDefinition[] = [];
	const warnings: string[] = [];
	const warn = (message: string): void => {
		warnings.push(message);
	};

	let entries: string[];
	try {
		entries = readdirSync(directory).filter((entry) => entry.endsWith(".md"));
	} catch {
		return { agents, warnings };
	}

	for (const entry of entries.sort()) {
		const path = join(directory, entry);
		let content: string;
		try {
			content = readFileSync(path, "utf8");
		} catch (error) {
			warn(`${path}: cannot read (${describe(error)})`);
			continue;
		}
		const agent = parseAgent(content, path, warn);
		if (agent === undefined) continue;
		agents.push(agent);
	}
	return { agents, warnings };
}

/** The one-line catalog injected into the system prompt. Its size follows the definitions. */
export function formatCatalog(agents: AgentDefinition[]): string | undefined {
	if (agents.length === 0) return undefined;
	const lines = agents.map((agent) => {
		if (agent.description.length === 0) return agent.name;
		return `${agent.name} — ${agent.description}`;
	});
	return `agents: ${lines.join("; ")}`;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readTools(value: unknown, path: string, warn: (message: string) => void): string[] | undefined {
	if (value === undefined) return undefined;
	const raw = Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: typeof value === "string"
			? value.split(",")
			: undefined;
	if (raw === undefined) {
		warn(`${path}: 'tools' is neither a string list nor an array, ignoring`);
		return undefined;
	}
	return raw.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function readThinking(value: unknown, path: string, warn: (message: string) => void): ThinkingLevel | undefined {
	const thinking = readString(value);
	if (thinking === undefined) return undefined;
	if (!THINKING_LEVELS.has(thinking)) {
		warn(`${path}: unknown thinking level '${thinking}', ignoring`);
		return undefined;
	}
	return thinking as ThinkingLevel;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Append is the safe default: Pi's own tool guidance survives. */
function readSystemPromptMode(value: unknown, path: string, warn: (message: string) => void): "append" | "replace" {
	const mode = readString(value);
	if (mode === undefined) return "append";
	if (mode === "append" || mode === "replace") return mode;
	warn(`${path}: unknown systemPromptMode '${mode}', using append`);
	return "append";
}

/**
 * `@path` imports in an agent definition body, formatted like Claude Code's memory.
 *
 * The rules and the text are pi-import's (Claude Code 2.1.287): imports resolve
 * against the importing file's directory, at most four hops, every path is
 * processed once per call (which also stops cycles), non-text and oversized
 * files are skipped silently, and imports inherit the importer's memory type.
 * The definition body is the root: its top-level imports resolve against the
 * child's working directory, because the definition file is not where the
 * child works.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, resolve } from "node:path";
import { scanImports, stripForInjection } from "./import-scan.ts";

type MemoryType = "project" | "user";

export interface MemoryEntry {
	path: string;
	content: string;
	type: MemoryType;
}

export interface DefinitionPromptInput {
	/** Definition body after frontmatter, as written. */
	body: string;
	/** The definition file; its own path is never imported again. */
	bodyPath: string;
	/** The child's working directory; the base for top-level imports. */
	cwd: string;
	/** The Pi agent directory. Definitions under it are `user`, the rest `project`. */
	agentDir: string;
}

/** Claude Code allows at most four hops below the root (depth 0). */
const MAX_DEPTH = 4;

/** Claude Code refuses files above 4 MiB (`vQ` in the bundled code). */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Claude Code's allowed import extensions; extensionless files pass too. */
const TEXT_EXTENSIONS = new Set(
	(
		".md .txt .text .json .yaml .yml .toml .xml .csv .html .htm .css .scss .sass .less " +
		".js .ts .tsx .jsx .mjs .cjs .mts .cts .py .pyi .pyw .rb .erb .rake .go .rs .java .kt .kts .scala " +
		".c .cpp .cc .cxx .h .hpp .hxx .cs .swift .sh .bash .zsh .fish .ps1 .bat .cmd .env .ini .cfg .conf " +
		".config .properties .sql .graphql .gql .proto .vue .svelte .astro .ejs .hbs .pug .jade .php .pl .pm " +
		".lua .r .dart .ex .exs .erl .hrl .clj .cljs .cljc .edn .hs .lhs .elm .ml .mli .f .f90 .f95 .for " +
		".cmake .make .makefile .gradle .sbt .rst .adoc .asciidoc .org .tex .latex .lock .log .diff .patch"
	).split(" "),
);

/** The fixed preamble Claude Code puts in front of every memory text. */
export const MEMORY_PROMPT =
	"Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";

const DESCRIPTION: Record<MemoryType, string> = {
	project: " (project instructions, checked into the codebase)",
	user: " (user's private global instructions for all projects)",
};

/**
 * The definition body as written, followed by the imported files in the memory format.
 *
 * Returns the trimmed body alone when no import resolves, so a definition without
 * imports reaches the model exactly as before.
 */
export function expandDefinitionBody(input: DefinitionPromptInput): string {
	const body = input.body.trim();
	const type: MemoryType = dirname(dirname(input.bodyPath)) === resolve(input.agentDir) ? "user" : "project";
	const processed = new Set<string>([canonicalKey(input.bodyPath)]);
	const entries: MemoryEntry[] = [];

	const visit = (content: string, baseDir: string, depth: number): void => {
		if (depth >= MAX_DEPTH) return;
		for (const candidate of scanImports(content)) {
			const imported = readImport(candidate, baseDir, processed);
			if (imported === undefined) continue;
			const text = stripForInjection(imported.content).trim();
			if (text === "") continue;
			entries.push({ path: imported.path, content: text, type });
			visit(imported.content, dirname(imported.path), depth + 1);
		}
	};

	visit(body, input.cwd, 0);
	const memory = formatMemory(entries);
	return memory === "" ? body : `${body}\n\n${memory}`;
}

/** Formats memory entries exactly as Claude Code does. Entries are joined by a blank line. */
export function formatMemory(entries: readonly MemoryEntry[]): string {
	const blocks = entries.map(
		(entry) => `Contents of ${entry.path}${DESCRIPTION[entry.type]}:\n\n${entry.content.trim()}`,
	);
	if (blocks.length === 0) return "";
	return `${MEMORY_PROMPT}\n\n${blocks.join("\n\n")}`;
}

interface Imported {
	path: string;
	content: string;
}

/** Resolves and reads one import, or returns undefined when it is skipped. The first sighting claims the path. */
function readImport(candidate: string, baseDir: string, processed: Set<string>): Imported | undefined {
	const absolute = resolveImportPath(candidate, baseDir);
	if (!isTextFile(absolute)) return undefined;
	const key = canonicalKey(absolute);
	if (processed.has(key)) return undefined;
	processed.add(key);
	const content = readTextFile(absolute);
	if (content === undefined || content.trim() === "") return undefined;
	return { path: absolute, content };
}

/** `~/x` goes to the home directory; everything else resolves against the importer. */
function resolveImportPath(candidate: string, baseDir: string): string {
	if (candidate.startsWith("~/")) return resolve(homedir(), candidate.slice(2));
	return resolve(baseDir, candidate);
}

function isTextFile(path: string): boolean {
	const extension = extname(path).toLowerCase();
	return extension === "" || TEXT_EXTENSIONS.has(extension);
}

/** Dedup and cycle key: the real path when it exists, the absolute path otherwise. */
function canonicalKey(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** Reads a regular text file under the size cap; anything else is skipped. */
function readTextFile(path: string): string | undefined {
	try {
		const stats = statSync(path);
		if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return undefined;
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

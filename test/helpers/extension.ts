/**
 * Loads the real extension entry through Pi's own loader (jiti), the same path
 * Pi uses at runtime. Contract tests therefore validate the shipped artifact,
 * not a re-import of the modules under test.
 *
 * The loader also scans project and global extension directories, so both are
 * redirected to an empty temporary directory to keep the test hermetic and
 * independent of whatever the developer has installed.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions, type Extension, type ToolDefinition } from "@earendil-works/pi-coding-agent";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root, derived from this file: test/helpers/ -> ../.. */
export const PACKAGE_ROOT = join(HERE, "..", "..");

/** The path declared in package.json under `pi.extensions`. */
export const EXTENSION_ENTRY = join(PACKAGE_ROOT, "src", "index.ts");

/** Empty sandbox standing in for a project root and a Pi agent directory. */
const SANDBOX = mkdtempSync(join(tmpdir(), "pi-spawn-contract-"));

/** Load the extension exactly as Pi does, failing loudly on loader errors. */
export async function loadSpawnExtension(): Promise<Extension> {
	const result = await discoverAndLoadExtensions([EXTENSION_ENTRY], SANDBOX, SANDBOX);
	assert.deepEqual(result.errors, [], "extension must load without errors");
	assert.equal(result.extensions.length, 1, "the sandbox must load only this extension");
	const extension = result.extensions[0];
	assert.ok(extension, "loader must return one extension");
	return extension;
}

/** Registered tools, keyed by model-facing name. */
export async function loadSpawnTools(): Promise<Map<string, ToolDefinition>> {
	const extension = await loadSpawnExtension();
	return new Map([...extension.tools].map(([name, registered]) => [name, registered.definition]));
}

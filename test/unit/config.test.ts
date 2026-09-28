/**
 * Unit: spawn.json discovery and resolution.
 *
 * The deadline is a harness policy, not a model decision, so its discovery rules
 * (global, project-when-trusted, invalid values) are pinned here.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadSpawnConfig, resolveConfig } from "../../src/config.ts";

interface Sandbox {
	agentDir: string;
	cwd: string;
	cleanup(): void;
}

function sandbox(): Sandbox {
	const root = mkdtempSync(join(tmpdir(), "pi-spawn-config-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	return { agentDir, cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("the default deadline is one hour", () => {
	assert.equal(DEFAULT_CONFIG.timeoutMs, 3_600_000, "the documented default is part of the contract");
	const box = sandbox();
	try {
		const loaded = loadSpawnConfig({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted: false });
		assert.deepEqual(loaded.config, DEFAULT_CONFIG);
		assert.deepEqual(loaded.warnings, []);
	} finally {
		box.cleanup();
	}
});

test("the global config sets the deadline", () => {
	const box = sandbox();
	try {
		writeFileSync(join(box.agentDir, "spawn.json"), JSON.stringify({ timeoutMs: 120_000 }));
		const loaded = loadSpawnConfig({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted: false });
		assert.equal(loaded.config.timeoutMs, 120_000);
		assert.deepEqual(loaded.warnings, []);
	} finally {
		box.cleanup();
	}
});

test("a trusted project config overrides the global one", () => {
	const box = sandbox();
	try {
		writeFileSync(join(box.agentDir, "spawn.json"), JSON.stringify({ timeoutMs: 120_000 }));
		writeFileSync(join(box.cwd, ".pi", "spawn.json"), JSON.stringify({ timeoutMs: 600_000 }));
		const loaded = loadSpawnConfig({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted: true });
		assert.equal(loaded.config.timeoutMs, 600_000);
	} finally {
		box.cleanup();
	}
});

test("an untrusted project config is ignored with a warning", () => {
	const box = sandbox();
	try {
		writeFileSync(join(box.cwd, ".pi", "spawn.json"), JSON.stringify({ timeoutMs: 600_000 }));
		const loaded = loadSpawnConfig({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted: false });
		assert.equal(loaded.config.timeoutMs, DEFAULT_CONFIG.timeoutMs);
		assert.equal(loaded.warnings.length, 1);
		assert.match(loaded.warnings[0] ?? "", /not trusted/);
	} finally {
		box.cleanup();
	}
});

test("invalid values fall back to the default with a warning", () => {
	const warnings: string[] = [];
	assert.equal(resolveConfig([{ timeoutMs: -1 }], warnings).timeoutMs, DEFAULT_CONFIG.timeoutMs);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /timeoutMs/);

	const stringWarnings: string[] = [];
	assert.equal(resolveConfig([{ timeoutMs: "soon" }], stringWarnings).timeoutMs, DEFAULT_CONFIG.timeoutMs);
	assert.equal(stringWarnings.length, 1);

	const fractionalWarnings: string[] = [];
	assert.equal(resolveConfig([{ timeoutMs: 1.7 }], fractionalWarnings).timeoutMs, DEFAULT_CONFIG.timeoutMs);
	assert.equal(fractionalWarnings.length, 1);
});

test("zero means no deadline", () => {
	assert.equal(resolveConfig([{ timeoutMs: 0 }], []).timeoutMs, 0);
});

test("broken JSON is a warning, not a failure", () => {
	const box = sandbox();
	try {
		writeFileSync(join(box.agentDir, "spawn.json"), "{ not json");
		const loaded = loadSpawnConfig({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted: false });
		assert.deepEqual(loaded.config, DEFAULT_CONFIG);
		assert.equal(loaded.warnings.length, 1);
		assert.match(loaded.warnings[0] ?? "", /not valid JSON/);
	} finally {
		box.cleanup();
	}
});

test("a JSON value that is not an object is a warning", () => {
	const box = sandbox();
	try {
		writeFileSync(join(box.agentDir, "spawn.json"), "[1, 2]");
		const loaded = loadSpawnConfig({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted: false });
		assert.deepEqual(loaded.config, DEFAULT_CONFIG);
		assert.equal(loaded.warnings.length, 1);
		assert.match(loaded.warnings[0] ?? "", /must contain a JSON object/);
	} finally {
		box.cleanup();
	}
});

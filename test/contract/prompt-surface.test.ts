/**
 * Contract: how the agent catalog reaches the model.
 *
 * The catalog is injected as the `spawn_catalog` section. Returning a whole
 * `systemPrompt` would set `forceSystemPrompt`, which freezes the run and hides
 * the section changes of extensions registered after this one.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadSpawnExtension } from "../helpers/extension.ts";

const CATALOG = "agents: worker — Does work.";

function agentDirWith(files: Record<string, string>): string {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-spawn-prompt-"));
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	for (const [name, content] of Object.entries(files)) writeFileSync(join(agentDir, "agents", name), content);
	return agentDir;
}

/** Invokes the shipped handler with the agent directory redirected to a temp dir. */
async function runBeforeAgentStart(agentDir: string): Promise<{ result: unknown; sections: Record<string, string> }> {
	const extension = await loadSpawnExtension();
	const handler = extension.handlers.get("before_agent_start")?.[0];
	assert.ok(handler, "before_agent_start must be registered");
	const sections: Record<string, string> = {};
	const event = { type: "before_agent_start", prompt: "", systemPrompt: "", systemPromptOptions: { sections } };
	const ctx = { cwd: mkdtempSync(join(tmpdir(), "pi-spawn-cwd-")), isProjectTrusted: () => false };
	const previous = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	try {
		return { result: await handler(event, ctx as unknown as ExtensionContext), sections };
	} finally {
		if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previous;
	}
}

test("adds the catalog as the spawn_catalog section without forcing the prompt", async () => {
	const agentDir = agentDirWith({ "worker.md": "---\nname: worker\ndescription: Does work.\n---\nbody\n" });
	const { result, sections } = await runBeforeAgentStart(agentDir);
	assert.equal(result, undefined);
	assert.equal(sections["spawn_catalog"], CATALOG);
});

test("adds no section when no definition exists", async () => {
	const { result, sections } = await runBeforeAgentStart(agentDirWith({}));
	assert.equal(result, undefined);
	assert.deepEqual(sections, {});
});

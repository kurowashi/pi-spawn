/**
 * Integration: a child session can authenticate a llama.cpp model without an API key.
 *
 * llama.cpp is configured by a base URL in auth.json and no key. The provider that
 * reads it comes from the CLI's built-in llama.cpp extension, which an SDK session does
 * not load. Without that extension the child fails with "No API key found for llama.cpp".
 *
 * A local stub server stands in for llama.cpp. The test checks that the request reaches it,
 * so it never touches a real llama.cpp server on this machine.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createChildChannel } from "../../src/spawn.ts";
import type { AgentDefinition } from "../../src/types.ts";

const agent: AgentDefinition = {
	name: "llama-child",
	path: "llama-child.md",
	description: "llama.cpp child",
	body: "Answer briefly.",
	systemPromptMode: "append",
	inheritProjectContext: false,
	inheritSkills: false,
	inheritConversation: false,
	extensions: false,
};

test("a llama.cpp model runs in a child without an API key", async () => {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(`${request.method} ${request.url}`);
		response.writeHead(400, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: { message: "stub llama.cpp", type: "invalid_request_error" } }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	const serverUrl = `http://127.0.0.1:${port}`;

	try {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-spawn-llama-"));
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ "llama.cpp": { type: "api_key", env: { LLAMA_BASE_URL: serverUrl } } }),
		);
		const model = {
			provider: "llama.cpp",
			id: "fixture-model",
			name: "fixture-model",
			api: "openai-completions",
			baseUrl: `${serverUrl}/v1`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		};
		const channel = await createChildChannel({
			sessionId: "llama-auth-1",
			agent,
			cwd: process.cwd(),
			agentDir,
			model: model as never,
			customTools: [],
		});
		try {
			await channel.prompt("ping").catch(() => {});
			const message = channel.snapshot().outcome?.errorMessage ?? "";
			assert.doesNotMatch(message, /No API key found/);
			assert.ok(requests.length > 0, "the request reached the configured llama.cpp URL");
		} finally {
			await channel.dispose();
		}
	} finally {
		server.close();
	}
});

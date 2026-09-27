/**
 * pi-spawn — child agent sessions with in-process sibling messaging.
 *
 * This factory is the entire public surface: Pi loads this file (jiti) and
 * nothing else needs to be exported. Constraints live in AGENTS.md; the
 * model-facing token budget is enforced by test/contract/budget.test.ts.
 */

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { definitionRoots, discoverAgents, formatCatalog } from "./catalog.ts";
import { createRunRegistry } from "./registry.ts";
import { createSpawnAgentsTool } from "./tools/spawn-agents.ts";

export default function registerSpawnExtension(pi: ExtensionAPI): void {
	const registry = createRunRegistry();
	pi.registerTool(createSpawnAgentsTool({ registry }));

	// The catalog is the only discovery surface: no list tool, no skill file.
	pi.on("before_agent_start", (event, ctx) => {
		const roots = definitionRoots(ctx.cwd, getAgentDir(), ctx.isProjectTrusted());
		const catalog = formatCatalog(discoverAgents(roots).agents);
		if (catalog === undefined) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${catalog}` };
	});
}

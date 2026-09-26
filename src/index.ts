/**
 * pi-spawn — child agent sessions with in-process messaging.
 *
 * This factory is the entire public surface: Pi loads this file (jiti) and
 * nothing else needs to be exported. Constraints live in AGENTS.md; the
 * model-facing token budget is enforced by test/contract/budget.test.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMessageAgentTool } from "./tools/message-agent.ts";
import { createSpawnAgentTool } from "./tools/spawn-agent.ts";

export default function registerSpawnExtension(pi: ExtensionAPI): void {
	pi.registerTool(createSpawnAgentTool());
	pi.registerTool(createMessageAgentTool());
}

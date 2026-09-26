/**
 * The tools every child session receives.
 *
 * One place decides the child-facing surface, so the contract test and the real
 * session construction cannot drift apart. A child without a dialog UI cannot
 * ask the human, so the tool is absent rather than failing at call time.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ChildToolInput } from "../spawn.ts";
import { createAskUserTool } from "./ask-user.ts";
import { createMessageAgentTool } from "./message-agent.ts";

/** The child tools in a stable order: sibling messaging first, human questions second. */
export function childTools(input: ChildToolInput): ToolDefinition[] {
	const tools: ToolDefinition[] = [
		createMessageAgentTool({ runId: input.runId, self: input.self, registry: input.registry }),
	];
	if (input.askUser !== undefined) tools.push(createAskUserTool(input.askUser));
	return tools;
}

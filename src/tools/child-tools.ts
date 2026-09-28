/**
 * The tools every child session receives.
 *
 * One place decides the child-facing surface, so the contract test and the real
 * session construction cannot drift apart.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ChildToolInput } from "../spawn.ts";
import { createMessageAgentTool } from "./message-agent.ts";

/** The child tools in a stable order. */
export function childTools(input: ChildToolInput): ToolDefinition[] {
	return [createMessageAgentTool({ registry: input.registry, self: input.self })];
}

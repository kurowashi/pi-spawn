/**
 * spawn_agent — parent-only tool.
 *
 * Children never receive this tool, which fixes delegation depth at 1.
 * See docs/adr/0001-in-process-children-only.md.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const DESCRIPTION = "Spawn one child agent session and wait for its result.";

const Parameters = Type.Object(
	{
		agent: Type.String({ description: "Agent definition name" }),
		task: Type.String({ description: "Task for the child agent" }),
		model: Type.Optional(Type.String({ description: "Override model: provider/model-id" })),
		cwd: Type.Optional(Type.String({ description: "Working directory for the child" })),
		context: Type.Optional(
			StringEnum(["fresh", "fork"] as const, {
				description: "fresh: empty context (default); fork: copy this conversation",
			}),
		),
		timeout_ms: Type.Optional(Type.Number({ description: "Hard runtime limit in milliseconds" })),
	},
	{ additionalProperties: false },
);

export function createSpawnAgentTool() {
	return defineTool({
		name: "spawn_agent",
		label: "Spawn agent",
		description: DESCRIPTION,
		parameters: Parameters,
		async execute() {
			throw new Error("spawn_agent is not implemented yet (see docs/design.md)");
		},
	});
}

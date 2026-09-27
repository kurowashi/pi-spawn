/**
 * message_agent — child-only tool.
 *
 * One way to talk to a sibling: address a run by run id or by agent name. The
 * parent is not addressable because it is inside its own spawn_agents call and
 * cannot answer. The message arrives as a new turn in the recipient's session,
 * so the sender never blocks waiting for a reply.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { deliverMessage } from "../deliver.ts";
import { explainTarget, type RunRegistry } from "../registry.ts";

export const DESCRIPTION = "Message a sibling agent run. The reply arrives as a new turn.";

const Parameters = Type.Object(
	{
		to: Type.String({ description: "Sibling run id or agent name" }),
		text: Type.String({ description: "Message text" }),
	},
	{ additionalProperties: false },
);

export interface MessageToolOptions {
	registry: RunRegistry;
}

export function createMessageAgentTool(options: MessageToolOptions) {
	return defineTool({
		name: "message_agent",
		label: "Message agent",
		description: DESCRIPTION,
		parameters: Parameters,
		async execute(_toolCallId, params) {
			const resolution = options.registry.resolve(params.to);
			if (!resolution.ok) throw new Error(explainTarget(params.to, resolution, options.registry.list()));

			const outcome = await deliverMessage({ target: resolution.handle, text: params.text });
			if (!outcome.delivered) throw new Error(outcome.error);

			return {
				content: [{ type: "text" as const, text: "delivered" }],
				details: { to: resolution.handle.runId, agent: resolution.handle.agent },
			};
		},
	});
}

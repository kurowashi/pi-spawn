/**
 * message_agent — child-only tool.
 *
 * One way to talk to a sibling: address a run by its session id. The parent is
 * not addressable because it is inside its own spawn_agents call and cannot
 * answer. The message arrives as a new turn in the recipient's session, so the
 * sender never blocks waiting for a reply. The recipient sees the sender's
 * session id and name in the message header.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { deliverMessage } from "../deliver.ts";
import { explainTarget, type RunRegistry } from "../registry.ts";
import type { MessageSender } from "../types.ts";

const DESCRIPTION = "Message a sibling agent run by target_session_id. The reply arrives as a new turn.";

const Parameters = Type.Object(
	{
		target_session_id: Type.String({ description: "Session id of the sibling to message, from your briefing" }),
		text: Type.String({ description: "Message text" }),
	},
	{ additionalProperties: false },
);

export interface MessageToolOptions {
	registry: RunRegistry;
	/** This run, so the recipient can attribute the message. */
	self: MessageSender;
}

export function createMessageAgentTool(options: MessageToolOptions) {
	return defineTool({
		name: "message_agent",
		label: "Message agent",
		description: DESCRIPTION,
		parameters: Parameters,
		async execute(_toolCallId, params) {
			const resolution = options.registry.resolve(params.target_session_id);
			if (!resolution.ok) {
				throw new Error(explainTarget(params.target_session_id, resolution, options.registry.list()));
			}

			const outcome = await deliverMessage({ target: resolution.handle, from: options.self, text: params.text });
			if (!outcome.delivered) throw new Error(outcome.error);

			return {
				content: [{ type: "text" as const, text: "delivered" }],
				details: { target_session_id: resolution.handle.sessionId, agent: resolution.handle.agent },
			};
		},
	});
}

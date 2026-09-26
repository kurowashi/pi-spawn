/**
 * message_agent — available to the parent and to every child.
 *
 * One tool covers both directions: a child addresses its parent or a sibling,
 * the parent addresses a child it spawned. Delivery is a plain method call on
 * the target session because every session lives in this process.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const DESCRIPTION = 'Send a message to "parent", a run id, or an agent name. Set wait to get the reply.';

const Parameters = Type.Object(
	{
		to: Type.String({ description: 'Target: "parent", a run id, or an agent name' }),
		text: Type.String({ description: "Message text" }),
		wait: Type.Optional(Type.Boolean({ description: "Wait for the reply (default: true when to is parent)" })),
	},
	{ additionalProperties: false },
);

export function createMessageAgentTool() {
	return defineTool({
		name: "message_agent",
		label: "Message agent",
		description: DESCRIPTION,
		parameters: Parameters,
		async execute() {
			throw new Error("message_agent is not implemented yet (see docs/design.md)");
		},
	});
}

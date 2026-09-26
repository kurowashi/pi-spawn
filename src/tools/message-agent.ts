/**
 * message_agent — child-only tool.
 *
 * One tool covers every direction that exists in this design: a run addresses a
 * sibling by run id or by agent name. The parent is not addressable because it
 * is inside its own spawn_agents call and cannot answer.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { deliverMessage } from "../deliver.ts";
import type { RunRegistry } from "../registry.ts";
import type { SelfReference } from "../spawn.ts";

export const DESCRIPTION = "Message a sibling agent run. Set wait to receive its reply.";

const Parameters = Type.Object(
	{
		to: Type.String({ description: "Sibling run id or agent name" }),
		text: Type.String({ description: "Message text" }),
		wait: Type.Optional(Type.Boolean({ description: "Wait for the reply (default false)" })),
	},
	{ additionalProperties: false },
);

export interface MessageToolOptions {
	runId: string;
	self: SelfReference;
	registry: RunRegistry;
}

export function createMessageAgentTool(options: MessageToolOptions) {
	return defineTool({
		name: "message_agent",
		label: "Message agent",
		description: DESCRIPTION,
		parameters: Parameters,
		async execute(_toolCallId, params) {
			const waiter = options.self.current;
			if (waiter === undefined) throw new Error("this run is not registered with the parent session");

			const resolution = options.registry.resolve(params.to);
			if (!resolution.ok) throw new Error(explain(resolution, options.registry));

			const outcome = await deliverMessage({
				waiter,
				target: resolution.handle,
				text: params.text,
				wait: params.wait === true,
			});
			if (!outcome.delivered) throw new Error(outcome.error);

			return {
				content: [{ type: "text" as const, text: outcome.reply ?? "delivered" }],
				details: { to: resolution.handle.runId, agent: resolution.handle.agent, replied: outcome.reply !== undefined },
			};
		},
	});
}

function explain(
	resolution: { reason: "not_found" } | { reason: "ambiguous"; candidates: string[] },
	registry: RunRegistry,
): string {
	if (resolution.reason === "ambiguous") {
		return `'${resolution.candidates.join("', '")}' are all live: address one of those run ids instead of the agent name`;
	}
	const live = registry
		.list()
		.map((handle) => `${handle.agent} (${handle.runId})`)
		.join(", ");
	return `no live run matches that target. Live runs: ${live.length > 0 ? live : "(none)"}`;
}

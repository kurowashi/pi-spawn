/**
 * ask_user — child-only tool, present only when a dialog UI exists.
 *
 * The parent model is blocked inside spawn_agents, so the human is the only
 * participant who can answer. A cancelled dialog returns guidance instead of an
 * error, letting the run continue with a stated assumption.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AskUser } from "../types.ts";

export const DESCRIPTION = "Ask the user to decide something ambiguous.";

const Parameters = Type.Object(
	{ question: Type.String({ description: "The decision you need" }) },
	{ additionalProperties: false },
);

export function createAskUserTool(askUser: AskUser) {
	return defineTool({
		name: "ask_user",
		label: "Ask user",
		description: DESCRIPTION,
		parameters: Parameters,
		async execute(_toolCallId, params) {
			const answer = await askUser(params.question);
			return { content: [{ type: "text" as const, text: answer }], details: { question: params.question } };
		},
	});
}

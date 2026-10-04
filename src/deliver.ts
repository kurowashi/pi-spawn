/**
 * Message delivery between sibling runs.
 *
 * Delivery is one-way. `AgentChannel.deliver` starts a turn when the recipient
 * is idle and interrupts it at the next safe point when it is already running.
 * The turn a message starts is tracked on the recipient so the spawn call owns
 * its completion; the sender never waits for it.
 */

import type { MessageSender, RunHandle } from "./types.ts";

export type DeliverOutcome = { delivered: true } | { delivered: false; error: string };

export interface DeliverRequest {
	target: RunHandle;
	from: MessageSender;
	text: string;
}

/**
 * One message as the recipient sees it: a `from_session_id` header, then the text.
 * The header is the only way the recipient can attribute and answer a message.
 */
function formatMessage(from: MessageSender, text: string): string {
	return `message_agent from_session_id=${from.sessionId} name=${JSON.stringify(from.name)}\n\n${text}`;
}

/**
 * Deliver one message. Resolves once the message is handed to the recipient;
 * the turn it may start settles before the spawn call returns.
 */
export async function deliverMessage(request: DeliverRequest): Promise<DeliverOutcome> {
	try {
		startDelivery(request.target, formatMessage(request.from, request.text));
		return { delivered: true };
	} catch (error) {
		return { delivered: false, error: describe(error) };
	}
}

/**
 * Send the message and remember the turn it may start, so `spawnAgents` waits
 * for work this call caused even after the sender has moved on.
 */
function startDelivery(target: RunHandle, text: string): void {
	const delivery = target.channel.deliver(text);
	const tracked = delivery.then(
		() => {},
		(error: unknown) => {
			target.inducedErrors.push(describe(error));
		},
	);
	target.induced.add(tracked);
	void tracked.finally(() => target.induced.delete(tracked));
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

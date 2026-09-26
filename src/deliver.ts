/**
 * Message delivery between sibling runs.
 *
 * An idle recipient queues the message for its next turn boundary; a streaming
 * recipient is interrupted at its next safe point. This is the pair Pi's
 * session API offers, and it avoids the documented weakness of delivering only
 * at turn boundaries.
 *
 * Deadlock guard: a run may not wait on a sibling while a sibling is waiting on
 * it. The rule needs one bit per run and makes every wait cycle impossible.
 */

import type { DeliveryMode, RunHandle } from "./types.ts";

export type DeliverOutcome = { delivered: true; reply?: string } | { delivered: false; error: string };

export function deliveryMode(isStreaming: boolean): DeliveryMode {
	return isStreaming ? "steer" : "followUp";
}

/** Reason a wait must be refused, or undefined when it is safe. */
export function waitRefusal(waiter: RunHandle, target: RunHandle): string | undefined {
	if (waiter.runId === target.runId) return "a run cannot wait on itself";
	if (target.hasInboundWait) {
		return `run '${target.runId}' is already answering another run and cannot be waited on again`;
	}
	return undefined;
}

export interface DeliverRequest {
	waiter: RunHandle;
	target: RunHandle;
	text: string;
	wait: boolean;
}

/**
 * Deliver one message. `wait` returns the recipient's next assistant message as
 * the reply; without it delivery is fire-and-forget.
 */
export async function deliverMessage(request: DeliverRequest): Promise<DeliverOutcome> {
	const { waiter, target, text, wait } = request;

	if (wait) {
		const refusal = waitRefusal(waiter, target);
		if (refusal !== undefined) return { delivered: false, error: refusal };
		target.hasInboundWait = true;
	}

	try {
		// Subscribe before delivering so a fast reply cannot be missed.
		const replyPromise = wait ? target.channel.nextAssistantText() : undefined;
		const mode = deliveryMode(target.channel.isStreaming());
		if (mode === "steer") await target.channel.steer(text);
		else await target.channel.followUp(text);

		if (replyPromise === undefined) return { delivered: true };
		return { delivered: true, reply: await replyPromise };
	} catch (error) {
		return { delivered: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		if (wait) target.hasInboundWait = false;
	}
}

/**
 * Message delivery between sibling runs.
 *
 * One primitive covers both recipient states: `AgentChannel.deliver` starts a
 * turn when the child is idle and interrupts it at the next safe point when it
 * is already running. The sender waits only for the reply; the turn a message
 * starts is tracked on the recipient so the spawn call owns its completion.
 *
 * Deadlock guard: a run may not wait on a sibling while a sibling is waiting on
 * it. The rule needs one bit per run and makes every wait cycle impossible.
 */

import type { RunHandle } from "./types.ts";

export type DeliverOutcome = { delivered: true; reply?: string } | { delivered: false; error: string };

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
		const delivery = startDelivery(target, text);
		if (replyPromise === undefined) return { delivered: true };
		return { delivered: true, reply: await Promise.race([replyPromise, startedTurnFailure(delivery)]) };
	} catch (error) {
		return { delivered: false, error: describe(error) };
	} finally {
		if (wait) target.hasInboundWait = false;
	}
}

/**
 * Send the message and remember the turn it may start, so `spawnAgents` waits
 * for work this call caused even after the sender has moved on.
 */
function startDelivery(target: RunHandle, text: string): Promise<void> {
	const delivery = target.channel.deliver(text);
	const tracked = delivery.then(
		() => {},
		(error: unknown) => {
			target.inducedErrors.push(describe(error));
		},
	);
	target.induced.add(tracked);
	void tracked.finally(() => target.induced.delete(tracked));
	return delivery;
}

/** Rejects when the delivery fails; a delivery that succeeds never settles this arm. */
function startedTurnFailure(delivery: Promise<void>): Promise<never> {
	return delivery.then(
		() => new Promise<never>(() => undefined),
		(error: unknown) => {
			throw error;
		},
	);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

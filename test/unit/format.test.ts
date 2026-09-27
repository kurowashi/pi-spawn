/**
 * Unit: the shared display formatters.
 *
 * The same numbers appear in progress lines, result blocks, and the /spawn
 * viewer, so their compact shape is pinned once here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { contextText, formatCost, formatTokenCount } from "../../src/format.ts";

test("token counts stay compact", () => {
	assert.equal(formatTokenCount(0), "0");
	assert.equal(formatTokenCount(999), "999");
	assert.equal(formatTokenCount(1000), "1k");
	assert.equal(formatTokenCount(12_345), "12.3k");
	assert.equal(formatTokenCount(1_200_000), "1.2M");
});

test("cost keeps enough precision for cheap runs", () => {
	assert.equal(formatCost(0), "$0");
	assert.equal(formatCost(0.0025), "$0.0025");
	assert.equal(formatCost(0.25), "$0.25");
	assert.equal(formatCost(12.5), "$12.50");
});

test("context usage reads as used out of window with a percent", () => {
	assert.equal(contextText({ tokens: 12_345, contextWindow: 200_000, percent: 6.2 }), "ctx 12.3k/200k (6%)");
	assert.equal(contextText({ tokens: 500, contextWindow: 200_000, percent: null }), "ctx 500/200k");
	assert.equal(contextText({ tokens: null, contextWindow: 200_000, percent: null }), "ctx ?/200k");
});

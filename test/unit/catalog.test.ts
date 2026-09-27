/**
 * Unit: definition discovery and frontmatter parsing.
 *
 * The parser must ignore keys this extension does not implement, and never let
 * one bad file break discovery.
 * Definitions are written to a temporary directory so the repository carries no
 * fixtures that can drift from the tests.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { definitionRoots, discoverAgents, formatCatalog, parseAgent } from "../../src/catalog.ts";

function parse(content: string): ReturnType<typeof parseAgent> {
	return parseAgent(content, "test.md", () => {});
}

/** Build an agent directory whose entries exercise discovery edge cases. */
function makeAgentDir(files: Record<string, string>): string {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-spawn-catalog-"));
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	for (const [name, content] of Object.entries(files)) writeFileSync(join(agentDir, "agents", name), content);
	return agentDir;
}

test("parses a full definition", () => {
	const agent = parse(`---
name: reviewer
description: Reviews documents.
tools: read, grep
model: opencode-go/gpt-6-luna
thinking: medium
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
extensions: true
---

Body text.
`);
	assert.ok(agent);
	assert.equal(agent.name, "reviewer");
	assert.deepEqual(agent.tools, ["read", "grep"]);
	assert.equal(agent.model, "opencode-go/gpt-6-luna");
	assert.equal(agent.thinking, "medium");
	assert.equal(agent.systemPromptMode, "replace");
	assert.equal(agent.inheritProjectContext, false);
	assert.equal(agent.inheritSkills, false);
	assert.equal(agent.extensions, true);
	assert.equal(agent.body, "Body text.");
});

test("accepts a tools array as well as a comma separated list", () => {
	const agent = parse(`---
name: a
tools:
  - read
  - write
---
`);
	assert.deepEqual(agent?.tools, ["read", "write"]);
});

test("reports unsupported keys instead of failing", () => {
	const warnings: string[] = [];
	parseAgent(
		`---
name: a
async: true
fallbacks: other
---
`,
		"legacy.md",
		(message) => warnings.push(message),
	);
	assert.equal(warnings.length, 2);
	assert.ok(warnings.every((message) => message.includes("legacy.md")));
});

test("skips a file without a name", () => {
	assert.equal(parse("---\ndescription: no name\n---\n"), undefined);
});

test("defaults to append mode and inheriting context", () => {
	const agent = parse("---\nname: a\n---\n");
	assert.equal(agent?.systemPromptMode, "append");
	assert.equal(agent?.inheritProjectContext, true);
	assert.equal(agent?.inheritSkills, true);
	assert.equal(agent?.extensions, false);
	assert.equal(agent?.tools, undefined);
});

test("ignores an unknown thinking level and an unknown prompt mode", () => {
	const warnings: string[] = [];
	const agent = parseAgent(
		`---
name: a
thinking: loud
systemPromptMode: sideways
---
`,
		"odd.md",
		(message) => warnings.push(message),
	);
	assert.equal(agent?.thinking, undefined);
	assert.equal(agent?.systemPromptMode, "append");
	assert.equal(warnings.length, 2);
});

test("discovers definitions alphabetically and keeps duplicates", () => {
	const agentDir = makeAgentDir({
		"reviewer.md": "---\nname: reviewer\ndescription: Reviews a document.\n---\nBody.\n",
		"reviewer-copy.md": "---\nname: reviewer\ndescription: Again.\n---\n",
		"writer.md": "---\nname: writer\ndescription: Writes the draft.\ntools: read, write\n---\n",
		"missing-name.md": "---\ndescription: No name here.\n---\n",
	});
	const { agents, warnings } = discoverAgents([agentDir]);
	assert.deepEqual(
		agents.map((agent) => agent.name),
		["reviewer", "reviewer", "writer"],
	);
	assert.equal(warnings.length, 1, "only the missing name is reported");
});

test("a missing agents directory is not an error", () => {
	const agentDir = makeAgentDir({});
	const { agents, warnings } = discoverAgents([join(agentDir, "nope")]);
	assert.deepEqual(agents, []);
	assert.deepEqual(warnings, []);
});

test("an unreadable entry is reported and skipped", () => {
	const agentDir = makeAgentDir({ "good.md": "---\nname: good\n---\n" });
	mkdirSync(join(agentDir, "agents", "unreadable.md"));
	const { agents, warnings } = discoverAgents([agentDir]);
	assert.deepEqual(
		agents.map((agent) => agent.name),
		["good"],
	);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /cannot read/);
});

test("a tools value that is neither a list nor a string is reported", () => {
	const warnings: string[] = [];
	const agent = parseAgent(`---\nname: a\ntools: 5\n---\n`, "odd.md", (message) => warnings.push(message));
	assert.equal(agent?.tools, undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /tools/);
});

test("blank optional values are absent; a blank tool list allows no tools", () => {
	const agent = parse(`---\nname: a\ndescription: "  "\nmodel: ""\nthinking: ""\ntools: ""\n---\n`);
	assert.equal(agent?.description, "");
	assert.equal(agent?.model, undefined);
	assert.equal(agent?.thinking, undefined);
	assert.deepEqual(agent?.tools, []);
	assert.deepEqual(parse("---\nname: a\ntools: []\n---\n")?.tools, []);
});

test("formats a one-line catalog from the definitions as written", () => {
	assert.equal(formatCatalog([]), undefined);
	const line = formatCatalog([
		{
			name: "reviewer",
			description: "x".repeat(80),
			body: "",
			inheritProjectContext: true,
			inheritSkills: true,
			extensions: false,
			systemPromptMode: "append",
			path: "p",
		},
		{
			name: "writer",
			description: "",
			body: "",
			inheritProjectContext: true,
			inheritSkills: true,
			extensions: false,
			systemPromptMode: "append",
			path: "p",
		},
	]);
	assert.ok(line);
	assert.ok(line.includes(`reviewer — ${"x".repeat(80)}`));
	assert.ok(line.includes("writer"));
});

test("the catalog lists a duplicated name once, matching spawn resolution", () => {
	const agentDir = makeAgentDir({
		"a-general.md": "---\nname: reviewer\ndescription: Researches.\n---\n",
		"b-review.md": "---\nname: reviewer\ndescription: Reviews.\n---\n",
	});
	const { agents } = discoverAgents([agentDir]);
	assert.equal(formatCatalog(agents), "agents: reviewer — Researches.");
});

test("earlier roots win when the same name appears twice", () => {
	const project = makeAgentDir({ "reviewer.md": "---\nname: reviewer\ndescription: Project.\n---\n" });
	const user = makeAgentDir({ "reviewer.md": "---\nname: reviewer\ndescription: User.\n---\n" });
	const { agents } = discoverAgents([project, user]);
	assert.equal(agents[0]?.path, join(project, "agents", "reviewer.md"));
	assert.equal(formatCatalog(agents), "agents: reviewer — Project.");
});

test("the project root is searched first, and only while trusted", () => {
	assert.deepEqual(definitionRoots("/work", "/home/u/.pi/agent", true), [join("/work", ".pi"), "/home/u/.pi/agent"]);
	assert.deepEqual(definitionRoots("/work", "/home/u/.pi/agent", false), ["/home/u/.pi/agent"]);
});

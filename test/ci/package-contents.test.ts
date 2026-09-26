/**
 * Contract: the published tarball contains the extension and nothing else.
 *
 * Tests, fixtures, and docs must not reach users through `npm pack`. This is
 * cheaper and stricter than arguing with types/publishing linters, given the
 * package ships TypeScript source and runs no build step.
 *
 * `--ignore-scripts` keeps the `prepare` hook (lefthook) out of the output so
 * the JSON stays parseable and the check stays side-effect free.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { PACKAGE_ROOT } from "../helpers/extension.ts";

interface PackResult {
	files: Array<{ path: string }>;
}

test("npm pack ships src and package metadata only", () => {
	const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: PACKAGE_ROOT,
		encoding: "utf8",
	});
	const [result] = JSON.parse(output) as PackResult[];
	assert.ok(result, "npm pack --dry-run --json must report one package");

	const shipped = result.files.map((file) => file.path);
	const allowed = new Set(["package.json", "README.md"]);
	const unexpected = shipped.filter((path) => !allowed.has(path) && !path.startsWith("src/"));

	assert.deepEqual(unexpected, [], "only src and package metadata may be published");
	assert.ok(
		shipped.includes("src/index.ts"),
		"the extension entry declared in package.json must be present in the tarball",
	);
});

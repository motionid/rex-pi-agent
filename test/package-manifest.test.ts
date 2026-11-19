import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import manifest from "../package.json" with { type: "json" };

test("declares the rex-pi-agent Pi package", () => {
  assert.equal(manifest.name, "rex-pi-agent");
  assert.equal(manifest.version, "4.0.0");
  assert.equal(manifest.private, true);
  assert.equal(manifest.repository.url, "git+https://github.com/motionid/rex-pi-agent.git");
  assert.deepEqual(manifest.pi.extensions, ["./pi-extension/subagents/index.ts"]);
  assert.equal(manifest.keywords.includes("pi-package"), true);
  assert.equal(manifest.scripts.test, "node --test test/test.ts test/*.test.ts");
  assert.equal(manifest.scripts.typecheck, "tsc --noEmit");
});

test("documents installation, Rex and portable model setup", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

  for (const requiredText of [
    "# rex-pi-agent",
    "pi install git:github.com/motionid/rex-pi-agent",
    "REX_SESSION",
    "/subagent-setup",
    "~/.pi/rex-pi-agent/config.json",
    ".pi/rex-pi-agent/config.json",
    "amosblomqvist/pi-interactive-subagents",
  ]) {
    assert.match(readme, new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(readme, /cmux/i);
});

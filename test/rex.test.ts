import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as mux from "../pi-extension/subagents/rex.ts";
import { parseRexCreatedBlock } from "../pi-extension/subagents/rex.ts";

// A fake `rex` on PATH: logs every call; `split` returns block:1, block:2, … and
// fails from the call number in REX_TEST_FAIL_SPLIT_AT; `capture` prints 5 lines;
// `block inspect` fails for blocks listed in REX_TEST_GONE.
const FAKE_REX = `#!/bin/sh
printf '%s\\n' "$*" >> "$REX_TEST_LOG"
case "$1" in
  split)
    n=0; test -f "$REX_TEST_COUNT" && n=$(cat "$REX_TEST_COUNT"); n=$((n + 1)); printf '%s' "$n" > "$REX_TEST_COUNT"
    if [ -n "$REX_TEST_FAIL_SPLIT_AT" ] && [ "$n" -ge "$REX_TEST_FAIL_SPLIT_AT" ]; then echo "no room" >&2; exit 1; fi
    printf '{"anchor_id":"x","block_ids":["block:%s"]}\\n' "$n" ;;
  window) printf '%s\\n' '{"window_id":"window:9","block_ids":["block:tab"]}' ;;
  capture) printf 'one\\ntwo\\nthree\\nfour\\n__SUBAGENT_DONE_0__\\n\\n' ;;
  block)
    if [ "$2" = "inspect" ]; then
      for g in $REX_TEST_GONE; do [ "$g" = "$5" ] && exit 3; done
      echo '{}'
    fi ;;
esac
`;

const ENV_KEYS = ["PATH", "REX_SESSION", "REX_BLOCK", "REX_TEST_LOG", "REX_TEST_COUNT", "REX_TEST_FAIL_SPLIT_AT", "REX_TEST_GONE"];

describe("rex backend", () => {
  let dir: string;
  let saved: Record<string, string | undefined>;
  const calls = () => readFileSync(join(dir, "rex.log"), "utf8").split("\n").filter(Boolean);

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    dir = mkdtempSync(join(tmpdir(), "rex-test-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "rex"), FAKE_REX, { mode: 0o755 });
    writeFileSync(join(dir, "rex.log"), "");
    process.env.PATH = `${join(dir, "bin")}:${saved.PATH ?? ""}`;
    process.env.REX_SESSION = "session:s";
    process.env.REX_BLOCK = "block:parent";
    process.env.REX_TEST_LOG = join(dir, "rex.log");
    process.env.REX_TEST_COUNT = join(dir, "count");
    delete process.env.REX_TEST_FAIL_SPLIT_AT;
    delete process.env.REX_TEST_GONE;
    mux.resetCascadingSplitState();
  });

  afterEach(() => {
    mux.resetCascadingSplitState();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("is available only inside a Rex terminal", () => {
    assert.equal(mux.isRexAvailable(), true);
    delete process.env.REX_BLOCK;
    assert.equal(mux.isRexAvailable(), false);
    assert.match(mux.rexSetupHint(), /Rex/);
  });

  it("cascades splits right then below from the parent pane, without taking focus, and labels them", () => {
    assert.equal(mux.createSurface("scout"), "block:1");
    assert.equal(mux.createSurface("worker"), "block:2");
    assert.equal(mux.createSurface("third"), "block:3");
    const splits = calls().filter((c) => c.startsWith("split"));
    assert.deepEqual(splits, [
      "split -s session:s --split right --focus=false --json -b block:parent",
      "split -s session:s --split below --focus=false --json -b block:1",
      "split -s session:s --split right --focus=false --json -b block:2",
    ]);
    assert.ok(calls().includes("block rename -s session:s block:1 scout"));
  });

  it("starts again from the parent pane when the last subagent pane has gone", () => {
    mux.createSurface("a");
    process.env.REX_TEST_GONE = "block:1";
    mux.createSurface("b");
    assert.equal(calls().filter((c) => c.startsWith("split")).at(-1), "split -s session:s --split below --focus=false --json -b block:parent");
  });

  it("opens a tab when a split fails", () => {
    process.env.REX_TEST_FAIL_SPLIT_AT = "2";
    assert.equal(mux.createSurface("a"), "block:1");
    assert.equal(mux.createSurface("b"), "block:tab");
    assert.ok(calls().includes("window new -s session:s b --focus=false --json"));
  });

  it("sends text after -- with Return, reads the last lines, and closes", () => {
    mux.sendCommand("block:7", "-leading dash");
    assert.ok(calls().includes("send -s session:s -b block:7 -- -leading dash"));
    assert.ok(calls().includes("send-key -s session:s -b block:7 enter"));
    assert.equal(mux.readScreen("block:7", 2), "four\n__SUBAGENT_DONE_0__\n");
    assert.ok(calls().includes("capture -s session:s -b block:7 --trim --unwrap"), "joins soft-wrapped lines so a wrapped done marker is still found");
    mux.closeSurface("block:7");
    assert.ok(calls().includes("block close -s session:s block:7"));
  });

  it("does not try to close a pane that is already gone", () => {
    process.env.REX_TEST_GONE = "block:7";
    mux.closeSurface("block:7");
    assert.ok(!calls().some((c) => c.startsWith("block close")));
  });

  it("sees the done marker when polling a Rex pane", async () => {
    const r = await mux.pollForExit("block:7", new AbortController().signal, { interval: 10 });
    assert.deepEqual(r, { reason: "sentinel", exitCode: 0 });
  });

  it("parses created block IDs and rejects anything else", () => {
    assert.equal(parseRexCreatedBlock('{"block_ids":["block:abc"]}'), "block:abc");
    assert.throws(() => parseRexCreatedBlock("oops"), /Unexpected rex output/);
    assert.throws(() => parseRexCreatedBlock('{"block_ids":["surface:1"]}'), /Unexpected rex output/);
  });
});

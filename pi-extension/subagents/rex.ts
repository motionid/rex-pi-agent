/**
 * Rex terminal layer — the same operations as cmux.ts, through the `rex` CLI.
 *
 * Rex sets REX_SESSION and REX_BLOCK in every terminal it opens. A Rex pane is a
 * "block" with an ID such as `block:01a1…`; that ID is used as the surface ID, so
 * the dispatcher in cmux.ts can tell Rex surfaces from cmux ones (`surface:N`).
 * Subagent splits cascade from the parent pane, alternating right and below, like
 * cmux. If a split fails, the subagent opens in a new tab (Rex window) instead.
 */
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let rexOnPath: boolean | undefined;
function hasRex(): boolean {
  if (rexOnPath === undefined) {
    rexOnPath = spawnSync("sh", ["-c", "command -v rex"], { stdio: "ignore" }).status === 0;
  }
  return rexOnPath;
}

export function isRexAvailable(): boolean {
  return !!process.env.REX_SESSION && !!process.env.REX_BLOCK && hasRex();
}

export function isRexSurface(surface: string): boolean {
  return surface.startsWith("block:");
}

function session(): string {
  const s = process.env.REX_SESSION;
  if (!s) throw new Error("REX_SESSION is not set. Run pi in a Rex terminal.");
  return s;
}

function rex(args: string[]): string {
  return execFileSync("rex", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** The first block ID in `rex split/window new --json` output. */
export function parseRexCreatedBlock(output: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = null;
  }
  const ids = (parsed as { block_ids?: unknown } | null)?.block_ids;
  const block = Array.isArray(ids) ? ids[0] : undefined;
  if (typeof block !== "string" || !isRexSurface(block)) {
    throw new Error(`Unexpected rex output: ${output.trim() || "(empty)"}`);
  }
  return block;
}

type Direction = "left" | "right" | "up" | "down";
const REX_DIRECTION: Record<Direction, string> = { left: "left", right: "right", up: "above", down: "below" };

function label(block: string, name: string): void {
  try {
    rex(["block", "rename", "-s", session(), block, name]);
  } catch {
    // a missing label is cosmetic
  }
}

export function rexCreateSplit(name: string, direction: Direction, fromBlock?: string): string {
  const args = ["split", "-s", session(), "--split", REX_DIRECTION[direction], "--focus=false", "--json"];
  const anchor = fromBlock ?? process.env.REX_BLOCK;
  if (anchor) args.push("-b", anchor);
  const block = parseRexCreatedBlock(rex(args));
  label(block, name);
  return block;
}

function createTab(name: string): string {
  const block = parseRexCreatedBlock(rex(["window", "new", "-s", session(), name, "--focus=false", "--json"]));
  label(block, name);
  return block;
}

export function rexBlockExists(block: string): boolean {
  return spawnSync("rex", ["block", "inspect", "-s", session(), block, "--json"], { stdio: "ignore" }).status === 0;
}

let lastLiveBlock: string | null = null;
let splitDepth = 0;

export function resetRexCascade(): void {
  lastLiveBlock = null;
  splitDepth = 0;
}

/** A new pane for a subagent: split the last subagent pane (or our own), alternating right and below. */
export function rexCreateSurface(name: string): string {
  if (lastLiveBlock && !rexBlockExists(lastLiveBlock)) lastLiveBlock = null;
  const direction: Direction = splitDepth % 2 === 0 ? "right" : "down";
  try {
    const block = rexCreateSplit(name, direction, lastLiveBlock ?? undefined);
    lastLiveBlock = block;
    splitDepth += 1;
    return block;
  } catch {
    // no room, or the anchor vanished: a tab never fails for lack of space
    return createTab(name);
  }
}

/** Types text into the pane exactly as given (include "\n" to press Return). */
export function rexSend(block: string, text: string): void {
  rex(["send", "-s", session(), "-b", block, "--", text]);
}

function lastLines(screen: string, lines: number): string {
  const all = screen.replace(/\n+$/, "").split("\n");
  return all.slice(-Math.max(1, lines)).join("\n") + "\n";
}

export function rexReadScreen(block: string, lines = 50): string {
  return lastLines(rex(["capture", "-s", session(), "-b", block, "--trim"]), lines);
}

export async function rexReadScreenAsync(block: string, lines = 50): Promise<string> {
  const { stdout } = await execFileAsync("rex", ["capture", "-s", session(), "-b", block, "--trim"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return lastLines(stdout, lines);
}

export function rexCloseSurface(block: string): void {
  if (!rexBlockExists(block)) return;
  try {
    rex(["block", "close", "-s", session(), block]);
  } catch (error) {
    if (rexBlockExists(block)) throw error;
  }
}

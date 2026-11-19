/**
 * Rex terminal layer.
 *
 * Everything the extension does to a terminal goes through this file: open a
 * pane, type a command, read its screen, close it, and wait for the subagent in
 * it to finish. It drives Rex through the `rex` command.
 *
 * Rex sets REX_SESSION and REX_BLOCK in every terminal it opens. A Rex pane is a
 * "block" (`block:01a1…`); its ID is the "surface" the rest of the extension
 * passes around. Subagent panes cascade from the pi pane, alternating right and
 * below, without taking focus. If a split fails, the subagent opens in a new tab.
 */
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

export function rexSetupHint(): string {
  return "Open a terminal in Rex, then run `pi`.";
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
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

export function createSurfaceSplit(name: string, direction: Direction, fromBlock?: string): string {
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

export function resetCascadingSplitState(): void {
  lastLiveBlock = null;
  splitDepth = 0;
}

/** A new pane for a subagent: split the last subagent pane (or our own), alternating right and below. */
export function createSurface(name: string): string {
  if (lastLiveBlock && !rexBlockExists(lastLiveBlock)) lastLiveBlock = null;
  const direction: Direction = splitDepth % 2 === 0 ? "right" : "down";
  try {
    const block = createSurfaceSplit(name, direction, lastLiveBlock ?? undefined);
    lastLiveBlock = block;
    splitDepth += 1;
    return block;
  } catch {
    // no room, or the anchor vanished: a tab never fails for lack of space
    return createTab(name);
  }
}

/** Types a command into the pane and presses Return. */
export function sendCommand(block: string, command: string): void {
  rex(["send", "-s", session(), "-b", block, "--", command + "\n"]);
}

function lastLines(screen: string, lines: number): string {
  const all = screen.replace(/\n+$/, "").split("\n");
  return all.slice(-Math.max(1, lines)).join("\n") + "\n";
}

export function readScreen(block: string, lines = 50): string {
  return lastLines(rex(["capture", "-s", session(), "-b", block, "--trim", "--unwrap"]), lines);
}

export async function readScreenAsync(block: string, lines = 50): Promise<string> {
  const { stdout } = await execFileAsync("rex", ["capture", "-s", session(), "-b", block, "--trim", "--unwrap"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return lastLines(stdout, lines);
}

export function closeSurface(block: string): void {
  if (!rexBlockExists(block)) return;
  try {
    rex(["block", "close", "-s", session(), block]);
  } catch (error) {
    if (rexBlockExists(block)) throw error;
  }
}

export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) scriptParts.push(options.scriptPreamble.trimEnd());
  scriptParts.push(command);
  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", { mode: 0o755 });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

export interface PollResult {
  reason: "done" | "sentinel" | "error";
  exitCode: number;
  errorMessage?: string;
}

function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();
  let consecutiveMissingSurfaceChecks = 0;

  for (;;) {
    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");

    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) return { reason: "sentinel", exitCode: 0 };
      } catch {}
    }

    try {
      const screen = await readScreenAsync(surface, 5);
      consecutiveMissingSurfaceChecks = 0;
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
    } catch {
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }

      consecutiveMissingSurfaceChecks = rexBlockExists(surface)
        ? 0
        : consecutiveMissingSurfaceChecks + 1;
      if (consecutiveMissingSurfaceChecks >= 3) {
        return {
          reason: "error",
          exitCode: 1,
          errorMessage: `Rex pane ${surface} was closed or became unavailable before completion.`,
        };
      }
    }

    options.onTick?.(Math.floor((Date.now() - start) / 1000));
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

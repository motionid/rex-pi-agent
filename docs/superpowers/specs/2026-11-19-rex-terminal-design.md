# Rex terminal layer

**Date:** 2026-11-19 · **Version:** 4.0.0

## Intent

Run every subagent in its own visible Rex pane, opened beside the pi pane without
taking focus, with its result returned to the parent session automatically.
Rex is the only supported terminal.

## Where the code is

`pi-extension/subagents/rex.ts` is the whole terminal layer. The rest of the
extension calls only its functions and treats a pane ID as an opaque "surface".

| Function | Rex command |
| --- | --- |
| `isRexAvailable` | `REX_SESSION` and `REX_BLOCK` set, `rex` on `PATH` |
| `createSurface` | `rex split -s S -b ANCHOR --split right/below --focus=false --json`, then `rex block rename` |
| fallback when a split fails | `rex window new -s S NAME --focus=false --json` (a new tab) |
| `sendCommand` | `rex send -s S -b B -- "command\n"` |
| `readScreen` / `readScreenAsync` | `rex capture -s S -b B --trim --unwrap`, last N lines |
| `closeSurface` | `rex block close -s S B` (skipped if `rex block inspect` says it is gone) |
| `pollForExit` | exit sidecar file, sentinel file, or `__SUBAGENT_DONE_n__` on screen |

## Decisions

- **Panes cascade.** The first subagent splits right from the pi pane, the next
  below that one, alternating, so the layout tiles instead of only narrowing. If
  the last subagent pane has closed, the next split starts from the pi pane again.
- **Focus never moves.** Every pane and tab is created with `--focus=false`.
- **A split failure opens a tab.** Rex reports no "no space" error code, so any
  split failure falls back to a new tab rather than failing the spawn.
- **Screen reads are unwrapped.** In a narrow pane a long line soft-wraps; without
  `--unwrap` the done marker can be split across lines and never seen.
- **Text is sent after `--`.** Messages starting with `-` would otherwise be read
  as flags by `rex send`.
- **The shell gets time to start.** A new pane's shell drops input typed before
  its prompt is ready; the existing `PI_SUBAGENT_SHELL_READY_DELAY_MS` wait
  (default 500 ms) applies before the first command.
- **Configuration moves** from `.pi/cmuxagent/` to `.pi/rex-pi-agent/`
  (global and trusted project). Old files are not read.

## Testing

- Unit tests put a fake `rex` on `PATH` that logs its arguments
  (`test/rex.test.ts`, and the launch test in `test/test.ts`).
- `npm run test:integration` from a Rex terminal opens real panes
  (`test/integration/rex-surface.test.ts`, no model calls) and runs real pi
  sessions (`subagent-lifecycle.test.ts`, uses a model).

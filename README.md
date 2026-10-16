# OpenCode Token Rate Plugin

A small [OpenCode](https://opencode.ai) v2 CLI (TUI) plugin that puts a **sparkline**
at the bottom of the session sidebar, with current / average / max stats for the session.

The sparkline cycles through five views — generation speed plus per-minute token usage
broken down by category — and you switch between them by clicking the toggle or pressing
a key.

```
55.0 tok/s                     avg 37.0 max 60.0
▁▂▄▅▇█▃▅▆▇
‹ Throughput ›
```

```
120 tok/min                  avg 3.0 max 120
▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▅█
‹ Output Usage ›
```

- **Left:** the "current" value for the active view and its unit.
- **Right:** the average and max for the active view's window.
- **Middle:** a sparkline of recent activity, oldest → newest.
- **Bottom:** a clickable toggle showing the active view; click `‹` / `›` to cycle. Hover the
  sparkline to read out the point under the cursor here.

The current value and unit are left-aligned; `avg`/`max` are pushed to the right edge,
and the sparkline auto-fits the available width.

## Views

| View | Unit | What one point is | Stats window |
| --- | --- | --- | --- |
| **Throughput** | `tok/s` | one completed step | last 50 steps |
| **Output Usage** | `tok/min` | one wall-clock minute | last 60 minutes |
| **Reasoning Usage** | `tok/min` | one wall-clock minute | last 60 minutes |
| **Input Usage** | `tok/min` | one wall-clock minute | last 60 minutes |
| **Cache Usage** | `tok/min` | one wall-clock minute | last 60 minutes |

Views cycle in that order and wrap around. **Cache Usage** counts cache *read + write*
tokens. The view selection is shared across sessions, so every open sidebar shows the
same view.

## Switching views

- **Click** the toggle under the sparkline: `›` (or the view name) advances, `‹` goes back.
- **Keyboard:** the `ctrl+alt+t` command advances the view. It is registered as a
  `global` keymap command, so it works while the prompt is focused. Override the binding
  with the plugin's `keybind` option, or set it to `false` to disable the shortcut.

## Hovering the sparkline

Hovering the sparkline reads out the point under the cursor, on the **right of the bottom
row** beside the toggle:

```
55.0 tok/s             avg 37.0 max 60.0
▁▂▄▅▇█▃▅▆▇
‹ Throughput ›       45.0 tok/s · 1 ago
```

The readout gives the point's **value and unit**, then **how far back** it is:

- **Throughput:** `latest` for the newest step, then `N ago` (steps).
- **Usage:** `now` for the minute in progress, then `Nm ago` (minutes).

The value tracks the same column of the same chart the view is showing, so it follows the
active view and its window. Moving the cursor off the chart clears the readout. Hovering
relies on the terminal reporting mouse motion; where it doesn't, the toggle and keyboard
shortcut still work.

## How tokens/sec is calculated (Throughput)

OpenCode records one assistant message per model "step", and each message carries its
token usage and timing. For every step the plugin computes:

```
(output + reasoning) tokens / (time.streamed - time.created)
```

- **One point per step** — a step maps 1:1 to an assistant message.
- **`streamed`, not `completed`** — `completed` waits for tool settlement and can lag by
  minutes, so `streamed` (the moment the provider's response body ended) is the honest
  end of generation.
- **Output + reasoning tokens** are both counted as generated tokens.
- **Rolling window of 50** — average and max cover the last 50 steps; the sparkline shows
  as many of those as fit the sidebar width.
- **Practical filters** — steps that never streamed, or that produced zero tokens, are
  skipped so failures don't skew the stats; replayed events are de-duplicated.

## How per-minute usage is calculated

Each completed step is folded into the **wall-clock minute** it streamed in, and its
`input`, `output`, `reasoning`, and `cache` (read + write) tokens are added to that
minute's bucket. A usage view plots one category's per-minute totals:

- **Zero-filled, rolling 60-minute window** — minutes with no activity are plotted as
  `0`, so the sparkline keeps a true time axis across idle gaps and slides forward as
  time passes (even while idle).
- **`current`** is the minute in progress; **`avg`** is the mean tokens/minute over the
  whole window (idle minutes included); **`max`** is the busiest minute.
- **Usage is counted whenever tokens were consumed**, even for a step whose timing is
  missing (those steps are still skipped by the throughput view).
- **Per session, in memory** — each session has its own numbers, and they reset when the
  TUI exits. Subagent sessions are separate and do not mix in. Old minute buckets are
  pruned past the window so memory stays bounded.

Every sparkline is scaled to the min→max of the points it is showing, so it stays
readable even when values are close together. Large usage counts are shown with a
`k`/`M` suffix (e.g. `12.4k`).

## Theme colors

The plugin uses the **default OpenCode theme colors** and defines none of its own, so it
matches whatever theme you use (dark or light):

| Element | Theme token |
| --- | --- |
| Sparkline | `hue.accent[500]` |
| Current value | `text.base` |
| Active view label | `hue.accent[500]` |
| Hovered point readout | `text.base` |
| `tok/s`, `tok/min`, `avg`, `max`, toggle arrows | `text.muted` |
| Placeholder (`—`) before the first step | `text.faint` |

## Install

This is a **CLI-only** plugin, so it stays active even when the CLI is connected to a
remote server. Clone the repo and point `~/.config/opencode/cli.json` at it:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["/path/to/opencode-token-rate-plugin"]
}
```

OpenCode resolves `@opencode/plugin/tui` at runtime, so there is no build step.

## Development

```sh
npm install
npm run typecheck      # tsc --noEmit
npm run check          # event -> tok/s and per-minute usage data path, with a fake context
npm run check:render   # renders the footer with the real OpenTUI test renderer (toggle click + hover)
```

`tui.tsx` and `server.ts` live at the package root because the plugin loader resolves a
configured spec as `<spec>/tui` and `<spec>/server`.

## License

MIT

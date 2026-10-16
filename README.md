# OpenCode Token Rate Plugin

A small [OpenCode](https://opencode.ai) v2 CLI (TUI) plugin that puts a **tokens-per-second**
sparkline at the bottom of the session sidebar, with current / average / max generation
speed for the session.

```
55.0 tok/s                     avg 37.0 max 60.0
▁▂▄▅▇█▃▅▆▇
```

- **Left:** the speed of the most recent completed step (the "current" value) and its unit.
- **Right:** the average and max over the rolling window.
- **Below:** a sparkline of recent steps, oldest → newest.

The current value and `tok/s` are left-aligned; `avg`/`max` are pushed to the right edge,
and the sparkline auto-fits the available width.

## How tokens/sec is calculated

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
- **Per session, in memory** — each session has its own numbers, and they reset when the
  TUI exits. Subagent sessions are separate and do not mix in.

The sparkline is scaled to the min→max of the steps it is showing, so it stays readable
even when all your speeds are close together.

## Theme colors

The plugin uses the **default OpenCode theme colors** and defines none of its own, so it
matches whatever theme you use (dark or light):

| Element | Theme token |
| --- | --- |
| Sparkline | `hue.accent[500]` |
| Current value | `text.base` |
| `tok/s`, `avg`, `max` | `text.muted` |
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
npm run check          # event -> tok/s data path, with a fake context
npm run check:render   # renders the footer with the real OpenTUI test renderer
```

`tui.tsx` and `server.ts` live at the package root because the plugin loader resolves a
configured spec as `<spec>/tui` and `<spec>/server`.

## License

MIT

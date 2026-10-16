import { Plugin } from "@opencode/plugin"

/**
 * Server-side entrypoint.
 *
 * This plugin is TUI-only; it is enabled through `cli.json` and renders in the
 * terminal. This no-op server plugin exists so the package also has a valid
 * server entrypoint if it is ever loaded from `opencode.json` instead.
 */
export default Plugin.define({
  id: "opencode.tps-sparkline",
  setup() {},
})

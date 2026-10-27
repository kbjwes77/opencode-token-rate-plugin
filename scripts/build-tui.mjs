// Compile the TUI entry (tui.tsx) to plain JS for packaged-CLI installs.
//
// OpenCode's packaged CLI does not run OpenTUI's runtime Solid JSX transform on
// files under node_modules, so a raw tui.tsx entry fails to load from a plugin
// install with "Cannot find package 'react'" (opencode#39986). Compiling with
// babel-preset-solid (moduleName "@opentui/solid", generate "universal") emits
// explicit runtime imports that the host bridges to its own singletons, and no
// JSX, so no auto-generated jsx-runtime import exists.
import { transformFileAsync } from "@babel/core"
import { writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const input = process.argv[2] ?? join(root, "tui.tsx")
const output = process.argv[3] ?? join(root, "tui.js")

const result = await transformFileAsync(input, {
  plugins: [["@babel/plugin-syntax-jsx"]],
  presets: [
    ["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }],
    ["@babel/preset-typescript", { ignoreExtensions: true }],
  ],
  sourceType: "module",
  compact: false,
  comments: true,
})

if (!result) throw new Error("babel produced no result")
await writeFile(output, result.code)
console.log(`wrote ${output} (${result.code.length} bytes)`)

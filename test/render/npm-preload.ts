// Render tests as an npm install sees the plugin: OpenTUI skips Solid's JSX
// compiler for files under node_modules, so Bun compiles `tui.tsx` with the
// automatic runtime. Only Solid itself is swapped from its server build
// (which `bun test` resolves) to the client build the TUI uses.
import { plugin } from "bun"
import { readFile } from "node:fs/promises"

plugin({
  name: "solid-client-build",
  setup(build) {
    build.onLoad({ filter: /[/\\]node_modules[/\\]solid-js[/\\](store[/\\])?dist[/\\]server\.js$/ }, async (args) => {
      const client = args.path.replace(/server\.js$/, args.path.includes("store") ? "store.js" : "solid.js")
      return { contents: await readFile(client, "utf8"), loader: "js" }
    })
  },
})

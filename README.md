# opencode-spend

A TUI plugin for [opencode](https://opencode.ai) that displays the **total session spend** — the orchestrator session plus every nested subagent — in the sidebar.

```
Total Spend
$15.29 ($12.24)
```

The first figure is the combined total. The figure in parentheses is the portion spent by subagents. The total updates live as tokens are consumed, including while long-running subagents are still working.

## Why

opencode's built-in cost display only accounts for the session you're looking at. When a session spawns subagents, their spend is invisible. This plugin walks the entire subagent tree and surfaces the true cost of the work.

## Requirements

- opencode `>= 1.17.0`

## Install

This is a **TUI plugin**, so it is registered in your `tui.json`, not the regular `opencode.json` `plugin` array.

The TUI config lives at:

- `~/.config/opencode/tui.json` — global
- `.opencode/tui.json` — project-level

### From npm (recommended)

Add the package name to the `plugin` array in your `tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-spend"]
}
```

opencode installs the package (and its dependencies) with Bun at startup and caches it under `~/.cache/opencode/`. Restart opencode and the **Total Spend** section appears in the sidebar, between Context and MCP.

### From a local checkout

Clone the repository and reference it with a `file://` URL:

```sh
git clone https://gitlab.com/jwoodwardgl/opencode-spend.git
```

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["file:///absolute/path/to/opencode-spend"]
}
```

Then install its dependencies once:

```sh
cd opencode-spend
bun install
```

Restart opencode.

## Configuration

Optional. Create `~/.config/opencode/spend.json` to control where the total is shown:

```json
{
  "location": "both"
}
```

| `location` | Effect                                                          |
| ---------- | --------------------------------------------------------------- |
| `both`     | (default) Show in the sidebar **and** the prompt footer.        |
| `sidebar`  | Show only the **Total Spend** section in the sidebar.           |
| `prompt`   | Show only the compact total at the right of the prompt footer.  |

If the file is missing or invalid, it defaults to `both`.

## How it works

- The plugin registers into the `sidebar_content` slot.
- It listens for `message.updated` and `session.idle` events via the TUI event bus. These events are delivered for **descendant subagent sessions** as well as the focused session, which is what makes live subagent spend possible.
- On each relevant event it recursively walks `session.children` to sum the cost of the whole subagent tree (with cycle and depth guards).
- Refreshes are **coalesced**: at most one tree walk runs at a time, so a burst of streaming events cannot pile up work.

## Debugging / performance

The plugin ships with optional, low-overhead instrumentation that is disabled by default. Set the `SPEND_DEBUG` environment variable before launching opencode to enable it:

```sh
SPEND_DEBUG=1 opencode
```

It writes an aggregated, one-line-every-5-seconds summary to `/tmp/spend-debug.log`:

```
[metrics 5s] events=3 refreshes=3 coalesced=0 avgWalkMs=6.7 maxWalkMs=10.0 trackers=1
```

It also emits `[WARN]` lines if the refresh rate looks like a loop or a tree walk gets slow. When `SPEND_DEBUG` is unset there is no filesystem activity and no timer.

## License

[MIT](./LICENSE)

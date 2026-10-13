<p align="center">
  <img src="https://gitlab.com/jwoodwardgl/opencode-spend/-/raw/main/assets/header.svg" alt="opencode-spend" width="100%"/>
</p>

<p align="center">
  An <a href="https://opencode.ai">opencode</a> TUI plugin that replaces the sidebar Context section with a context bar and the <strong>true cost</strong> of your session — orchestrator and every nested subagent — broken down by agent, agent type, model and subagent.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/opencode-spend"><img src="https://img.shields.io/npm/v/opencode-spend?color=3fb950&label=npm&logo=npm&logoColor=white" alt="npm version"/></a>
  <img src="https://img.shields.io/badge/opencode-%3E%3D2.0.9-58a6ff?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0tMiAxNWwtNS01IDEuNDEtMS40MUwxMCAxNC4xN2w3LjU5LTcuNTlMMTkgOGwtOSA5eiIvPjwvc3ZnPg==&logoColor=white" alt="opencode version"/>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license"/>
</p>

---

## Installation

Requires OpenCode 2.0.9 or newer. Add `opencode-spend` to `plugins` in your CLI config, **`~/.config/opencode/cli.json`**. The plugin replaces the built-in **Context** sidebar section, so disable that one too:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["*", "-opencode.sidebar.context", "opencode-spend"]
}
```

Restart OpenCode and it installs the plugin automatically.

---

## What it shows

A **Context** section at the top of the sidebar, where the built-in one was (above MCP):

```
Context
████████████▌░░░░░░░░░░░ 52%
▶ 172k / 400k · $19.29
```

- **Bar:** context window usage of the viewed session. Green, yellow from 70%, red from 90%. A new session shows it at 0% as soon as its first message starts. After a model switch, the current context is measured against the new model's limit as soon as its first step starts, since that step sends the same conversation; switching to a smaller model can show over 100%. Hidden when the model's context limit is unknown; the summary then reads `172k tokens`.
- **Summary line:** context used / context limit, then the total spend of the whole session family (orchestrator plus every nested subagent). Under $1 it is shown in cents (`34c`, or `<1c` for less than half a cent), from $1 in dollars and cents (`$19.29`). A trailing `…` means subagent sessions are not loaded yet; `?` means loading gave up.

Click the header (title, bar or summary line) to expand it:

```
▼ 172k / 400k · $19.29
  ▼ $19.29 spent
    By agent
    $12.01  Orchestrator
     $7.28  ▼ Subagents (4)
     $3.18    general · Refactor auth
     $2.02    explore · Find call sites
     $1.23    explore · Read docs
     $0.85    explore · Check tests
    By agent type
     $9.38  build
     $4.10  explore ×3
     $3.18  general
     $2.63  plan
    By model
    $15.20  claude-opus
     $4.09  claude-haiku
  ▶ 592,819 tokens
```

- **Spent:** the exact total. Click it to show or hide the breakdown, which lists every configured view in one section:

| View | Shows |
|---|---|
| `agents` | Orchestrator vs subagents, with the number of subagents. With more than one, click `Subagents (n)` to list each subagent's spend. |
| `agentTypes` | Spend per agent across the whole family: the orchestrator's primary agents (`plan`, `build`, …) and subagents with a session count (`explore ×3`). `other` is spend not tied to a message, such as title generation and compaction. |
| `models` | Spend per model across the whole family, labelled by model ID (`provider/model` when two providers offer the same ID). `other` is the same unattributed spend as in `agentTypes`. |

- **Tokens:** every token of every step across the family. Click it to break it down by type (`reasoning` is listed after `output` when the model reports it):

```
  ▼ 15,975,013 tokens
        1,211  input
       93,122  output
      211,034  context
    8,856,883  cache read
    7,023,797  cache write
               cache hit 56%
```

  `context` is the viewed session's current context size, for comparison. The cache counts are much larger because they add up every step: each model call reads the whole cached conversation again, and the cache is written again after it expires (a few minutes idle) and for every new subagent.

Every section starts collapsed. Open sections are remembered per session, across restarts: expanding a section in one session or tab leaves the others alone.

### Live sections

When something needs attention, a live section appears at the bottom of the panel, below the spend and token sections. It shows even while the summary is collapsed. When several conditions hold at once, their sections stack in the order below.

```
Running (2)
explore      ██████░░ 61%  12c
general      ██░░░░░░ 18%   4c
```

- **Running subagents:** one context bar per running subagent. Rows disappear as subagents finish.
- **Low cache hit rate:** `⚠ Cache hit 31% (target 50%)` when cache reads fall below the threshold, once the family has used enough input tokens for the rate to be meaningful.

Click a live section (for running subagents, its `Running (n)` header) to dismiss it. It stays hidden until its condition clears and triggers again; dismissing one leaves the others in place.

### Performance

Subagent sessions carry their own agent, model, cost and tokens, so their message histories are never read for spend. The only read for a subagent is one page of its five newest messages, once, to start its context bar (after that, finished steps update it). The root session's assistant messages are read to split its spend between primary agents and models:

- The first visit reads them once, newest first. Messages include their full content, so a long session costs a few MB once (a 268-step, $178 session read 4 MB in three requests).
- After that, each finished or failed step reads a page of four messages, back to the last one counted.
- The newest message is re-read until a newer one starts, because its cost can still change: a step waiting on a long subagent has no cost until it ends, and a failed step can be retried under the same message.
- Totals are saved per session, so reopening a session after a restart only reads what changed since. If a revert removed counted messages, or the saved totals exceed what the server reports, the session is recounted once.
- Reads that gave up while offline are retried on reconnect.

---

## Configuration

Pass options with the object form in `cli.json`:

```json
{
  "plugins": [
    "*",
    "-opencode.sidebar.context",
    {
      "package": "opencode-spend",
      "options": {
        "views": ["agents", "agentTypes", "models"],
        "live": { "subagents": true, "cacheHitBelow": 0.5, "cacheMinInput": 100000 },
        "compactionMarker": 0.8,
        "barWidth": 24,
        "maxSavedSessions": 200
      }
    }
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `views` | all three | Breakdown views to show, in order. |
| `live.subagents` | `true` | Show running subagents with their own context bars. |
| `live.cacheHitBelow` | `0.5` | Warn when the cache hit rate drops below this ratio (strictly between 0 and 1). `false` turns it off. |
| `live.cacheMinInput` | `100000` | Input tokens the family must use before the cache warning can trigger. |
| `live` | | `false` turns off every live section. |
| `compactionMarker` | off | Draw a `│` threshold line on the bar at this ratio (strictly between 0 and 1), e.g. where auto-compaction kicks in. It is hidden once the fill passes it. |
| `barWidth` | `24` | Width of the context bar, in cells (whole number, 8 to 80). |
| `maxSavedSessions` | `200` | Sessions whose saved totals and open sections are kept; the least recently used are dropped first. |

### Upgrading from 0.2

1.0 removes the prompt footer total (OpenCode V2 shows the total there itself) and with it the `location` option and the V1 `~/.config/opencode/spend.json` file. Both are ignored if still present.

OpenCode V2 loads CLI plugins from `cli.json`, not the V1 `~/.config/opencode/tui.json`. Remove `opencode-spend` from the `plugin` list in `tui.json` and add it to `plugins` in `cli.json` as shown in [Installation](#installation).

---

## Updating

To get a specific release, pin the version in `cli.json`:

```json
{
  "plugins": ["*", "-opencode.sidebar.context", "opencode-spend@1.0.1"]
}
```

### Sidebar missing after upgrading from 0.x

OpenCode can keep using a copy of the plugin it cached earlier, even after a newer version is published. If the sidebar doesn't appear after upgrading, check which version is cached:

```sh
grep -h '"version"' ~/.cache/opencode/npm/opencode-spend@latest/*/node_modules/opencode-spend/package.json
```

If it shows a `0.x` version, delete the cached copy and restart OpenCode:

```sh
rm -rf ~/.cache/opencode/npm/opencode-spend@latest
```

Pinning a version as shown above also avoids this.

---

## Contributing

Issues and PRs welcome at [gitlab.com/jwoodwardgl/opencode-spend](https://gitlab.com/jwoodwardgl/opencode-spend).

### Install locally

```sh
git clone https://gitlab.com/jwoodwardgl/opencode-spend.git
cd opencode-spend
bun install
```

Reference the directory with a `file://` URL in `cli.json`:

```json
{
  "plugins": ["file:///absolute/path/to/opencode-spend"]
}
```

OpenCode loads a local plugin directory's terminal entry from `<dir>/tui.tsx`. It does not read `package.json` `exports` for local directories, so keep that file at the repository root.

---

<p align="center">MIT License · <a href="https://www.npmjs.com/package/opencode-spend">npmjs.com/package/opencode-spend</a> · <a href="https://gitlab.com/jwoodwardgl/opencode-spend">gitlab.com/jwoodwardgl/opencode-spend</a></p>

<p align="center">
  <img src="https://gitlab.com/jwoodwardgl/opencode-spend/-/raw/main/assets/header.svg" alt="opencode-spend" width="100%"/>
</p>

<p align="center">
  An <a href="https://opencode.ai">opencode</a> TUI plugin that tracks the <strong>true cost</strong> of your session — orchestrator and every nested subagent — live as tokens are consumed.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/opencode-spend"><img src="https://img.shields.io/npm/v/opencode-spend?color=3fb950&label=npm&logo=npm&logoColor=white" alt="npm version"/></a>
  <img src="https://img.shields.io/badge/opencode-%3E%3D2.0.9-58a6ff?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0tMiAxNWwtNS01IDEuNDEtMS40MUwxMCAxNC4xN2w3LjU5LTcuNTlMMTkgOGwtOSA5eiIvPjwvc3ZnPg==&logoColor=white" alt="opencode version"/>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license"/>
</p>

---

<p align="center">
  <img src="https://gitlab.com/jwoodwardgl/opencode-spend/-/raw/main/assets/screenshot.png" alt="opencode-spend screenshot" width="100%"/>
</p>

---

## Installation

Requires OpenCode 2.0.9 or newer. Add `opencode-spend` to `plugins` in your CLI config, **`~/.config/opencode/cli.json`**:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["opencode-spend"]
}
```

Restart OpenCode and it installs the plugin automatically. A **Total Spend** section appears in the sidebar, and a compact total appears in the prompt footer status. Both show the full total first, then the subagent share in brackets: `$1.23 ($0.45)`.

The total covers the root session and every nested subagent. Subagent sessions that already existed when you reopen a session are loaded once in the background, so their spend is included too.

---

## Updating

To get a specific release, pin the version in `cli.json`:

```json
{
  "plugins": ["opencode-spend@0.2.0"]
}
```

---

## Configuration

Choose where the total is displayed with the `location` plugin option:

```json
{
  "plugins": [
    { "package": "opencode-spend", "options": { "location": "both" } }
  ]
}
```

| Value | Display |
|---|---|
| `both` | Sidebar **+** prompt footer *(default)* |
| `sidebar` | Sidebar only |
| `prompt` | Prompt footer only |

The V1 `~/.config/opencode/spend.json` file (`{ "location": "..." }`) is still read when no option is set. Plugin options take precedence.

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

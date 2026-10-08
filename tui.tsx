// CLI plugin entrypoint.
//
// OpenCode V2 resolves a local plugin directory's TUI entry with
// `Bun.resolveSync("<dir>/tui")` - it does NOT consult package.json `exports`
// for directory plugins, and a missing entry is skipped silently. This file
// must therefore live at the package root. Published installs resolve the
// same file through the package.json `./tui` export.
export { default } from "./src/tui.tsx"

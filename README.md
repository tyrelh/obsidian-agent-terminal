# Agent Terminal (Local Plugin)

This plugin adds an Obsidian pane with an integrated terminal aimed at running agent CLIs such as:

- `codex --no-alt-screen`
- `claude`

## Features

- Dockable Obsidian view (`Agent Terminal`)
- `xterm.js` terminal rendering
- Preset profiles: Codex, Claude, Custom
- Quick commands:
  - `Open Agent Terminal`
  - `Agent Terminal: Run Codex profile`
  - `Agent Terminal: Run Claude profile`
- Configurable shell, working directory, and commands

## Development

```bash
cd .obsidian/plugins/agent-terminal
npm install
npm run build
```

This generates:

- `main.js`
- `styles.css`

## Notes

- The plugin is desktop-only.
- On macOS/Linux, commands are run through a local `python3` PTY bridge script for interactive CLI support.
- If your shell path differs, set it in plugin settings.

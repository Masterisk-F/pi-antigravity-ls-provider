# pi-antigravity-ls-provider

A direct, official-binary-driven **Google Antigravity Language Server** provider extension for [`pi-coding-agent`](https://github.com/earendil-works/pi).

Talk directly to Google's official Language Server (LS) binary via ConnectRPC (gRPC-Web over HTTP/2) — **without `agy` CLI wrappers, without ACP, and without direct token reuse**.

---

## Highlights

- 🛡️ **Zero Token Reuse (Low Ban Risk)**: The official Language Server binary (`/opt/Antigravity/resources/bin/language_server`) executes Google OAuth and backend communications itself. Your access tokens are never transmitted to unauthorized harnesses.
- 🚫 **Built-in Tools Excluded from Schema**: Uses Antigravity's `DeclarativeMixinConfig` to completely strip internal tools (`read_file`, `write_file`, `edit_file`, `run_command`) from the model's function-calling definitions. The model cannot even see them.
- 🔌 **Full Pi Tool Exposure via MCP Round-Trip**: All active Pi tools (built-ins like `read`, `write`, `edit`, `bash`, plus all installed extensions) are exposed as native tool definitions through an embedded Streamable HTTP MCP server. Tool execution runs inside Pi's standard loop, allowing permission gates and undo/redo snapshots to work natively.
- ⏪ **CoW Reflink Rewind Integration**: Because mutating tools execute in Pi, `pi-rewind-cp` captures per-file undo snapshots as usual. When navigating the session tree (`/tree` or `/rewind`), Cascade conversation history is automatically rolled back via `revertToCascadeStep`.
- 🧠 **Unified Thinking Tiers**: `gemini-3.8-flash` and `gemini-4-argon` are exposed as single models with thinking levels mapped via Pi's native `thinkingLevelMap` (`low`, `medium`, `high`), rather than cluttering the model list with tiered duplicates.
- ⚡ **Authentic Antigravity Environment**: Replicates the exact flags used by the official Electron app (`--standalone`, `--override_ide_name antigravity`, `--subclient_type hub`, etc.), unlocking full production models including **Gemini 3.8 Flash** and **Claude Sonnet/Opus 5.5**.

---

## Supported Models

Switch models via `/model` and adjust thinking effort via `/thinking <level>`:

| Model ID | Display Name | Context | Max Output | Thinking Effort |
|---|---|---|---|---|
| `antigravity-ls/gemini-3.8-flash` | Gemini 3.8 Flash | 1M | 64K | low / medium / high |
| `antigravity-ls/gemini-4-argon` | Gemini 4 Argon | 1M | 64K | low / medium / high |
| `antigravity-ls/claude-sonnet-5-5` | Claude Sonnet 5.5 | 200K | 64K | low / medium / high |
| `antigravity-ls/claude-opus-5-5` | Claude Opus 5.5 | 200K | 64K | low / medium / high |
| `antigravity-ls/gpt-oss-120b` | GPT-OSS 120B | 131K | 32K | off |

---

## Installation

### Prerequisites
- Linux with Antigravity installed (`/opt/Antigravity/resources/bin/language_server`).
- Node.js 22+.
- [pi-coding-agent](https://github.com/earendil-works/pi).

### Option 1: Direct from GitHub
Install directly using Pi's package manager:

```bash
pi install github:Masterisk-F/pi-antigravity-ls-provider
```

*(npm 12+ users: ensure `.npmrc` allows git dependencies if installing via npm)*

### Option 2: Local Checkout

```bash
git clone https://github.com/Masterisk-F/pi-antigravity-ls-provider.git ~/Projects/pi-antigravity-ls-provider
cd ~/Projects/pi-antigravity-ls-provider
npm install
npm run build
```

Then register the package in `~/.pi/agent/settings.json`:

```jsonc
{
  "packages": [
    "../../Projects/pi-antigravity-ls-provider"
  ],
  "enabledModels": [
    "antigravity-ls/gemini-3.8-flash",
    "antigravity-ls/gemini-4-argon",
    "antigravity-ls/claude-sonnet-5-5"
  ]
}
```

---

## Commands

### `/agls`
Inspect provider status, running LS process info, active MCP bridge port, and recorded rewind checkpoints:

```text
=== Antigravity LS Provider Doctor ===
LS Status:     Connected (Tier: Standard)
MCP Server:    http://127.0.0.1:41235/mcp (Port: 41235)
Loaded Models: 5 models
Active Cascade: casc-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
Rewind Points: 4 recorded steps
```

- `/agls` — Show diagnostic summary.
- `/agls clear` — Drop active Cascade binding for the current session (starts fresh on the next turn).
- `/agls clear-all` — Drop all session bindings across workspaces.

---

## Architecture & How It Works

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed sequence diagrams, round-trip state mechanics, and history synchronization algorithms.

---

## License

MIT

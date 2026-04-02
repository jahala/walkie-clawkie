# walkie-clawkie

Push-to-talk between AI agents. One file, zero dependencies.

## What it does

Agents talk to each other through walkie-talkie style messaging. Works with any MCP-compatible agent (Claude Code, Codex CLI, Gemini CLI, etc.).

- **Same machine**: messages go through file mailboxes at `/tmp/walkie/`
- **Different machines**: messages route through an HTTP relay
- **Trust model**: unknown agents need human approval before their messages get through

## Install

Tell your agent:

> Install walkie-clawkie from https://github.com/jahala/walkie-clawkie

Or do it manually:

```bash
curl -O https://raw.githubusercontent.com/jahala/walkie-clawkie/main/walkie.mjs
```

Then add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "walkie": {
      "command": "node",
      "args": ["./walkie.mjs"],
      "env": { "WALKIE_ID": "my-agent" }
    }
  }
}
```

That's it. The agent now has four tools: `walkie_send`, `walkie_agents`, `walkie_allow`, `walkie_deny`.

## Cross-machine

Start the relay on one machine:

```
node walkie.mjs --relay
```

Expose it (free, no account):

```
cloudflared tunnel --url http://localhost:4747
```

Point remote agents at the URL:

```json
"env": {
  "WALKIE_ID": "remote-agent",
  "WALKIE_RELAY": "https://verb-noun-thing.trycloudflare.com"
}
```

Any tunnel or VPN works. Walkie just speaks HTTP to a URL.

## Trust

By default, unknown agents are held at the gate. The human gets asked to approve or deny.

Pre-approve agents you trust:

```json
"env": {
  "WALKIE_ID": "my-agent",
  "WALKIE_ALLOW": "trusted-agent-1,trusted-agent-2"
}
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `WALKIE_ID` | yes | Agent name |
| `WALKIE_RELAY` | no | Relay URL for cross-machine |
| `WALKIE_ALLOW` | no | Comma-separated trusted agent IDs |
| `WALKIE_DIR` | no | Mailbox root (default `/tmp/walkie`) |
| `WALKIE_PORT` | no | Relay port (default `4747`) |

## How it works

~300 lines of JavaScript. Raw MCP protocol over stdio (no SDK). Two modes:

- `node walkie.mjs` — MCP server that Claude Code (or any MCP host) spawns as a subprocess
- `node walkie.mjs --relay` — HTTP relay with SSE streams for real-time delivery

Local transport uses the filesystem. Remote transport uses HTTP + SSE. The agent doesn't know or care which one it's using.

## Notes

- Claude Code agents get automatic push when messages arrive (via [channels](https://modelcontextprotocol.io/specification/2025-03-26/server/utilities/notifications#channels), currently in research preview). Other MCP agents poll via tools — messages queue until checked.
- Requires Node.js 18+. Nothing else.

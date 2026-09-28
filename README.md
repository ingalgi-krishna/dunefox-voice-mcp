# Dunefox Voice MCP server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for
**[Dunefox Voice](https://dunefox.io/voice)**, the AI voice calling platform from
**[Dunefox](https://dunefox.io)**. Dunefox Voice's AI agents call your leads, hold a real conversation
in their own language (50+ languages, including English/Hindi/Marathi with mid-sentence code-switching),
qualify them, book appointments, and hand the hot ones to your team, with recordings, transcripts and
summaries logged automatically.

This server lets any MCP client (**Claude**, **Claude Code**, **OpenAI Codex**, **VS Code**, or any
other MCP host) manage a Dunefox Voice workspace directly: create and edit AI calling agents, run
outbound calling campaigns, place calls, send one-way voice messages (order updates, payment
reminders, delivery notifications), read call and campaign analytics, and manage webhook endpoints.
One MCP connection, the whole AI voice agent platform.

It is a thin client. Every tool is one HTTPS call to Dunefox Voice's public v1 API with the same
`x-api-key` / `x-org-id` headers a `curl` request would use, gated by the same scopes. This server holds
no data of its own and can never do more than the API key it is given.

New to Dunefox Voice? **[Start a trial at dunefox.io/voice](https://dunefox.io/voice)**. This
repository is the developer-facing MCP connector for an existing workspace, not the product itself.

## Requirements

- [Node.js](https://nodejs.org) 18 or later.
- A Dunefox Voice account with API access. See [dunefox.io](https://dunefox.io).

## Setup

1. **Get an API key.** In your Dunefox Voice dashboard, go to **Settings → Developer** and create a
   key. Tick the scopes you want this MCP connection to have. `dial`, `agents` and `campaigns` are
   **off by default**: they spend money or change what a workspace's calls say and do, so a key
   doesn't get that power just by existing. The key is shown once; save it immediately. Note the
   workspace's **org id**, shown next to the key.

2. **Clone and install:**

   ```bash
   git clone https://github.com/ingalgi-krishna/dunefox-voice-mcp.git
   cd dunefox-voice-mcp
   npm install
   ```

3. **Connect it to your MCP client.** `DUNEFOX_API_BASE_URL` is optional in every example below and
   defaults to `https://voice.dunefox.io`; set it only if your workspace runs somewhere else (a
   self-hosted deploy, a staging environment).

   <details open><summary><b>Claude Desktop</b></summary>

   Edit your `claude_desktop_config.json` ([config file locations](https://modelcontextprotocol.io/quickstart/user)):

   ```json
   {
     "mcpServers": {
       "dunefox-voice": {
         "command": "npx",
         "args": ["tsx", "/absolute/path/to/dunefox-voice-mcp/src/index.ts"],
         "env": {
           "DUNEFOX_API_KEY": "sk_live_...",
           "DUNEFOX_ORG_ID": "your-org-id"
         }
       }
     }
   }
   ```

   Restart Claude Desktop.
   </details>

   <details><summary><b>Claude Code</b></summary>

   From any terminal, no config file to edit:

   ```bash
   claude mcp add dunefox-voice \
     --env DUNEFOX_API_KEY=sk_live_... \
     --env DUNEFOX_ORG_ID=your-org-id \
     -- npx tsx /absolute/path/to/dunefox-voice-mcp/src/index.ts
   ```
   </details>

   <details><summary><b>OpenAI Codex CLI</b></summary>

   Add a block to `~/.codex/config.toml` (`$CODEX_HOME/config.toml`):

   ```toml
   [mcp_servers.dunefox-voice]
   command = "npx"
   args = ["tsx", "/absolute/path/to/dunefox-voice-mcp/src/index.ts"]
   env = { DUNEFOX_API_KEY = "sk_live_...", DUNEFOX_ORG_ID = "your-org-id" }
   ```
   </details>

   <details><summary><b>VS Code</b> (GitHub Copilot Chat / agent mode)</summary>

   Create `.vscode/mcp.json` in your workspace (or run **MCP: Add Server** from the Command Palette):

   ```json
   {
     "servers": {
       "dunefox-voice": {
         "type": "stdio",
         "command": "npx",
         "args": ["tsx", "/absolute/path/to/dunefox-voice-mcp/src/index.ts"],
         "env": {
           "DUNEFOX_API_KEY": "sk_live_...",
           "DUNEFOX_ORG_ID": "your-org-id"
         }
       }
     }
   }
   ```

   To share one config across VS Code, Codex and other Copilot surfaces instead, use the portable
   `.mcp.json` format at your workspace root (top-level `mcpServers`, same shape as the Claude Desktop
   example above), see the [VS Code MCP docs](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
   for the full reference.
   </details>

   <details><summary><b>Any other MCP client</b></summary>

   Point it at a stdio server: `npx tsx /absolute/path/to/dunefox-voice-mcp/src/index.ts`, with
   `DUNEFOX_API_KEY` and `DUNEFOX_ORG_ID` set in its environment. That is the entire integration
   surface: no ports, no auth flow, no server to keep running.
   </details>

4. Restart your MCP client. It should list the tools below.

One server, one workspace: to manage two workspaces, add two entries with two different API keys.

## Tools

| Tool | What it does | Scope needed |
|---|---|---|
| `whoami` | Confirms the key works, returns the workspace's name. | any key |
| `list_agents` | Agent id/name/active, for picking one to call with. | `dial` |
| `get_agent` / `create_agent` / `update_agent` / `delete_agent` | An agent's full setup, including one-way scripts. | `agents` |
| `list_campaigns` / `get_campaign` / `create_campaign` / `update_campaign` / `delete_campaign` | Campaign CRUD. `update_campaign` with `status` starts, pauses, resumes or cancels one. | `campaigns` |
| `get_campaign_report` | Outcomes, sentiment, talk time, and the numbers/names a campaign collected. `csv:true` for a spreadsheet export. | `campaigns` |
| `place_call` | Starts a real conversational AI call right now. | `dial` |
| `list_calls` / `get_call` / `get_transcript` | Call records and transcripts. | `calls` / `transcripts` |
| `send_announcement` / `get_announcement` | A one-way (script-only) call, like an order update or a reminder, far cheaper than `place_call`. | `dial` |
| `list_leads` / `create_lead` / `get_lead_for_call` | Lead records. | `leads` |
| `list_webhooks` / `create_webhook` / `delete_webhook` / `get_webhook_samples` | Outbound webhook endpoints, so your own systems hear about calls and campaigns without polling. | `webhooks` |

Every tool returns the API's own JSON response as text, and reports `isError: true` when the API
refused the request. The error message and `code` field (`wallet_low`, `outside_hours`,
`not_one_way`, ...) are in the text, so a model reading the tool result can see exactly why.

## Notes for whoever is driving this

- `place_call` and `send_announcement` do real, billed things: a phone actually rings. `update_campaign`
  with `status:"running"` starts dialling a whole lead list. None of these ask for a second
  confirmation; that's the MCP client's job, same as any other tool with side effects.
- `delete_agent`, `delete_campaign` and `delete_webhook` are permanent.
- Nothing here bypasses the do-not-call list, calling hours, or the wallet balance check. Those are
  enforced by the Dunefox Voice API itself, not by this wrapper, so they hold regardless of which
  client is calling.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm start            # run the server directly against stdin/stdout, for manual testing
```

There's nothing to build: the server runs straight from TypeScript via [tsx](https://tsx.is).

## About Dunefox Voice

[Dunefox Voice](https://dunefox.io/voice) is the AI voice calling platform from
[Dunefox](https://dunefox.io), the AI suite for customer support, lead management and marketing.
Dunefox Voice's real-time AI phone agents answer, qualify, book appointments to your calendar, send
proposals mid-call over WhatsApp or email, and hand off to a human the moment they're unsure, grounded
in your own knowledge base, so they never make things up. Outbound calling campaigns dial a whole lead
list with retry and suppression rules built in; every call comes back with a recording, transcript, AI
summary and structured data pushed straight to your CRM.

- **Product:** [dunefox.io/voice](https://dunefox.io/voice)
- **Docs:** [dunefox.io](https://dunefox.io)
- **This connector:** built and maintained by [Sucetas Technologies](https://sucetastech.com), the
  company behind Dunefox.

## License

[MIT](LICENSE) © Sucetas Technologies Private Limited

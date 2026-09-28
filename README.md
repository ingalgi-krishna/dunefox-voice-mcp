# Dunefox Voice MCP server

An [MCP](https://modelcontextprotocol.io) server for [Dunefox Voice](https://dunefox.io) — AI voice
agents that call your leads, hold a real conversation in their own language, qualify them, book
appointments, and hand the hot ones to your team. This server lets any MCP client (Claude Desktop,
Claude Code, or any other MCP host) manage a Dunefox Voice workspace directly: create and edit agents,
run campaigns, place calls, send one-way messages, read call/campaign analytics, and manage webhook
endpoints — one MCP connection, the whole surface.

It is a thin client. Every tool is one HTTPS call to Dunefox Voice's public v1 API with the same
`x-api-key` / `x-org-id` headers a `curl` request would use, gated by the same scopes. This server holds
no data of its own and can never do more than the API key it is given.

## Requirements

- [Node.js](https://nodejs.org) 18 or later.
- A Dunefox Voice account with API access — see [dunefox.io](https://dunefox.io).

## Setup

1. **Get an API key.** In your Dunefox Voice dashboard, go to **Settings → Developer** and create a
   key. Tick the scopes you want this MCP connection to have. `dial`, `agents` and `campaigns` are
   **off by default** — they spend money or change what a workspace's calls say and do, so a key
   doesn't get that power just by existing. The key is shown once; save it immediately. Note the
   workspace's **org id**, shown next to the key.

2. **Clone and install:**

   ```bash
   git clone https://github.com/ingalgi-krishna/dunefox-voice-mcp.git
   cd dunefox-voice-mcp
   npm install
   ```

3. **Add it to your MCP client's config.** For Claude Desktop or Claude Code, that's a block like:

   ```json
   {
     "mcpServers": {
       "dunefox-voice": {
         "command": "npx",
         "args": ["tsx", "/absolute/path/to/dunefox-voice-mcp/src/index.ts"],
         "env": {
           "DUNEFOX_API_KEY": "sk_live_...",
           "DUNEFOX_ORG_ID": "your-org-id",
           "DUNEFOX_API_BASE_URL": "https://voice.dunefox.io"
         }
       }
     }
   }
   ```

   Or, with the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code), no config file needed:

   ```bash
   claude mcp add dunefox-voice \
     --env DUNEFOX_API_KEY=sk_live_... \
     --env DUNEFOX_ORG_ID=your-org-id \
     -- npx tsx /absolute/path/to/dunefox-voice-mcp/src/index.ts
   ```

   `DUNEFOX_API_BASE_URL` is optional and defaults to `https://voice.dunefox.io`; set it only if your
   workspace runs somewhere else (a self-hosted deploy, a staging environment).

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
| `send_announcement` / `get_announcement` | A one-way (script-only) call — an order update, a reminder — far cheaper than `place_call`. | `dial` |
| `list_leads` / `create_lead` / `get_lead_for_call` | Lead records. | `leads` |
| `list_webhooks` / `create_webhook` / `delete_webhook` / `get_webhook_samples` | Outbound webhook endpoints, so your own systems hear about calls and campaigns without polling. | `webhooks` |

Every tool returns the API's own JSON response as text, and reports `isError: true` when the API
refused the request — the error message and `code` field (`wallet_low`, `outside_hours`,
`not_one_way`, ...) are in the text, so a model reading the tool result can see exactly why.

## Notes for whoever is driving this

- `place_call` and `send_announcement` do real, billed things — a phone actually rings. `update_campaign`
  with `status:"running"` starts dialling a whole lead list. None of these ask for a second
  confirmation; that's the MCP client's job, same as any other tool with side effects.
- `delete_agent`, `delete_campaign` and `delete_webhook` are permanent.
- Nothing here bypasses the do-not-call list, calling hours, or the wallet balance check — those are
  enforced by the Dunefox Voice API itself, not by this wrapper, so they hold regardless of which
  client is calling.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm start            # run the server directly against stdin/stdout, for manual testing
```

There's nothing to build — the server runs straight from TypeScript via [tsx](https://tsx.is).

## License

[MIT](LICENSE) © Sucetas Technologies Private Limited

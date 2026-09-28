#!/usr/bin/env node
/**
 * Dunefox Voice MCP server.
 *
 * A thin wrapper over the public v1 API (app/api/v1/*): every tool here is one HTTP call, with the
 * same x-api-key / x-org-id headers and the same scopes a curl request would need — see
 * app/dashboard/settings/developer/docs. Nothing here talks to the database directly, so it can run
 * anywhere with network access to the API, and it can never do more than the API key it was given
 * already allows.
 *
 * Why stdio, and why one process per workspace: an MCP client (Claude Desktop, Claude Code, any other
 * MCP host) spawns this as a child process and owns its lifetime, so there is no server to deploy or
 * keep warm. The API key and org id come in as environment variables set by that client's own MCP
 * config, one workspace per configured server — the same shape as any other MCP server that wraps a
 * SaaS API.
 *
 * stdout is reserved for the MCP protocol itself (JSON-RPC over stdio); every log line in this file
 * goes to stderr, on purpose. A stray console.log here would corrupt the stream the client is reading
 * and break every tool call, not just log something extra.
 *
 * Setup: see mcp-server/README.md.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_KEY = process.env.DUNEFOX_API_KEY;
const ORG_ID = process.env.DUNEFOX_ORG_ID;
// Matches the app's own fallback for a workspace's public origin (see lib/appOrigin.ts and the
// online-stores dashboard page) — the same default a curl example in the docs would use.
const BASE_URL = (process.env.DUNEFOX_API_BASE_URL || "https://voice.dunefox.io").replace(/\/+$/, "");

if (!API_KEY || !ORG_ID) {
  console.error(
    "[dunefox-voice-mcp] Missing DUNEFOX_API_KEY and/or DUNEFOX_ORG_ID. Both come from " +
    "Dashboard → Settings → Developer, where the key is shown once at creation and the org id " +
    "sits next to it. Set them in this MCP server's env block and restart the client.",
  );
  process.exit(1);
}

type ApiResult = { ok: boolean; status: number; body: unknown };

/**
 * One call to the v1 API. Never throws: a network failure or a non-JSON response becomes a normal
 * `{ok:false}` result like any other API refusal, so a tool handler has exactly one failure shape to
 * turn into text instead of two (a caught exception AND a JSON error body).
 */
async function apiCall(method: string, path: string, opts: { query?: Record<string, string | undefined>; body?: unknown } = {}): Promise<ApiResult> {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "x-api-key": API_KEY as string,
        "x-org-id": ORG_ID as string,
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* the CSV report route returns plain text, by design */ }
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { error: `Could not reach ${BASE_URL}: ${(e as Error)?.message ?? e}` } };
  }
}

/** The result every tool returns: the API's own JSON, pretty-printed, whether it succeeded or not. */
function toResult(r: ApiResult) {
  const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body, null, 2);
  return { content: [{ type: "text" as const, text }], isError: !r.ok };
}

const server = new McpServer({ name: "dunefox-voice", version: "1.0.0" });

// ── whoami ───────────────────────────────────────────────────────────────────────────────────────
server.registerTool(
  "whoami",
  {
    title: "Which workspace is this key for?",
    description: "Confirms the API key and org id are valid, and returns the workspace's name. Call this first if a tool starts failing with 401s.",
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => toResult(await apiCall("GET", "/api/v1/me")),
);

// ── Agents ───────────────────────────────────────────────────────────────────────────────────────
server.registerTool(
  "list_agents",
  {
    title: "List agents (names only)",
    description: "This workspace's AI agents: id, name, active. Enough to choose one for place_call or send_announcement. For an agent's full setup (prompt, voice, one-way script), use get_agent — it needs the separate \"agents\" scope.",
    annotations: { readOnlyHint: true },
  },
  async () => toResult(await apiCall("GET", "/api/v1/agents")),
);

server.registerTool(
  "get_agent",
  {
    title: "Read one agent in full",
    description: "An agent's full configuration: prompt, voice/model params, knowledge base, handoff rules, integrations, and its one-way script if it has one. Needs the \"agents\" scope.",
    inputSchema: { agentId: z.string().describe("The agent's id, from list_agents.") },
    annotations: { readOnlyHint: true },
  },
  async ({ agentId }) => toResult(await apiCall("GET", `/api/v1/agents/${encodeURIComponent(agentId)}`)),
);

server.registerTool(
  "create_agent",
  {
    title: "Create an agent",
    description:
      "Create a conversational (two-way) or one-way (script-only, no listening) agent. Same rules as the " +
      "dashboard builder, including the plan's agent limit and provider/language restrictions. For a " +
      "one-way agent, set communication:\"one_way\" and pass announcement:{script, useCase}. Needs the " +
      "\"agents\" scope.",
    inputSchema: {
      name: z.string().describe("Shown in the dashboard and in call records."),
      prompt: z.object({
        persona: z.string().optional(),
        company: z.string().optional(),
        goal: z.string().optional(),
        tone: z.string().optional(),
        customInstructions: z.string().optional(),
      }).optional().describe("Two-way agents only. Left out entirely for a one-way agent."),
      communication: z.enum(["one_way", "two_way"]).optional().describe("Defaults to two_way when omitted."),
      announcement: z.object({
        script: z.string().describe("The fixed message, with {field.name} placeholders for per-call values (e.g. {lead.name}, {order.amount})."),
        useCase: z.enum(["announcement", "reminder", "delivery_update", "cod_confirmation", "payment_reminder", "keypad_survey"]).optional(),
        allowKeypad: z.boolean().optional().describe("Whether a single keypress (opt-out, or COD confirm/cancel) is collected."),
      }).optional().describe("Required when communication is one_way."),
      params: z.record(z.string(), z.unknown()).optional().describe("Voice/model settings (ttsProvider, ttsVoice, llmProvider, sttLanguage, ...). Omit to use the builder's defaults."),
    },
    annotations: { idempotentHint: false },
  },
  async (args) => toResult(await apiCall("POST", "/api/v1/agents", { body: args })),
);

server.registerTool(
  "update_agent",
  {
    title: "Update an agent",
    description: "Change any of an agent's fields. Send only what changes - fields left out are untouched. Needs the \"agents\" scope.",
    inputSchema: {
      agentId: z.string(),
      name: z.string().optional(),
      active: z.boolean().optional(),
      prompt: z.record(z.string(), z.unknown()).optional(),
      communication: z.enum(["one_way", "two_way"]).optional(),
      announcement: z.object({
        script: z.string(),
        useCase: z.enum(["announcement", "reminder", "delivery_update", "cod_confirmation", "payment_reminder", "keypad_survey"]).optional(),
        allowKeypad: z.boolean().optional(),
      }).optional(),
      params: z.record(z.string(), z.unknown()).optional(),
    },
    annotations: { idempotentHint: true },
  },
  async ({ agentId, ...rest }) => toResult(await apiCall("PATCH", `/api/v1/agents/${encodeURIComponent(agentId)}`, { body: rest })),
);

server.registerTool(
  "delete_agent",
  {
    title: "Delete an agent",
    description: "Permanent. Does not touch calls it already placed - only the agent record. Needs the \"agents\" scope.",
    inputSchema: { agentId: z.string() },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  async ({ agentId }) => toResult(await apiCall("DELETE", `/api/v1/agents/${encodeURIComponent(agentId)}`)),
);

// ── Campaigns ────────────────────────────────────────────────────────────────────────────────────
server.registerTool(
  "list_campaigns",
  { title: "List campaigns", description: "This workspace's outbound campaigns. Needs the \"campaigns\" scope.", annotations: { readOnlyHint: true } },
  async () => toResult(await apiCall("GET", "/api/v1/campaigns")),
);

server.registerTool(
  "get_campaign",
  {
    title: "Read one campaign",
    description: "A campaign's full settings and live counters (callsPlaced, callsCompleted, callsConnected). For outcomes/sentiment/the numbers it collected, use get_campaign_report instead.",
    inputSchema: { campaignId: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ campaignId }) => toResult(await apiCall("GET", `/api/v1/campaigns/${encodeURIComponent(campaignId)}`)),
);

server.registerTool(
  "create_campaign",
  {
    title: "Create a campaign (as a draft)",
    description:
      "Create an outbound campaign against a lead group or a filter. Starts as \"draft\" - call update_campaign " +
      "with status:\"running\" to actually dial. Same trial block, concurrency cap and calling-hours " +
      "narrowing as the dashboard. Needs the \"campaigns\" scope, and the workspace's campaigns entitlement.",
    inputSchema: {
      name: z.string(),
      agentId: z.string().describe("The agent that places these calls."),
      leadGroupId: z.string().optional().describe("Required unless targetType is \"filter\"."),
      targetType: z.enum(["group", "filter"]).optional(),
      targetFilter: z.object({ tags: z.array(z.string()).optional(), status: z.array(z.string()).optional(), priority: z.array(z.string()).optional() }).optional(),
      concurrency: z.number().optional().describe("Clamped to the plan's max concurrent calls."),
      retryEnabled: z.boolean().optional(),
      maxRetryAttempts: z.number().optional(),
      budgetCapCents: z.number().optional(),
      callingWindowStart: z.string().optional().describe("HH:mm, narrowed into the legal hours for the workspace's market."),
      callingWindowEnd: z.string().optional(),
      scheduledAt: z.string().optional().describe("ISO datetime. Leave out to start it manually instead."),
    },
    annotations: { idempotentHint: false, openWorldHint: true },
  },
  async (args) => toResult(await apiCall("POST", "/api/v1/campaigns", { body: args })),
);

server.registerTool(
  "update_campaign",
  {
    title: "Update, start, pause, resume or cancel a campaign",
    description:
      "Change settings, or change status. status:\"running\" starts dialling (kicks the dialer right " +
      "away - real calls start going out), \"paused\" holds it, \"cancelled\" stops it for good. " +
      "Fires the campaign.status_changed webhook, if the workspace has one subscribed.",
    inputSchema: {
      campaignId: z.string(),
      status: z.enum(["running", "paused", "cancelled", "completed", "scheduled", "draft"]).optional(),
      name: z.string().optional(),
      concurrency: z.number().optional(),
      budgetCapCents: z.number().optional(),
    },
    annotations: { idempotentHint: false, openWorldHint: true },
  },
  async ({ campaignId, ...rest }) => toResult(await apiCall("PATCH", `/api/v1/campaigns/${encodeURIComponent(campaignId)}`, { body: rest })),
);

server.registerTool(
  "delete_campaign",
  {
    title: "Delete a campaign",
    description: "Permanent. Does not touch calls it already placed. Needs the \"campaigns\" scope.",
    inputSchema: { campaignId: z.string() },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  async ({ campaignId }) => toResult(await apiCall("DELETE", `/api/v1/campaigns/${encodeURIComponent(campaignId)}`)),
);

server.registerTool(
  "get_campaign_report",
  {
    title: "Campaign analytics: outcomes, sentiment, and what it collected",
    description:
      "Did it work, and what did it collect: per-lead outcome, sentiment, talk time, intent score, and the " +
      "phone numbers/names the agent was told. Set csv:true for a spreadsheet-ready export instead of JSON.",
    inputSchema: { campaignId: z.string(), csv: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ campaignId, csv }) => toResult(await apiCall("GET", `/api/v1/campaigns/${encodeURIComponent(campaignId)}/report`, { query: { format: csv ? "csv" : undefined } })),
);

// ── Calls ────────────────────────────────────────────────────────────────────────────────────────
server.registerTool(
  "place_call",
  {
    title: "Place an AI agent call right now",
    description:
      "Starts a real conversational call from this workspace's own number. Behind the same gates as the " +
      "dashboard: the do-not-call list, calling hours, wallet balance and concurrency. A refusal carries a " +
      "code (suppressed, outside_hours, wallet_low, ...) to branch on. Needs the \"dial\" scope, which no " +
      "key holds by default. For a fixed script with no listening (an order update, a reminder), use " +
      "send_announcement instead - it is far cheaper.",
    inputSchema: {
      agentId: z.string(),
      to: z.string().describe("E.164, e.g. +919876543210."),
      leadId: z.string().optional(),
    },
    annotations: { idempotentHint: false, openWorldHint: true },
  },
  async (args) => toResult(await apiCall("POST", "/api/v1/calls", { body: args })),
);

server.registerTool(
  "list_calls",
  {
    title: "List calls",
    description: "This workspace's calls, newest first, with outcome/sentiment/summary once analysed. Needs the \"calls\" scope.",
    inputSchema: { limit: z.number().max(200).optional(), offset: z.number().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ limit, offset }) => toResult(await apiCall("GET", "/api/v1/calls", { query: { limit: limit?.toString(), offset: offset?.toString() } })),
);

server.registerTool(
  "get_call",
  {
    title: "Read one call",
    description: "A call's full record - outcome, sentiment, summary, extracted details - with its transcript and lead merged in.",
    inputSchema: { callUuid: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ callUuid }) => toResult(await apiCall("GET", `/api/v1/calls/${encodeURIComponent(callUuid)}`)),
);

server.registerTool(
  "get_transcript",
  {
    title: "Read a call's transcript",
    description: "The turn-by-turn transcript of one call.",
    inputSchema: { callUuid: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ callUuid }) => toResult(await apiCall("GET", `/api/v1/transcripts/${encodeURIComponent(callUuid)}`)),
);

// ── Announcements (one-way: script only, no listening) ─────────────────────────────────────────
server.registerTool(
  "send_announcement",
  {
    title: "Send a one-way message call",
    description:
      "Plays a one-way agent's fixed script to one number - a delivery update, a payment reminder, a COD " +
      "confirmation. Text-to-speech only, no conversation, billed at the one-way rate (far cheaper than " +
      "place_call). Values are formatted for speech before the call (amounts in words, dates as dates); a " +
      "script field with no value is refused by name rather than skipped mid-sentence. externalId makes " +
      "retries safe: the same reference answers with the first send instead of ringing again.",
    inputSchema: {
      agentId: z.string().describe("Must be a one-way agent (communication: \"one_way\")."),
      to: z.string().describe("E.164, e.g. +919876543210."),
      name: z.string().optional(),
      variables: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('Fills the script\'s {field.name} placeholders, e.g. {"order.id": "OD1042", "order.amount": 1299}.'),
      externalId: z.string().optional().describe("Your own reference for this send, for safe retries."),
    },
    annotations: { idempotentHint: false, openWorldHint: true },
  },
  async (args) => toResult(await apiCall("POST", "/api/v1/announcements", { body: args })),
);

server.registerTool(
  "get_announcement",
  {
    title: "Check a one-way call's delivery status",
    description: "queued, ringing, delivered, no-answer, busy, or a refusal code - never the phone number or the message text.",
    inputSchema: { deliveryId: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ deliveryId }) => toResult(await apiCall("GET", `/api/v1/announcements/${encodeURIComponent(deliveryId)}`)),
);

// ── Leads ────────────────────────────────────────────────────────────────────────────────────────
server.registerTool(
  "list_leads",
  {
    title: "List leads",
    description: "This workspace's leads, newest first. Needs the \"leads\" scope.",
    inputSchema: { limit: z.number().max(200).optional(), offset: z.number().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ limit, offset }) => toResult(await apiCall("GET", "/api/v1/leads", { query: { limit: limit?.toString(), offset: offset?.toString() } })),
);

server.registerTool(
  "create_lead",
  {
    title: "Create a lead",
    description: "Creates a lead, or returns the existing one with that phone number (201 created, 200 found - check the tool's isError/status if that distinction matters to you).",
    inputSchema: {
      name: z.string().optional(),
      phone: z.string(),
      email: z.string().optional(),
      source: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    annotations: { idempotentHint: true },
  },
  async (args) => toResult(await apiCall("POST", "/api/v1/leads", { body: args })),
);

server.registerTool(
  "get_lead_for_call",
  {
    title: "Find the lead a call belongs to",
    description: "The lead record linked to a given call.",
    inputSchema: { callUuid: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ callUuid }) => toResult(await apiCall("GET", `/api/v1/leads/${encodeURIComponent(callUuid)}`)),
);

// ── Webhooks ─────────────────────────────────────────────────────────────────────────────────────
server.registerTool(
  "list_webhooks",
  { title: "List webhook endpoints", description: "This workspace's outbound webhook endpoints. Needs the \"webhooks\" scope.", annotations: { readOnlyHint: true } },
  async () => toResult(await apiCall("GET", "/api/v1/webhooks")),
);

server.registerTool(
  "create_webhook",
  {
    title: "Add a webhook endpoint",
    description:
      "Subscribes a URL to one or more events (call.started, call.ended, call.analyzed, lead.created, " +
      "campaign.status_changed, or \"*\" for all of them). Returns the signing secret ONCE - store it, it " +
      "cannot be read back later.",
    inputSchema: {
      url: z.string().describe("Must be a public https URL."),
      events: z.union([z.array(z.string()), z.literal("*")]).optional(),
      description: z.string().optional(),
    },
    annotations: { idempotentHint: false },
  },
  async (args) => toResult(await apiCall("POST", "/api/v1/webhooks", { body: args })),
);

server.registerTool(
  "delete_webhook",
  {
    title: "Remove a webhook endpoint",
    description: "Permanent.",
    inputSchema: { endpointId: z.string() },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  async ({ endpointId }) => toResult(await apiCall("DELETE", `/api/v1/webhooks/${encodeURIComponent(endpointId)}`)),
);

server.registerTool(
  "get_webhook_samples",
  {
    title: "See a sample payload for an event type",
    description: "Recent real events of one type, in the exact shape a live delivery POSTs - useful for building a receiver before anything has fired for real.",
    inputSchema: { event: z.string().describe('e.g. "call.analyzed" or "campaign.status_changed".'), limit: z.number().max(10).optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ event, limit }) => toResult(await apiCall("GET", "/api/v1/webhooks/samples", { query: { event, limit: limit?.toString() } })),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[dunefox-voice-mcp] Connected. Base URL ${BASE_URL}, org ${ORG_ID}.`);
}

main().catch((e) => {
  console.error("[dunefox-voice-mcp] Fatal error:", e);
  process.exit(1);
});

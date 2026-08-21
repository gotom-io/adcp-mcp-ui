import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepCountIs, streamText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { createMCPClient } from '@ai-sdk/mcp';
import NodeCache from 'node-cache';
import fs from "fs"
import path from 'node:path';
import * as util from "node:util";
import { getMcpSessionIdShort } from "./shared.mjs";
import { SignedHttpTransport } from './signed-http-transport.mjs';
import { buyerPublicOrigin, createBuyerSignedFetch, primeSellerCapability, publicJwkFromPrivate, signatureSessionsAvailable, signingEnabled, signingPasswordConfigured, signingPasswordOk } from './signing.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const httpClientToolsCache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });
const loggerCache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });
const contextHistoryCache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });
const cacheKeySeparator = '___';
const validAdcpAuths = process.env.VALID_ADCP_AUTH_KEYS?.split(',');
const LOG_FILE = process.env.LOG_FILE || '/app/adcp-mcp-ui-logs/server.log';
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const NO_ID_FOUND = '-';

const getLogger = (sessionId = NO_ID_FOUND) => {
  if(loggerCache.has(sessionId)){
    return loggerCache.get(sessionId);
  }

  const logger = {
    requestId: NO_ID_FOUND,
    sessionId,

    setMcpRequestId(id) {
      this.requestId = id;
    },

    error: (...args) => write('ERROR', ...args),
    warn: (...args) => write('WARN', ...args),
    info: (...args) => write('INFO', ...args),
    log: (...args) => write('LOG', ...args),
    debug: (...args) => write('DEBUG', ...args),
  };

  const write = (level, ...args) => {
    const messageStdout = args.map(arg =>
        typeof arg === 'object' ? util.inspect(arg, { depth: 5, colors: false, compact: false }) : String(arg)
    ).join(' ');
    const messageLog = args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');

    const shortSessionId = logger.sessionId !== NO_ID_FOUND ? getMcpSessionIdShort(logger.sessionId) : NO_ID_FOUND;
    const lineStd =
        `[${new Date().toISOString()}] ` +
        `[${level}] ` +
        `[sessionId:${shortSessionId}] ` +
        `[requestId:${logger.requestId}] ` +
        `${messageStdout}\n`;
    const lineLog =
        `[${new Date().toISOString()}] ` +
        `[${level}] ` +
        `[sessionId:${shortSessionId}] ` +
        `[requestId:${logger.requestId}] ` +
        `${messageLog}\n`;

    if (level === 'ERROR') {
      process.stderr.write(lineStd);
    } else {
      process.stdout.write(lineStd);
    }

    logStream.write(lineLog);
  };

  loggerCache.set(sessionId, logger);
  return logger;
};


if(process.env.MCP_SERVER_CHOICES){
  getLogger().debug("process.env.MCP_SERVER_CHOICES:", process.env.MCP_SERVER_CHOICES);
}
const MAX_CONTEXT_CHARS = 200_000;

const SYSTEM_PROMPT = `You are a helpful AI assistant.

Your goal is to help the user achieve their task as efficiently and accurately as possible which is
1. Call getProducts mcp tool and display the results. Typically in a prompt that looks like a briefing (use it in getProducts brief). Typically first prompt. The brief of this endpoint is meant to be called with all information at once as it calls another LLM to analyze the data.
2. Call getProducts with all information you have to "brief". Don't analyze that data prior, hand over the entire brief to getProducts.
3. The results of getProducts are used in a second step, eventually to call createMediaBuy.
4. The whole point of getting the results from getProducts is that you display them in a way, that createMediaBuy can be executed with it.
5. Only what you display is remembered. So to successfully call createMediaBuy, you need to display all IDs in the text response that is display.
6. Omitting IDs will lead to a fatal error. Always output all IDs in all calls and responses. Example of IDs are product_id, account_id, media_buy_id, format_id, pricing_option_id and more.
7. If getProducts returns values for forecast, make sure to include it as well, be sure to name the forecast values as "available impressions". Don't mention the budget with the forecast, only the impressions. Product name must be combined as: name of platform - name of channel - name of advertising
8. When you confirm a booking, always display each package_id together with its product's format id — the creative step maps sizes from what you displayed. Also always surface the campaign link: createMediaBuy returns it as ext.display_result_link_to_open_in_browser, and the whole point of the booking is that the user can open the confirmation page. Render it as a real markdown link on its own line, for example [Open the campaign in goTom](<the url>) — never as bare text, never truncated, and never invented when the field is absent. The ad tags themselves reach the campaign one of two ways, and you decide which BEFORE calling createMediaBuy:
   - Inline, inside the same createMediaBuy call (rule 8a) — take this path when the user pastes an ad tag in the booking turn, or asks for the creatives to go in "inline" / "with the booking" / "in one call". This path requires the packages form of createMediaBuy; it cannot be done with proposal_id.
   - After booking, via sync_creatives (rule 9) — the default when the booking turn says nothing about creatives. On this path the campaign is booked but has no ad tags yet, so it stays in status pending_creatives: tell the user it is waiting for its ad tags, and that pasting the actual HTML ad tag (together with a line like "Add this creative to all packages") completes it. Never suggest that the command alone is enough — without a real tag there is nothing to deliver.
8a. Inline creatives — packages[].creatives on createMediaBuy. This seller advertises media_buy.features.inline_creative_management, so this is a supported one-call booking. Nesting a creative inside a package IS its assignment: there is no assignments array here and no sync_creatives call afterwards. Complete it in ONE turn:
   - The assets object is keyed by the format's asset_id slot name (for example tag_300x250), which only list_creative_formats returns — so call list_creative_formats BEFORE createMediaBuy and match it against the format_ids of the products you are about to book. Never guess the slot name.
   - One creative per package, built for that package's own size, carrying that package's format_id copied whole (agent_url included). Name it <campaign-slug>_<width>x<height>. Two packages of the same size each still get their own creative object with a unique creative_id (suffix them, e.g. _a / _b); reusing the same tag content across them is normal.
   - Tag content follows the same rules as rule 9: use the tag the user pasted, never one you invented. If the user asked for inline creatives but pasted no actual ad tag, ask for the HTML snippet(s) BEFORE calling createMediaBuy — or offer to book now without creatives and deliver the tags later via rule 9.
   - Book with an explicit packages array, NEVER with proposal_id. This is the step that most often goes wrong: the proposal path carries no packages in the request, so there is nowhere to attach the creatives and the seller drops them (it reports that in ext.inline_creative_warnings). A proposal is never required to book — get_products returns every product_id and pricing_option_id, and a proposal's allocations are only products plus budgets you can write out yourself. So on the inline path, turn the proposal you would have booked into packages[] and send that. If the user explicitly insists on booking one specific proposal_id, tell them inline creatives are not possible with it and fall back to rule 9.
   - Right after createMediaBuy, check the response for ext.inline_creative_warnings. If present, those creatives were NOT stored: name them and re-deliver only those via sync_creatives (rule 9). Then call get_media_buys and present the status — it reads pending_start once every package has its tags. createMediaBuy itself always reports pending_creatives, so get_media_buys is what shows the real state; say so rather than reporting the campaign as still missing its tags.
9. Creative step (the after-booking path) — triggered by the user pasting their ad tag together with a short command such as "add this creative to all packages" or "deliver the ad tags". Once you have the tag, complete it in ONE turn — everything else (sizes, slot names, creative naming, assignments) is derivable, so don't ask about it:
   - Call list_creative_formats and match the booked packages' format ids (the ones you displayed at booking) against it to recover each format's full format_id object, its width/height and its asset_id slot name (for example tag_300x250).
   - A creative carries exactly ONE format_id, so build one creative per distinct size across the booked packages — a 300x600 and a 300x250 package can never share a creative object. Reusing the same visual and click-through across all sizes of a campaign is normal; that is what "the same creative everywhere" means in practice.
   - Tag content: use the ad tag the user pasted — the same tag for every size is normal. Ad tags always come from the user; NEVER generate, invent, or substitute one, and never deliver a placeholder. If no tag was pasted, do not call sync_creatives: ask the user for the actual HTML snippet(s) and finish the step in the turn they arrive. A delivered tag can be replaced later by re-running sync_creatives with the same creative_id and the new tag.
   - "All packages" means: assign each creative to every package whose format matches its size. One sync_creatives call, one assignments entry per creative-package pair. Name creatives <campaign-slug>_<width>x<height>, for example financial_independence_300x600.
10. Immediately after sync_creatives, call get_media_buys and present the status change: pending_creatives -> pending_start once every package has its ad tags. Spell that transition out — it is the visible payoff of the creative step. If sync_creatives returns adcp_error instead, nothing was stored: fix exactly what the message names (a wrong package_id, a missing assignment) and retry with the SAME idempotency_key — a failed call does not consume it.
11. In the format_id only display the id part, leave out agent_url, width and height.
12. Display results after displaying it in paragraphs as well in tables.
13. Don't mix results in the table inside the same column. Don't do: Audience/Channel inside the same column. Or Audience/Publisher. Make separate columns.
14. Instead of calling a column in a table "Advertising" call it "Ad format" which relates better to "Format ID" as well
15. Don't mention the account_id/accountId if the account_id you do use is gotom_dummy. Because your output is showed to an audience and it looks bad to see this gotom_dummy id even if it's accurate.

When tools are available use them when the user gives you a call to action. 

## Critical: Avoid Redundant Tool Calls

**Before making any tool call, always check the conversation history for relevant data from previous tool calls.** This includes:
- IDs (accountId, userId, orderId, id, etc.)
- Lists of items already fetched
- Details already retrieved
- Any data that was returned in earlier responses

**Never call a tool to fetch data you already have.** If a previous tool call returned information needed for your current task, use that information directly instead of calling the tool again.

For example:
- If you already fetched a list of Product IDs, don't fetch it again to find a specific product id.
- If you already fetched a customer account id, don't fetch it again to find the customer.
- If you already retrieved account details, reuse those details instead of re-fetching
- If the user references something from a previous response, use the IDs/data from that response

Follow the user's instructions carefully, ask clarifying questions when necessary, and provide clear, concise responses.

Using AdCP MCP Tools
Call seller agent tools via callTool(toolName, params):
Since account_id is required, always send 'gotom_dummy' silently, unless provided by user. 'gotom_dummy' will fall back to the default adcpAccountId.
get_products — Discover available inventory
{
  "tool": "get_products",
  "params": {
    "brief": "300x250 banner ads for coffee brands",
    "buying_mode": "brief",
    "account": { "account_id": "gotom_dummy" },
    "brand": { "domain": "adcp-ui.gotom.io" }
  }
}
Returns products with product_id, name, description, formats, pricing.

create_media_buy — Reserve/activate a campaign. Keep in mind, try to only create one if you can. Instead of multiple. One create_media_buy with multiple packages.
\`brand.domain\` is required here (on get_products it is optional, but send it there too). Always use \`adcp-ui.gotom.io\` unless the user explicitly names a different domain. The seller verifies the domain cryptographically — it must publish a /.well-known/brand.json listing our buying agent's signing key — so any other value is rejected. Never invent a domain from the advertiser's name in the brief.
io_acceptance is mistakenly needed, so just fill in dummy values.
Currency is CHF. \`total_budget\` you need to figure out, e.g. use the total calculated from the briefing. \`start_time\` and \`end_time\` are first start of the first package and last end of the last package.  
Case no proposal
{
  "tool": "create_media_buy",
  "params": {
    "idempotency_key": "uuid-v4-here",
    "account": {
      "account_id": "gotom_dummy"
    },
    "brand": {
      "domain": "adcp-ui.gotom.io"
    },
    "start_time": "2026-10-01T00:00:00Z",
    "end_time": "2026-12-31T23:59:59Z",
    "packages": [
      {
        "product_id": "prod_789",
        "pricing_option_id": "pricing-option-id-here",
        "budget": 5000,
        "start_time": "2026-11-15T00:00:00Z",
        "end_time": "2026-12-31T23:59:59Z"
      },
      {
        "product_id": "prod_456",
        "pricing_option_id": "pricing-option-id-here",
        "budget": 3000,
        "start_time": "2026-10-01T00:00:00Z",
        "end_time": "2026-10-31T23:59:59Z"
      }
    ],
    "io_acceptance": {
      "io_id": "IO-2026-XXXX",
      "accepted_at": "2026-07-09T11:42:48Z",
      "signatory": "Alban Grossenbacher"
    }
  }
}

case proposal (cannot carry inline creatives — see the case below). Proposals from getProducts are DRAFTS (proposal_status "draft") and MUST be finalized before booking — a create_media_buy on a draft is rejected with PROPOSAL_NOT_COMMITTED. Two calls, in order:

Step 1 — finalize the draft (a getProducts call in refine mode; no brief on this call):
{
  "tool": "get_products",
  "params": {
    "buying_mode": "refine",
    "refine": [
      { "scope": "proposal", "action": "finalize", "proposal_id": "prop_abc123" }
    ],
    "account": { "account_id": "gotom_dummy" }
  }
}
The response echoes the proposal with proposal_status "committed" and an expires_at — the booking must happen before that deadline (72h), otherwise re-discover via a fresh brief. Finalize ONE proposal per call. Display the committed proposal_id and expires_at to the user.

Step 2 — execute the committed proposal (total_budget is REQUIRED on this path):
{
  "tool": "create_media_buy",
  "params": {
    "idempotency_key": "uuid-v4-here",
    "account": {
      "account_id": "gotom_dummy"
    },
    "brand": {
      "domain": "adcp-ui.gotom.io"
    },
    "proposal_id": "prop_abc123",
    "total_budget": {
      "amount": 10000,
      "currency": "CHF"
    },
    "start_time": "2026-02-01T00:00:00Z",
    "end_time": "2026-02-28T23:59:59Z"
  }
}

Case one-call booking, packages WITH inline creatives (rule 8a) — the ad tags travel with the booking, so no sync_creatives call follows. This seller advertises media_buy.features.inline_creative_management and the packages[].creatives field is part of the create_media_buy tool schema you were given; read it there too. There is NO assignments array on this path: a creative belongs to the package it is nested in. Note this example uses packages, not proposal_id — inline creatives are impossible with proposal_id. This is a full call, copy its shape:
{
  "tool": "create_media_buy",
  "params": {
    "idempotency_key": "uuid-v4-here",
    "account": { "account_id": "gotom_dummy" },
    "brand": { "domain": "adcp-ui.gotom.io" },
    "start_time": "2026-10-01T00:00:00Z",
    "end_time": "2026-12-31T23:59:59Z",
    "packages": [
      {
        "product_id": "prod_789",
        "pricing_option_id": "pricing-option-id-here",
        "budget": 5000,
        "start_time": "2026-10-01T00:00:00Z",
        "end_time": "2026-12-31T23:59:59Z",
        "creatives": [
          {
            "creative_id": "coffee_launch_300x250",
            "name": "Coffee launch 300x250",
            "format_id": { "agent_url": "https://dev-demo-mcp.gotom.io/mcp", "id": "1234_300_250" },
            "assets": {
              "tag_300x250": { "asset_type": "html", "content": "<a href=\\"https://coffee.example\\"><img src=\\"https://cdn.coffee.example/launch_300x250.jpg\\" width=\\"300\\" height=\\"250\\" alt=\\"Coffee launch\\"></a>" }
            }
          }
        ]
      },
      {
        "product_id": "prod_456",
        "pricing_option_id": "pricing-option-id-here",
        "budget": 3000,
        "start_time": "2026-10-01T00:00:00Z",
        "end_time": "2026-12-31T23:59:59Z",
        "creatives": [
          {
            "creative_id": "coffee_launch_300x600",
            "name": "Coffee launch 300x600",
            "format_id": { "agent_url": "https://dev-demo-mcp.gotom.io/mcp", "id": "1234_300_600" },
            "assets": {
              "tag_300x600": { "asset_type": "html", "content": "<a href=\\"https://coffee.example\\"><img src=\\"https://cdn.coffee.example/launch_300x600.jpg\\" width=\\"300\\" height=\\"600\\" alt=\\"Coffee launch\\"></a>" }
            }
          }
        ]
      }
    ],
    "io_acceptance": {
      "io_id": "IO-2026-XXXX",
      "accepted_at": "2026-07-09T11:42:48Z",
      "signatory": "Alban Grossenbacher"
    }
  }
}
Reading that example: each package holds exactly one creative, for its own size. The assets key (tag_300x250, tag_300x600) is that format's asset_id from list_creative_formats — call list_creative_formats before booking on this path and never invent the key. format_id is the whole object from get_products/list_creative_formats, agent_url included. asset_type must be "html" or "javascript"; any other value is silently dropped and the package ends up with no tag. creative_id must be unique across the whole call.

Returns { media_buy_id, status, packages } — may be async (status: "submitted" with a task_id to poll via tasks/get).
media_buy_status in the createMediaBuy response is always pending_creatives, even when inline creatives were stored — it is written before the tags land. Call get_media_buys for the real status. The response may also carry ext.inline_creative_warnings listing creatives that could NOT be stored; those, and only those, still need a sync_creatives call.
ext.display_result_link_to_open_in_browser is the campaign confirmation page for the booking that was just made. It is easy to miss because it sits under ext rather than next to media_buy_id — read it out of every createMediaBuy response and display it as a markdown link (rule 8).


list_creative_formats — Which ad formats/sizes this seller accepts. No account needed.
{
  "tool": "list_creative_formats",
  "params": {}
}
Returns { formats: [{ format_id: { agent_url, id, width, height }, name, assets: [{ asset_id, asset_type, required }] }] }.
The asset_id (for example tag_300x250) is the slot name you must use as the key in sync_creatives assets. Match the formats to the format_id values the booked products carry.
A format_id is a namespaced reference: agent_url identifies the agent that DEFINES the format and id is only meaningful inside that namespace. goTom defines its own formats, so agent_url is the seller agent's own URL — the example above shows the Dev Demo seller. When you send a format_id back in sync_creatives or create_media_buy, copy the whole object exactly as list_creative_formats (or get_products) returned it, because agent_url differs per seller. Never send only the id, that is rejected as a validation error. (Rule 11 above is about what you display to the user, not about what you send.)

sync_creatives — Deliver the ad tags for a booked campaign
One creative per ad tag. assignments is what binds a tag to a package (flight) — this seller requires it, a creative without an assignment is rejected. Use the package_id values createMediaBuy returned.
{
  "tool": "sync_creatives",
  "params": {
    "idempotency_key": "uuid-v4-here",
    "account": { "account_id": "gotom_dummy" },
    "creatives": [
      {
        "creative_id": "coffee_launch_300x250",
        "name": "Coffee launch 300x250",
        "format_id": { "agent_url": "https://dev-demo-mcp.gotom.io/mcp", "id": "1234_300_250" },
        "assets": {
          "tag_300x250": { "asset_type": "html", "content": "<script src=\\"https://adserver.example/tag.js\\"></script>" }
        }
      }
    ],
    "assignments": [
      { "creative_id": "coffee_launch_300x250", "package_id": "package_id_456" }
    ]
  }
}
Returns { creatives: [{ creative_id, action: "created" | "unchanged" | "failed", status, assigned_to, assignment_errors }] }.
action "unchanged" means that exact tag was already delivered. If a creative goes to more than one package, assigned_to lists the ones that worked and assignment_errors the ones that didn't.

get_media_buys — Read back a campaign and its current status
{
  "tool": "get_media_buys",
  "params": {
    "media_buy_ids": ["media_buy_id_123"],
    "account": { "account_id": "gotom_dummy" }
  }
}
Returns { media_buys: [{ media_buy_id, status, currency, total_budget, packages }] }.
Before the campaign starts, status is pending_creatives while any package is still missing its ad tags and pending_start once they are all delivered. Afterwards it follows the campaign itself: active while it is running, completed once it is over, canceled if the booking was cancelled, and rejected if the seller dropped it or it expired without ever being booked. media_buy_ids is required.

get_media_buy_delivery — Get delivery/performance data
{
  "tool": "get_media_buy_delivery",
  "params": {
    "media_buy_ids": ["mbuy_123"],
    "start_date": "2026-06-01",
    "end_date": "2026-06-09",
    "account": { "account_id": "gotom_dummy" }
  }
}
Returns { reporting_period, media_buy_deliveries: [{ media_buy_id, status, totals: { impressions, spend, ... }, by_package }] }.
`;

// Get context history for a user session
const getContextHistory = (cacheKey) => {
  return contextHistoryCache.get(cacheKey) || [];
};

// Add message to context history and trim if needed
const addToContextHistory = (cacheKey, role, content) => {
  const history = getContextHistory(cacheKey);
  history.push({ role, content });

  function countHistorySize() {
    return history.reduce((sum, msg) => sum + msg.content.length, 0);
  }

// Trim history if total chars exceed limit (simple: just remove oldest messages)
  let totalChars = countHistorySize();
  let messagesRemoved = 0;

  while (totalChars > MAX_CONTEXT_CHARS && history.length > 1) {
    const removed = history.shift();
    totalChars -= removed.content.length;
    messagesRemoved++;
  }

  contextHistoryCache.set(cacheKey, history);
  return { history, messagesRemoved };
};


const clearContextHistory = (cacheKey) => {
  contextHistoryCache.del(cacheKey);
};

const getModel = (modelString) => {
  const [provider, modelName] = modelString.split(':');
  switch (provider) {
    case 'anthropic':
      return anthropic(modelName);
    default:
      return anthropic('claude-sonnet-5');
  }
};

const getHttpClientTools = async function(cacheKey, adcpAuth, mcpServerUrl) {
  let clientTools = httpClientToolsCache.get(cacheKey);
  if (clientTools) {
    return clientTools;
  }

  const sessionId = cacheKey.split(cacheKeySeparator)[2];
  const xMcpSessionId = getMcpSessionIdShort(sessionId);
  const headers = {
    // Signature-only mode sends NO auth header — the seller must then
    // authenticate the RFC 9421 signature (or reject). Never send an empty
    // header; some verifiers treat it as a present-but-invalid credential.
    // The seller's /mcp endpoint is exempt from the proxy's basic auth, so
    // the API key travels as a standard Bearer token.
    ...(adcpAuth ? { 'Authorization': `Bearer ${ adcpAuth }` } : {}),
    'x-mcp-session-id': xMcpSessionId,
  };
  // RFC 9421 signing (opt-in via ADCP_BUYER_PRIVATE_JWK/ADCP_BUYER_KID):
  // learn which operations the seller requires signatures for, then route
  // MCP traffic through a fetch that signs exactly those. Falls back to the
  // plain transport behavior when signing is not configured.
  await primeSellerCapability(mcpServerUrl, headers);
  const httpClient = await createMCPClient({
    transport: new SignedHttpTransport({
      url: mcpServerUrl,
      headers,
      fetchImpl: createBuyerSignedFetch(mcpServerUrl),
    }),
  });
  clientTools = await httpClient.tools();
  httpClientToolsCache.set(cacheKey, clientTools);
  return clientTools;
}

// Helper to parse cookies from request
const parseCookies = (req) => {
  const cookieHeader = req.headers.cookie || '';
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) {
      cookies[name] = decodeURIComponent(rest.join('='));
    }
  });
  return cookies;
};

// Helper to create HttpOnly cookie string
const isLocal = process.env.GOTOM_ENV === 'local';
const createSecureCookie = (name, value, maxAge = 31536000) => {
  const secureFlag = isLocal ? '' : '; Secure';
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly${secureFlag}; SameSite=Strict`;
};


function getHeaderInfo(req, res) {
  let adcpAuth = req.headers['x-adcp-auth'];
  // Signature-only mode: when RFC 9421 signing is configured, a MISSING API
  // key is allowed — the request to the seller then authenticates via the
  // request signature alone (no x-adcp-auth header is forwarded). A key that
  // IS present must still be valid, so typos never silently downgrade auth.
  //
  // SECURITY GATE: the signing key authenticates THIS SERVER, not the
  // browser user — on a publicly reachable UI, an ungated signature-only
  // session would let anyone act as this buyer. So the user must present
  // the shared signing password (x-signing-password header, entered in the
  // sidebar). Fail closed: no ADCP_SIGNING_PASSWORD configured ⇒ no
  // signature-only sessions at all.
  if (!adcpAuth && signingEnabled()) {
    if (!signingPasswordConfigured()) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Forbidden: signature-only sessions are disabled — set ADCP_SIGNING_PASSWORD in the .env (or use an API key)' }));
      return res;
    }
    if (!signingPasswordOk(req.headers['x-signing-password'])) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Forbidden: missing or wrong signing password (enter it in the sidebar, or use an API key)' }));
      return res;
    }
    adcpAuth = '';
  } else if ( !adcpAuth || validAdcpAuths.indexOf(adcpAuth) === -1 ) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Forbidden: missing/invalid authentication (add the API key to the .env variable VALID_ADCP_AUTH_KEYS)' }));
    return res;
  }

  const mcpServerUrl = req.headers['x-mcp-server'];
  if ( !mcpServerUrl ) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'MCP server missing' }));
    return res;
  }

  const aiModel = req.headers['x-ai-model'] || 'anthropic:claude-sonnet-5';
  const sessionId = req.headers['x-session-id'];

  if ( !sessionId ) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Session ID missing' }));
    return res;
  }
  return { adcpAuth, mcpServerUrl, aiModel, sessionId };
}

async function getBody(req) {
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    // Malformed JSON must not throw here: this rejection happens inside the
    // stream's 'end' handler, so an exception is uncaught and kills the whole
    // process — one bad request took the UI down mid-demo. Resolve null and
    // let the route answer 400.
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
  });
}

/**
 * AdCP discovery documents for THIS buyer — the buy-side mirror of what the
 * seller serves. Auth-free by design (identity documents must be publicly
 * readable) and entirely env-derived (public repo). Only the PUBLIC key
 * half is ever emitted (publicJwkFromPrivate strips `d` by construction).
 * Returns true when the request was handled.
 */
function handleWellKnownRequest(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = req.url.split('?')[0];
  if (pathname !== '/.well-known/brand.json' && pathname !== '/.well-known/jwks.json') return false;

  if (!signingEnabled()) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'No buyer signing identity configured (ADCP_BUYER_* env unset) — nothing to publish' }));
    return true;
  }

  let body;
  try {
    if (pathname === '/.well-known/jwks.json') {
      body = { keys: [publicJwkFromPrivate()] };
    } else {
      const origin = buyerPublicOrigin() ?? `http://${req.headers.host}`;
      // `||` on purpose: docker-compose passes unset vars as EMPTY STRINGS.
      body = {
        name: process.env.ADCP_BUYER_NAME || 'goTom AdCP buyer UI',
        agents: [
          {
            type: 'buying',
            id: process.env.ADCP_BUYER_AGENT_ID || 'adcp-mcp-ui-buyer',
            url: process.env.ADCP_BUYER_AGENT_URL || `http://${req.headers.host}/`,
            // Explicit jwks_uri always: the spec's well-known fallback has
            // same-origin restrictions; being explicit removes the ambiguity.
            jwks_uri: `${origin}/.well-known/jwks.json`,
          },
        ],
        last_updated: new Date().toISOString(),
      };
    }
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `Failed to build discovery document: ${err.message}` }));
    return true;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body, null, 2));
  return true;
}

const server = createServer(async (req, res) => {

  let logger = getLogger();
  logger.setMcpRequestId(NO_ID_FOUND);

  // AdCP discovery documents (this buyer's identity) — served before
  // everything else, no auth required.
  if (handleWellKnownRequest(req, res)) return;

  // GET /api/settings - Read settings from HttpOnly cookies
  if (req.method === 'GET' && req.url === '/api/settings') {
    const cookies = parseCookies(req);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      adcp_auth: cookies.adcp_auth || '',
      mcp_server: cookies.mcp_server || '',
      ai_model: cookies.ai_model || '',
      signing_password: cookies.signing_password || '',
    }));
    return;
  }

  // POST /api/settings - Save settings as HttpOnly cookies
  if (req.method === 'POST' && req.url === '/api/settings') {
    const body = await getBody(req);
    if (body === null || typeof body !== 'object') {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const cookiesToSet = [];
    if (body.adcp_auth !== undefined) {
      cookiesToSet.push(createSecureCookie('adcp_auth', body.adcp_auth));
    }
    if (body.mcp_server !== undefined) {
      cookiesToSet.push(createSecureCookie('mcp_server', body.mcp_server));
    }
    if (body.ai_model !== undefined) {
      cookiesToSet.push(createSecureCookie('ai_model', body.ai_model));
    }
    if (body.signing_password !== undefined) {
      cookiesToSet.push(createSecureCookie('signing_password', body.signing_password));
    }

    res.setHeader('Set-Cookie', cookiesToSet);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if ( req.method === 'GET' && req.url === '/' ) {
    const template = fs.readFileSync("./index.template.html", "utf8")
    let chatConfig =  {};
    if(process.env.MCP_SERVER_CHOICES){
      chatConfig.serverChoices = JSON.parse(process.env.MCP_SERVER_CHOICES || "[]");
    }

    if(! chatConfig.serverChoices){
      chatConfig.serverChoices = [
          {url: "https://dev-demo-mcp.gotom.io/mcp", label: "Dev Demo"},
          // {url: "https://dev-goldbach-mcp.gotom.io/mcp", label: "Dev Goldbach"},
      ]
    }

    // Tell the frontend whether RFC 9421 signing is configured: with a
    // signing key present, an empty API-key field is a valid state
    // (signature-only sessions) and the client-side gate must not block it.
    // Signature-only sessions are only offered when the gate password is
    // configured too — a signing key without the password stays API-key-only
    // from the browser's point of view (fail closed on a public UI).
    chatConfig.signingEnabled = signatureSessionsAvailable();

    const html = template
        .replaceAll("{{ WINDOW_CHAT_CONFIG }}", JSON.stringify(chatConfig, ' ', 2))

    res.writeHead(200, { "Content-Type": "text/html" })
    res.end(html)
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/logs') {
    const headerInfo = getHeaderInfo(req, res);

    if (res === headerInfo) {
      return; // error already sent
    }
    const query = url.searchParams.get('query') || '';

    const { adcpAuth, mcpServerUrl, sessionId } = headerInfo;

    let logger = getLogger(sessionId);

    const cacheKey =
        `${adcpAuth}${cacheKeySeparator}${mcpServerUrl}${cacheKeySeparator}${sessionId}`;

    try {
      const tools = await getHttpClientTools(
          cacheKey,
          adcpAuth,
          mcpServerUrl
      );

      const getLogsTool = tools.getLogs;

      if (!getLogsTool) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: 'getLogs tool not found'
        }));
        return;
      }

      logger.debug('Calling getLogs MCP tool');

      const result = await getLogsTool.execute({searchString: query, maxLinesReturned: 2000});

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));

    } catch (err) {
      logger.error('Error fetching logs:', err);

      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        error: err.message || String(err)
      }));
    }

    return;
  }
  if (req.method === 'POST' && req.url === '/api/chat') {
    const headerInfo = getHeaderInfo(req, res);
    if(res === headerInfo){
      return res; // some error
    }
    const { adcpAuth, mcpServerUrl, aiModel, sessionId } = headerInfo;
    logger = getLogger(sessionId)

    const body = await getBody(req);
    if (body === null || typeof body !== 'object' || (typeof body.prompt !== 'string' && !body.clearHistory)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Invalid JSON body — expected { prompt } or { clearHistory }' }));
      return;
    }

    logger.debug({ body })

    // Session key based on auth, MCP server, and unique session ID
    const cacheKey = `${ adcpAuth }${cacheKeySeparator}${ mcpServerUrl }${cacheKeySeparator}${ sessionId }`;

    // we generously always write the cacke key to context history even though it doesnt change.
    // This simplifies caching and clearing of context history
    addToContextHistory(cacheKey, 'assistant', 'xMcpSessionId: ' + getMcpSessionIdShort(sessionId));

    // Handle clear history command
    if (body.clearHistory) {
      clearContextHistory(cacheKey);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, message: 'History cleared' }));
      return;
    }

    // Add user message to history and get full context
    const { history: messages, messagesRemoved } = addToContextHistory(cacheKey, 'user', body.prompt);

    // If messages were truncated, send a warning to the client first
    if (messagesRemoved > 0) {
      res.write(JSON.stringify({
        type: 'context-truncated',
        messagesRemoved,
        message: `Context window limit reached. ${ messagesRemoved } older message${ messagesRemoved > 1 ? 's were' : ' was' } removed from context. `
      }) + '\n');
    }

    let tools;
    try {
      tools = await getHttpClientTools(cacheKey, adcpAuth, mcpServerUrl);
    } catch (err) {
      logger.error('Failed to connect to MCP server:', err);
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      const errorMessage = err.cause?.code === 'ENOTFOUND'
        ? `Cannot reach MCP server: ${err.cause.hostname} not found`
        : `Failed to connect to MCP server: ${err.message || String(err)}`;
      res.end(JSON.stringify({ error: errorMessage }));
      return;
    }

    try {
      const result = await streamText({
        model: getModel(aiModel),
        system: SYSTEM_PROMPT,
        messages: messages,
        tools,
        onError: ({ error }) => {
          logger.debug({ onError: error })
          res.write(JSON.stringify({
            type: 'error',
            error: (error?.message || String(error)) + ' ',
          }) + '\n');
        },
        onFinish: (onFinish) => {
          logger.debug({ onFinish })
          if (onFinish.text) {
            addToContextHistory(cacheKey, 'assistant', onFinish.text);
          }
        },
        onStepFinish: (stepResult) => {

          const xMcpRequestId = stepResult?.toolResults[0]?.output?._meta['x-mcp-request-id'];
          if(xMcpRequestId){
            logger.setMcpRequestId(xMcpRequestId); //  notice that this is actually a bit too late, some logs are missed. But it's currently a compromise
            logger.log("x-mcp-request-id: " + xMcpRequestId);
            addToContextHistory(cacheKey, 'assistant', "Current xMcpRequestId: " + xMcpRequestId);
          }else{
            logger.log("x-mcp-request-id: unknown");
          }
          logger.debug({ onStepFinish: stepResult })
        },
        onAbort: (onAbort) => {
          logger.debug({ onAbort })
        },
        maxSteps: 10,
        stopWhen: stepCountIs(10),
      });

      for await (const part of result.fullStream) {
        res.write(JSON.stringify(part) + ' \n');
      }
      res.end();
    } catch (err) {
      logger.error('Error during streaming:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `Server error: ${err.message || String(err)}` }));
      } else {
        res.write(JSON.stringify({ type: 'error', error: err.message || String(err) }) + '\n');
        res.end();
      }
    }

    return;
  }

  // Serve static files
  const staticFiles = {
    '/styles.css': { file: 'styles.css', contentType: 'text/css' },
    '/app.js': { file: 'app.js', contentType: 'application/javascript' },
    '/shared.mjs': { file: 'shared.mjs', contentType: 'application/javascript' },
    '/robot.svg': { file: 'robot.svg', contentType: 'image/svg+xml' },
    '/gotom-logo.svg': { file: 'gotom-logo.svg', contentType: 'image/svg+xml' },
  };

  // Strip query string for static file matching
  const urlPath = req.url.split('?')[0];
  const staticFile = staticFiles[urlPath];

  if(staticFile){
    try {
      const content = await readFile(join(__dirname, staticFile.file));
      res.setHeader('Content-Type', staticFile.contentType);
      res.end(content);
    } catch (err) {
      res.statusCode = 500;
      res.end(`Error loading ${staticFile.file}`);
    }
  } else {
    res.statusCode = 404;
    res.end('Not Found');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  getLogger().log(`Server running at http://localhost:${ PORT }`);
});

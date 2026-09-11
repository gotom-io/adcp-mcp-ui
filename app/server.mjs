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
import { customerServerAllowed, findCustomerProfile, parseCustomerKeys, resolveAccess } from './customer-keys.mjs';
import { SignedHttpTransport } from './signed-http-transport.mjs';
import { buyerPublicOrigin, createBuyerSignedFetch, primeSellerCapability, publicJwkFromPrivate, signatureSessionsAvailable, signingEnabled, signingPasswordConfigured, signingPasswordOk } from './signing.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const httpClientToolsCache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });
const loggerCache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });
const contextHistoryCache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });
const cacheKeySeparator = '___';
const validAdcpAuths = process.env.VALID_ADCP_AUTH_KEYS?.split(',') ?? [];
// Customer mode (GOT-12664): fail fast at boot — a malformed allowlist must
// never come up half-parsed and expose foreign environments to a customer key.
const customerKeys = parseCustomerKeys(process.env.ADCP_CUSTOMER_KEYS);
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
1. A prompt that reads like a briefing means: call request_proposals with the ENTIRE briefing as "brief". Don't analyze the briefing yourself first — the seller runs another LLM on it that expects all information at once. Typically the first prompt.
2. request_proposals answers outcome "proposed" with draft proposals plus the products they reference — or outcome "rejected" with a reason (for example: the briefing named no flight dates). On "rejected", ask the user for exactly what the reason names, then re-send the FULL brief including it.
3. Booking a proposal takes exactly two calls, in this order: refine_proposals with action "finalize" (ONE proposal per call), then accept_proposal on the committed successor that finalize returned. If the user wants a draft changed first, call refine_proposals with action "revise" and the user's wording as "ask" — it returns a new draft to finalize. Direct purchases without a proposal go through list_products + buy_products instead.
4. The whole point of displaying results is that the follow-up call can be executed from what you displayed. Only what you display is remembered.
5. So always display ALL IDs in the visible text: proposal_id, terms_digest, product_id, pricing_option_id, package_id, media_buy_id, format_id, feed_version and more. accept_proposal is impossible without the terms_digest you displayed, buy_products is impossible without the feed_version you displayed.
6. Omitting IDs will lead to a fatal error later. Always output all IDs in all calls and responses.
7. If a response carries forecast values, include them and name them "available impressions"; don't mention the budget with the forecast, only the impressions. Product name must be combined as: name of platform - name of channel - name of advertising.
8. All three booking tools (accept_proposal, buy_products, legacy create_media_buy) answer with a TASK, not a finished buy: { status: "submitted", task_id, ext: { gotom_io: { media_buy_id, campaign_link, note } } }. goTom creates the campaign as an offer and a goTom user has to approve it — ext.gotom_io.note says so in words ("Awaiting human approval in goTom"; on a finished task it reads "Approved and booked in goTom" or "Not booked: goTom dropped the offer"). Always display the task_id, the media_buy_id, the note and the campaign_link — render the link as a real markdown link on its own line, for example [Open the campaign in goTom](<the url>) — never as bare text, never truncated, never invented when absent. Tell the user the campaign is waiting for approval in goTom. To see whether it was approved, call get_task_status with that task_id and include_result true: status "completed" carries the finished buy in result (media_buy_id, packages or purchase_bindings with package_id, confirmed_at); status "failed" with error.code OFFER_NOT_BOOKED means goTom dropped the offer — the user must book again. Never claim a buy is confirmed while the task is still submitted. Every task read (get_task_status, list_tasks) repeats ext.gotom_io.media_buy_id, campaign_link and note, so the campaign and its stage are always identifiable. The package_ids for the creative step do not wait for approval: get_media_buys with the media_buy_id from ext works on an offer too and returns packages[].package_id. The ad tags reach the campaign one of two ways, decided BEFORE you book:
   - Inline, inside one legacy create_media_buy call (rule 8a) — take this path when the user pastes an ad tag in the booking turn, or asks for creatives "inline" / "with the booking". The 3.2 booking tools (accept_proposal, buy_products) can NOT carry creatives, so the inline path requires create_media_buy with an explicit packages array.
   - After booking, via sync_creatives (rule 9) — the default when the booking turn says nothing about creatives. The campaign then stays in status pending_creatives: tell the user it is waiting for its ad tags, and that pasting the actual HTML ad tag (with a line like "Add this creative to all packages") completes it. Never suggest the command alone is enough — without a real tag there is nothing to deliver.
8a. Inline creatives — packages[].creatives on legacy create_media_buy, the one remaining reason to use that tool. Nesting a creative inside a package IS its assignment: no assignments array, no sync_creatives afterwards. Complete it in ONE turn:
   - The assets object is keyed by the format's asset_id slot name (for example tag_22_300x250), which only list_creative_formats returns — call it BEFORE booking and match it against the format_ids of the products you book. Never guess the slot name.
   - One creative per package, built for that package's own size, carrying that package's format_id copied whole (agent_url included). Naming (rule 9 applies here too): name is human-readable words, creative_id a short distinct technical id, never the same string. Two packages of the same size each still get their own creative object with a unique creative_id (suffix -a / -b); reusing the same tag content across them is normal.
   - Tag content: use the tag the user pasted, never one you invented. If the user asked for inline creatives but pasted no actual ad tag, ask for the HTML snippet(s) BEFORE booking — or offer to book now via the 3.2 path and deliver the tags later via rule 9.
   - Neither accept_proposal nor create_media_buy with proposal_id can carry creatives. To book a proposal WITH inline creatives, write the committed proposal's purchases out as packages[] (each purchase already names product_id, pricing_option_id, budget and flight) and send that as a packages-form create_media_buy.
   - Inline creatives are stored right away, before the offer is approved. Once the task completes, check ext.gotom_io.inline_creative_warnings on its result. If present, those creatives were NOT stored: name them and re-deliver only those via sync_creatives (rule 9). Then call get_media_buys and present the status (rule 10): stored tags show as pending_review under creative_approvals and the buy stays pending_creatives until a goTom user has integrated every package's tag; only then does it read pending_start.
9. Creative step (the after-booking path) — triggered by the user pasting their ad tag with a short command such as "add this creative to all packages". Once you have the tag, complete it in ONE turn — sizes, slot names, creative naming and assignments are all derivable, so don't ask about them:
   - Call list_creative_formats and match the booked packages' format ids (the ones you displayed at booking) against it to recover each format's full format_id object, its width/height and its asset_id slot name.
   - A creative carries exactly ONE format_id, so build one creative per distinct size across the booked packages. Reusing the same visual and click-through across all sizes is normal.
   - Tag content: use the ad tag the user pasted — the same tag for every size is normal. Ad tags always come from the user; NEVER generate, invent, or substitute one, and never deliver a placeholder. If no tag was pasted, do not call sync_creatives: ask for the actual HTML snippet(s). A delivered tag can be replaced later by re-running sync_creatives with the same creative_id and the new tag.
   - "All packages" means: assign each creative to every package whose format matches its size — the package_ids come from get_media_buys (packages[].package_id, works while the campaign is still an offer) or, once the booking task completed, from its result's purchase_bindings (3.2) or packages (legacy). One sync_creatives call, one assignments entry per creative-package pair. Naming: both end up in the goTom document filename, so they must differ and read well — name is human-readable words with the campaign, device and size (for example "Financial Independence Desktop 300x250"); creative_id is a short technical id in lowercase with hyphens (for example "fin-indep-desktop-300x250"). Never use the same string for both, and never use underscores in the creative name or creative_id. The asset slot key is exempt — copy it verbatim from list_creative_formats (real keys look like tag_22_300x250 and do contain underscores).
10. Immediately after sync_creatives, call get_media_buys and present the status: right after delivery every creative is pending_review and the campaign stays pending_creatives — a goTom user must integrate each tag; only then does it flip to pending_start. Spell that out — delivery is done, integration is goTom's step. If sync_creatives returns adcp_error instead, nothing was stored: fix exactly what the message names and retry with the SAME idempotency_key — a failed call does not consume it.
11. In the format_id only display the id part, leave out agent_url, width and height.
12. Display results after displaying it in paragraphs as well in tables.
13. Don't mix results in the table inside the same column. Don't do: Audience/Channel inside the same column. Or Audience/Publisher. Make separate columns.
14. Instead of calling a column in a table "Advertising" call it "Ad format" which relates better to "Format ID" as well.
15. Name the account by its advertiser name — the \`advertiser\` value list_accounts returned for it — not by the raw account_id, in prose addressed to the user — your output is shown to an audience. The account_id still belongs in the ID list of rule 5.

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
The seller publishes a typed input schema per tool; follow it, and use the examples below for the field combinations it cannot express.
\`account\` is always an OBJECT, never a bare string: \`{ "account_id": "<account_id from list_accounts>" }\`. Sending \`"account": "<account_id from list_accounts>"\` fails with VALIDATION_ERROR "/account: must be object". There is no placeholder account id — an invented one answers ACCOUNT_NOT_FOUND, which is terminal. Call list_accounts FIRST in a session and use a real account_id from it; when it returns more than one account, pick the one whose \`advertiser\` matches the brief and say which you picked, or ask the user when the brief names none. refine_proposals and decline_proposals take NO account at all — their schema rejects extra fields; the seller scopes them by the credential.
\`brand\` is likewise an OBJECT: \`{ "domain": "adcp-ui.gotom.io" }\`. request_proposals and buy_products both REQUIRE it alongside the id-only account — omitting it fails with "/brand: must have required property 'brand'". Never send a top-level \`brand\` together with an \`account\` that itself carries brand+operator; that combination fails with "/: must NOT be valid". With \`{ "account_id": ... }\` the pairing is correct.
\`idempotency_key\` is REQUIRED on request_proposals, buy_products, refine_proposals, accept_proposal and create_media_buy — a fresh UUID per distinct call, the same one on a retry.
\`brand.domain\`: always \`adcp-ui.gotom.io\` unless the user explicitly names a different domain. The seller verifies an asserted domain cryptographically — it must publish a /.well-known/brand.json listing our buying agent's signing key — so any other value risks rejection. Never invent a domain from the advertiser's name in the brief.
The legacy get_products tool still exists but do not use it: request_proposals covers the brief path, list_products the catalog path.

list_accounts — Which advertiser accounts this credential may buy for. Call it first; every other tool needs an account_id from here.
{
  "tool": "list_accounts",
  "params": {}
}
Returns { accounts: [{ account_id, name, advertiser, operator, brand: { domain }, status }] }. Use \`advertiser\` to match the brief and \`account_id\` in every later call.

request_proposals — Brief-driven discovery: draft proposals with firm terms
{
  "tool": "request_proposals",
  "params": {
    "idempotency_key": "uuid-v4-here",
    "brief": "300x250 banner ads for coffee brands, CHF 8000, October 2026",
    "account": { "account_id": "the account_id list_accounts returned" },
    "brand": { "domain": "adcp-ui.gotom.io" }
  }
}
Returns outcome "proposed" with proposals and the products they reference, or outcome "rejected" with a reason (see rule 2). Each proposal carries proposal_id, name, expires_at, terms_digest, and commercial_terms: purchases (each with product_id, pricing_option_id, resolved pricing, budget, start_time, end_time), overall start_time/end_time and total_budget. Proposals are DRAFTS — they must be finalized (refine_proposals) and then accepted (accept_proposal) to book. Display proposal_id, terms_digest and expires_at for every proposal.

list_products — The plain catalog, no AI and no brief
{
  "tool": "list_products",
  "params": {
    "account": { "account_id": "the account_id list_accounts returned" },
    "max_results": 50
  }
}
Returns { products, feed_version, pricing_version, next_cursor? }. Page with cursor=next_cursor until it is absent. Products carry product_id and pricing_options with pricing_option_id and fixed_price (already net for this account). feed_version and pricing_version identify exactly what was served — buy_products requires the current feed_version, so display it.

buy_products — Direct purchase of published offers, no proposal round trip
{
  "tool": "buy_products",
  "params": {
    "idempotency_key": "uuid-v4-here",
    "account": { "account_id": "the account_id list_accounts returned" },
    "brand": { "domain": "adcp-ui.gotom.io" },
    "feed_version": "the feed_version list_products just returned",
    "start_time": "2026-10-01T00:00:00Z",
    "end_time": "2026-12-31T23:59:59Z",
    "purchases": [
      { "product_id": "prod_789", "pricing_option_id": "the option list_products returned for prod_789", "budget": 5000 },
      { "product_id": "prod_456", "pricing_option_id": "the option list_products returned for prod_456", "budget": 3000, "start_time": "2026-10-01T00:00:00Z", "end_time": "2026-10-31T23:59:59Z" }
    ]
  }
}
feed_version must be CURRENT: PRODUCT_EXPIRED means the catalog or the rates moved — call list_products again and retry with the fresh token. pricing_option_id must be exactly the one list_products returned for that product; anything else is INVALID_REQUEST. A purchase without its own start_time/end_time inherits the campaign window. Returns the commitment shape (see accept_proposal).

refine_proposals — Finalize ONE draft proposal
{
  "tool": "refine_proposals",
  "params": {
    "adcp_version": "3.2",
    "adcp_major_version": 3,
    "idempotency_key": "uuid-v4-here",
    "refinements": [
      { "proposal_id": "prop_draft_123", "action": "finalize" }
    ]
  }
}
Both version fields are REQUIRED on this call (only here): adcp_version "3.2" and adcp_major_version 3. No account and no brief on this call. Exactly ONE refinement per call — a second finalize answers MULTI_FINALIZE_UNSUPPORTED, a second revise INVALID_REQUEST. The finalize response carries the committed successor — a NEW proposal_id, its terms_digest, and expires_at (the hold deadline — currently 24h; the booking must happen before it, otherwise re-discover with a fresh brief). Display the committed proposal_id, its terms_digest and expires_at.

refine_proposals — Revise ONE draft from the user's wording (change terms before finalizing)
{
  "tool": "refine_proposals",
  "params": {
    "adcp_version": "3.2",
    "adcp_major_version": 3,
    "idempotency_key": "uuid-v4-here",
    "refinements": [
      { "proposal_id": "prop_draft_123", "action": "revise", "ask": "drop the mobile placements and move that budget to the desktop rectangles" }
    ]
  }
}
Use this when the user wants a proposal changed (different budget, dates, products, split) — do NOT decline and re-brief for that. "ask" is REQUIRED and is the user's request in plain words; pass it whole, the seller runs its own LLM on it. Outcomes: "revised" returns ONE new DRAFT with a new proposal_id and parent_proposal_id = the source (the source draft stays valid); "partial" means part of the ask is not offered — read reason and tell the user; "unable" with reason_code unsupported_dimension (a cancellation — this seller refuses cancellations), uninterpreted (the ask was empty or could not be planned) or commercially_declined (asked for products or prices outside the tariff). A revised draft is a draft: it still needs finalize, then accept_proposal. Display the new proposal_id, terms_digest and expires_at exactly as for request_proposals.

accept_proposal — Execute a committed proposal as a campaign
{
  "tool": "accept_proposal",
  "params": {
    "idempotency_key": "uuid-v4-here",
    "account": { "account_id": "the account_id list_accounts returned" },
    "proposal_id": "prop_committed_456",
    "proposal_terms_digest": "the committed proposal's terms_digest"
  }
}
proposal_id and proposal_terms_digest are the COMMITTED successor's (from refine_proposals), not the draft's. A wrong digest answers PROPOSAL_NOT_FOUND — use exactly the digest you displayed. Returns the submitted task envelope of rule 8: { status: "submitted", task_id, ext: { gotom_io: { media_buy_id, campaign_link, note } } }. Once goTom approved the offer, get_task_status (include_result true) returns in result: { media_buy_id, media_buy_status, confirmed_at, accepted_proposal, purchase_bindings: [{ purchase_index, product_id, package_id }], ext: { gotom_io: { campaign_link } } }. media_buy_status in that result is the status at the moment goTom approved the offer — pending_creatives, or pending_start when the tags were already integrated — and never changes afterwards; the live status is always get_media_buys. The package_ids for the creative step come from get_media_buys or from purchase_bindings. campaign_link is the campaign confirmation page: display it as a markdown link (rule 8).

decline_proposals — Walk away from proposals you will not book
{
  "tool": "decline_proposals",
  "params": {
    "idempotency_key": "uuid-v4-here",
    "declines": [
      { "proposal_id": "prop_draft_123", "reason": "budget_changed", "detail": "client cut Q4 budget" }
    ]
  }
}
No account on this call. reason is one of: price, inventory_fit, audience_fit, creative_unsupported, measurement_unsupported, policy, timing, budget_changed, selected_alternative, other — and reason "other" REQUIRES a detail, so prefer a specific reason and always include detail with "other". An accepted proposal cannot be declined — that would be a cancellation, which this seller does not support.

create_media_buy — LEGACY booking; use it only for inline creatives (rule 8a)
\`brand.domain\` is required here. io_acceptance is optional and this seller ignores it — leave it out, never invent a signatory. Currency is CHF. \`total_budget\` you need to figure out, e.g. the total calculated from the briefing. \`start_time\` and \`end_time\` are the first start and last end across packages. This is a full call, copy its shape:
{
  "tool": "create_media_buy",
  "params": {
    "idempotency_key": "uuid-v4-here",
    "account": { "account_id": "the account_id list_accounts returned" },
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
            "creative_id": "coffee-launch-desktop-300x250",
            "name": "Coffee Launch Desktop 300x250",
            "format_id": { "agent_url": "https://dev-demo-mcp.gotom.io/mcp", "id": "1234_300_250" },
            "assets": {
              "tag_22_300x250": { "asset_type": "html", "content": "<a href=\\"https://coffee.example\\"><img src=\\"https://cdn.coffee.example/launch_300x250.jpg\\" width=\\"300\\" height=\\"250\\" alt=\\"Coffee launch\\"></a>" }
            }
          }
        ]
      }
    ]
  }
}
Reading that example: each package holds exactly one creative, for its own size. The assets key (tag_22_300x250) is that format's asset_id from list_creative_formats — call list_creative_formats before booking on this path and never invent the key. format_id is the whole object from list_creative_formats, agent_url included. asset_type must be "html" or "javascript"; any other value is silently dropped and the package ends up with no tag. creative_id must be unique across the whole call.
The response is the submitted task envelope of rule 8 — { status: "submitted", task_id, ext: { gotom_io: { media_buy_id, campaign_link, note } } } — never the buy itself. The finished buy arrives on the task's result once goTom approved the offer: media_buy_status there is the status at the moment goTom approved the offer (pending_creatives, or pending_start once the tags were integrated) and never changes afterwards — call get_media_buys for the live status. That result may carry ext.gotom_io.inline_creative_warnings listing creatives that could NOT be stored; those, and only those, still need a sync_creatives call. ext.gotom_io.campaign_link — on the envelope and again on the result — is the campaign confirmation page; display it as a markdown link (rule 8).

list_creative_formats — Which ad formats/sizes this seller accepts. No account needed.
{
  "tool": "list_creative_formats",
  "params": {}
}
Returns { formats: [{ format_id: { agent_url, id, width, height }, name, assets: [{ asset_id, asset_type, required }] }] }.
The asset_id (for example tag_22_300x250) is the slot name you must use as the key in sync_creatives assets. Match the formats to the format_id values the booked products carry.
A format_id is a namespaced reference: agent_url identifies the agent that DEFINES the format and id is only meaningful inside that namespace. goTom defines its own formats, so agent_url is the seller agent's own URL — the example above shows the Dev Demo seller. When you send a format_id back in sync_creatives or create_media_buy, copy the whole object exactly as list_creative_formats returned it, because agent_url differs per seller. Never send only the id, that is rejected as a validation error. (Rule 11 above is about what you display to the user, not about what you send.)

sync_creatives — Deliver the ad tags for a booked campaign
One creative per ad tag. assignments is what binds a tag to a package (flight) — this seller requires it, a creative without an assignment is rejected. The package_id values come from get_media_buys (packages[].package_id — works while the campaign is still an offer, no need to wait for approval) or, once the booking task completed, from its result's purchase_bindings (3.2) or packages (legacy).
{
  "tool": "sync_creatives",
  "params": {
    "idempotency_key": "uuid-v4-here",
    "account": { "account_id": "the account_id list_accounts returned" },
    "creatives": [
      {
        "creative_id": "coffee-launch-desktop-300x250",
        "name": "Coffee Launch Desktop 300x250",
        "format_id": { "agent_url": "https://dev-demo-mcp.gotom.io/mcp", "id": "1234_300_250" },
        "assets": {
          "tag_22_300x250": { "asset_type": "html", "content": "<script src=\\"https://adserver.example/tag.js\\"></script>" }
        }
      }
    ],
    "assignments": [
      { "creative_id": "coffee-launch-desktop-300x250", "package_id": "package_id_456" }
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
    "account": { "account_id": "the account_id list_accounts returned" }
  }
}
Returns { media_buys: [{ media_buy_id, status, currency, total_budget, confirmed_at, packages: [{ package_id, creative_approvals }] }] }.
It works while the campaign is still an offer: confirmed_at is null until a goTom user approves it, then it becomes the approval time — that is how you tell an offer from a booking. Before the campaign starts, status is pending_creatives while any package is still missing its ad tags and pending_start once they are all delivered and integrated. Afterwards it follows the campaign itself: active while it is running, completed once it is over, canceled if the booking was cancelled, and rejected if the seller dropped it or it expired without ever being booked. Each package lists its synced creatives under creative_approvals as { creative_id, approval_status } — pending_review until a goTom user integrates the tag, approved afterwards. media_buy_ids is required.

get_task_status — Where a booking task stands (rule 8)
{
  "tool": "get_task_status",
  "params": {
    "task_id": "the task_id the booking tool returned",
    "include_result": true,
    "account": { "account_id": "the account_id list_accounts returned" }
  }
}
Returns { task_id, status, ext: { gotom_io: { media_buy_id, campaign_link, note } }, result?, error? }. status "submitted" = the offer is still waiting for approval in goTom; "completed" = approved, result holds the finished buy (rule 8); "failed" with error.code OFFER_NOT_BOOKED = goTom dropped or deleted the offer, book again if still wanted. list_tasks lists every task of the account with the same ext, without result — always pass account: { "account_id": ... }, this credential holds more than one account and an account-less call lists nothing. Always use get_task_status for a single task, never tasks_get; include_result is a boolean, account an object.

get_media_buy_delivery — Get delivery/performance data
{
  "tool": "get_media_buy_delivery",
  "params": {
    "media_buy_ids": ["mbuy_123"],
    "start_date": "2026-06-01",
    "end_date": "2026-06-09",
    "account": { "account_id": "the account_id list_accounts returned" }
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

/**
 * The message the chat shows for a failed model call. Anthropic answers HTTP 529
 * `overloaded_error` when the selected model has no capacity; the AI SDK retries
 * and then throws a RetryError whose `lastError`/`errors` carry the 529. Any
 * other model has its own capacity, so switching is the fix a user can apply.
 */
const OVERLOAD_HINT = 'Anthropic overload, please change AI Model in selection or retry in a moment.';

function describeAiError(error) {
  const message = error?.message || String(error);
  return isAnthropicOverload(error) ? `${OVERLOAD_HINT} (${message})` : message;
}

function isAnthropicOverload(error, depth = 0) {
  if (!error || depth > 4) return false;
  if (error.statusCode === 529) return true;
  const text = `${error.message ?? ''} ${error.responseBody ?? ''}`;
  if (/overloaded_error|\bOverloaded\b/.test(text)) return true;
  const nested = [error.lastError, error.cause, ...(Array.isArray(error.errors) ? error.errors : [])];
  return nested.some((inner) => isAnthropicOverload(inner, depth + 1));
}

const getModel = (modelString) => {
  const [provider, modelName] = modelString.split(':');
  switch (provider) {
    case 'anthropic':
      return anthropic(modelName);
    default:
      return anthropic('claude-sonnet-5');
  }
};

const getHttpClientTools = async function(cacheKey, adcpAuth, mcpServerUrl, signRequests = true) {
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
  //
  // Customer sessions never sign (GOT-12664): when a signature and an API key
  // arrive together, the seller keeps the SIGNED identity as the buyer and
  // demotes the key to operatorPrincipal ("the key must never widen who you
  // buy as", sdk-adcp-seller app/auth/signing/verifier.ts). Our signing key
  // maps to one internal principal, so signing a customer's call would book it
  // as that principal instead of the customer's own agency. API key only.
  if (signRequests) {
    await primeSellerCapability(mcpServerUrl, headers);
  }
  const httpClient = await createMCPClient({
    transport: new SignedHttpTransport({
      url: mcpServerUrl,
      headers,
      fetchImpl: signRequests ? createBuyerSignedFetch(mcpServerUrl) : fetch,
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
  // Customer mode (GOT-12664): a customer key is valid on its own, but only
  // towards its own environments. The checks live HERE (not just in the UI)
  // because every restriction the sidebar hides can be forged as a header.
  const customerProfile = findCustomerProfile(customerKeys, adcpAuth);
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
  } else if ( !customerProfile && (!adcpAuth || validAdcpAuths.indexOf(adcpAuth) === -1) ) {
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
  if (customerProfile && !customerServerAllowed(customerProfile, mcpServerUrl)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Forbidden: this API key is locked to its own environments' }));
    return res;
  }

  // Customers don't pick the model — the key's configured model always wins.
  const aiModel = customerProfile
    ? customerProfile.model
    : (req.headers['x-ai-model'] || 'anthropic:claude-sonnet-5');
  const sessionId = req.headers['x-session-id'];

  if ( !sessionId ) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Session ID missing' }));
    return res;
  }
  return { adcpAuth, mcpServerUrl, aiModel, sessionId, customerProfile };
}

/** Every MCP server this deployment knows — internal callers only. */
function internalServerChoices() {
  if (process.env.MCP_SERVER_CHOICES) {
    const parsed = JSON.parse(process.env.MCP_SERVER_CHOICES || "[]");
    if (parsed.length) return parsed;
  }
  return [
    { url: "https://dev-demo-mcp.gotom.io/mcp", label: "Dev Demo" },
  ];
}

/**
 * The config the frontend runs on, derived from the presented credentials.
 * Injected into `/` at render time (from the cookies) and served live via
 * GET /api/profile so the sidebar can react when a key is typed in.
 *
 * The server list is WITHHELD unless the credentials resolve (GOT-12664):
 * an unknown key, no key, or a wrong signing password gets an empty list.
 * This is a backend gate, not a UI one — hiding the environments in the
 * sidebar would protect nothing, since anyone can read this response
 * directly. A customer key sees only its own servers, with the model pinned
 * and the lockdown UI on (no signing password, no logs, no session id).
 */
function buildChatConfig(adcpAuth, signingPassword) {
  const access = resolveAccess({
    customerKeys,
    validKeys: validAdcpAuths,
    adcpAuth,
    signaturePasswordOk: signatureSessionsAvailable() && signingPasswordOk(signingPassword),
  });

  if (access.mode === 'customer') {
    return {
      authenticated: true,
      customerMode: true,
      serverChoices: access.profile.servers,
      aiModel: access.profile.model,
      signingEnabled: false,
    };
  }

  // Tell the frontend whether RFC 9421 signing is configured: with a
  // signing key present, an empty API-key field is a valid state
  // (signature-only sessions) and the client-side gate must not block it.
  // Signature-only sessions are only offered when the gate password is
  // configured too — a signing key without the password stays API-key-only
  // from the browser's point of view (fail closed on a public UI).
  const signingEnabled = signatureSessionsAvailable();

  if (access.mode === 'anonymous') {
    return { authenticated: false, customerMode: false, serverChoices: [], signingEnabled };
  }

  return {
    authenticated: true,
    customerMode: false,
    serverChoices: internalServerChoices(),
    signingEnabled,
  };
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

  // GET /api/profile — the chat config for the key currently in the auth
  // cookie. The frontend re-fetches this whenever the API key changes, so
  // entering a customer key locks the sidebar down without a reload.
  if (req.method === 'GET' && req.url === '/api/profile') {
    const cookies = parseCookies(req);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(buildChatConfig(cookies.adcp_auth || '', cookies.signing_password || '')));
    return;
  }

  if ( req.method === 'GET' && req.url === '/' ) {
    const template = fs.readFileSync("./index.template.html", "utf8")
    // A returning customer's key is already in the cookie, so the first paint
    // is already locked down — no flash of the internal sidebar.
    const cookies = parseCookies(req);
    const chatConfig = buildChatConfig(cookies.adcp_auth || '', cookies.signing_password || '');

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
    // Logs are an internal debugging surface — customers never see them
    // (GOT-12664). The button is hidden in customer mode, but the endpoint
    // must refuse on its own.
    if (headerInfo.customerProfile) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Forbidden: logs are not available for this API key' }));
      return;
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
    const { adcpAuth, mcpServerUrl, aiModel, sessionId, customerProfile } = headerInfo;
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
      tools = await getHttpClientTools(cacheKey, adcpAuth, mcpServerUrl, !customerProfile);
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
            error: describeAiError(error) + ' ',
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
        res.end(JSON.stringify({ error: `Server error: ${describeAiError(err)}` }));
      } else {
        res.write(JSON.stringify({ type: 'error', error: describeAiError(err) }) + '\n');
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

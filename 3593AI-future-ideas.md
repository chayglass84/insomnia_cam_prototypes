# 3593AI: future ideas from the Kong AI Gateway 2.3 work

Written 2026-11-06, revised the same day after reading the rest of the docs. **Nothing here is built or decided.** This is a list to walk through and rank together.

## How to read this

- **Sources:** developer.konghq.com: AI Management, the AI Model / Model Provider / MCP Server / Agent / Policy / Auth Strategy entity pages, AI Cost Management (budgets, attribution, analytics, price catalog), Access Management, Roles, Token Vault, Observability, load balancing, streaming, passthrough, semantic similarity, MCP version support, the policy pages for Prompt Guard, Lakera Guard, PII Sanitizer and AI Rate Limiting Advanced, and the **AI Gateway changelog**. Plus our own `3593AI.md`.
- **What 2.3 actually is:** AI Gateway **2.3.0 was released 2026-11-04** (2.2.0 on 2026-09-30, 2.1.0 on 2026-09-24, 2.0.0 on 2026-07-10). Headline 2.3 items from the changelog: Token Vault plugins and gateway-hosted OAuth enrollment; the `access-policy-engine` plugin (Cedar policies from a Kong Identity principal); cost tags from `ai-cost-*` request headers; a node-level dynamic price catalog; much wider `failover_criteria`; new analytics token/cost fields (`input_tokens`, `output_tokens`, cache-write detail, `input_token_cost`, `output_token_cost`, `service_tier`); `allow_when`/`deny_when` CEL on MCP tool ACLs; `log_blocked_content` on the guard policies; Baseten and new Bedrock endpoint options; `principal`-based rate limiting. Access Management, Budgets, Attribution, Analytics and the Price Catalog pages are all gated at `ai-gateway 2.3`, so **the whole "who is using the AI and what does it cost" area is new this week.**
- **Still not read:** the AI Semantic Cache, Prompt Decorator, Prompt Template and LLM-as-Judge policy pages; Cost Management integrations, org chart, exports and notification channels; Kong Identity principals; the OTel metrics page; the Konnect AI Gateway REST reference. Ideas that depend on them say so.
- **Docs gaps worth knowing:** several things we would want a client to detect are simply **not documented** (no header says which target answered, no header says a cache hit, no header says a guard ran, the Token Vault "not enrolled" status code, the header name for a virtual key). Those ideas carry that risk.
- **Ranking:** agreed with Cam on 2026-11-06 (see "Agreed grouping" below). The per-idea sections further down still carry my original write-up; where a section says "unknowns" or "caveat", the grouping notes say which of those become plan items.
- **Context:** none of this AI Gateway in Insomnia work is planned or ready. The goal is alignment next week, then 2-3 weeks of planning before building starts.

## Agreed grouping (2026-11-06)

**Definitely do (v1)**
- **#1** Request shape from model `capabilities` + `formats`
- **#9** Routing beyond a body `model` value. Rides along with #1; the unknowns are implementation details, not a decision.
- **#13** Streaming-mode awareness (small fix for our main feature)
- **Money theme: "help people investigate and track money":**
  - **#2** Real per-model cost
  - **#3** Attribution tags (`ai-cost-*`) on requests and Evaluator runs
  - **#10** Your usage and budget inside Insomnia. Per-person visibility is documented (callers who can only see some principals get only their events). A live poke on 2026-11-06 got **401** on usage events, usage query and budget balances with the Konnect MCP's login, while gateways and the cost-tags endpoint worked, so it is unconfirmed whether a personal access token can read them. Check that early.

**Decide before building**
- **#12** Our Judge vs the gateway's `ai-llm-as-judge` policy. Recommendation: **keep ours, positioned as pre-production testing with your own criteria.** The policy is one sampled 1-100 score with no criteria list, written to logs and optionally a response header (`X-Kong-LLM-Accuracy-Score`, off by default). Next week's alignment only needs to confirm the positioning.

**Investigate**
- **#7** MCP: keep investing in Insomnia's MCP tester, move to Ardi (a better MCP tester built but not launched), or reconcile the two. **#17** (MCP error-code explainers) is folded in and follows whatever this decides.

**Bring more from Konnect (v1 or not, decided together as one scope call)**
- **#7** MCP servers, **#8** agents (anything else we sync from Konnect)

**Want, not v1**
- **#4** Auth and access hints and **#5** Policy insights share the same machinery, so they are the first additions if v1 finishes early. Not required for v1.
- **#6** Which target answered (a catalog-only piece, showing algorithm and weights, is an optional extra)
- **#8** Sync agents (check whether any users have agents behind the gateway yet)
- **#11** Debugger for AI, and **#20** a visual view of what a single request hits. They rely on the same data.

**Someday**
- **#14** Token Vault enrollment prompt, **#15** "Request access" shortcut, **#16** LLM key from inside Insomnia (much easier if OAuth to Konnect gets built for #10), **#18** batches for large evaluations, **#19** runtime-version awareness (low priority, build a small version only if another item needs it)

**Carry into the plan (small checks, not decisions)**
- Check early that Insomnia's login can read the usage endpoints (#10).
- Check what a denied stream returns on our test gateway (#13).
- Confirm the Konnect list endpoint returns `capabilities`, `formats`, routing config and target cost fields (#1, #2, #9).
- Decide what Insomnia does when attribution is off for a gateway (#3). Working guess: send the headers anyway, show a note if we can detect it is off.

## Summary table

| # | Idea | Builds on | Bucket |
|---|---|---|---|
| 1 | Derive request shape from model `capabilities` + `formats` | Retires our hardcoded 2-entry path map | Definitely do (v1) |
| 2 | Real per-model cost (target fields, overrides, catalog, usage events) | Replaces the estimated-cost shortcut | Definitely do (v1, money) |
| 3 | Attribution tags (`ai-cost-*`) on requests and Evaluator runs | Evaluator, cost | Definitely do (v1, money) |
| 4 | Auth and access hints on AI Gateway responses | Plugin hints (work item 12) + policies tab | Want, not v1 |
| 5 | Policy insights on responses (guards, rate limits, sanitizer) | Plugin-header registry | Want, not v1 |
| 6 | Show which target answered (load balancer view) | Rotating aliases, future idea #1 | Want, not v1 |
| 7 | Sync AI MCP Servers into Insomnia | Sync + Insomnia's MCP client | Investigate (Insomnia vs Ardi); Bring more from Konnect |
| 8 | Sync AI Agents (A2A) and a task view | Sync, chat window | Want, not v1; Bring more from Konnect |
| 9 | Routing beyond a body `model` value | Sync, picker, evaluator fan-out | Definitely do (v1, with #1) |
| 10 | Your usage and your budget, inside Insomnia | Future idea #3 | Definitely do (v1, money) |
| 11 | Debugger / event link for AI Gateway requests | Future idea #2 | Want, not v1 |
| 12 | Relate our Judge to the gateway's LLM-as-Judge policy | Judge (work item 6) | Decide before building |
| 13 | Streaming-mode awareness (`response_streaming`) | Streaming chat window | Definitely do (v1) |
| 14 | Token Vault enrollment prompt | Auth hints (4) | Someday |
| 15 | "Request access" shortcut | Access management | Someday |
| 16 | Get an LLM key from inside Insomnia | Future idea #4 | Someday |
| 17 | MCP protocol and error-code explainers | Item 7 | Folded into #7 |
| 18 | Async API models (batches) for large evaluations | Model Evaluator | Someday |
| 19 | Gateway runtime-version awareness | Sync | Someday |
| 20 | Visual view of what models, agents and policies a single request hits | #11, future idea #1 | Want, not v1 |

---

## 1. Derive request shape from model `capabilities` + `formats`

**What Kong has.** An AI Model declares `type` (`model` sync, `api` async), `capabilities` (generate, embeddings, audio, image, video, realtime, rerank, decisions, batches, files, skills) and `formats` (openai, anthropic, bedrock, cohere, gemini, huggingface, typesafe, passthrough). Each capability has default paths (generate is `/chat/completions` and `/completions`, embeddings is `/embeddings`). 2.3 adds Bedrock native paths (`/openai/v1/chat/completions`, `/openai/v1/responses`, `/anthropic/v1/messages`) and Bedrock "mantle" models (`/v1/chat/completions`, `/v1/responses`, `/v1/files`, `/v1/messages`).

**What we do today.** A hardcoded map: `anthropic` goes to `/v1/messages`, `openai` goes to `/chat/completions`. Other formats get the bare route path. Skills and the chat parser only work on those two formats. First row of our shortcuts table.

**The idea.** Read `capabilities` and `formats` at sync and build the starter request from them: the right path, the right body shape, honest labels. Embeddings and rerank models would get a starter request instead of a chat one. Gemini and Bedrock become usable, and "skill silently not applied" shrinks to a per-format branch.

**Caveat from the docs.** `passthrough` models forward bytes untouched, support none of the body-rewriting or guard policies, and report reliable token counts only for some providers (anthropic, bedrock, cohere, gemini, huggingface). So for passthrough models our tokens/cost columns and skills would be unreliable; we should label them rather than guess.

**Why it matters.** Removes our biggest known fake and makes more gateways work without hand-fixing.

**Unknowns.** Exact response shapes for bedrock and cohere rerank. Whether the Konnect list endpoint returns these fields in the form the entity page shows (our sync reads a smaller slice).

## 2. Real per-model cost (target fields, overrides, catalog, usage events)

**What Kong has.** Price precedence, from the Price Catalog page: **(1)** cost fields on the model target (`input_cost`, `output_cost`, `cache_read_cost`, `cache_write_cost`, `cache_write_cost_list` by TTL, `context_window_factor`, `service_tier_factor`), **(2)** an org custom-rate override for the model, **(3)** a provider percentage-off override, **(4)** the catalog list price. Dynamic pricing is on by default in 2.3 (data planes poll a catalog every 60 seconds). A target with no cost fields uses the catalog. Prices are USD per million tokens. Overrides apply org-wide, can be scheduled, and include rate cards (flex, priority, long-context). Usage events carry `reported_cost` and `reported_cache_cost`, and can be queried (`POST /v1/ai-cost-management/events/query`). 2.3 analytics also exposes `input_token_cost` and `output_token_cost`.

**What we do today.** Cost is an estimate: tokens times a beta per-token price fetched at sync. Cache prices and overrides are ignored. The "real cost" TODO is still open.

**The idea.** Honor the same precedence: target cost fields first, then overrides, then catalog, labelling which source a price came from. Add cache read/write pricing when the response usage includes cache tokens. A longer option is to read `reported_cost` from the usage events for runs we sent (see item 3 for how to find them).

**Why it matters.** Honest numbers on the thing the Evaluator ranks by, and it closes a TODO we have carried since 2026-10-09.

**Unknowns.** Whether target cost fields come back on the list call we already make. Which of the new price endpoints our token can read. Events only exist for successful requests and can arrive up to an hour late.

## 3. Attribution tags (`ai-cost-*`) on requests and Evaluator runs

**What Kong has.** Cost attribution tags are set by **request headers, no model configuration needed**: send `ai-cost-<key>: <value>` (for example `ai-cost-project: atlas`). Standard keys include `experiment`, `experiment-variant`, `use-case`, `feature`, `project`, `ticket`, `environment`, `ci-*`, and agent keys. Limits: 64 tags per event, key 1-128 chars, value 1-256 chars, no PII, duplicate headers drop the tag. Konnect has a Header builder (curl, HTTP headers, Claude Code, Codex, OpenCode, Gemini CLI). Prerequisites: attribution enabled per gateway, and data planes run with `KONG_CUSTOM_PLUGIN_STREAMING_ENABLED=on` (default on 2.x Dedicated Cloud Gateways; otherwise enabling shows a Conflict error). Budgets and analytics can filter and group by `tags.<key>`.

**What we do today.** Evaluation spend is indistinguishable from real traffic in Konnect.

**The idea.** Let the Model Evaluator (and optionally the testing project) stamp every request with `ai-cost-experiment`, `ai-cost-use-case: model-evaluation` and similar. A sync-time check could tell the user if attribution is off for the gateway.

**Why it matters.** Probably the cheapest high-value item: it is a header. It also gives us a way to find our own events later (item 2) and lets a team see what evaluation costs them.

**Unknowns.** Whether we can read the per-gateway attribution toggle through the API. Integrations and the org chart pages (unread) may add native header names we should match.

## 4. Auth and access hints on AI Gateway responses

**What Kong has.** Models, agents and MCP servers take an AI Auth Strategy (`key-auth` or `openid-connect`; a model can have one of each, and either passing is enough) and `access.acls` (allow/deny of consumers, groups, authenticated groups, or CEL `allow_when`/`deny_when`). Documented client behavior: attaching a strategy creates an anonymous consumer with request termination, so **no credential, a bad token, or an unmapped token all give `401 Unauthorized`**. key-auth defaults to the key name `apikey`, in a header or query (`config.key_names` overrides; body keys optional). openid-connect expects a bearer JWT (DPoP and mTLS variants exist). A CEL failure fails closed with 500; Konnect rejects bad CEL with 400. New in 2.3: the `access-policy-engine` plugin (Cedar policies, model calls as `CallModel`), principal groups usable in CEL and ACLs.

**What we do today.** The plugin bar already explains key-auth 401 and acl 403 for API Gateway requests (work item 12). The AI Gateway side shows policies but not auth. The judge request does not apply auth at all.

**The idea.** Read each synced model's `access` block and strategies. When a request returns 401 or 403, show the same one-line hint: which strategy, which key name or bearer, who is allowed. Pair with the "add the missing header" button from work item 12.

**Caveat.** The docs give **no body or headers for the 401**, and no documented 403 for authentication (403 is only documented for guard `stealth`/`verbose` modes). So hints would be driven by status plus config, like key-auth today, with the same "assumes the attached thing caused it" shortcut.

**Unknowns.** Whether the list call returns `access`. Whether virtual keys (item 16) change the header to send.

## 5. Policy insights on responses (guards, rate limits, sanitizer)

**What Kong has (client-visible behavior from the policy pages).**
- **AI Prompt Guard** (user-message regex): `rejection_mode` `none` gives **400** `{"error":{"message":...}}` (same status as a malformed request); `stealth` gives **403** "request forbidden"; `verbose` gives **403** with a structured body `{"type":"guardrail_rejected","plugin":"ai-prompt-guard","reason":...,"code":"GUARDRAIL_BLOCKED","detail":{"matched_pattern":...}}`. No response header says the policy ran. `continue_on_detection` lets the request through silently.
- **AI Lakera Guard:** same three modes (`verbose` names the plugin, reason like `prompt_attack`, and detectors). On a **streaming** block the HTTP status stays **200** and the last chunk carries `finish_reason: "blocked_by_guard"`. Its `none`-mode body differs from Prompt Guard's (`{"message":...,"error":true}`).
- **AI Rate Limiting Advanced:** **429** `{"message":"API rate limit exceeded for provider ..."}` plus `Retry-After`. Response headers `X-AI-RateLimit-Limit-<N>-<provider|policy>`, `X-AI-RateLimit-Remaining-<N>-...`, `X-AI-RateLimit-Reset`, `X-AI-RateLimit-Retry-After`, `X-AI-RateLimit-Query-Cost`, and the IETF `RateLimit-*` set. `hide_client_headers` removes some. Strategies include tokens and **cost**.
- **AI PII Sanitizer:** redacts and sends upstream; **nothing client-visible is documented** (no status, header or body), and it needs an external service.
- **Not detectable:** Semantic Cache hits (only a `cache_status` metric is documented), Prompt Decorator/Template/Compressor changes (the request is rewritten upstream).
- Only the most specific policy of a given type runs (consumer, then group, then model/agent/MCP, then global), one per type per entity, and policies run in a fixed priority order.

**What we do today.** The Policies tab lists attached policies by name. The header registry explains rate-limiting headers for API Gateway responses only.

**The idea.** Extend the registry: AI rate-limit headers get the same "19 left this minute" summary; a guard rejection becomes a plain sentence (and in `verbose` mode shows the matched pattern); the Lakera streaming `blocked_by_guard` case is flagged even though the status is 200. A hint can also note when a model's attached policies include a guard so a 400 is not mistaken for a bad request.

**Why it matters.** Answers "why did the gateway change or refuse my prompt" where the developer is looking. `verbose` bodies are unusually rich.

**Unknowns.** Most guard bodies are configurable by policy (`request_failure_message`), so detection leans on status plus attached-policy config. The Semantic Cache, Prompt Decorator and Template pages are unread; they may expose something.

## 6. Show which target answered (load balancer view)

**What Kong has.** Algorithms: round-robin (weighted), consistent-hashing, least-connections, lowest-usage (by tokens, cost, or an LLM accuracy score), lowest-latency, semantic, priority. `failover_criteria` and a circuit breaker (`max_fails`, `fail_timeout`; failures counted in total, not consecutive). 2.3 widens failover to `http_5xx` and many 4xx codes; only 429 and 5xx count toward the breaker. If every target is unhealthy, requests fail with 500.

**What we do today.** Rotating aliases show as "rotates between N models" and the summary splits by whichever model answered. We cannot say why.

**The idea.** Show algorithm, weights and failover rules next to a rotating model in the catalog. For `semantic`, show each target's description. In the Evaluator, label a row "may have failed over" when the answering model is not the highest-priority target.

**Caveat.** **No response header says which target answered or that failover happened.** The response's `model` field is the only client-side clue. A definitive answer would need the Debugger/Events (item 11).

**Unknowns.** Whether a failed-over request is visible in usage events (one event or several).

## 7. Sync AI MCP Servers into Insomnia

**What Kong has.** Five modes (passthrough-listener, conversion-listener, conversion-only, listener, upstream-server), per-tool ACLs (CEL in 2.3), rate limits per method or tool, upstream auth (Token Vault, AWS SigV4), OAuth protected-resource metadata. Protocol revisions 2025-03-26 to 2025-11-25 plus a stateless 2026-07-28. A separate **Catalog** MCP object can be created from a gateway MCP server (a snapshot, not a live sync; "connect to a running server" is listed as coming soon). The docs name Insomnia as an MCP client.

**What we do today.** Nothing. Sync pulls models only. (Debugging MCP-bundled servers was dropped on 2026-10-16; this is different: gateway-managed MCP servers as synced items.)

**The idea.** Sync lists MCP servers per gateway and creates an MCP request for each in the gateway project, with the route URL, plus a list of the tools the caller may use.

**Why it matters.** Same value as model sync. MCP traffic is API-level, so our LLM features (cost, judge, skills) do not apply and the scope stays small.

**Unknowns.** How Insomnia's MCP request authenticates against a server that needs OIDC or key-auth. How the route path is exposed in the list response.

## 8. Sync AI Agents (A2A) and a task view

**What Kong has.** Agents are an A2A proxy (`a2a`) or a plain HTTP proxy (`http`). It recognizes send/stream/get/cancel task operations (REST and JSON-RPC bindings), rewrites the Agent Card URL to the gateway, and records task id, state and streaming stats. A2A requests must use the JSON-RPC envelope.

**What we do today.** Nothing; the chat window assumes chat-completion shapes.

**The idea.** Sync agents like models. Starter A2A request with the envelope pre-filled, an Agent Card view, and task state/artifacts rendered instead of raw JSON.

**Why it matters.** Agents are one of the four headline entities and nothing in Insomnia understands them yet.

**Unknowns.** How many of our users have agents behind the gateway. Which binding is common. Whether the SSE viewer handles A2A streams unchanged.

## 9. Routing beyond a body `model` value

**What Kong has.** `config.route.model` can read the alias from `body_param`, `header_param` or `path_param`. Target names and per-target config can use `$(headers.x)`, `$(uri_captures.x)`, `$(query_params.x)`.

**What we do today.** We assume the alias is the body `model` (picker, Evaluator override, the 503 "no model" note).

**The idea.** Read which kind a model uses and apply the alias in the right place when retargeting. Note templated targets.

**Why it matters.** Correctness on gateways configured differently from our test one.

**Unknowns.** How common header and path routing are. Whether the list call returns `config.route.model`.

## 10. Your usage and your budget, inside Insomnia

**What Kong has.** **My Usage** is available to every role (Individual User, Team Manager, Admin) and appears after your first request. Dashboard and Explorer are for managers and admins. Budgets (admin-created, alert-only: `posture` is `advisory`, enforcement is documented as not implemented) have `consumed`, `remaining` and `projected` balances and Email/Slack alerts. A usage-events query API exists (max 2 dimensions). Only successful requests create events. Roles: Org Admin, Team Manager (their team), Individual User (their own usage).

**What we do today.** Future idea #3 is written down, not built. Analytics `cost` was 0 on our test gateway.

**The idea.** A small panel in the gateway project: your spend this month by model and, if a budget covers you, how close you are. Pulled from the usage-events API with the user's own role.

**Why it matters.** The cost story for the person, not just one test run, and it turns the real-cost TODO into a feature. Per-person attribution now has a defined path (principal, consumer, or OIDC `sub`).

**Unknowns.** Whether our token can call the cost endpoints and what an Individual User sees. Budget alerts do not block, so the panel would be informational only.

## 11. Debugger / event link for AI Gateway requests

**What Kong has.** Debug sessions accept `ai_gateway_id` as well as `control_plane_id` (checked via the MCP, 2026-10-16). 2.3 raises the Konnect debugger body capture from 128KB to 1MB. An admin-only Events debugger shows individual usage events (provenance includes `request_id`, `route_id`, `plugin_name`). Gen AI and A2A OpenTelemetry spans exist for self-hosted tracing.

**What we do today.** The Debugger tab is a no-op for AI Gateway and prompts projects. Future idea #2.

**The idea.** Turn the Debugger on for AI Gateway requests, or as a first step a "View this request in Konnect" link.

**Why it matters.** The only likely route to a definitive answer for items 6 and 5's undetectable cases.

**Unknowns.** Whether `o11y/debug-sessions` takes a gateway id and what traces show for model selection. The Events debugger is admin-only, so many users could not follow a link.

## 12. Relate our Judge to the gateway's LLM-as-Judge policy

**What Kong has.** `ai-llm-as-judge` is a policy that "scores prompt-response pairs" at the gateway. `lowest-usage` balancing can also use an LLM-accuracy score. The page for the policy is unread.

**What we do today.** `insomnia.judge()` runs a second model in an after-response script, with criteria scored 0, 0.5 or 1.

**The idea.** Find out what the policy produces and where it is reported. If it records scores in analytics or logs, show them next to our judge results, or make our judge's criteria shape compatible. Otherwise note it as complementary.

**Why it matters.** Avoid building a parallel concept the platform already has.

**Unknowns.** Everything; read the policy page first.

## 13. Streaming-mode awareness (`response_streaming`)

**What Kong has.** Model `config.response_streaming` is `allow` (default), `deny` (callers cannot set `stream: true`) or `always`. Policies that run in the response phase are not supported with streaming, and the AI Response Transformer does not work with streaming. Usage in streams needs `stream_options.include_usage` (we already handle this).

**What we do today.** Our whole chat window is streaming-first, and the Evaluator forces `stream: false`.

**The idea.** If a model denies streaming, say so when Connect fails, and offer the non-stream path. If it is `always`, note that `stream: false` may be ignored. Mention that response-phase policies will not apply to a streaming chat.

**Why it matters.** Explains an otherwise mysterious failure in the main feature we built.

**Unknowns.** What status and body a denied stream returns.

## 14. Token Vault enrollment prompt

**What Kong has.** Token Vault lets the gateway call upstream services with a user's own credentials. For an unenrolled caller the gateway returns an **enrollment URL, valid 10 minutes**, that opens the provider's OAuth consent; once per user per provider. Providers include GitHub, Slack, Atlassian, Google and others. MCP servers use it for outbound auth; model providers can too (2.3).

**The idea.** When a response carries an enrollment URL, show a "Connect your account" button, the same pattern as the CORS "Create OPTIONS request" action.

**Why it matters.** Otherwise the developer sees a confusing tool result or error body.

**Unknowns.** The docs do not give the status code, body or headers for the not-enrolled case, so detection is guesswork until we see one live.

## 15. "Request access" shortcut

**What Kong has.** Konnect's AI Management lets Team Managers and Individual Users "Request a model / MCP server / agent" and "Request access" (reason required) from the resource page; an Org Admin approves. No API for requests is described.

**The idea.** When sync finds nothing, or a call is denied, say why and deep-link to the Konnect page to request access.

**Why it matters.** Matches our persona (enterprise users with limited say over models); today it is a dead end.

**Unknowns.** Whether the page has a stable deep link. Approval delivery is not described.

## 16. Get an LLM key from inside Insomnia

**What Kong has.** Virtual keys (AI Gateway can generate the value, shown once, or accept your own; expiry 30 days, 90 days, 1 year or never; no rotation) with a named holder user. Per the roles page, **all three roles can create keys** for themselves, and an Individual User sees only their own. Requests with a personal key are attributed to its holder, and that user's spend limits apply. Identity providers (Okta, Auth0) back sign-in.

**The idea.** After connecting Konnect, let a developer create a virtual key and have it land in the environment. Closer to real than when future idea #4 was written.

**Why it matters.** Removes the biggest first-use obstacle for developers without Konnect access.

**Unknowns.** **The docs do not name the header a virtual key goes in**, and no key-creation API call is shown. Konnect-by-OAuth is still the prerequisite. Long term.

## 17. MCP protocol and error-code explainers

**What Kong has.** Unsupported revision gives HTTP 400 and JSON-RPC `-32022` (lists served revisions); MCP rate limiting gives 429 and `-32023`. The stateless 2026-07-28 revision drops `initialize` and `Mcp-Session-Id`; `server/discover` replaces `initialize`; `Mcp-Method` and `Mcp-Name` headers must match the body.

**The idea.** Explain those codes in the response viewer. Only meaningful if item 7 exists.

**Unknowns.** Depends on item 7.

## 18. Async API models (batches) for large evaluations

**What Kong has.** `type: api` models expose batches, files and skills (skills are native passthrough to OpenAI or Anthropic).

**The idea.** Run a big Evaluator job through a batches endpoint, which providers usually discount, for runs over our 20-run confirmation threshold.

**Why it matters.** Cheaper large comparisons. **Speculative:** nothing read says a batches route is commonly set up, and Insomnia would need polling and result retrieval.

**Unknowns.** Almost everything. Lowest priority to research.

## 19. Gateway runtime-version awareness

**What Kong has.** Features are version-gated (2.0 entities, 2.1 cost lists and `condition`, 2.2 CEL ACLs and passthrough/typesafe formats, 2.3 Token Vault, `expressions`, attribution, budgets and more). 2.3 also lets control and data planes run different patch releases within a minor.

**The idea.** Read the data plane version and warn when a feature we show is not available.

**Why it matters.** Avoids confusing "field missing" cases on older gateways.

**Unknowns.** Where the version is exposed. Low value on its own; only worth it if other items need it.

## 20. Visual view of what a single request hits

**What Kong has.** The same data that would power #11: debug-session traces (which accept an AI gateway id), usage events (provenance includes `route_id`, `plugin_name`, provider and model), and Gen AI / A2A spans for self-hosted tracing. A request can pass through an auth strategy, one or more policies in a fixed priority order, a model, a load balancer, a target and a provider.

**What we do today.** Nothing visual. This is future idea #1 in `3593AI.md` (a traffic visualization, inspired by the debugger in the AI management vision prototype, which Claude cannot open; Cam to share screenshots when we pick it up).

**The idea.** A picture, not a trace table, of one request's path: which model and target answered, which policies fired, which provider it reached, and for MCP or agents which servers and agents were hit. Think of it as a "VISUAL debugger for AI", sitting next to #11.

**Why it matters.** Makes the gateway's behavior legible at a glance and is the natural home for #5 (policy outcomes) and #6 (which target answered), which have no client-side signal today.

**Dependency.** Relies on the same data as #11, so it is blocked on the same open question: whether `o11y/debug-sessions` accepts a gateway id and what the traces hold for model and provider selection. Also depends on the Debugger's unresolved waterfall-paint bug on branch 3593. Bucket: **want, not v1**, together with #11.

**Unknowns.** What the vision prototype shows (not visible to Claude); whether the trace contains enough to draw model, policy and provider hops; MCP and agent hops depend on the #7/#8 decisions.

---

## Not on the list on purpose

- **Semantic Cache, Prompt Decorator, Prompt Template, RAG Injector, Prompt Compressor:** they exist as policies, but a client sees no documented signal of any of them running. Showing them would need the Debugger (item 11). Revisit after reading their pages.
- **Konnect Metering & Billing:** still skipped (it is for charging customers).
- **Mirroring the Evaluator in `inso`:** already a known gap in the shortcuts table, not new.
- **Observability dashboards, Explorer and Logs:** Konnect already does these well; we would link, not rebuild.

## Suggested next step

(The concrete carry-forward checks are listed under "Agreed grouping" at the top.) Most "unknowns" now need a live gateway rather than more reading. A short spike on our test gateway would settle several at once: the Konnect AI Gateway list response fields (items 1, 2, 4, 9), whether target cost fields and `access` come back, and what a guard rejection or an unenrolled Token Vault call really returns (items 5, 14).

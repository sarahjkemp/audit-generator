# Comms Opportunity Radar integration

Only the existing company AI perception engine is reused. The visibility/Semrush,
Scriptwriter rewrite and person-legibility routes are unchanged. Calls through
`/radar/company-audit` disable the legacy destructive replacement routine, then
save the signed result through the append-only, read-back-verified OS store.

## Activation

1. After owner approval, commit/push `server.js`, `radar-integration.js` and its test
   to the existing `sarahjkemp/audit-generator` repository.
2. Add the same cryptographically random, 32+ character `RADAR_INTEGRATION_TOKEN`
   as an environment secret to the existing Render audit service and the existing
   private Sites radar. Never commit the token or put it in browser code.
3. Wait for Render to deploy the changed repository. A bearer-authenticated
   `GET /radar/health` must return `ready: true` and both feature names.
4. Publish the radar to its existing owner-private Site. Check the connection,
   then verify one live company perception audit and pitch end-to-end.

Render retains all existing AI provider keys and billing. The radar does not need
copies of those keys. New routes reject missing/incorrect connection credentials.
An audit result is signed before the browser receives it; pitch generation rejects
altered results, inaccessible ground truth, mismatched company identities and
audits with no complete platform. AI errors do not become low business scores.
Generated drafts require an exact audit evidence excerpt and are limited to five
sentences and 120 words; overlong output is rewritten once, not blindly truncated.

The saver targets the existing Supabase `audit_reports` and `signals` tables.
The report's hidden markdown footer preserves the complete signed snapshot for
cross-device loading. **Activation blocker confirmed 2026-09-16:** the existing
`audit_reports_entity_date` unique constraint rejects a second company report on
the same day. Do not remove/delete existing reports to bypass it. Database-admin
access is still needed to resolve this safely and verify durable live storage.
The radar returns `OS_DAILY_REPORT_LIMIT`, not a false saved receipt.
Scores use stable
per-audit IDs and question keys, never response array positions. Only readable
website benchmarks and fully tested platforms produce scored signal rows;
unavailable/untested answers and null scores remain in the archived snapshot.
Both report and signal contents are read back before a saved receipt is returned.
Failed/partial saves preserve the paid result and can resume without another AI
call. Existing signals/reports are never deleted or overwritten. Older v1 device
copies cannot be securely backfilled because their signatures did not cover scores
or raw answers; those require one rerun. Existing OS records remain unchanged.
Editable outreach drafts remain device-local, as do temporary unsaved audit copies,
without changing existing notes/contact statuses.
The dashboard never sends LinkedIn messages automatically.

## Budget company-model profile — checked 2026-09-16

`company-perception.js` is the single source of truth for company perception and
radar pitch models. OpenAI uses `gpt-5.6-luna` with reasoning effort set to `none`,
live web search required, low search context, one tool call and a 700-token answer
ceiling. Google uses the lower-priced stable `gemini-3.1-flash-lite`, minimal
thinking, Google Search grounding and a 700-token answer ceiling. The cheaper
2.5 Flash-Lite was rejected by the live key as unavailable to new users; 3.1
Flash-Lite remains documented as supported, cheaper than 3.5 Flash-Lite. Claude uses
`claude-haiku-4-5-20251001`, basic web search, at most one search per buyer question
and a 700-token answer ceiling. Sonar retains low search context and a 500-token
ceiling. Six buyer questions remain independent on each platform; batching them
into a single prompt would change the audit methodology.

Company-only requests have explicit timeouts and disable hidden SDK retries;
Claude can retry one overload response, and an invalid pitch can be rewritten
once. No paid query is silently rerun when it produces an inconclusive answer.
Live checks on 2026-09-16 verified grounded OpenAI, Haiku and Sonar answers.
Gemini's active key still returns depleted prepaid credits despite the reported
top-up; its grounded completion is pending a positive balance on that key's project.

Haiku replaces Opus as company report writer and Sonnet as radar pitch writer.
There is no premium fallback. New reports identify the tested API models; they do
not claim to reproduce the consumer ChatGPT/Gemini/Claude apps. Grounding failures
and truncated responses are untested, not business weaknesses. The shared legacy
person lookup, visibility/Semrush and rewrite defaults have not been changed.

Official sources:
- https://developers.openai.com/api/docs/models/gpt-5.6-luna
- https://developers.openai.com/api/docs/guides/tools-web-search
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/deprecations
- https://platform.claude.com/docs/en/about-claude/pricing
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- https://docs.perplexity.ai/docs/getting-started/pricing

Token list prices are not the complete bill: provider search fees and retrieved
search-result tokens also apply. Do not promise a fixed per-audit cost.

## Checks

`node --check server.js`

`node --test radar-integration.test.js`

`node --test radar-os-store.test.js`

`node --test company-perception.test.js`

The radar's existing build and rendered-worker tests cover its fixed-destination
server proxy, published company identity, private-note exclusion, cross-origin
rejection and independent five-sentence enforcement. Those tests use stubs, not
billable provider calls. Live activation remains a separate verification step.

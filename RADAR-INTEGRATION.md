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

Audits are durable in the existing Supabase `audit_reports` and `signals` tables.
The report's hidden markdown footer preserves the complete signed snapshot for
cross-device loading without a new database or schema change. Scores use stable
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

## Checks

`node --check server.js`

`node --test radar-integration.test.js`

`node --test radar-os-store.test.js`

The radar's existing build and rendered-worker tests cover its fixed-destination
server proxy, published company identity, private-note exclusion, cross-origin
rejection and independent five-sentence enforcement. Those tests use stubs, not
billable provider calls. Live activation remains a separate verification step.

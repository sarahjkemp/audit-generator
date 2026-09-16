const assert = require('node:assert/strict');
const test = require('node:test');
const { registerRadarRoutes, publicWebsite, fetchPublicPage, normalizeAudit, validatePitch, signature } = require('./radar-integration');

test('website and redirects must stay on public HTTPS hosts', async () => {
  for (const value of ['http://example.com', 'https://127.0.0.1', 'https://host.internal', 'https://user:pass@example.com', 'https://example.com:8443']) {
    assert.throws(() => publicWebsite(value));
  }
  assert.equal(publicWebsite('example.com'), 'https://example.com/');
  const privatePage = await fetchPublicPage('https://example.com', 6000, {
    lookup: async () => [{ address: '10.0.0.1' }], fetch: () => { throw new Error('Must not fetch private IP'); },
  });
  assert.equal(privatePage.accessible, false);
  const redirect = await fetchPublicPage('https://example.com', 6000, {
    lookup: async () => [{ address: '8.8.8.8' }],
    fetch: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }),
  });
  assert.equal(redirect.accessible, false);
});

function response() { return { code: 200, headersSent: false, status(s) { this.code = s; return this; },
  set() {}, json(body) { this.body = body; this.headersSent = true; return this; } }; }
function auditData() { return { report: 'The website is clear and the AI answers capture the main customer problem accurately.', benchmarkAccessible: true,
  rawResponses: Object.fromEntries(['chatgpt', 'claude', 'gemini', 'perplexity'].map(p => [p, Object.fromEntries(Array.from({ length: 6 }, (_, i) => [i, 'An actual answer']))])),
  scores: { openai: { Clarity: 4 }, claude: { Clarity: 4 }, gemini: { Clarity: 4 }, perplexity: { Clarity: 4 } } }; }

test('unavailable platforms are untested, not low-scoring businesses', () => {
  const data = auditData(); data.rawResponses.gemini = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [i, '[Error: platform down]']));
  const audit = normalizeAudit(data, 'Example', 'https://example.com/', 'a'.repeat(64));
  assert.equal(audit.platformStatus.gemini, 'unavailable');
  assert.equal(audit.scores.gemini.Clarity, null);
  assert.equal(audit.scores.openai.Clarity, 4);
  assert.equal(signature(audit, 'a'.repeat(64)), audit.signature);
});

test('pitch validation requires literal audit evidence and enforces five sentences', () => {
  const report = auditData().report;
  const valid = validatePitch({ sentences: ['I noticed your Series B raise.', 'The audit captured your customer problem accurately.', 'Would you like me to share the findings?'], evidenceQuote: 'AI answers capture the main customer problem accurately' }, report);
  assert.equal(valid.sentenceCount, 3);
  assert.throws(() => validatePitch({ sentences: ['One. Two. Three. Four. Five. Six.'], evidenceQuote: report }, report));
  assert.throws(() => validatePitch({ sentences: ['A short draft.'], evidenceQuote: 'An invented weakness.' }, report));
});

test('radar is authenticated, never files to OS, and rejects a tampered audit', async () => {
  const previous = process.env.RADAR_INTEGRATION_TOKEN;
  process.env.RADAR_INTEGRATION_TOKEN = 'a'.repeat(64);
  try {
    const routes = {}, middleware = [];
    registerRadarRoutes({ app: { use(_p, f) { middleware.push(f); }, get(p, f) { routes[p] = f; }, post(p, f) { routes[p] = f; } },
      runCompanyAudit: async (req, res, options) => {
        assert.equal(options.fileToOS, false); assert.equal(options.radarMode, true); assert.equal(req.body.notes, '');
        return res.json(auditData());
      }, client: { messages: { create() { throw new Error('No live AI call in tests'); } } }, withRetry: f => f() });
    const unauthorized = response(); middleware[0]({ get: () => 'Bearer wrong' }, unauthorized, () => assert.fail('Must not authorize'));
    assert.equal(unauthorized.code, 401);
    const auditResponse = response();
    await routes['/radar/company-audit']({ body: { companyName: 'Example', website: 'https://example.com/', notes: 'Private note must not be sent' } }, auditResponse);
    assert.equal(auditResponse.code, 200); assert.equal(auditResponse.body.companyName, 'Example');
    const tampered = { ...auditResponse.body, report: 'Invented report' };
    const pitchResponse = response();
    await routes['/radar/linkedin-pitch']({ body: { audit: tampered, prospect: { company: 'Example', source: 'https://example.com/news' } } }, pitchResponse);
    assert.equal(pitchResponse.code, 400);
  } finally { if (previous === undefined) delete process.env.RADAR_INTEGRATION_TOKEN; else process.env.RADAR_INTEGRATION_TOKEN = previous; }
});

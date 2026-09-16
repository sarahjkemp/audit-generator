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

test('radar saves through the verified store, never uses destructive filing, and rejects tampering', async () => {
  const previous = process.env.RADAR_INTEGRATION_TOKEN;
  process.env.RADAR_INTEGRATION_TOKEN = 'a'.repeat(64);
  try {
    const routes = {}, middleware = [];
    registerRadarRoutes({ app: { use(_p, f) { middleware.push(f); }, get(p, f) { routes[p] = f; }, post(p, f) { routes[p] = f; } },
      runCompanyAudit: async (req, res, options) => {
        assert.equal(options.fileToOS, false); assert.equal(options.radarMode, true); assert.equal(req.body.notes, '');
        return res.json(auditData());
      }, osStore: { save: async audit => ({ status: 'saved', auditId: audit.auditId, signalsSaved: 4 }), latest: async()=>null },
      client: { messages: { create() { throw new Error('No live AI call in tests'); } } }, withRetry: f => f() });
    const unauthorized = response(); middleware[0]({ get: () => 'Bearer wrong' }, unauthorized, () => assert.fail('Must not authorize'));
    assert.equal(unauthorized.code, 401);
    const auditResponse = response();
    await routes['/radar/company-audit']({ body: { companyName: 'Example', website: 'https://example.com/', notes: 'Private note must not be sent' } }, auditResponse);
    assert.equal(auditResponse.code, 200); assert.equal(auditResponse.body.companyName, 'Example');
    assert.equal(auditResponse.body.persistence.status, 'saved');
    const badScores = { ...auditResponse.body, scores: { openai: { Clarity: 1 } } };
    const saveResponse = response();
    await routes['/radar/save-audit']({ body: { audit: badScores } }, saveResponse);
    assert.equal(saveResponse.code, 400);
    const tampered = { ...auditResponse.body, report: 'Invented report' };
    const pitchResponse = response();
    await routes['/radar/linkedin-pitch']({ body: { audit: tampered, prospect: { company: 'Example', source: 'https://example.com/news' } } }, pitchResponse);
    assert.equal(pitchResponse.code, 400);
  } finally { if (previous === undefined) delete process.env.RADAR_INTEGRATION_TOKEN; else process.env.RADAR_INTEGRATION_TOKEN = previous; }
});

test('a database failure preserves the paid audit and retry does not call AI again', async () => {
  process.env.RADAR_INTEGRATION_TOKEN = 'a'.repeat(64);
  const routes = {}; let aiCalls = 0, saveCalls = 0;
  registerRadarRoutes({ app: { use() {}, get(p,f){routes[p]=f;}, post(p,f){routes[p]=f;} },
    runCompanyAudit: async (_req,res)=>{ aiCalls++; res.json(auditData()); },
    osStore: { async save(){ if (++saveCalls === 1) throw new Error('DB down'); return { status:'saved' }; }, latest:async()=>null },
    client:{}, withRetry:f=>f() });
  const first = response();
  await routes['/radar/company-audit']({ body:{companyName:'Example',website:'https://example.com/'} }, first);
  assert.equal(first.code,200); assert.equal(first.body.persistence.status,'failed'); assert.ok(first.body.report);
  const retry = response();
  await routes['/radar/save-audit']({ body:{audit:first.body} }, retry);
  assert.equal(retry.body.persistence.status,'saved'); assert.equal(aiCalls,1);
});

test('the budget pitch maps evidence indices to real report excerpts and rejects invalid indices',async()=>{
  const previous=process.env.RADAR_INTEGRATION_TOKEN;
  process.env.RADAR_INTEGRATION_TOKEN='b'.repeat(64);
  try{
    const routes={};let index=0;
    registerRadarRoutes({app:{use(){},get(p,f){routes[p]=f;},post(p,f){routes[p]=f;}},runCompanyAudit(){},osStore:{},withRetry:f=>f(),
      client:{messages:{create:async body=>{
        assert.equal(body.model,'claude-haiku-4-5-20251001');assert(body.messages[0].content.includes('Exactly THREE sentences'));
        return{stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({sentences:['I noticed your Series B raise.','The dated audit captured your customer problem accurately.','Would it help if I shared the findings?'],evidenceIndex:index})}]};
      }}}});
    const audit=normalizeAudit(auditData(),'Example','https://example.com/',process.env.RADAR_INTEGRATION_TOKEN);
    const req={body:{audit,prospect:{company:'Example',source:'https://example.com/news'}}};
    const valid=response();await routes['/radar/linkedin-pitch'](req,valid);
    assert.equal(valid.code,200);assert.equal(valid.body.sentenceCount,3);assert.equal(valid.body.evidenceQuote,audit.report);
    index=10000;const invalid=response();await routes['/radar/linkedin-pitch'](req,invalid);assert.equal(invalid.code,502);
  }finally{if(previous===undefined)delete process.env.RADAR_INTEGRATION_TOKEN;else process.env.RADAR_INTEGRATION_TOKEN=previous;}
});

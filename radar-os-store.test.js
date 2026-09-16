const assert = require('node:assert/strict');
const test = require('node:test');
const { createOSStore, signalRows, reportText, parseReport } = require('./radar-os-store');
const { normalizeAudit } = require('./radar-integration');
const dimensions = ['Clarity','Accuracy','Differentiation','Customer pain point','Proof / credibility','Category fit'];
const keys = ['what_they_do','who_for','problem','differentiation','credibility','alternatives'];
function fixture() {
  return normalizeAudit({ report:'A complete dated report.', benchmarkAccessible:true,
    rawResponses:Object.fromEntries(['chatgpt','claude','gemini','perplexity'].map(p=>[p,Object.fromEntries(keys.map(k=>[k,`${p}: ${k}`]))])),
    scores:Object.fromEntries(['openai','claude','gemini','perplexity'].map(p=>[p,Object.fromEntries(dimensions.map(d=>[d,4]))])) },
    'Example','https://example.com/','a'.repeat(64));
}
function database() {
  const tables = { entities:[{id:'entity-1',name:'Example'}], audit_reports:[{id:'earlier-report',entity_id:'entity-1',report_text:'Existing report',created_at:'2026-08-01'}], signals:[{id:'earlier-signal',score:5}] };
  const calls = []; let failSignals = false, hideSignal = false;
  return { tables, calls, failSignals(value){failSignals=value;}, hideSignal(value){hideSignal=value;},
    async fetch(url,init) {
      const parsed = new URL(url), table=parsed.pathname.split('/').at(-1), q=parsed.searchParams;
      calls.push({table,method:init.method,body:init.body});
      assert.equal(init.headers.Authorization,undefined,'publishable keys must not be sent as JWT Bearer credentials');
      if (table === 'signals' && init.method === 'POST' && failSignals) return Response.json({error:'Unavailable'},{status:503});
      if (init.method === 'POST') {
        const body = JSON.parse(init.body), values=Array.isArray(body)?body:[body], result=[];
        for(const value of values) {
          if (!tables[table].some(r=>r.id===value.id)) { tables[table].push({...value,created_at:new Date().toISOString()});result.push(value); }
        }
        return Response.json(result);
      }
      assert.equal(init.method,'GET','must never delete or overwrite OS history');
      let rows=tables[table];
      for(const field of ['id','name','entity_id']) if(q.has(field)) {
        const match=q.get(field);
        rows=rows.filter(r=>match.startsWith('eq.')?r[field]===match.slice(3):match.slice(4,-1).split(',').includes(r[field]));
      }
      if(q.has('report_text')) rows=rows.filter(r=>r.report_text.includes('<!-- comms-radar-v2:'));
      if(table==='signals' && hideSignal) rows=rows.slice(1);
      return Response.json(rows);
    } };
}
test('correctly links OpenAI answers and research dimensions using keys, not array positions',()=>{
  const audit=fixture(), rows=signalRows(audit,'entity-1');
  assert.equal(rows.length,24);
  assert.equal(rows.find(r=>r.platform==='openai'&&r.category==='Differentiation').raw_answer,'chatgpt: differentiation');
  assert.equal(rows.find(r=>r.platform==='anthropic'&&r.category==='Customer pain point').raw_answer,'claude: problem');
  audit.platformStatus.gemini='unavailable';
  assert.equal(signalRows(audit,'entity-1').length,18);
  assert.deepEqual(parseReport(reportText(audit)),audit);
});
test('saves report and every score, reads them back, retains history, and deduplicates retries',async()=>{
  const db=database(), store=createOSStore({url:'https://db.supabase.co',key:'sb_publishable_test',fetch:db.fetch}), audit=fixture();
  const receipt=await store.save(audit);
  assert.equal(receipt.status,'saved');assert.equal(receipt.signalsSaved,24);
  await store.save(audit);
  assert.equal(db.tables.audit_reports.length,2);assert.equal(db.tables.signals.length,25);
  assert.equal(db.tables.audit_reports[0].report_text,'Existing report');
  assert.equal(db.tables.signals[0].score,5);
  const loaded=await store.latest('Example');
  assert.equal(loaded.auditId,audit.auditId);assert.equal(loaded.report,audit.report);assert.equal(loaded.persistence.status,'saved');
});
test('a partial database write is never reported as complete and can be resumed',async()=>{
  const db=database(),store=createOSStore({url:'https://db.supabase.co',key:'sb_publishable_test',fetch:db.fetch}),audit=fixture();
  db.failSignals(true); await assert.rejects(()=>store.save(audit));
  assert.equal(db.tables.audit_reports.length,2);assert.equal(db.tables.signals.length,1);
  assert.equal((await store.latest('Example')).persistence.status,'failed');
  db.failSignals(false);assert.equal((await store.save(audit)).status,'saved');
  db.hideSignal(true);assert.equal((await store.latest('Example')).persistence.status,'failed');
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { createOSStore, signalRows, reportText, parseReport } = require('./radar-os-store');
const { normalizeAudit, signature } = require('./radar-integration');
const dimensions = ['Clarity','Accuracy','Differentiation','Customer pain point','Proof / credibility','Category fit'];
const keys = ['what_they_do','who_for','problem','differentiation','credibility','alternatives'];
function fixture(completedAt) {
  const audit=normalizeAudit({ report:'A complete dated report.', benchmarkAccessible:true,
    rawResponses:Object.fromEntries(['chatgpt','claude','gemini','perplexity'].map(p=>[p,Object.fromEntries(keys.map(k=>[k,`${p}: ${k}`]))])),
    scores:Object.fromEntries(['openai','claude','gemini','perplexity'].map(p=>[p,Object.fromEntries(dimensions.map(d=>[d,4]))])) },
    'Example','https://example.com/','a'.repeat(64));
  if(completedAt){audit.completedAt=completedAt;audit.signature=signature(audit,'a'.repeat(64));}
  return audit;
}
function database() {
  const tables = { entities:[{id:'entity-1',name:'Example'}], audit_reports:[{id:'earlier-report',entity_id:'entity-1',report_date:'2026-08-01',report_text:'Existing report',created_at:'2026-08-01'}], signals:[{id:'earlier-signal',score:5}] };
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
          if(table==='audit_reports' && tables[table].some(r=>r.entity_id===value.entity_id&&r.report_date===value.report_date&&r.id!==value.id))
            return Response.json({code:'23505',message:'duplicate key value violates unique constraint "audit_reports_entity_date"'},{status:409});
          if (!tables[table].some(r=>r.id===value.id)) { tables[table].push({...value,created_at:new Date().toISOString()});result.push(value); }
        }
        return Response.json(result);
      }
      if(init.method==='PATCH'){
        assert.equal(table,'audit_reports');assert(q.get('id')?.startsWith('eq.'));assert(q.get('entity_id')?.startsWith('eq.'));
        const row=tables[table].find(r=>r.id===q.get('id').slice(3)&&r.entity_id===q.get('entity_id').slice(3));
        const body=JSON.parse(init.body);assert.equal(body.id,undefined,'preserve the report primary key');
        if(row)Object.assign(row,body);
        return Response.json(row?[row]:[]);
      }
      assert.equal(init.method,'GET','must never delete OS records');
      let rows=tables[table];
      for(const field of ['id','name','entity_id','report_date']) if(q.has(field)) {
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
test('a same-day company perception report is refreshed without a second report or schema change',async()=>{
  const db=database(), audit=fixture();
  Object.assign(db.tables.audit_reports[0],{report_date:audit.completedAt.slice(0,10),report_text:'## Example AI Perception Audit\nExisting company audit'});
  const store=createOSStore({url:'https://db.supabase.co',key:'sb_publishable_test',fetch:db.fetch});
  const receipt=await store.save(audit);
  assert.equal(receipt.status,'saved');assert.equal(receipt.reportId,'earlier-report');assert.equal(db.tables.audit_reports.length,1);
  assert.equal(db.tables.audit_reports[0].report_text,reportText(audit));assert.equal(db.tables.audit_reports[0].id,'earlier-report');
  assert.equal((await store.latest('Example')).auditId,audit.auditId);assert.equal(db.tables.signals[0].score,5);
  assert(!db.calls.some(c=>c.table==='audit_reports'&&c.method==='POST'));
});
test('reruns across days use one current report, and an older draft cannot replace it',async()=>{
  const db=database(),store=createOSStore({url:'https://db.supabase.co',key:'sb_publishable_test',fetch:db.fetch});
  const first=fixture('2026-09-15T10:00:00.000Z'),second=fixture('2026-09-16T11:00:00.000Z');
  const [a,b]=await Promise.all([store.save(first),store.save(second)]);
  assert.equal(a.reportId,b.reportId);assert.equal(db.tables.audit_reports.length,2);
  assert.equal(db.tables.audit_reports[0].report_text,'Existing report');assert.equal(db.tables.signals[0].score,5);
  assert.equal((await store.latest('Example')).auditId,second.auditId);
  const writes=db.calls.filter(c=>c.method!=='GET').length;
  await assert.rejects(()=>store.save(first),error=>error.code==='OS_AUDIT_SUPERSEDED');
  assert.equal(db.calls.filter(c=>c.method!=='GET').length,writes);
  await store.save(second);assert.equal(db.tables.audit_reports.length,2);assert.equal(db.tables.signals.length,49);
});
test('a different audit section occupying the same company/date is left untouched',async()=>{
  const db=database(),audit=fixture();
  Object.assign(db.tables.audit_reports[0],{report_date:audit.completedAt.slice(0,10),report_text:'Existing website audit'});
  const store=createOSStore({url:'https://db.supabase.co',key:'sb_publishable_test',fetch:db.fetch});
  await assert.rejects(()=>store.save(audit),error=>error.code==='OS_REPORT_COLLISION');
  assert.equal(db.tables.audit_reports[0].report_text,'Existing website audit');assert.equal(db.tables.signals.length,1);
});

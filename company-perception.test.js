const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { MODELS, MODEL_SUMMARY, queryCompanyPlatform, createCompanyLookup } = require('./company-perception');

test('company lookup uses the budget profile, live search and bounded spend', async()=>{
  const requests = [], metrics = [];
  const deps = { query:'What does Example do?', withRetry:fn=>fn(), geminiKey:'private-test-key', onUsage:m=>metrics.push(m),
    openaiClient:{responses:{create:async body=>{requests.push({platform:'chatgpt',body});return{model:body.model,status:'completed',output:[{type:'web_search_call',status:'completed'}],output_text:'A cited OpenAI answer.'};}}},
    perplexityClient:{chat:{completions:{create:async body=>{requests.push({platform:'perplexity',body});return{model:body.model,choices:[{finish_reason:'stop',message:{content:'A cited Sonar answer.'}}]};}}}},
    client:{messages:{create:async body=>{requests.push({platform:'claude',body});return{model:body.model,stop_reason:'end_turn',content:[{type:'web_search_tool_result',content:[{type:'web_search_result'}]},{type:'text',text:'A cited Claude answer.'}]};}}},
    fetch:async(url,init)=>{requests.push({platform:'gemini',url,headers:init.headers,body:JSON.parse(init.body)});return Response.json({modelVersion:MODELS.gemini,candidates:[{finishReason:'STOP',groundingMetadata:{webSearchQueries:['Example company']},content:{parts:[{text:'A cited Gemini answer.'}]}}]});},
  };
  for(const platform of ['chatgpt','gemini','claude','perplexity']) assert(!/^\[/.test(await queryCompanyPlatform({...deps,platform})));
  const oa=requests.find(r=>r.platform==='chatgpt').body;
  assert.equal(oa.model,'gpt-5.6-luna');assert.equal(oa.reasoning.effort,'none');assert.equal(oa.max_tool_calls,1);assert.equal(oa.tools[0].external_web_access,true);assert.equal(oa.tool_choice,'required');assert.equal(oa.store,false);
  const gem=requests.find(r=>r.platform==='gemini');assert(gem.url.includes('gemini-3.1-flash-lite'));assert(!gem.url.includes('private-test-key'));assert.equal(gem.headers['x-goog-api-key'],'private-test-key');assert.deepEqual(gem.body.tools,[{google_search:{}}]);assert.equal(gem.body.generationConfig.thinkingConfig.thinkingLevel,'MINIMAL');
  const cl=requests.find(r=>r.platform==='claude').body;assert.equal(cl.model,MODELS.claude);assert.equal(cl.tools[0].max_uses,1);assert.equal(cl.tool_choice.name,'web_search');
  const pp=requests.find(r=>r.platform==='perplexity').body;assert.equal(pp.model,'sonar');assert.equal(pp.web_search_options.search_context_size,'low');
  assert(metrics.every(m=>m.searched));assert(MODEL_SUMMARY.includes(MODELS.gemini));
});
test('failed or truncated searches remain untested, and credentials stay private',async()=>{
  const base={platform:'chatgpt',query:'Example'};
  assert.match(await queryCompanyPlatform({...base,openaiClient:{responses:{create:async()=>({status:'completed',output_text:'Ungrounded answer',output:[]})}}}),/did not complete live web search/);
  assert.match(await queryCompanyPlatform({...base,openaiClient:{responses:{create:async()=>({status:'incomplete',output:[]})}}}),/incomplete/);
  assert.match(await queryCompanyPlatform({...base,openaiClient:{responses:{create:async()=>{throw Error('bad sk-private_secret_key');}}}}),/credential redacted/);
  assert.match(await queryCompanyPlatform({platform:'gemini',query:'Example',geminiKey:'private-test-key',fetch:async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'Not searched'}]}}]})}),/did not complete Google Search/);
  assert.match(await queryCompanyPlatform({platform:'gemini',query:'Example',geminiKey:'private-test-key',fetch:async()=>Response.json({candidates:[{finishReason:'MAX_TOKENS',groundingMetadata:{webSearchQueries:['Example']}}]})}),/incomplete/);
  assert.match(await queryCompanyPlatform({platform:'claude',query:'Example',withRetry:fn=>fn(),client:{messages:{create:async()=>({stop_reason:'end_turn',content:[{type:'text',text:'Not searched'}]})}}}),/did not complete live web search/);
  assert.match(await queryCompanyPlatform({platform:'perplexity',query:'Example',perplexityClient:{chat:{completions:{create:async()=>({choices:[{finish_reason:'length',message:{content:'Truncated answer'}}]})}}}}),/incomplete/);
});
test('budget routing is confined to company perception and the radar pitch',()=>{
  const server=fs.readFileSync(require.resolve('./server'),'utf8');
  const company=server.slice(server.indexOf('async function runCompanyAudit'),server.indexOf('// ── Person Legibility Audit'));
  const person=server.slice(server.indexOf('// ── Person Legibility Audit'));
  assert(company.includes('createCompanyLookup({'));assert(company.includes('model: COMPANY_MODELS.report'));
  assert(company.includes('SCORABLE PLATFORMS:'));assert(company.includes('not proof of absent indexed content'));
  assert(person.includes('queryPlatform(t.platform'));assert(!person.includes('queryCompanyPlatform'));
  assert.equal(MODELS.report,MODELS.claude);assert.equal(MODELS.pitch,MODELS.claude);
});
test('Sonar questions are paced independently without blocking other platforms',async()=>{
  const order=[];let active=0,maxActive=0;
  const lookup=createCompanyLookup({
    perplexityClient:{chat:{completions:{create:async body=>{
      active++;maxActive=Math.max(maxActive,active);order.push(body.messages[0].content.split('\n')[0]);
      await new Promise(resolve=>setTimeout(resolve,5));active--;
      return{choices:[{finish_reason:'stop',message:{content:'A cited Sonar answer.'}}]};
    }}}},
    openaiClient:{responses:{create:async()=>{order.push('openai');return{status:'completed',output:[{type:'web_search_call',status:'completed'}],output_text:'A cited OpenAI answer.'};}}},
  });
  const answers=await Promise.all([lookup('perplexity','Q1'),lookup('perplexity','Q2'),lookup('chatgpt','Q3')]);
  assert.equal(maxActive,1);assert.equal(order[0],'openai');assert.deepEqual(order.slice(1),['Q1','Q2']);assert(answers.every(a=>!/^\[/.test(a)));
});

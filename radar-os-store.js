'use strict';
const crypto = require('node:crypto');
const DIMENSIONS = ['Clarity', 'Accuracy', 'Differentiation', 'Customer pain point', 'Proof / credibility', 'Category fit'];
const QUESTIONS = {
  Clarity: ['what_they_do', 'What does this company do?'],
  Accuracy: ['who_for', 'Who is it for?'],
  Differentiation: ['differentiation', 'What makes it different?'],
  'Customer pain point': ['problem', 'What problem does it solve?'],
  'Proof / credibility': ['credibility', 'Is it credible?'],
  'Category fit': ['alternatives', 'Who are its alternatives?'],
};
const PLATFORMS = { chatgpt: ['openai', 'openai'], claude: ['claude', 'anthropic'], gemini: ['gemini', 'gemini'], perplexity: ['perplexity', 'perplexity'] };
const MARKER = 'comms-radar-v2:';
function signalId(auditId, platform, dimension) {
  const hash = crypto.createHash('sha256').update(`${auditId}:${platform}:${dimension}`).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
function reportText(audit) {
  const { report, persistence, ...metadata } = audit;
  return `${report}\n\n<!-- ${MARKER}${Buffer.from(JSON.stringify(metadata)).toString('base64')} -->`;
}
function parseReport(text) {
  const match = text?.match(/\n\n<!-- comms-radar-v2:([A-Za-z0-9+/=]+) -->$/);
  if (!match) return null;
  try { return { ...JSON.parse(Buffer.from(match[1], 'base64').toString()), report: text.slice(0, match.index) }; }
  catch { return null; }
}
function signalRows(audit, entityId) {
  const rows = [];
  for (const [source, [scoreKey, osPlatform]] of Object.entries(PLATFORMS)) {
    for (const dimension of DIMENSIONS) {
      const score = audit.scores?.[scoreKey]?.[dimension];
      if (!audit.benchmarkAccessible || audit.platformStatus?.[source] !== 'complete' || !Number.isInteger(score) || score < 1 || score > 5) continue;
      const [key, prompt] = QUESTIONS[dimension];
      const answer = audit.rawResponses?.[source]?.[key];
      if (typeof answer !== 'string' || !answer.trim() || /^\s*\[/.test(answer)) throw new Error('A scored answer is missing.');
      rows.push({ id: signalId(audit.auditId, source, dimension), entity_id: entityId, platform: osPlatform,
        category: dimension, prompt, raw_answer: answer, score, signal_date: audit.completedAt.slice(0,10) });
    }
  }
  return rows;
}
function createOSStore({ url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON_KEY, fetch: request = fetch } = {}) {
  const locks = new Map();
  async function rest(table, method = 'GET', params = {}, body) {
    if (!url || !key) throw new Error('Supabase is not configured.');
    const endpoint = new URL(`${url.replace(/\/$/, '')}/rest/v1/${table}`);
    if (endpoint.protocol !== 'https:') throw new Error('Supabase must use HTTPS.');
    for (const [name, value] of Object.entries(params)) endpoint.searchParams.set(name, value);
    const headers = { apikey: key, 'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'resolution=ignore-duplicates,return=representation' : 'return=representation' };
    // Publishable/secret keys belong in apikey, not in a JWT Bearer header.
    if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
    const response = await request(endpoint.href, { method, headers, redirect: 'error', signal: AbortSignal.timeout(20000),
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) {
      console.warn('[Radar OS] Database operation failed', table, method, response.status);
      throw new Error('Supabase could not complete the save or verification.');
    }
    return response.json();
  }
  async function entity(name, create = false) {
    let rows = await rest('entities', 'GET', { name: `eq.${name}`, select: 'id', limit: '2' });
    if (rows.length > 1) throw new Error('Company identity is ambiguous in the OS.');
    if (rows[0]) return rows[0].id;
    if (!create) return null;
    try { rows = await rest('entities', 'POST', {}, { name, type: 'company' }); }
    catch { rows = await rest('entities', 'GET', { name: `eq.${name}`, select: 'id', limit: '2' }); }
    if (rows.length !== 1 || !rows[0]?.id) throw new Error('Company identity could not be matched in the OS.');
    return rows[0].id;
  }
  async function verify(audit, entityId, reportId) {
    const reports = await rest('audit_reports', 'GET', { id: `eq.${reportId}`, select: 'id,entity_id,report_date,report_text' });
    if (reports.length !== 1 || reports[0].entity_id !== entityId || reports[0].report_text !== reportText(audit)) throw new Error('The complete report was not verified.');
    if (reports[0].report_date !== audit.completedAt.slice(0,10)) throw new Error('The report date was not verified.');
    const expected = signalRows(audit, entityId);
    if (expected.length) {
      const rows = await rest('signals', 'GET', { id: `in.(${expected.map(r=>r.id).join(',')})`, select: 'id,entity_id,platform,category,prompt,raw_answer,score,signal_date' });
      if (rows.length !== expected.length || expected.some(wanted => {
        const row = rows.find(r=>r.id === wanted.id);
        return !row || Object.entries(wanted).some(([k,v])=>row[k] !== v);
      })) throw new Error('Some scores or answers were not verified.');
    }
    return { status: 'saved', entityId, reportId, auditId: audit.auditId, verifiedAt: new Date().toISOString(), signalsSaved: expected.length,
      message: 'Saved to Intelligence OS — report, scores and answers verified in Supabase.' };
  }
  function storageError(code, message) { return Object.assign(new Error(message), { code }); }
  async function currentReport(audit, entityId) {
    const date = audit.completedAt.slice(0,10);
    const rows = await rest('audit_reports', 'GET', { entity_id: `eq.${entityId}`,
      select: 'id,entity_id,report_date,report_text', order: 'report_date.desc', limit: '100' });
    const radar = rows.map(row=>({row,audit:parseReport(row.report_text)}))
      .filter(item=>item.audit?.companyName===audit.companyName && typeof item.audit.completedAt==='string')
      .sort((a,b)=>b.audit.completedAt.localeCompare(a.audit.completedAt));
    if (radar[0]?.audit.completedAt > audit.completedAt) throw storageError('OS_AUDIT_SUPERSEDED',
      'A newer audit is already saved for this company. Load the saved report instead of replacing it with an older draft.');
    const companyPerception = row => /AI Perception Audit|Scriptwriter Test Scores/i.test(row.report_text || '');
    const today = rows.find(row=>row.report_date===date);
    // Reuse one company perception row, preserving its primary key. Never replace
    // a website/narrative/person report just because it shares the same entity.
    let target = radar[0]?.row || rows.find(row=>row.report_date===date && companyPerception(row)) || rows.find(companyPerception);
    if (today && today.id !== target?.id) {
      if (companyPerception(today) || parseReport(today.report_text)?.companyName===audit.companyName) target=today;
      else throw storageError('OS_REPORT_COLLISION',
        'A different OS report already occupies this company/date. It was left unchanged; this audit has not been saved.');
    }
    return target;
  }
  async function save(audit) {
    const lockKey = audit.companyName;
    const work = (locks.get(lockKey) || Promise.resolve()).catch(()=>{}).then(async()=> {
      const entityId = await entity(audit.companyName, true);
      const target = await currentReport(audit, entityId);
      const reportId = target?.id || audit.auditId;
      const report = { entity_id: entityId, report_date: audit.completedAt.slice(0,10), report_text: reportText(audit) };
      if (target) {
        if (target.report_text !== report.report_text || target.report_date !== report.report_date)
          await rest('audit_reports', 'PATCH', { id: `eq.${reportId}`, entity_id: `eq.${entityId}` }, report);
      } else await rest('audit_reports', 'POST', { on_conflict: 'id' }, { id: reportId, ...report });
      // Score records remain keyed to the sampled audit, so retries do not
      // duplicate scores and existing OS signal history is not destroyed.
      const rows = signalRows(audit, entityId);
      if (rows.length) await rest('signals', 'POST', { on_conflict: 'id' }, rows);
      return verify(audit, entityId, reportId);
    });
    locks.set(lockKey, work);
    try { return await work; } finally { if (locks.get(lockKey)===work) locks.delete(lockKey); }
  }
  async function latest(companyName) {
    const entityId = await entity(companyName);
    if (!entityId) return null;
    const rows = await rest('audit_reports', 'GET', { entity_id: `eq.${entityId}`, report_text: `like.*<!-- ${MARKER}*`,
      select: 'id,report_text', order: 'report_date.desc', limit: '100' });
    const audits = rows.map(row=>({reportId:row.id,audit:parseReport(row.report_text)}))
      .filter(item=>item.audit?.companyName===companyName)
      .sort((a,b)=>b.audit.completedAt.localeCompare(a.audit.completedAt));
    if (!audits[0]) return null;
    const { audit, reportId } = audits[0];
    try { return { ...audit, persistence: await verify(audit, entityId, reportId) }; }
    catch { return { ...audit, persistence: { status: 'failed', message: 'Report found in Supabase, but the complete save is not verified. Retry saving to OS.' } }; }
  }
  return { save, latest };
}
module.exports = { createOSStore, signalRows, signalId, reportText, parseReport };

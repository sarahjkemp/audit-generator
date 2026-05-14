const express = require('express');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/', limits: { fileSize: 25 * 1024 * 1024 } });
const client = new Anthropic();

const openaiClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const perplexityClient = process.env.PERPLEXITY_API_KEY
  ? new OpenAI({ apiKey: process.env.PERPLEXITY_API_KEY, baseURL: 'https://api.perplexity.ai' })
  : null;

const geminiClient = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

app.use(express.static('public'));
app.use(express.json());

async function fetchPage(url, maxChars = 6000) {
  try {
    if (!url.startsWith('http')) url = 'https://' + url;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });
    clearTimeout(timeout);
    const html = await res.text();

    // Extract OG/meta tags for a structured summary
    const getMeta = (name) => {
      const m = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'))
               || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`, 'i'));
      return m ? m[1] : null;
    };

    const title = getMeta('og:title') || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || null;
    const description = getMeta('og:description') || getMeta('description') || null;
    const siteName = getMeta('og:site_name') || null;

    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxChars);

    return { url, title, description, siteName, text, accessible: true };
  } catch (err) {
    return { url, accessible: false, error: err.message };
  }
}

function formatChannelData(channels) {
  const results = [];
  for (const [name, data] of Object.entries(channels)) {
    if (!data.url) continue;
    if (!data.accessible) {
      results.push(`${name} (${data.url}): Could not fetch — likely requires login or blocked. ${data.notes ? 'Analyst notes: ' + data.notes : ''}`);
    } else {
      const parts = [`${name} (${data.url}):`];
      if (data.title) parts.push(`  Title: ${data.title}`);
      if (data.description) parts.push(`  Description: ${data.description}`);
      if (data.text) parts.push(`  Content excerpt: ${data.text.slice(0, 800)}`);
      if (data.notes) parts.push(`  Analyst notes: ${data.notes}`);
      results.push(parts.join('\n'));
    }
  }
  return results.join('\n\n');
}

const METHODOLOGY = `## About This Audit

This audit works across two distinct layers that most audits treat separately — and that's exactly where the insight lives.

**Layer one: AI visibility data.** Using Semrush's AI Visibility Overview, we measure how AI platforms currently see the business — what score they assign, where the company is being mentioned and cited, which topics and prompts are driving that visibility, and where competitors are appearing in their place. This gives us the quantitative picture: what AI knows, and what it doesn't.

**Layer two: Narrative and channel analysis.** We then audit the full owned-channel footprint — website, LinkedIn, YouTube, social profiles — assessing what each channel is actually saying, whether it's legible to AI systems, whether it's active, and whether the story compounds or fragments across channels. This is the qualitative layer: what the business is telling AI to find.

**The gap between those two layers is where the work is.** A high citation count with a fragmented narrative means authority is leaking. A coherent story with low visibility means the right foundations exist but no one — human or AI — is being pointed to them. This audit names which problem you have, in what order, and what to do about it.

**This audit covers:**
- AI Visibility Score across ChatGPT, AI Overview, Gemini, and AI Mode
- Mention, citation, and cited page analysis
- Performing topics and prompts — and whether they're the right ones
- Competitive gap: where you're absent and rivals aren't
- Full channel footprint: GEO legibility, activity, and narrative coherence per channel
- Cross-channel narrative assessment
- Prioritised recommendations and recommended next engagement

---`;

app.post('/generate', upload.single('semrushPdf'), async (req, res) => {
  const {
    clientName, website, industry, yourNotes,
    channelLinkedIn, channelTwitter, channelYouTube,
    channelFacebook, channelInstagram, channelSubstack, channelOther,
    channelObservations,
  } = req.body;

  if (!clientName) return res.status(400).json({ error: 'Client name is required.' });
  if (!req.file) return res.status(400).json({ error: 'Please upload the Semrush PDF.' });

  const pdfBase64 = fs.readFileSync(req.file.path).toString('base64');
  const today = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  // Fetch all channels in parallel
  const fetchJobs = {
    website: website ? fetchPage(website) : Promise.resolve(null),
    linkedin: channelLinkedIn ? fetchPage(channelLinkedIn, 2000) : Promise.resolve(null),
    twitter: channelTwitter ? fetchPage(channelTwitter, 2000) : Promise.resolve(null),
    youtube: channelYouTube ? fetchPage(channelYouTube, 3000) : Promise.resolve(null),
    facebook: channelFacebook ? fetchPage(channelFacebook, 1000) : Promise.resolve(null),
    instagram: channelInstagram ? fetchPage(channelInstagram, 1000) : Promise.resolve(null),
    substack: channelSubstack ? fetchPage(channelSubstack, 3000) : Promise.resolve(null),
    other: channelOther ? fetchPage(channelOther, 2000) : Promise.resolve(null),
  };

  const fetched = {};
  for (const [key, job] of Object.entries(fetchJobs)) {
    fetched[key] = await job;
  }

  const websiteContent = fetched.website;

  // Build channel footprint summary
  const channelMap = {
    'LinkedIn': { ...fetched.linkedin, url: channelLinkedIn },
    'Twitter / X': { ...fetched.twitter, url: channelTwitter },
    'YouTube': { ...fetched.youtube, url: channelYouTube },
    'Facebook': { ...fetched.facebook, url: channelFacebook },
    'Instagram': { ...fetched.instagram, url: channelInstagram },
    'Substack / Blog': { ...fetched.substack, url: channelSubstack },
    'Other': { ...fetched.other, url: channelOther },
  };

  const channelSummary = formatChannelData(channelMap);

  const prompt = `You are an AI Visibility & Narrative Audit specialist working for SJK Labs.

The attached PDF is a Semrush AI Visibility Overview report for ${clientName}${website ? ` (${website})` : ''}. Read it carefully and extract all data: AI visibility score, mentions, citations, cited pages, monthly audience, platform scores (ChatGPT/AI Overview/Gemini/AI Mode), performing topics, performing prompts, topic opportunities, and prompt opportunities.

${websiteContent?.accessible ? `WEBSITE (${website}):\n${websiteContent.description ? 'Meta description: ' + websiteContent.description + '\n' : ''}Content:\n${websiteContent.text}\n` : website ? `WEBSITE (${website}): Could not fetch.\n` : ''}

${channelSummary ? `CHANNEL FOOTPRINT (auto-fetched where accessible):\n${channelSummary}\n` : ''}

${channelObservations ? `ANALYST CHANNEL OBSERVATIONS:\n${channelObservations}\n` : ''}

ANALYST CONTEXT:
What they do: ${industry || 'Not provided'}
Strategic observations: ${yourNotes || 'Not provided'}

---

Write in a clear, direct, strategic voice. Not corporate, not fluffy. The client is paying £3,500 for real insight. Reference actual data points throughout. Don't pad. Don't hedge.

Generate the findings section of the audit report. Start directly with the first section heading — do not include a title or header block. Use this exact structure:

## The Situation
2–3 sentences. The honest "so what" — where does ${clientName} stand in AI right now, and how coherent is their owned-channel footprint? The headline finding.

## How AI Sees You Right Now
Interpret the Semrush scores with specificity. What does the AI visibility score mean in practical terms? Examine the citations vs mentions ratio. Break down the platform scores and flag anything notable — especially any platform scoring zero.

## What AI Finds You For
Interrogate the performing topics and prompts. Are these the right topics for this business? Are AI systems routing the right buyers to them, or finding them for tangential things?

## Where AI Misses You
The gap is the story. Identify the topic and prompt opportunities where competitors appear and ${clientName} doesn't. Quantify the missed audience where possible.

## Channel Footprint: What AI Can Actually Read
This is a critical section. For each channel present, assess:
- **AI legibility**: Can AI systems actually crawl, read, and cite this channel? (YouTube transcripts yes; locked Facebook pages no; stale Xing profiles near-zero)
- **Activity signal**: Is this channel active or abandoned? When was it last updated?
- **Narrative coherence**: Does this channel reinforce the main website story, or does it go its own way — or say nothing useful at all?

Be specific about which channels are compounding authority and which are creating dead weight or narrative noise. A broken Facebook link or a 2023 Xing profile is not neutral — it's a negative signal.

## Narrative Diagnostic

Apply the Scriptwriter Test™ framework to the website and owned channel content. Be direct and specific — use actual language examples from what was fetched. Do not be generous. If the narrative fails a test, say so plainly.

**Protagonist — Who is the story about?**
What you see: [2–3 lines describing how the company positions itself — who is at the centre of the story]
Issue: State clearly whether the company is the hero, the customer is the hero, or it's unclear. The correct answer is always that the customer should be the hero — the company is the guide. If ${clientName} is the protagonist, name it directly.
Why it matters: If the customer is not clearly the hero, the story becomes harder to relate to and remember.

**Stakes — Why does this matter now?**
What you see: [What the content says about the problem being solved and the cost of inaction]
Issue: Are the stakes explicit and urgent, or weak, implied, or missing entirely?
Why it matters: Without stakes, there is no urgency or reason to choose this now.

**Dialogue — How does it sound?**
What you see: [Pull actual phrases or language examples from the website/channels]
Issue: Does it sound human and repeatable, or like a manual, a brochure, or a list of category clichés?
Why it matters: If it can't be said simply, it won't be repeated or understood.

**Where the story breaks:**
One clear sentence. The exact point at which the narrative fails.

**One-line summary:**
The honest commercial consequence of the current narrative state.

---

## The Strategic Read
The synthesis. Where do the AI visibility gaps and the channel/narrative gaps intersect? What is the one underlying problem that explains most of what we're seeing? Name the diagnosis, not the symptoms.

## What Needs to Happen Next
3–5 specific, ordered fixes. Most impactful first. Concrete enough that the client knows exactly what each one means.

## The Path Forward
Based on everything this audit has revealed, make a clear recommendation for the right next engagement. Choose from:
- **The Scriptwriter Test™ (£3,000 · 5 days)** — if the core problem is that the narrative and positioning aren't clear enough yet to build on
- **Narrative Development (£12,000 · 4 weeks)** — if the problem is diagnosed and the story needs a full rebuild before any visibility work
- **Authority Building (£6,500/month · 6-month minimum)** — if the narrative is clear enough and the priority is compounding visibility and presence
- **Narrative Development, then Authority Building** — if both are needed in sequence

State your recommendation clearly, explain why in 2–3 sentences grounded in the evidence from this audit. This is a conclusion, not a sales pitch.

---

Format in clean markdown. Use **bold** for key data points and key conclusions.`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 5000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: prompt },
        ],
      }],
    });

    fs.unlinkSync(req.file.path);

    const header = `# AI Visibility & Narrative Audit\n## ${clientName} | ${today} | SJK Labs\n*Confidential*\n\n---\n`;
    const report = `${header}\n${METHODOLOGY}\n\n${message.content[0].text}`;

    res.json({ report });
  } catch (error) {
    try { if (req.file) fs.unlinkSync(req.file.path); } catch {}
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/scriptwriter', async (req, res) => {
  const {
    clientName, website,
    sw_aboutUrl, sw_serviceUrl, sw_proofUrl,
    sw_protagonist, sw_audience, sw_conversionGoal, sw_whatTheySell,
    sw_problem, sw_stakes, sw_differentiators, sw_proof,
    sw_spokespersonName, sw_spokespersonVoice,
    sw_audienceLanguage, sw_brandVoice,
    sw_objections, sw_competitors,
  } = req.body;

  if (!clientName) return res.status(400).json({ error: 'Client name is required.' });
  if (!website) return res.status(400).json({ error: 'Website URL is required.' });

  const today = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  const [homePage, aboutPage, servicePage, proofPage] = await Promise.all([
    fetchPage(website, 8000),
    sw_aboutUrl ? fetchPage(sw_aboutUrl, 8000) : Promise.resolve(null),
    sw_serviceUrl ? fetchPage(sw_serviceUrl, 8000) : Promise.resolve(null),
    sw_proofUrl ? fetchPage(sw_proofUrl, 8000) : Promise.resolve(null),
  ]);

  const formatPage = (label, data) => {
    if (!data) return null;
    if (!data.accessible) return `${label} (${data.url}): Could not fetch — ${data.error}`;
    const parts = [`${label} (${data.url}):`];
    if (data.title) parts.push(`Title: ${data.title}`);
    if (data.description) parts.push(`Meta description: ${data.description}`);
    parts.push(`Content:\n${data.text}`);
    return parts.join('\n');
  };

  const pagesContent = [
    formatPage('HOMEPAGE', homePage),
    sw_aboutUrl ? formatPage('ABOUT PAGE', aboutPage) : null,
    sw_serviceUrl ? formatPage('SERVICE/METHODOLOGY PAGE', servicePage) : null,
    sw_proofUrl ? formatPage('PROOF/CASE STUDIES PAGE', proofPage) : null,
  ].filter(Boolean).join('\n\n---\n\n');

  const prompt = `You are running The Scriptwriter Test — a structured narrative audit and full website rewrite.

WHAT YOU ARE DOING
You are auditing the narrative of ${clientName}'s website and producing a complete rewrite based on the Scriptwriter Test framework. The framework diagnoses three failure modes — protagonist, stakes, and dialogue — then builds a messaging spine and writes full page-level copy.

GROUND RULES FOR THE REWRITE
- The customer is the hero. The company is the guide.
- Name the problem before the method, every time.
- Stakes must be explicit: the cost of inaction must land in plain language.
- Replace category language with specific, human, repeatable phrases.
- Every proof claim must use the exact evidence provided. Do not invent proof. If evidence is thin, flag it.
- Draft copy that cannot be said in a conversation has failed. Rewrite it.

COMPANY CONTEXT
Company: ${clientName}
Website: ${website}
What they sell: ${sw_whatTheySell || '(not provided)'}
Target audience: ${sw_audience || '(not provided)'}
Primary protagonist: ${sw_protagonist || '(not provided)'}
Conversion goal: ${sw_conversionGoal || '(not provided)'}
Top problem the protagonist has: ${sw_problem || '(not provided)'}
Why that problem matters now — the stakes: ${sw_stakes || '(not provided)'}
Main differentiators: ${sw_differentiators || '(not provided)'}
Core proof — results, numbers, case studies: ${sw_proof || '(not provided)'}
Brand voice: ${sw_brandVoice || '(not provided)'}
Spokesperson: ${sw_spokespersonName || '(none specified)'}
Spokesperson voice examples: ${sw_spokespersonVoice || '(none provided)'}
How the audience describes their own problem: ${sw_audienceLanguage || '(none provided)'}
Customer objections: ${sw_objections || '(none provided)'}
Competitors / category: ${sw_competitors || '(none provided)'}

PAGES FETCHED
${pagesContent}

---

OUTPUT STRUCTURE

Produce the following sections in order. Use the exact headings. Write actual copy — not descriptions of what the copy should say.

## One-Line Summary
[One sentence. The honest commercial consequence of the current narrative state. Not a compliment.]

---

## The Diagnosis

**Protagonist — Who is the story about?**
What we see: [2–3 sentences. Who is centred in the current copy. Reference actual phrases from the pages.]
Issue: [Direct statement — is the company or the customer the hero?]
Why it matters: [Commercial consequence.]

**Stakes — Why does this matter now?**
What we see: [What does the content say about the problem and cost of inaction? Quote actual language.]
Issue: [Explicit and urgent, or weak, implied, or absent?]
Why it matters: [What the buyer loses without urgency in the copy.]

**Dialogue — How does it sound?**
What we see: [Pull 2–3 actual phrases from the pages verbatim.]
Issue: [Human and repeatable, or jargon-heavy and forgettable?]
Why it matters: [If it can't be said simply, it won't be remembered.]

**Where the story breaks:**
[One sentence. The single clearest point of narrative failure.]

---

## What to Fix First
1. [Most impactful. Concrete.]
2.
3.
4.
5.

---

## The Messaging Spine

**Protagonist:** [One sentence — who this is for and what they're trying to do]
**Stakes:** [One sentence — the cost of not solving this]
**Proof pillars:**
- [Specific claim backed by provided evidence]
- [Specific claim backed by provided evidence]
- [Specific claim, or flag if evidence is insufficient]
**CTA logic:** [What action, why now, what happens next]
**One-line narrative:** [Protagonist + problem + guide + outcome in one sentence]

---

## Page Rewrites

Write full draft copy for each page that was successfully fetched. Skip pages that could not be accessed and note why.

### Homepage

**Narrative job:** [What this page must do — one sentence]

**Key shifts:**
-
-
-

**Draft copy:**

HERO
Headline:
Subhead:
Opening paragraph:

THE PROBLEM
Section headline:
Body:

THE GUIDE
Section headline:
Body:

PROOF
Section headline:
Body:

CTA
Headline:
Body:
Button text:

---

### About Page

**Narrative job:**

**Key shifts:**
-
-

**Draft copy:**

OPENING
Headline:
Body:

THE PROBLEM WE SAW
Body:

HOW WE THINK
Body:

CREDIBILITY
Body:

CTA
Headline:
Button text:

---

### Service / Methodology Page

**Narrative job:**

**Key shifts:**
-
-

**Draft copy:**

WHAT THIS IS
Headline:
Subhead:
Body:

HOW IT WORKS
Section headline:
Body:

PROOF IT WORKS
Section headline:
Body:

WHO IT'S FOR
Body:

CTA
Headline:
Button text:

---

### Proof / Case Studies Page

**Narrative job:**

**Key shifts:**
-
-

**Draft copy:**

OPENING
Headline:
Body:

PROOF POINTS
Context:
The problem they had:
What changed:
The result:

CTA
Headline:
Button text:

---

## Confidence Flags

**High confidence — strong evidence in what you were given:**
-

**Needs your judgment before using:**
-
`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    });

    const header = `# The Scriptwriter Test\n## ${clientName} | ${today} | SJK Labs\n*Internal — not for distribution*\n\n---\n`;
    const report = `${header}\n${message.content[0].text}`;

    res.json({ report });
  } catch (error) {
    console.error('Scriptwriter error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── AI Perception Audit (50-Company Study) ──────────────────────────────────

const COMPANY_PROMPTS = [
  { key: 'what_they_do',    label: 'What does this company do?',     query: (n) => `What does ${n} do?` },
  { key: 'who_for',         label: 'Who is it for?',                 query: (n) => `Who is ${n} for?` },
  { key: 'problem',         label: 'What problem does it solve?',    query: (n) => `What problem does ${n} solve?` },
  { key: 'differentiation', label: 'What makes it different?',       query: (n) => `What makes ${n} different from its competitors?` },
  { key: 'credibility',     label: 'Is it credible?',                query: (n) => `Is ${n} credible? What evidence exists for this?` },
  { key: 'alternatives',    label: 'Who are its alternatives?',      query: (n) => `Who are the main alternatives to ${n}?` },
];

const PLATFORM_META = {
  chatgpt:    { label: 'ChatGPT (GPT-4o, web search)',            model: 'gpt-4o-search-preview' },
  claude:     { label: 'Claude (claude-sonnet-4-6, web search)',  model: 'claude-sonnet-4-6' },
  gemini:     { label: 'Gemini (gemini-2.5-flash, web search)',   model: 'gemini-2.5-flash' },
  perplexity: { label: 'Perplexity (sonar, web search)',          model: 'sonar' },
};

async function queryPlatform(platform, query) {
  try {
    if (platform === 'chatgpt') {
      if (!openaiClient) return '[OpenAI API key not configured]';
      const res = await openaiClient.chat.completions.create({
        model: 'gpt-4o-search-preview', messages: [{ role: 'user', content: query }], max_tokens: 400,
      });
      return res.choices[0].message.content.trim();
    }
    if (platform === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return '[Gemini API key not configured]';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      const gemRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: query }] }],
          tools: [{ google_search: {} }],
        }),
      });
      const gemData = await gemRes.json();
      if (!gemRes.ok) return `[Gemini error: ${gemData.error?.message || gemRes.status}]`;
      return gemData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '[Gemini returned empty response]';
    }
    if (platform === 'perplexity') {
      if (!perplexityClient) return '[Perplexity API key not configured]';
      const res = await perplexityClient.chat.completions.create({
        model: 'sonar', messages: [{ role: 'user', content: query }], max_tokens: 400,
      });
      return res.choices[0].message.content.trim();
    }
    if (platform === 'claude') {
      const res = await client.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 800,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        messages: [{ role: 'user', content: query }],
      });
      const textBlocks = res.content.filter(b => b.type === 'text');
      return textBlocks.map(b => b.text).join(' ').trim() || '[No text response]';
    }
  } catch (err) {
    return `[Error: ${err.message}]`;
  }
}

app.post('/company-audit', async (req, res) => {
  const { companyName, website, category, notes } = req.body;
  if (!companyName) return res.status(400).json({ error: 'Company name is required.' });
  if (!website)     return res.status(400).json({ error: 'Website URL is required.' });

  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const platforms = ['chatgpt', 'claude', 'gemini', 'perplexity'];

  // Build all query tasks and fetch website in parallel
  const allTasks = [];
  for (const platform of platforms) {
    for (const prompt of COMPANY_PROMPTS) {
      allTasks.push({ platform, key: prompt.key, label: prompt.label });
    }
  }

  const [websiteData, ...platformResults] = await Promise.all([
    fetchPage(website, 6000),
    ...allTasks.map(t => queryPlatform(t.platform, COMPANY_PROMPTS.find(p => p.key === t.key).query(companyName))),
  ]);

  // Organise results by platform → prompt key
  const responses = {};
  platforms.forEach(p => { responses[p] = {}; });
  allTasks.forEach((task, i) => { responses[task.platform][task.key] = platformResults[i]; });

  const groundTruth = websiteData?.accessible
    ? [
        websiteData.title       ? `Title: ${websiteData.title}` : null,
        websiteData.description ? `Meta description: ${websiteData.description}` : null,
        `Content:\n${websiteData.text}`,
      ].filter(Boolean).join('\n')
    : `Website could not be fetched: ${websiteData?.error || 'unknown error'}`;

  // Format raw responses block for scoring prompt
  let responsesBlock = '';
  for (const prompt of COMPANY_PROMPTS) {
    responsesBlock += `\n**${prompt.label}**\n`;
    for (const platform of platforms) {
      responsesBlock += `${PLATFORM_META[platform].label}: ${responses[platform][prompt.key]}\n\n`;
    }
  }

  const scoringPrompt = `You are a researcher at SJK Labs producing a structured AI perception audit. This is entry ${companyName} in the study "The Scriptwriter Test: What AI Gets Wrong About Expert-Led Businesses" — a structured analysis of how AI systems describe 50 companies when asked buyer-style questions.

COMPANY: ${companyName}
WEBSITE: ${website}
CATEGORY: ${category || 'Not specified'}
DATE TESTED: ${today}
MODELS USED: ChatGPT (GPT-4o) · Claude (claude-opus-4-7) · Gemini (gemini-2.0-flash) · Perplexity (sonar, web-enabled)
${notes ? `ANALYST NOTES: ${notes}` : ''}

GROUND TRUTH (from company website):
${groundTruth}

RAW AI PLATFORM RESPONSES:
${responsesBlock}

---

Produce the full audit report below. Be analytical and direct. Quote actual language from the website and AI responses. Do not be generous with scores: 3 = partial/generic, 5 = accurate and specific. Fill in every table cell.

---

## ${companyName}
*${category || 'B2B business'} · Tested ${today} · SJK Labs · Methodology: The Scriptwriter Test*

---

### What They Actually Do
3–4 sentences from the ground truth only. What does the website say this company does, who it serves, and what makes it different? Quote actual language from the site.

---

### AI Responses

${COMPANY_PROMPTS.map((p, i) => `#### Q${i + 1}: ${p.label}

**ChatGPT:** [response]
**Claude:** [response]
**Gemini:** [response]
**Perplexity:** [response]`).join('\n\n')}

Fill in each response with the actual platform response above (condense to 1–2 sentences where needed, preserving key language and any notable claims or errors).

---

### Scriptwriter Test Scores

Score 1–5 per dimension per platform:
- 1 = completely fails (wrong, generic, or no information)
- 2 = weak (vague category-level only)
- 3 = partial (some accuracy, no differentiation)
- 4 = good (accurate, some specificity)
- 5 = strong (accurate, specific, differentiated)

| Dimension | ChatGPT | Claude | Gemini | Perplexity |
|-----------|---------|--------|--------|-----------|
| Clarity | | | | |
| Accuracy | | | | |
| Differentiation | | | | |
| Customer pain point | | | | |
| Proof / credibility | | | | |
| Category fit | | | | |
| **Total /30** | | | | |

---

### Analysis

**Where AI gets it right:**
What do the platforms accurately capture? Cite specific responses.

**Where AI gets it wrong:**
What do they miss, distort, or genericise? Quote actual response language.

**What's missing entirely:**
Specific claims, differentiators, or proof from the website that no AI platform surfaced.

**The narrative gap:**
One sentence: the clearest difference between how ${companyName} describes itself and how AI describes it.

**One-line finding for dataset:**
Format: "${companyName} — [key finding about AI perception gap in one sentence]"

---

### Best Next Step

Based on the scores, the narrative gap, and what's missing from AI responses, give one clear, specific recommendation. Consider:
- Is this a visibility problem (not enough indexed content, citations, or mentions for AI to find)?
- Is this a narrative problem (content exists but is unclear, fragmented, or uses the wrong language)?
- Is this a proof problem (no third-party validation, case studies, or press for AI to cite)?
- Is this a maturity problem (company too new to have a meaningful footprint yet)?

Name the diagnosis first, then give 2–3 concrete actions in priority order. Be direct. If the company is too new to have built AI visibility yet, say so plainly and explain what to do first. Do not recommend things that don't follow from the evidence.

---

Format in clean markdown. Fill in every table cell with a number.`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4000,
      messages: [{ role: 'user', content: scoringPrompt }],
    });

    res.json({ report: message.content[0].text, rawResponses: responses });
  } catch (error) {
    console.error('Company audit error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Gemini diagnostic endpoint ───────────────────────────────────────────────

app.get('/test-gemini', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.json({ status: 'no key', detail: 'GEMINI_API_KEY not set' });

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Say hello in one word.' }] }], tools: [{ google_search: {} }] }),
    });
    const data = await r.json();
    res.json({ httpStatus: r.status, body: data });
  } catch (err) {
    res.json({ status: 'fetch threw', error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));

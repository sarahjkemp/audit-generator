const express = require('express');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/', limits: { fileSize: 25 * 1024 * 1024 } });
const client = new Anthropic();

app.use(express.static('public'));

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

Generate the audit report in this exact structure:

# AI Visibility & Narrative Audit
## ${clientName} | ${today} | SJK Labs
*Confidential*

---

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

## What Your Owned Channels Are Actually Saying
Step back from individual channels and look at the full picture. What story does ${clientName}'s total footprint tell to a buyer — or to an AI system trying to summarise who they are? Where does the narrative compound? Where does it fragment, thin out, or contradict itself entirely?

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
    res.json({ report: message.content[0].text });
  } catch (error) {
    try { if (req.file) fs.unlinkSync(req.file.path); } catch {}
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));

const express = require('express');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/', limits: { fileSize: 25 * 1024 * 1024 } });
const client = new Anthropic();

app.use(express.static('public'));

async function fetchWebsite(url) {
  try {
    if (!url.startsWith('http')) url = 'https://' + url;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; audit-bot/1.0)' },
    });
    clearTimeout(timeout);
    const html = await res.text();
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6000);
  } catch {
    return null;
  }
}

app.post('/generate', upload.single('semrushPdf'), async (req, res) => {
  const { clientName, website, industry, yourNotes, nextStep } = req.body;

  if (!clientName) return res.status(400).json({ error: 'Client name is required.' });
  if (!req.file) return res.status(400).json({ error: 'Please upload the Semrush PDF.' });

  const pdfBase64 = fs.readFileSync(req.file.path).toString('base64');
  const websiteContent = website ? await fetchWebsite(website) : null;
  const today = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  const prompt = `You are an AI Visibility & Narrative Audit specialist working for SJK Labs.

The attached PDF is a Semrush AI Visibility Overview report for ${clientName}${website ? ` (${website})` : ''}. Read it carefully and extract all data: AI visibility score, mentions, citations, cited pages, monthly audience, platform scores (ChatGPT/AI Overview/Gemini/AI Mode), performing topics, performing prompts, topic opportunities, and prompt opportunities.

${websiteContent ? `WEBSITE CONTENT (fetched automatically from ${website}):\n${websiteContent}\n` : ''}

ANALYST CONTEXT:
What they do: ${industry || 'Not provided'}
Strategic observations: ${yourNotes || 'Not provided'}
Recommended next step: ${nextStep}

---

Write in a clear, direct, strategic voice. Not corporate, not fluffy. The client is paying £3,500 for real insight. Reference actual data points throughout — exact scores, topic names, competitor counts. Don't pad. Don't hedge.

Generate the audit report in this exact structure:

# AI Visibility & Narrative Audit
## ${clientName} | ${today} | SJK Labs
*Confidential*

---

## The Situation
2–3 sentences. The honest "so what" — where does ${clientName} stand in AI right now? What is the headline?

## How AI Sees You Right Now
Interpret the scores with specificity. What does the AI visibility score mean in practical terms for a business like this? Examine the citations vs mentions ratio — what does that gap signal? Break down the platform scores. Flag anything that stands out, especially a zero on any platform.

## What AI Finds You For
Don't just list the performing topics and prompts — interrogate them. Are these the right topics for ${clientName}'s business? Are AI systems routing the right buyers to them, or finding them for the wrong things?

## Where AI Misses You
The gap is the story. Identify the topic and prompt opportunities where competitors are appearing and ${clientName} isn't. Quantify the scale of the missed audience where possible. What is the competitive exposure if this isn't addressed?

## What Your Owned Channels Are Actually Saying
${websiteContent ? `Analyse their website content (fetched above) alongside any other context provided. ` : ''}Where does the story compound and reinforce itself? Where does it thin out, fragment, or contradict what AI is finding them for? Be specific and direct.

## The Strategic Read
This is the synthesis. Where do the AI visibility gaps and the narrative gaps intersect? What is the one underlying problem that explains most of what we're seeing? Don't list symptoms — name the diagnosis.

## What Needs to Happen Next
3–5 specific, ordered fixes. Most impactful first. Each should be concrete enough that the client knows exactly what it means.

## The Path Forward
One short paragraph. Based on what this audit has revealed, the logical next step is: ${nextStep}. Explain why — this is a conclusion from the evidence, not a pitch.

---

Format in clean markdown. Use **bold** for key data points and key conclusions.`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
          },
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

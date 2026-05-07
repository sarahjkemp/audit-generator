const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const client = new Anthropic();

app.post('/generate', async (req, res) => {
  const {
    clientName, website, industry,
    aiScore, mentions, citations, citedPages, monthlyAudience,
    chatgpt, aiOverview, gemini, aiMode,
    performingTopics, performingPrompts, topicOpportunities,
    websiteNotes, spokespersonNotes, channelsNotes, strategicNotes, industryContext,
    nextStep,
  } = req.body;

  if (!clientName) {
    return res.status(400).json({ error: 'Client name is required.' });
  }

  const today = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  const prompt = `You are an AI Visibility & Narrative Audit specialist working for SJK Labs. Generate a strategic audit report for the client below.

Write in a clear, direct, strategic voice. Not corporate. Not fluffy. Smart, specific, and honest. The client is paying £3,500 for real insight, not a generic scorecard. Reference actual data points throughout. Don't pad. Don't hedge. Write like a strategist who respects the client's intelligence.

---

CLIENT: ${clientName}
WEBSITE: ${website || 'Not provided'}
WHAT THEY DO: ${industry || 'Not provided'}

SEMRUSH AI VISIBILITY DATA:
AI Visibility Score: ${aiScore || 'Not provided'}/100
Mentions: ${mentions || 'Not provided'}
Citations: ${citations || 'Not provided'}
Cited Pages: ${citedPages || 'Not provided'}
Monthly AI Audience: ${monthlyAudience || 'Not provided'}

Platform Visibility:
- ChatGPT: ${chatgpt || 'Not provided'}/100
- AI Overview (Google): ${aiOverview || 'Not provided'}/100
- Gemini: ${gemini || 'Not provided'}/100
- AI Mode: ${aiMode || 'Not provided'}/100

Your Performing Topics:
${performingTopics || 'Not provided'}

Your Performing Prompts:
${performingPrompts || 'Not provided'}

Topic Opportunities (topics where competitors are mentioned but client is not):
${topicOpportunities || 'Not provided'}

NARRATIVE AUDIT — ANALYST OBSERVATIONS:
Website/homepage: ${websiteNotes || 'Not provided'}
Spokesperson/founder: ${spokespersonNotes || 'Not provided'}
Owned channels: ${channelsNotes || 'Not provided'}
Strategic read: ${strategicNotes || 'Not provided'}
Industry context: ${industryContext || 'Not provided'}

Recommended next step for this client: ${nextStep}

---

Generate the audit report in this exact structure. Start with a header block, then the sections below.

# AI Visibility & Narrative Audit
## ${clientName} | ${today} | SJK Labs
*Confidential*

---

## The Situation
2–3 sentences. The honest "so what" — where does ${clientName} actually stand in AI right now? What is the headline finding?

## How AI Sees You Right Now
Interpret the scores with specificity. What does a score of ${aiScore}/100 mean in practical terms for a business like this? Look at the citations vs mentions ratio — what does that gap signal? Examine the platform breakdown. Flag anything notable, especially if AI Mode is 0 or if one platform dominates.

## What AI Finds You For
Go beyond listing the topics — interrogate them. Are these the right topics for ${clientName}'s business? Are the prompts routing the right buyers to them, or are they being found for adjacent or tangential things? Name the mismatch if there is one.

## Where AI Misses You
The gap is the story. What topics should ${clientName} own, where competitors have already established a presence? Quantify the scale of the opportunity where the data allows. What's the competitive exposure if this isn't addressed?

## What Your Owned Channels Are Actually Saying
Based on the narrative observations. Where does the story compound and reinforce itself? Where does it thin out, fragment, or stop? Be specific and direct. This is the layer the Semrush data can't see.

## The Strategic Read
This is the synthesis. Where do the AI visibility gaps and the narrative gaps intersect? What is the one underlying problem that explains most of what we're seeing? Don't list symptoms — name the diagnosis. This is the section the client will remember.

## What Needs to Happen Next
3–5 specific, ordered fixes. Most impactful first. Each one should be concrete enough that the client knows what it means and why it matters. No vague recommendations.

## The Path Forward
One short paragraph. Based on what this audit has revealed, the logical next engagement is: ${nextStep}. Explain why briefly — this is a conclusion from the evidence, not a sales pitch.

---

Format in clean markdown. Use **bold** for key data points and key conclusions. Do not add a summary or sign-off after The Path Forward.`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    res.json({ report: message.content[0].text });
  } catch (error) {
    console.error('Error generating report:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Audit generator running on http://localhost:${PORT}`);
});

'use strict';

// Company AI perception only. Person/website/narrative audit defaults are separate.
// Verified against provider documentation on 2026-09-16. No premium-model fallback.
const MODELS = Object.freeze({
  chatgpt: 'gpt-5.6-luna',
  gemini: 'gemini-3.1-flash-lite',
  claude: 'claude-haiku-4-5-20251001',
  perplexity: 'sonar',
  report: 'claude-haiku-4-5-20251001',
  pitch: 'claude-haiku-4-5-20251001',
});
const LABELS = Object.freeze({
  chatgpt: `OpenAI (${MODELS.chatgpt} + web search)`,
  claude: `Claude (${MODELS.claude} + web search)`,
  gemini: `Gemini (${MODELS.gemini} + Google Search)`,
  perplexity: `Perplexity (${MODELS.perplexity} + web search)`,
});
const MODEL_SUMMARY = Object.values(LABELS).join(' · ');

async function queryCompanyPlatform({ platform, query, openaiClient, perplexityClient, client,
  withRetry, geminiKey, fetch: request = fetch, onUsage = () => {} }) {
  const input = `${query}\nUse live web search for current public information. Answer concisely in no more than 120 words, with source citations. If the company is ambiguous or evidence is unavailable, say so; do not invent facts.`;
  try {
    if (platform === 'chatgpt') {
      if (!openaiClient) return '[OpenAI API key not configured]';
      const result = await openaiClient.responses.create({ model: MODELS.chatgpt,
        reasoning: { effort: 'none' }, text: { verbosity: 'low' },
        max_output_tokens: 700, max_tool_calls: 1, store: false,
        tools: [{ type: 'web_search', search_context_size: 'low', external_web_access: true }],
        tool_choice: 'required', input }, { timeout: 60000, maxRetries: 0 });
      const searched = result.output?.some(item => item.type === 'web_search_call' && item.status === 'completed');
      onUsage({ platform, model: result.model, usage: result.usage, searched });
      if (result.status === 'incomplete') return '[OpenAI answer incomplete; untested]';
      if (!searched) return '[OpenAI did not complete live web search; untested]';
      return result.output_text?.trim() || '[OpenAI returned empty response]';
    }
    if (platform === 'gemini') {
      if (!geminiKey) return '[Gemini API key not configured]';
      const response = await request(`https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent`, {
        method: 'POST', signal: AbortSignal.timeout(60000),
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: input }] }], tools: [{ google_search: {} }],
          generationConfig: { maxOutputTokens: 700, thinkingConfig: { thinkingLevel: 'MINIMAL' } } }),
      });
      const result = await response.json();
      if (!response.ok) return `[Gemini error: ${result.error?.message || response.status}]`;
      const candidate = result.candidates?.[0];
      const searched = candidate?.groundingMetadata?.webSearchQueries?.length > 0;
      onUsage({ platform, model: result.modelVersion, usage: result.usageMetadata, searched });
      if (candidate?.finishReason === 'MAX_TOKENS') return '[Gemini answer incomplete; untested]';
      if (!searched) return '[Gemini did not complete Google Search grounding; untested]';
      return candidate?.content?.parts?.filter(p => !p.thought).map(p => p.text || '').join('').trim() || '[Gemini returned empty response]';
    }
    if (platform === 'perplexity') {
      if (!perplexityClient) return '[Perplexity API key not configured]';
      const result = await perplexityClient.chat.completions.create({ model: MODELS.perplexity,
        messages: [{ role: 'user', content: input }], max_tokens: 500,
        web_search_options: { search_context_size: 'low' } }, { timeout: 60000, maxRetries: 0 });
      onUsage({ platform, model: result.model, usage: result.usage, searched: true });
      if (result.choices?.[0]?.finish_reason === 'length') return '[Perplexity answer incomplete; untested]';
      return result.choices?.[0]?.message?.content?.trim() || '[Perplexity returned empty response]';
    }
    if (platform === 'claude') {
      const result = await withRetry(() => client.messages.create({ model: MODELS.claude, max_tokens: 700,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
        tool_choice: { type: 'tool', name: 'web_search' },
        messages: [{ role: 'user', content: input }] }, { timeout: 60000, maxRetries: 0 }), 1);
      const searched = result.content?.some(block => block.type === 'web_search_tool_result' && Array.isArray(block.content));
      onUsage({ platform, model: result.model, usage: result.usage, searched });
      if (['max_tokens','pause_turn'].includes(result.stop_reason)) return '[Claude answer incomplete; untested]';
      if (!searched) return '[Claude did not complete live web search; untested]';
      return result.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim() || '[Claude returned empty response]';
    }
    return '[Unknown AI platform]';
  } catch (error) {
    // SDK exceptions must not leak provider credentials into paid reports or logs.
    const message = String(error.message || 'Request failed').replace(/(?:sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]+)/g, '[credential redacted]');
    return `[Error: ${message}]`;
  }
}

module.exports = { MODELS, LABELS, MODEL_SUMMARY, queryCompanyPlatform };

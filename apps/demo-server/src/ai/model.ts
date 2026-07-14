/**
 * The demo's language model — `MockLanguageModelV4` from `ai/test`, running
 * entirely in memory.
 *
 * flow's AI layer takes any `LanguageModelV4`, and the AI SDK ships scripted
 * mock implementations of exactly that interface for tests. Using one here
 * means the demo needs no API key, no network, and no local inference runtime,
 * while still exercising every real seam: `generateText` calls the model,
 * flow's `createInstrumentedModel` middleware captures the reported usage, the
 * cost estimator prices it, and the usage recorder persists it. Swapping in a
 * real provider is one line (`anthropic('claude-haiku-4-5')` from
 * `@ai-sdk/anthropic`) — nothing downstream changes.
 *
 * The scripted `doGenerate` keys off a directive marker in the prompt (the
 * workflow steps embed `[summarize]` / `[follow-up]`) and reports token usage
 * derived from the text lengths, so usage numbers vary per contact like a real
 * model's would.
 */
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4 } from '@ai-sdk/provider';

export const DEMO_MODEL_ID = 'demo-mock-model';

/**
 * Pricing for the mock model, fed to flow's `createCostEstimator`. Without an
 * entry the estimator falls back to its priciest known model (a deliberate
 * overcount); registering the model id shows the intended wiring.
 */
export const DEMO_MODEL_PRICING = {
  [DEMO_MODEL_ID]: {
    inputPerMillion: 1,
    outputPerMillion: 5,
    cacheReadPerMillion: 0.1,
    cacheWritePerMillion: 1.25,
  },
};

/** ~4 chars per token — close enough for demo usage numbers. */
const approxTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

function promptText(prompt: unknown): string {
  // A LanguageModelV4 prompt is an array of messages whose content is an array
  // of typed parts; collect every text part.
  const parts: string[] = [];
  for (const message of Array.isArray(prompt) ? prompt : []) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if ((part as { type?: string }).type === 'text') parts.push((part as { text: string }).text);
      }
    }
  }
  return parts.join('\n');
}

function scriptedReply(text: string): string {
  const name = /Name: (.+)$/m.exec(text)?.[1]?.trim() ?? 'this contact';
  const email = /Email: (.+)$/m.exec(text)?.[1]?.trim() ?? 'their address';

  if (text.includes('[summarize]')) {
    return `${name} is an engaged demo contact reachable at ${email}. There is no open follow-up on file, so a short periodic check-in is the recommended next touch.`;
  }
  if (text.includes('[follow-up]')) {
    return `Hi ${name},\n\nIt has been a little while since we last spoke, so I wanted to check in and hear how things are going on your side. If it would help, I am happy to set up a short call next week.\n\nBest regards,\nThe Contact Desk Team`;
  }
  return `Scripted demo reply to: ${text.slice(0, 80)}`;
}

/** Build the scripted in-memory model. Deterministic per input — no randomness. */
export function createDemoAiModel(): LanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'demo',
    modelId: DEMO_MODEL_ID,
    doGenerate: async (options) => {
      const text = promptText(options.prompt);
      const reply = scriptedReply(text);
      return {
        content: [{ type: 'text', text: reply }],
        finishReason: 'stop' as const,
        usage: {
          inputTokens: {
            total: approxTokens(text),
            noCache: approxTokens(text),
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: approxTokens(reply),
            text: approxTokens(reply),
            reasoning: undefined,
          },
        },
        warnings: [],
      };
    },
  });
}

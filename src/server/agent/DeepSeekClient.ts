/**
 * Minimal, dependency-free DeepSeek (OpenAI-compatible) chat client.
 *
 * Only what TB5 needs: one non-streaming completion with JSON output, hard timeouts,
 * bounded retries and strict "never log the key" behaviour. The API key never leaves
 * this class and is masked everywhere it is exposed.
 */

export interface DeepSeekChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DeepSeekClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface DeepSeekChatResult {
  content: string;
  model: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  finishReason: string;
  attempts: number;
}

export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_CHAT_MODEL = 'deepseek-chat';
export const DEEPSEEK_REASONER_MODEL = 'deepseek-reasoner';

export class DeepSeekApiError extends Error {
  public readonly status: number;
  public readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'DeepSeekApiError';
    this.status = status;
    this.code = code;
  }
}

/** Never print a full key: keep the 4-char prefix marker and last 4 chars only. */
export function maskApiKey(key?: string): string {
  const clean = (key || '').trim();
  if (!clean) return '';
  if (clean.length <= 8) return '********';
  return `${clean.slice(0, 4)}...${clean.slice(-4)}`;
}

/**
 * Extract the first complete JSON object from a model answer. Handles markdown fences,
 * leading prose and trailing commentary, all of which DeepSeek occasionally emits.
 */
export function extractJsonObject(raw: string): any {
  if (!raw) throw new Error('Răspuns gol de la DeepSeek.');
  let text = String(raw).trim();

  // Strip ```json ... ``` (or plain ```) fences
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) text = fence[1].trim();

  const start = text.indexOf('{');
  if (start < 0) throw new Error('Răspunsul DeepSeek nu conține niciun obiect JSON.');

  // Walk the string to the matching closing brace (respects nested objects & strings)
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        return JSON.parse(slice);
      }
    }
  }
  throw new Error('JSON DeepSeek trunchiat sau dezechilibrat.');
}

export class DeepSeekClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(options: DeepSeekClientOptions) {
    this.apiKey = (options.apiKey || '').trim();
    this.baseUrl = (options.baseUrl || DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = options.model || DEEPSEEK_CHAT_MODEL;
    this.temperature = typeof options.temperature === 'number' ? options.temperature : 0.3;
    this.maxTokens = options.maxTokens && options.maxTokens > 0 ? options.maxTokens : 1800;
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 60_000;
    this.maxRetries = typeof options.maxRetries === 'number' ? options.maxRetries : 2;
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  public getMaskedKey(): string {
    return maskApiKey(this.apiKey);
  }

  public getModel(): string {
    return this.model;
  }

  private get endpoint(): string {
    // Both https://api.deepseek.com and https://api.deepseek.com/v1 must work.
    return /\/v\d+$/.test(this.baseUrl)
      ? `${this.baseUrl}/chat/completions`
      : `${this.baseUrl}/chat/completions`;
  }

  /**
   * Single non-streaming completion. Retries only on transient failures
   * (network error, timeout, HTTP 408/429/5xx) — never on 4xx auth/payload errors.
   */
  public async chat(
    messages: DeepSeekChatMessage[],
    overrides?: { jsonMode?: boolean; temperature?: number; maxTokens?: number; timeoutMs?: number; model?: string }
  ): Promise<DeepSeekChatResult> {
    if (!this.apiKey) {
      throw new DeepSeekApiError('Cheia API DeepSeek nu este configurată.', 401, 'MISSING_API_KEY');
    }

    const model = overrides?.model || this.model;
    const temperature = typeof overrides?.temperature === 'number' ? overrides.temperature : this.temperature;
    const maxTokens = overrides?.maxTokens && overrides.maxTokens > 0 ? overrides.maxTokens : this.maxTokens;
    const timeoutMs = overrides?.timeoutMs && overrides.timeoutMs > 0 ? overrides.timeoutMs : this.timeoutMs;

    const body: Record<string, any> = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    };
    // deepseek-reasoner does not accept response_format; it also rejects temperature tuning.
    if (overrides?.jsonMode && !/reasoner/i.test(model)) {
      body.response_format = { type: 'json_object' };
    }
    if (/reasoner/i.test(model)) {
      delete body.temperature;
    }

    let lastError: any = null;
    const attemptsMax = Math.max(0, this.maxRetries) + 1;

    for (let attempt = 1; attempt <= attemptsMax; attempt++) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const latencyMs = Date.now() - startedAt;
        const text = await res.text();

        if (!res.ok) {
          let apiMessage = `HTTP ${res.status}`;
          let apiCode: string | undefined;
          try {
            const parsed = JSON.parse(text);
            apiMessage = parsed?.error?.message || parsed?.message || apiMessage;
            apiCode = parsed?.error?.code || parsed?.error?.type;
          } catch {
            if (text) apiMessage = `${apiMessage}: ${text.slice(0, 200)}`;
          }
          const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
          const err = new DeepSeekApiError(
            `DeepSeek API ${res.status}: ${apiMessage}`,
            res.status,
            apiCode ? String(apiCode) : undefined
          );
          if (retryable && attempt < attemptsMax) {
            lastError = err;
            await this.sleep(800 * Math.pow(2, attempt - 1));
            continue;
          }
          throw err;
        }

        const data: any = text ? JSON.parse(text) : {};
        const content: string = data?.choices?.[0]?.message?.content ?? '';
        if (!content) {
          const finish = data?.choices?.[0]?.finish_reason;
          throw new DeepSeekApiError(
            `Răspuns DeepSeek fără conținut (finish_reason=${finish || 'necunoscut'}).`,
            502,
            'EMPTY_CONTENT'
          );
        }

        return {
          content,
          model: data?.model || model,
          latencyMs,
          promptTokens: Number(data?.usage?.prompt_tokens) || 0,
          completionTokens: Number(data?.usage?.completion_tokens) || 0,
          finishReason: String(data?.choices?.[0]?.finish_reason || 'stop'),
          attempts: attempt,
        };
      } catch (err: any) {
        lastError = err;
        const aborted = err?.name === 'AbortError';
        const retryable = aborted || err instanceof TypeError || (err instanceof DeepSeekApiError && err.status >= 500);
        if (retryable && attempt < attemptsMax) {
          await this.sleep(800 * Math.pow(2, attempt - 1));
          continue;
        }
        if (aborted) {
          throw new DeepSeekApiError(
            `Timeout DeepSeek după ${Math.round(timeoutMs / 1000)}s.`,
            408,
            'TIMEOUT'
          );
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new DeepSeekApiError('Eroare necunoscută la apelul DeepSeek.', 500);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }
}

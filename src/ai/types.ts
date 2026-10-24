export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  /** When set, the provider must return JSON. Gemini enforces the schema; Groq gets json_object mode. */
  jsonSchema?: object;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Streaming only: abort if no text arrives within this many ms (default 10s). */
  firstChunkMs?: number;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
  latencyMs: number;
}

/** Thrown by providers. `retryable` errors move the router to the next model/provider. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: "timeout" | "rate_limited" | "unavailable" | "not_found" | "bad_request" | "auth" | "empty" | "other",
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface Provider {
  readonly name: string;
  configured(): boolean;
  /** Candidate model IDs, best first, discovered from the provider's own model listing. */
  candidates(): Promise<string[]>;
  complete(model: string, req: CompletionRequest): Promise<string>;
  /** Yields text chunks as they arrive. */
  stream(model: string, req: CompletionRequest): AsyncGenerator<string>;
}

export function classifyHttp(status: number, message: string): ProviderError {
  const m = message.slice(0, 200);
  if (status === 429) return new ProviderError(m, "rate_limited", true);
  if (status === 503 || status === 502 || status === 500 || status === 504) return new ProviderError(m, "unavailable", true);
  if (status === 404) return new ProviderError(m, "not_found", true);
  if (status === 401 || status === 403) return new ProviderError(m, "auth", false);
  if (status === 400) return new ProviderError(m, "bad_request", true);
  return new ProviderError(m, "other", true);
}

/** fetch with an overall timeout that also aborts an in-flight body read. */
export async function timedFetch(url: string, init: RequestInit, timeoutMs: number, ctrl = new AbortController()): Promise<{ res: Response; done: () => void; signal: AbortSignal }> {
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return { res, done: () => clearTimeout(t), signal: ctrl.signal };
  } catch (e: any) {
    clearTimeout(t);
    if (e?.name === "AbortError") throw new ProviderError("timeout", "timeout", true);
    throw new ProviderError(String(e?.message ?? e), "unavailable", true);
  }
}

/** Parse a text/event-stream body into `data:` payloads. */
export async function* sseData(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
    if (buf.startsWith("data:")) yield buf.slice(5).trim();
  } catch (e: any) {
    if (e?.name === "AbortError") throw new ProviderError("timeout while streaming", "timeout", true);
    throw e;
  }
}

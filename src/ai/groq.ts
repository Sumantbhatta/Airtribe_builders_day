import { CompletionRequest, Provider, ProviderError, classifyHttp, sseData, timedFetch } from "./types.js";

// Groq via its OpenAI-compatible endpoint (api.groq.com/openai/v1).
// Key travels only in the Authorization header.

const API = "https://api.groq.com/openai/v1";
const key = () => process.env.GROQ_API_KEY || "";
let listCache: { at: number; ids: string[] } | null = null;

/** GROQ_MODELS override first, then large general chat models; skip speech/guard/tool-only models. */
export function rankGroq(ids: string[], preferred: string[] = []): string[] {
  const bad = /(whisper|tts|guard|prompt-guard|playai|orpheus|distil|compound|safeguard)/i;
  const size = (id: string) => {
    const m = id.match(/(\d+)b/i);
    return m ? Number(m[1]) : 0;
  };
  // Small models (<20B) gave incoherent Hinglish and wrong grading in testing; keep them out.
  const usable = ids.filter((id) => !bad.test(id) && size(id) >= 20).sort((a, b) => size(b) - size(a));
  const pinned = preferred.filter((p) => ids.includes(p));
  return [...pinned, ...usable.filter((id) => !pinned.includes(id))];
}

function body(req: CompletionRequest, model: string, stream: boolean) {
  const system = req.jsonSchema ? `${req.system}\n\nReply with ONLY a JSON object matching this schema: ${JSON.stringify(req.jsonSchema)}` : req.system;
  return JSON.stringify({
    model,
    stream,
    temperature: req.temperature ?? 0.5,
    max_tokens: req.maxTokens ?? 1024,
    ...(req.jsonSchema ? { response_format: { type: "json_object" } } : {}),
    messages: [{ role: "system", content: system }, ...req.messages.map((m) => ({ role: m.role, content: m.text }))],
  });
}

async function failure(res: Response, model: string): Promise<ProviderError> {
  const j: any = await res.json().catch(() => ({}));
  return classifyHttp(res.status, `${model}: ${res.status} ${j?.error?.message ?? ""}`);
}

const headers = () => ({ "content-type": "application/json", authorization: `Bearer ${key()}` });

export const groq: Provider = {
  name: "groq",
  configured: () => !!key(),

  async candidates() {
    if (!listCache || Date.now() - listCache.at > 30 * 60_000) {
      const { res, done } = await timedFetch(`${API}/models`, { headers: headers() }, 10_000);
      try {
        if (!res.ok) throw await failure(res, "list");
        const j: any = await res.json();
        listCache = { at: Date.now(), ids: (j.data ?? []).filter((m: any) => m.active !== false).map((m: any) => String(m.id)) };
      } finally {
        done();
      }
    }
    const pinned = (process.env.GROQ_MODELS || process.env.GROQ_MODEL || "").split(",").map((s) => s.trim()).filter(Boolean);
    return rankGroq(listCache.ids, pinned);
  },

  async complete(model, req) {
    const { res, done } = await timedFetch(`${API}/chat/completions`, { method: "POST", headers: headers(), body: body(req, model, false) }, req.timeoutMs ?? 15_000);
    try {
      if (!res.ok) throw await failure(res, model);
      const j: any = await res.json();
      const text = j?.choices?.[0]?.message?.content ?? "";
      if (!text) throw new ProviderError(`${model}: empty`, "empty", true);
      return text;
    } catch (e: any) {
      if (e?.name === "AbortError") throw new ProviderError(`${model}: timeout`, "timeout", true);
      throw e;
    } finally {
      done();
    }
  },

  async *stream(model, req) {
    const ctrl = new AbortController();
    const watchdog = setTimeout(() => ctrl.abort(), req.firstChunkMs ?? 10_000);
    const { res, done } = await timedFetch(`${API}/chat/completions`, { method: "POST", headers: headers(), body: body(req, model, true) }, req.timeoutMs ?? 30_000, ctrl).catch((e) => {
      clearTimeout(watchdog);
      throw e;
    });
    try {
      if (!res.ok) throw await failure(res, model);
      let any = false;
      for await (const data of sseData(res)) {
        if (!data || data === "[DONE]") continue;
        const t = JSON.parse(data)?.choices?.[0]?.delta?.content ?? "";
        if (t) {
          any = true;
          clearTimeout(watchdog);
          yield t;
        }
      }
      if (!any) throw new ProviderError(`${model}: empty stream`, "empty", true);
    } finally {
      clearTimeout(watchdog);
      done();
    }
  },
};

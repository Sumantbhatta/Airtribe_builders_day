import { CompletionRequest, Provider, ProviderError, classifyHttp, sseData, timedFetch } from "./types.js";

// Google Gemini via the Generative Language REST API (v1beta).
// Key travels only in the x-goog-api-key header.

const API = "https://generativelanguage.googleapis.com/v1beta";
const key = () => process.env.GEMINI_API_KEY || "";

let listCache: { at: number; ids: string[] } | null = null;
/** Models that reject thinkingConfig get it stripped on later calls. */
const noThinkingCfg = new Set<string>();

/** Rank listed models: GEMINI_MODELS override first, then stable flash text models, newest version first. */
export function rankGemini(ids: string[], preferred: string[] = []): string[] {
  const bad = /(image|tts|audio|live|embedding|vision|aqa|learnlm|robotics|computer-use|native|transcribe|omni|banana|lyria|veo|imagen|research|antigravity|customtools|gemma)/i;
  const ver = (id: string) => parseFloat(id.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? "0");
  const score = (id: string) =>
    ver(id) * 100 - (/preview|exp/.test(id) ? 50 : 0) - (/lite/.test(id) ? 30 : 0) - (/latest/.test(id) ? 5 : 0);
  const flash = ids.filter((id) => /^gemini-/.test(id) && /flash/.test(id) && !bad.test(id)).sort((a, b) => score(b) - score(a));
  const pinned = preferred.filter((p) => ids.includes(p));
  return [...pinned, ...flash.filter((id) => !pinned.includes(id))];
}

function body(req: CompletionRequest, model: string) {
  const generationConfig: Record<string, unknown> = {
    temperature: req.temperature ?? 0.5,
    maxOutputTokens: req.maxTokens ?? 1024,
  };
  if (!noThinkingCfg.has(model)) generationConfig.thinkingConfig = { thinkingLevel: "low" };
  if (req.jsonSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = req.jsonSchema;
  }
  return JSON.stringify({
    systemInstruction: { parts: [{ text: req.system }] },
    contents: req.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] })),
    generationConfig,
  });
}

async function failure(res: Response, model: string): Promise<ProviderError> {
  const j: any = await res.json().catch(() => ({}));
  const daily = (j?.error?.details ?? []).some((d: any) => (d?.violations ?? []).some((v: any) => /PerDay/i.test(String(v?.quotaId ?? ""))));
  const msg = `${model}: ${j?.error?.status ?? res.status}${daily ? " [daily quota]" : ""} ${j?.error?.message ?? ""}`;
  if (res.status === 400 && /thinking/i.test(msg)) noThinkingCfg.add(model);
  return classifyHttp(res.status, msg);
}

const textOf = (j: any) =>
  (j?.candidates?.[0]?.content?.parts ?? [])
    .filter((p: any) => !p.thought)
    .map((p: any) => p.text ?? "")
    .join("");

export const gemini: Provider = {
  name: "gemini",
  configured: () => !!key(),

  async candidates() {
    if (!listCache || Date.now() - listCache.at > 30 * 60_000) {
      const { res, done } = await timedFetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": key() } }, 10_000);
      try {
        if (!res.ok) throw await failure(res, "list");
        const j: any = await res.json();
        const ids = (j.models ?? [])
          .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
          .map((m: any) => String(m.name).replace(/^models\//, ""));
        listCache = { at: Date.now(), ids };
      } finally {
        done();
      }
    }
    const pinned = (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || "").split(",").map((s) => s.trim()).filter(Boolean);
    return rankGemini(listCache.ids, pinned);
  },

  async complete(model, req) {
    const { res, done } = await timedFetch(
      `${API}/models/${encodeURIComponent(model)}:generateContent`,
      { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key() }, body: body(req, model) },
      req.timeoutMs ?? 15_000,
    );
    try {
      if (!res.ok) throw await failure(res, model);
      const j: any = await res.json();
      const text = textOf(j);
      if (!text) throw new ProviderError(`${model}: empty (finishReason=${j?.candidates?.[0]?.finishReason ?? "none"})`, "empty", true);
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
    const { res, done } = await timedFetch(
      `${API}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key() }, body: body(req, model) },
      req.timeoutMs ?? 30_000,
      ctrl,
    ).catch((e) => {
      clearTimeout(watchdog);
      throw e;
    });
    try {
      if (!res.ok) throw await failure(res, model);
      let any = false;
      for await (const data of sseData(res)) {
        if (!data) continue;
        const t = textOf(JSON.parse(data));
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

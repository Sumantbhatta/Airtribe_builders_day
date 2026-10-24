// Minimal Gemini client (REST, generativelanguage.googleapis.com v1beta).
// - Key is sent in the x-goog-api-key header, never in URLs or logs.
// - The model is picked from the live ListModels response (or GEMINI_MODEL if
//   that model is actually listed), so we never hard-code an ID that may not exist.
// - Every call returns null on failure so callers can fall back deterministically.

const API = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 15000);

export interface LlmStatus {
  configured: boolean;
  model: string | null;
  lastError: string | null;
  lastOkAt: string | null;
  calls: number;
  failures: number;
}

const status: LlmStatus = { configured: false, model: null, lastError: null, lastOkAt: null, calls: 0, failures: 0 };
let modelPromise: Promise<string | null> | null = null;

export const llmStatus = (): LlmStatus => ({ ...status, configured: !!process.env.GEMINI_API_KEY });

const key = () => process.env.GEMINI_API_KEY || "";

async function call(path: string, init: RequestInit = {}): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${API}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { "content-type": "application/json", "x-goog-api-key": key(), ...(init.headers ?? {}) },
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`gemini ${r.status}: ${j?.error?.status ?? ""} ${String(j?.error?.message ?? "").slice(0, 160)}`);
    return j;
  } finally {
    clearTimeout(t);
  }
}

/** Rank listed models: stable "flash" text models first, newest version first. */
export function pickModel(names: string[], preferred?: string): string | null {
  const ids = names.map((n) => n.replace(/^models\//, ""));
  if (preferred && ids.includes(preferred)) return preferred;
  const bad = /(image|tts|audio|live|embedding|vision|aqa|learnlm|robotics|computer-use|native)/i;
  const cands = ids.filter((id) => /^gemini-/.test(id) && /flash/.test(id) && !bad.test(id));
  const ver = (id: string) => parseFloat(id.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? "0");
  const score = (id: string) =>
    ver(id) * 100 - (/preview|exp/.test(id) ? 50 : 0) - (/lite/.test(id) ? 10 : 0) - (/-\d{3,}$|latest/.test(id) ? 1 : 0);
  return cands.sort((a, b) => score(b) - score(a))[0] ?? null;
}

async function model(): Promise<string | null> {
  if (!key()) return null;
  if (!modelPromise) {
    modelPromise = (async () => {
      const j = await call("/models?pageSize=200");
      const names = (j.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m: any) => String(m.name));
      const m = pickModel(names, process.env.GEMINI_MODEL);
      status.model = m;
      if (!m) throw new Error("no usable gemini flash model in ListModels");
      return m;
    })().catch((e) => {
      status.lastError = String(e?.message ?? e);
      modelPromise = null; // retry discovery on the next call
      return null;
    });
  }
  return modelPromise;
}

/** Ask for JSON matching `schema`. Returns parsed object or null (never throws). */
export async function generateJson<T>(system: string, user: string, schema: object): Promise<T | null> {
  if (!key()) return null;
  status.calls++;
  try {
    const m = await model();
    if (!m) throw new Error(status.lastError ?? "no model");
    const j = await call(`/models/${encodeURIComponent(m)}:generateContent`, {
      method: "POST",
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.3, responseMimeType: "application/json", responseSchema: schema },
      }),
    });
    const text = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    if (!text) throw new Error(`empty response (finishReason=${j?.candidates?.[0]?.finishReason ?? "none"})`);
    const parsed = JSON.parse(text) as T;
    status.lastOkAt = new Date().toISOString();
    status.lastError = null;
    return parsed;
  } catch (e: any) {
    status.failures++;
    status.lastError = String(e?.name === "AbortError" ? "timeout" : e?.message ?? e).slice(0, 200);
    console.error("llm call failed:", status.lastError);
    return null;
  }
}

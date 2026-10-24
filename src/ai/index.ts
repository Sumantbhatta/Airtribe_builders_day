import { gemini } from "./gemini.js";
import { groq } from "./groq.js";
import { CompletionRequest, CompletionResult, Provider, ProviderError } from "./types.js";

export type { ChatMessage, CompletionRequest, CompletionResult } from "./types.js";

// Routes each request across providers (AI_PROVIDERS order, default gemini,groq) and
// their models. Models that fail with 404/429/503/timeouts are cooled down and the next
// candidate is tried. A startup probe measures real latency so we prefer models that
// actually respond, rather than trusting the model listing alone.

const ALL: Provider[] = [gemini, groq];
const COOLDOWN_MS: Record<ProviderError["code"], number> = {
  not_found: 6 * 3600_000,
  auth: 10 * 60_000,
  bad_request: 10 * 60_000,
  rate_limited: 60_000,
  unavailable: 90_000,
  timeout: 90_000,
  empty: 30_000,
  other: 60_000,
};
const MAX_ATTEMPTS = Number(process.env.AI_MAX_ATTEMPTS || 4);
/** Stop trying more models once a turn has spent this long; the caller then falls back. */
const TURN_BUDGET_MS = Number(process.env.AI_TURN_BUDGET_MS || 25_000);

interface ModelHealth {
  coolUntil: number;
  lastError?: string;
  lastCode?: string;
  lastOkAt?: string;
  latencyMs?: number;
}
const health = new Map<string, ModelHealth>();
const probeOrder = new Map<string, string[]>(); // provider -> models ordered by measured latency
let lastProbeAt: string | null = null;

const h = (p: string, m: string) => {
  const k = `${p}:${m}`;
  if (!health.has(k)) health.set(k, { coolUntil: 0 });
  return health.get(k)!;
};

export class AiUnavailable extends Error {}

export function providers(): Provider[] {
  const order = (process.env.AI_PROVIDERS || "groq,gemini").split(",").map((s) => s.trim().toLowerCase());
  return order.map((n) => ALL.find((p) => p.name === n)).filter((p): p is Provider => !!p && p.configured());
}

export const aiConfigured = () => providers().length > 0;

async function plan(): Promise<{ p: Provider; model: string }[]> {
  const out: { p: Provider; model: string }[] = [];
  for (const p of providers()) {
    let cands: string[] = [];
    try {
      cands = await p.candidates();
    } catch (e: any) {
      h(p.name, "*").lastError = String(e?.message ?? e).slice(0, 160);
      continue;
    }
    const probed = probeOrder.get(p.name) ?? [];
    const ordered = [...probed.filter((m) => cands.includes(m)), ...cands.filter((m) => !probed.includes(m))];
    const now = Date.now();
    for (const m of ordered) if (h(p.name, m).coolUntil <= now) out.push({ p, model: m });
  }
  return out;
}

function fail(p: Provider, model: string, e: unknown) {
  const err = e instanceof ProviderError ? e : new ProviderError(String((e as any)?.message ?? e), "other", true);
  const st = h(p.name, model);
  st.lastError = err.message.slice(0, 200);
  st.lastCode = err.code;
  // A thinking-config rejection is fixed on the next call (gemini strips it), so don't cool down.
  const cool =
    err.code === "bad_request" && /thinking/i.test(err.message)
      ? 0 // fixed on the next call (gemini strips thinkingConfig)
      : err.code === "rate_limited" && /daily quota/i.test(err.message)
        ? 6 * 3600_000 // per-day quota: don't keep retrying this model today
        : COOLDOWN_MS[err.code];
  st.coolUntil = Date.now() + cool;
  console.error(`ai ${p.name}/${model} failed [${err.code}]: ${err.message.slice(0, 160)}`);
  return err;
}

function ok(p: Provider, model: string, latencyMs: number) {
  const st = h(p.name, model);
  st.lastOkAt = new Date().toISOString();
  st.latencyMs = latencyMs;
  st.coolUntil = 0;
}

export async function complete(req: CompletionRequest): Promise<CompletionResult> {
  const attempts = (await plan()).slice(0, MAX_ATTEMPTS);
  const errors: string[] = [];
  const started = Date.now();
  for (const { p, model } of attempts) {
    if (Date.now() - started > TURN_BUDGET_MS) {
      errors.push("turn_budget_exceeded");
      break;
    }
    const t0 = Date.now();
    try {
      const text = await p.complete(model, req);
      ok(p, model, Date.now() - t0);
      return { text, provider: p.name, model, latencyMs: Date.now() - t0 };
    } catch (e) {
      const err = fail(p, model, e);
      errors.push(`${p.name}/${model}:${err.code}`);
      if (!err.retryable) continue;
    }
  }
  throw new AiUnavailable(errors.join(", ") || "no AI provider configured");
}

/**
 * Streams text through onDelta. Fails over to the next model only if nothing has been
 * streamed yet; once text reached the learner, a mid-stream failure returns the partial text.
 */
export async function stream(req: CompletionRequest, onDelta: (t: string) => void): Promise<CompletionResult & { partial: boolean }> {
  const attempts = (await plan()).slice(0, MAX_ATTEMPTS);
  const errors: string[] = [];
  const started = Date.now();
  for (const { p, model } of attempts) {
    if (Date.now() - started > TURN_BUDGET_MS) {
      errors.push("turn_budget_exceeded");
      break;
    }
    const t0 = Date.now();
    let text = "";
    try {
      for await (const chunk of p.stream(model, req)) {
        text += chunk;
        onDelta(chunk);
      }
      ok(p, model, Date.now() - t0);
      return { text, provider: p.name, model, latencyMs: Date.now() - t0, partial: false };
    } catch (e) {
      const err = fail(p, model, e);
      errors.push(`${p.name}/${model}:${err.code}`);
      if (text) return { text, provider: p.name, model, latencyMs: Date.now() - t0, partial: true };
    }
  }
  throw new AiUnavailable(errors.join(", ") || "no AI provider configured");
}

/** JSON helper: returns the parsed object, or null on any failure. */
export async function completeJson<T>(req: CompletionRequest & { jsonSchema: object }): Promise<{ data: T; meta: CompletionResult } | null> {
  try {
    const r = await complete(req);
    const raw = r.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    return { data: JSON.parse(raw) as T, meta: r };
  } catch (e: any) {
    console.error("ai json failed:", String(e?.message ?? e).slice(0, 200));
    return null;
  }
}

/** Measure real latency of the top candidates of each provider (tiny request, parallel). */
export async function probe(perProvider = 4): Promise<void> {
  await Promise.all(
    providers().map(async (p) => {
      let cands: string[] = [];
      try {
        cands = (await p.candidates()).slice(0, perProvider);
      } catch (e: any) {
        h(p.name, "*").lastError = String(e?.message ?? e).slice(0, 160);
        return;
      }
      const results = await Promise.all(
        cands.map(async (m) => {
          const t0 = Date.now();
          try {
            await p.complete(m, { system: "Reply with the single word: ok", messages: [{ role: "user", text: "ping" }], maxTokens: 256, timeoutMs: 12_000, temperature: 0 });
            const ms = Date.now() - t0;
            ok(p, m, ms);
            return { m, ms };
          } catch (e) {
            fail(p, m, e);
            return null;
          }
        }),
      );
      probeOrder.set(p.name, results.filter((r): r is { m: string; ms: number } => !!r).sort((a, b) => a.ms - b.ms).map((r) => r.m));
    }),
  );
  lastProbeAt = new Date().toISOString();
}

/** Safe-to-expose status: no keys, just provider/model health. */
export function aiStatus() {
  return {
    configured: aiConfigured(),
    provider_order: providers().map((p) => p.name),
    last_probe_at: lastProbeAt,
    providers: ALL.map((p) => ({
      name: p.name,
      configured: p.configured(),
      preferred_models: probeOrder.get(p.name) ?? [],
      models: [...health.entries()]
        .filter(([k]) => k.startsWith(`${p.name}:`))
        .map(([k, v]) => ({
          model: k.split(":")[1],
          latency_ms: v.latencyMs ?? null,
          last_ok_at: v.lastOkAt ?? null,
          cooling: v.coolUntil > Date.now(),
          last_error_code: v.lastCode ?? null,
        })),
    })),
  };
}

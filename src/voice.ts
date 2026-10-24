import crypto from "node:crypto";
import type { Request, Response } from "express";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { one, logEvent } from "./db.js";
import { createLearner, learnerByPhone, normalizePhone } from "./store.js";
import { mentorTurn } from "./mentor.js";
import type { Learner } from "./store.js";

// Voice = ElevenLabs Agent (speech in/out) + our mentor as its Custom LLM.
// ElevenLabs calls POST /v1/chat/completions (OpenAI-compatible, SSE) for each turn;
// we answer with the same mentorTurn the web chat uses, on the "voice" channel.

const signingKey = () => process.env.TOOL_SECRET || "";

/** Learner id + HMAC, so a voice session can't claim someone else's profile. */
export function signLearner(id: number): string {
  const mac = crypto.createHmac("sha256", signingKey()).update(`voice:${id}`).digest("hex").slice(0, 32);
  return `lr_${id}_${mac}`;
}

export function verifyLearner(v: unknown): number | null {
  const m = typeof v === "string" ? v.match(/^lr_(\d+)_([0-9a-f]{32})$/) : null;
  if (!m || !signingKey()) return null;
  const expected = signLearner(Number(m[1]));
  const a = Buffer.from(expected), b = Buffer.from(v as string);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? Number(m[1]) : null;
}

export const voiceConfigured = () => !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID);

export async function voiceSession(l: Learner) {
  const client = new ElevenLabsClient(); // reads ELEVENLABS_API_KEY
  const r: any = await client.conversationalAi.conversations.getSignedUrl({ agentId: process.env.ELEVENLABS_AGENT_ID! });
  const learner = signLearner(l.id);
  await logEvent("voice.session_start", {}, l.id);
  return {
    signedUrl: r.signedUrl ?? r.signed_url,
    userId: learner,
    customLlmExtraBody: { learner },
    dynamicVariables: { learner_name: l.name.split(" ")[0] },
  };
}

const systemText = (messages: any[]) =>
  (messages ?? []).filter((m: any) => m?.role === "system").map((m: any) => (typeof m.content === "string" ? m.content : "")).join("\n");

/**
 * Who is on the line: a signed web learner, else the phone caller (system__caller_id,
 * which the agent prompt passes as "CALLER_ID: ..."), else a shared TEST guest for
 * calls started from the ElevenLabs console.
 */
async function identify(body: any, extra: any): Promise<Learner | undefined> {
  const id = verifyLearner(extra.learner) ?? verifyLearner(body.user_id);
  if (id) return one<Learner>("select * from learners where id=$1", [id]);
  const sys = systemText(body.messages);
  const phone = normalizePhone(sys.match(/CALLER_ID:\s*(\+?[\d\s-]{7,20})/)?.[1]);
  if (phone) {
    const known = await learnerByPhone(phone);
    if (known) return known;
    const l = await createLearner({ name: "Caller", phone, consent: false, isTest: false, source: "phone" });
    await logEvent("voice.new_caller", {}, l.id);
    return l;
  }
  const guest = await one<Learner>("select * from learners where source='voice-console' and is_test order by id limit 1");
  return guest ?? createLearner({ name: "Console Guest", phone: null, consent: true, isTest: true, source: "voice-console" });
}

function lastUserText(messages: any[]): string {
  for (let i = (messages ?? []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.map((p: any) => p?.text ?? "").join(" ");
  }
  return "";
}

/** Speech can't render markdown; drop the symbols as they stream. */
const speakable = (t: string) => t.replace(/[*`#_]/g, "");

export async function chatCompletions(req: Request, res: Response) {
  const secret = process.env.VOICE_LLM_SECRET || "";
  const auth = String(req.header("authorization") ?? "");
  const got = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const okAuth = !!secret && got.length === secret.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(secret));
  const body = req.body ?? {};
  const extra = body.elevenlabs_extra_body ?? {};
  await logEvent("voice.llm_request", {
    auth_ok: okAuth,
    keys: Object.keys(body).slice(0, 20),
    has_user_id: !!body.user_id,
    extra_keys: Object.keys(extra).slice(0, 10),
    messages: Array.isArray(body.messages) ? body.messages.length : 0,
  });
  if (!okAuth) return res.status(401).json({ error: { message: "unauthorized" } });

  const learner = await identify(body, extra);
  const text = lastUserText(body.messages).trim();

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = String(body.model ?? "callmentor");
  const chunk = (content: string | null, finish: string | null = null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: content === null ? {} : { role: "assistant", content }, finish_reason: finish }] })}\n\n`;

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  const send = (t: string) => t && res.write(chunk(t));
  const finish = () => {
    res.write(chunk(null, "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
  };

  if (!learner) {
    send("I couldn't find your CallMentor profile for this call. Please start the call from your CallMentor page so I can remember your progress.");
    return finish();
  }
  if (!text) {
    send(`I'm here, ${learner.name.split(" ")[0]}. What would you like to talk about?`);
    return finish();
  }

  // If the first words take a moment (cold start, provider failover), keep the line alive.
  let streamed = false;
  const filler = setTimeout(() => {
    if (!streamed) {
      streamed = true;
      send("Hmm, let me think... ");
    }
  }, 1500);
  try {
    const r = await mentorTurn(learner, text.slice(0, 1000), "voice", (t) => {
      streamed = true;
      send(speakable(t));
    });
    clearTimeout(filler);
    // Fallback turns don't stream; speak them in one go.
    if (r.source !== "ai") send(speakable(r.replies.filter((x) => !x.startsWith("(My AI mentor is offline")).join(" ")));
  } catch (e: any) {
    clearTimeout(filler);
    console.error("voice turn failed:", e?.message ?? e);
    send("Sorry, I lost my train of thought there. Could you say that again?");
  }
  finish();
}

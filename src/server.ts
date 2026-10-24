import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import express, { NextFunction, Request, Response } from "express";
import { initDb, q, one, logEvent, dbKind } from "./db.js";
import { aiConfigured, aiStatus, probe } from "./ai/index.js";
import { loadContext, mentorTurn } from "./mentor.js";
import { getConcept, grade, prioritize, defaultTopic } from "./engine.js";
import {
  Learner,
  createLearner,
  effectsFor,
  endSession,
  learnerByPhone,
  learnerByToken,
  learnerView,
  normalizePhone,
  profilePayload,
} from "./store.js";
import { decide, finishRun, proposeNudge, stalledLearners, startRun } from "./agent.js";
import { createCheckout, paymentsEnabled, syncPayment, verifyCallbackSignature } from "./payments.js";

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "200kb", verify: (req, _res, buf) => ((req as any).rawBody = buf) }));
app.use(express.urlencoded({ extended: false }));

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

app.get("/health", (_req, res) => {
  const ai = aiStatus();
  const active = ai.providers.find((p) => p.configured && p.preferred_models.length);
  res.json({ ok: true, db: dbKind, ai: { configured: ai.configured, provider: active?.name ?? null, model: active?.preferred_models[0] ?? null }, at: new Date().toISOString() });
});

// Provider/model health for operators. Never includes keys.
app.get("/api/ai/status", (_req, res) => res.json(aiStatus()));

app.get("/api/config", (_req, res) =>
  res.json({
    voiceNumber: process.env.VOICE_NUMBER || null,
    whatsappLink: process.env.WHATSAPP_LINK || null,
    paymentsEnabled: paymentsEnabled(),
    mentorPricePaise: 4900,
  }),
);

// ---------- Learner-facing ----------

app.post(
  "/api/signup",
  wrap(async (req, res) => {
    const name = String(req.body.name ?? "").trim().slice(0, 80);
    const phone = normalizePhone(req.body.phone);
    const consent = req.body.consent === true || req.body.consent === "on" || req.body.consent === "true";
    if (!name) return res.status(400).json({ error: "Please tell us your name." });
    if (!phone) return res.status(400).json({ error: "Please enter a valid phone number (10 digits for India)." });
    if (!consent) return res.status(400).json({ error: "Please tick the consent box so we can store your progress." });
    const existing = await learnerByPhone(phone);
    if (existing) {
      // Only hand back the link if the name matches, so a phone number alone can't open someone else's profile.
      if (existing.name.trim().toLowerCase() === name.toLowerCase()) {
        if (!existing.consent) await q("update learners set consent = true where id=$1", [existing.id]);
        await logEvent("learner.signup_repeat", {}, existing.id);
        return res.json({ token: existing.token, existing: true });
      }
      return res.status(409).json({ error: "This number is already registered. Use the same name you signed up with." });
    }
    const l = await createLearner({
      name,
      phone,
      email: req.body.email ? String(req.body.email).slice(0, 120) : null,
      consent,
      isTest: req.body.test === true || req.body.test === "1",
      source: String(req.body.source ?? "web").slice(0, 40),
    });
    res.json({ token: l.token });
  }),
);

async function requireLearner(req: Request, res: Response): Promise<Learner | undefined> {
  const l = await learnerByToken(String(req.header("x-learner-token") ?? ""));
  if (!l) res.status(401).json({ error: "Unknown or expired link. Sign up again from the home page." });
  return l;
}

app.get(
  "/api/me",
  wrap(async (req, res) => {
    const l = await requireLearner(req, res);
    if (l) res.json(await profilePayload(l));
  }),
);

app.patch(
  "/api/me",
  wrap(async (req, res) => {
    const l = await requireLearner(req, res);
    if (!l) return;
    const changed: string[] = [];
    for (const k of ["name", "goal", "motivation", "struggle"] as const) {
      if (typeof req.body[k] === "string") {
        await q(`update learners set ${k}=$1, updated_at=now() where id=$2`, [req.body[k].trim().slice(0, 300), l.id]);
        changed.push(k);
      }
    }
    await logEvent("profile.update", { fields: changed, by: "learner" }, l.id);
    res.json({ ok: true });
  }),
);

// Learner corrects a fact the companion stored ("that's wrong, I do know this").
app.post(
  "/api/me/facts/:id",
  wrap(async (req, res) => {
    const l = await requireLearner(req, res);
    if (!l) return;
    const status = String(req.body.status ?? "");
    if (!["demonstrated", "gap", "inferred_gap", "removed"].includes(status)) return res.status(400).json({ error: "bad status" });
    const note = String(req.body.note ?? "").slice(0, 300) || null;
    const r = await q(
      "update profile_facts set status=$1, source='learner', learner_note=$2, updated_at=now() where id=$3 and learner_id=$4 returning id, concept",
      [status, note, Number(req.params.id), l.id],
    );
    if (!r.length) return res.status(404).json({ error: "not found" });
    await logEvent("profile.correction", { concept: r[0].concept, status, note }, l.id);
    res.json({ ok: true });
  }),
);

app.post(
  "/api/chat",
  wrap(async (req, res) => {
    const l = await requireLearner(req, res);
    if (!l) return;
    const msg = req.body.message == null ? null : String(req.body.message).slice(0, 1000);
    res.json(await mentorTurn(l, msg && msg.trim() ? msg : null));
  }),
);

// Same turn as /api/chat, streamed as server-sent events:
// {"type":"delta","text"} while the AI writes, then {"type":"done", ...TurnResult}.
app.post(
  "/api/chat/stream",
  wrap(async (req, res) => {
    const l = await requireLearner(req, res);
    if (!l) return;
    const msg = String(req.body.message ?? "").slice(0, 1000).trim();
    if (!msg) return res.status(400).json({ error: "message required" });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    try {
      const r = await mentorTurn(l, msg, "web", (text) => send({ type: "delta", text }));
      send({ type: "done", ...r });
    } catch (e: any) {
      console.error("stream turn failed:", e?.message ?? e);
      send({ type: "error", error: "Something went wrong. Please try again." });
    }
    res.end();
  }),
);

app.post(
  "/api/chat/reset",
  wrap(async (req, res) => {
    const l = await requireLearner(req, res);
    if (!l) return;
    await endSession(l.id, "web");
    res.json(await mentorTurn(l, null));
  }),
);

// ---------- Payments (Pine Labs hosted checkout) ----------

app.post(
  "/api/pay/mentor-review",
  wrap(async (req, res) => {
    const l = await requireLearner(req, res);
    if (!l) return;
    if (!paymentsEnabled()) return res.status(503).json({ error: "Payments are not switched on yet." });
    res.json({ redirect_url: await createCheckout(l, "mentor_review") });
  }),
);

// Pine Labs sends the shopper back here after checkout. Docs don't pin GET vs POST, so accept both.
app.all(
  "/pay/callback",
  wrap(async (req, res) => {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...req.query, ...(req.body ?? {}) })) if (typeof v === "string") params[k] = v;
    const ref = params.ref ?? "";
    const sig = verifyCallbackSignature(params, process.env.PINELABS_SECRET_KEY || process.env.PINELABS_CLIENT_SECRET);
    await logEvent("payment.callback", { ref, method: req.method, order_id: params.order_id, status: params.status, error_code: params.error_code, signature_check: sig });
    const r = ref ? await syncPayment(ref, "callback") : null;
    res.redirect(303, `/me?payment=${encodeURIComponent(r?.status ?? "UNKNOWN")}`);
  }),
);

// Webhook payload/signature format isn't documented on the pages we read, so we treat it
// only as a trigger and re-read the order from Pine Labs' API before changing anything.
app.post(
  "/webhooks/pinelabs",
  wrap(async (req, res) => {
    const b = req.body ?? {};
    const ref = b.data?.merchant_order_reference ?? b.merchant_order_reference ?? null;
    await logEvent("payment.webhook", { event_type: b.event_type ?? b.type ?? null, ref, order_id: b.data?.order_id ?? b.order_id ?? null });
    if (ref) await syncPayment(String(ref), "webhook");
    res.json({ received: true });
  }),
);

// ---------- ElevenLabs server tools (voice + WhatsApp agent) ----------

function requireToolSecret(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.TOOL_SECRET;
  const got = String(req.header("x-tool-secret") ?? "");
  if (!secret || !safeEq(got, secret)) {
    logEvent("tool.unauthorized", { path: req.path }).catch(() => {});
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

/** Find or create the learner behind a caller number, and the voice session for this conversation. */
async function voiceContext(body: any, channel: string) {
  const phone = normalizePhone(body.phone ?? body.caller_id);
  if (!phone) throw Object.assign(new Error("phone (caller id) missing or invalid"), { status: 400 });
  let l = await learnerByPhone(phone);
  let isNew = false;
  if (!l) {
    l = await createLearner({ name: String(body.name ?? "").trim() || "Caller", phone, consent: false, isTest: false, source: channel });
    isNew = true;
  }
  const convId = body.conversation_id ? String(body.conversation_id) : null;
  let s = convId ? await one<{ id: number }>("select id from sessions where external_id=$1", [convId]) : undefined;
  if (!s) {
    s = (await one<{ id: number }>(
      "insert into sessions (learner_id, channel, external_id, stage, is_test) values ($1,$2,$3,'DISCOVER',$4) returning id",
      [l.id, channel, convId, l.is_test],
    ))!;
    await logEvent("session.start", { channel, conversation_id: convId }, l.id, s.id);
  }
  return { learner: l, sessionId: s.id, isNew };
}

const toolChannel = (req: Request) => (String(req.body.channel ?? "voice").toLowerCase() === "whatsapp" ? "whatsapp" : "voice");

app.post(
  "/tools/get_profile",
  requireToolSecret,
  wrap(async (req, res) => {
    const { learner, sessionId, isNew } = await voiceContext(req.body, toolChannel(req));
    const view = await learnerView(learner);
    const topic = defaultTopic();
    const plan = prioritize(topic, learner.struggle ?? String(req.body.struggle ?? ""), view.facts)
      .slice(0, 3)
      .map((id) => {
        const c = getConcept(topic.id, id)!;
        return {
          concept: c.id,
          name: c.name,
          diagnose_question: c.diagnose.prompt,
          diagnose_answer: c.diagnose.explain,
          lesson: c.lesson,
          retest_question: c.retest.prompt,
          retest_answer: c.retest.explain,
          next_step: c.next_step,
        };
      });
    const ctx = await loadContext(learner);
    await logEvent("tool.get_profile", { is_new: isNew }, learner.id, sessionId);
    res.json({
      learner_name: learner.name === "Caller" ? null : learner.name,
      is_new: isNew,
      goal: learner.goal,
      motivation: learner.motivation,
      struggle: learner.struggle,
      known_facts: view.facts,
      misconceptions: ctx.facts.filter((f) => f.status === "gap").map((f) => ({ concept: f.concept, evidence: f.evidence })),
      recent_outcomes: ctx.outcomes,
      // Same memory as web chat: the last messages from any channel, oldest first.
      recent_conversation: ctx.history.slice(-10).map((m) => ({ role: m.role === "user" ? "learner" : "mentor", text: m.text.slice(0, 400) })),
      topic: topic.title,
      plan,
      all_clear_next_step: topic.all_clear_next_step,
    });
  }),
);

app.post(
  "/tools/record_attempt",
  requireToolSecret,
  wrap(async (req, res) => {
    const { learner, sessionId } = await voiceContext(req.body, toolChannel(req));
    const topic = defaultTopic();
    const c = getConcept(topic.id, String(req.body.concept ?? ""));
    if (!c) return res.status(400).json({ error: `unknown concept; use one of ${topic.concepts.map((x) => x.id).join(", ")}` });
    const phase = req.body.phase === "retest" ? "retest" : "diagnose";
    const answer = String(req.body.answer ?? "");
    const qn = phase === "retest" ? c.retest : c.diagnose;
    const engineCorrect = grade(qn, answer);
    const llmCorrect = typeof req.body.correct === "boolean" ? req.body.correct : req.body.correct === "true" ? true : req.body.correct === "false" ? false : null;
    const correct = llmCorrect ?? engineCorrect;
    const fx = effectsFor(learner, sessionId, llmCorrect === null ? "engine" : "voice_agent");
    await fx.attempt({ topic: topic.id, concept: c.id, phase, questionId: qn.id, question: String(req.body.question ?? qn.prompt), answer, correct });
    if (phase === "diagnose") {
      await fx.fact(c.id, correct ? "demonstrated" : "gap", "demonstrated", `${correct ? "Answered" : "Missed"} by voice: "${answer}"`);
    } else if (correct) {
      await fx.fact(c.id, "demonstrated", "demonstrated", `Got it after the lesson, by voice: "${answer}"`);
    }
    await q("update sessions set stage=$1, updated_at=now() where id=$2", [phase === "retest" ? "RETEST" : correct ? "DIAGNOSE" : "TEACH", sessionId]);
    res.json({ recorded: true, correct, engine_correct: engineCorrect, correct_answer: qn.explain });
  }),
);

app.post(
  "/tools/save_outcome",
  requireToolSecret,
  wrap(async (req, res) => {
    const { learner, sessionId } = await voiceContext(req.body, toolChannel(req));
    const fx = effectsFor(learner, sessionId, "voice_agent");
    const profile: Record<string, string> = {};
    for (const k of ["goal", "motivation", "struggle"]) if (req.body[k]) profile[k] = String(req.body[k]).slice(0, 300);
    if (Object.keys(profile).length) await fx.profile(profile);
    if (req.body.name && learner.name === "Caller") await q("update learners set name=$1 where id=$2", [String(req.body.name).slice(0, 80), learner.id]);
    const gap = req.body.gap_concept && getConcept(defaultTopic().id, String(req.body.gap_concept)) ? String(req.body.gap_concept) : null;
    const b = (v: unknown) => (v === true || v === "true" ? true : v === false || v === "false" ? false : null);
    await fx.outcome({
      topic: defaultTopic().id,
      gapConcept: gap,
      beforeCorrect: b(req.body.before_correct),
      afterCorrect: b(req.body.after_correct),
      nextStep: String(req.body.next_step ?? "").slice(0, 600),
      summary: String(req.body.summary ?? "").slice(0, 1000),
    });
    await q("update sessions set stage='DONE', ended_at=coalesce(ended_at, now()), updated_at=now() where id=$1", [sessionId]);
    res.json({ saved: true, profile_link_hint: "Tell the learner they can see their progress on the website after signing up with this same phone number." });
  }),
);

// ---------- Agent API (called by the AgenticOrg agent) ----------

function requireAgent(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.AGENT_SECRET;
  const h = req.header("authorization") ?? "";
  const got = h.startsWith("Bearer ") ? h.slice(7) : String(req.header("x-agent-secret") ?? "");
  if (!secret || !safeEq(got, secret)) {
    logEvent("agent.unauthorized", { path: req.path }).catch(() => {});
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.get(
  "/api/agent/stalled-learners",
  requireAgent,
  wrap(async (_req, res) => {
    const learners = await stalledLearners();
    await logEvent("agent.read_stalled", { count: learners.length });
    res.json({ count: learners.length, learners });
  }),
);

// One call = one agent run: find stalled learners and queue a draft nudge for each. Nothing is sent.
app.post(
  "/api/agent/stalled-followup/run",
  requireAgent,
  wrap(async (req, res) => {
    const trigger = String(req.body.trigger ?? "agenticorg").slice(0, 60);
    const runId = await startRun("stalled_learner_followup", trigger, { source: req.body.source ?? "agenticorg", external_run_id: req.body.external_run_id ?? null });
    try {
      const learners = await stalledLearners();
      const drafts: Record<string, string> = req.body.drafts ?? {};
      const queued = [];
      for (const l of learners) {
        const draft = drafts[String(l.learner_id)] || l.suggested_draft;
        queued.push({ learner_id: l.learner_id, first_name: l.first_name, gap: l.gap_name, approval_id: await proposeNudge(runId, l.learner_id, draft), draft });
      }
      await finishRun(runId, "awaiting_approval", { stalled: learners.length, queued: queued.map((x) => x.approval_id) });
      res.json({ agent_run_id: runId, stalled: learners.length, queued, note: "Drafts need human approval before anything is sent." });
    } catch (e: any) {
      await finishRun(runId, "error", { error: e?.message });
      throw e;
    }
  }),
);

app.post(
  "/api/agent/nudges",
  requireAgent,
  wrap(async (req, res) => {
    const learnerId = Number(req.body.learner_id);
    const draft = String(req.body.draft ?? "").trim();
    if (!learnerId || !draft) return res.status(400).json({ error: "learner_id and draft required" });
    const id = await proposeNudge(req.body.agent_run_id ? Number(req.body.agent_run_id) : null, learnerId, draft);
    res.json({ approval_id: id, status: "pending" });
  }),
);

app.get(
  "/api/agent/approvals",
  requireAgent,
  wrap(async (req, res) => {
    const status = String(req.query.status ?? "pending");
    res.json(
      await q(
        "select a.id, a.learner_id, l.name, a.kind, a.status, a.draft, a.final_text, a.decided_by, a.decided_at, a.created_at from approvals a left join learners l on l.id=a.learner_id where a.status=$1 order by a.id desc limit 100",
        [status],
      ),
    );
  }),
);

// Called after a human approved/rejected inside AgenticOrg's HITL step.
app.post(
  "/api/agent/approvals/:id/decision",
  requireAgent,
  wrap(async (req, res) => {
    const decision = req.body.decision === "reject" ? "reject" : req.body.decision === "approve" ? "approve" : null;
    const by = String(req.body.decided_by ?? "").trim();
    if (!decision || !by) return res.status(400).json({ error: "decision (approve|reject) and decided_by (the human) required" });
    res.json(await decide(Number(req.params.id), decision, `${by.slice(0, 60)} via agenticorg`, req.body.final_text));
  }),
);

// ---------- Admin / proof of life ----------

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const pw = process.env.ADMIN_PASSWORD;
  const h = req.header("authorization") ?? "";
  const given = h.startsWith("Basic ") ? Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":") : "";
  if (!pw || !safeEq(given, pw)) return res.status(401).json({ error: "admin auth required" });
  next();
}

app.get(
  "/api/admin/summary",
  requireAdmin,
  wrap(async (_req, res) => {
    const [counts] = await q(`select
      (select count(*) from learners where not is_test)::int as real_learners,
      (select count(*) from learners where is_test)::int as test_learners,
      (select count(*) from learners where not is_test and consent)::int as consented_learners,
      (select count(*) from sessions s join learners l on l.id=s.learner_id where not l.is_test)::int as real_sessions,
      (select count(*) from outcomes o join learners l on l.id=o.learner_id where not l.is_test)::int as real_outcomes,
      (select count(*) from outcomes o join learners l on l.id=o.learner_id where not l.is_test and o.gap_concept is not null and o.after_correct)::int as real_unstuck,
      (select count(*) from payments p join learners l on l.id=p.learner_id where not l.is_test and p.status='SUCCESS')::int as real_payments,
      (select count(*) from agent_runs)::int as agent_runs,
      (select count(*) from approvals where status='pending')::int as pending_approvals`);
    const [learners, sessions, outcomes, payments, agentRuns, approvals, events] = await Promise.all([
      q("select id, name, phone, consent, is_test, source, goal, struggle, created_at from learners order by id desc limit 500"),
      q(`select s.id, s.learner_id, l.name, s.channel, s.stage, s.external_id, jsonb_array_length(s.transcript) as turns, s.started_at, s.ended_at, l.is_test
         from sessions s left join learners l on l.id=s.learner_id order by s.id desc limit 300`),
      q(`select o.*, l.name, l.is_test from outcomes o left join learners l on l.id=o.learner_id order by o.id desc limit 300`),
      q(`select p.id, p.learner_id, l.name, p.product, p.amount_paise, p.status, p.merchant_order_ref, p.provider_order_id, p.created_at, p.updated_at, l.is_test
         from payments p left join learners l on l.id=p.learner_id order by p.id desc limit 300`),
      q("select * from agent_runs order by id desc limit 200"),
      q(`select a.*, l.name from approvals a left join learners l on l.id=a.learner_id order by a.id desc limit 200`),
      q("select * from events order by id desc limit 300"),
    ]);
    res.json({ now: new Date().toISOString(), counts, learners, sessions, outcomes, payments, agentRuns, approvals, events });
  }),
);

app.get(
  "/api/admin/sessions/:id",
  requireAdmin,
  wrap(async (req, res) => {
    res.json(await one("select * from sessions where id=$1", [Number(req.params.id)]));
  }),
);

app.post(
  "/api/admin/approvals/:id/decide",
  requireAdmin,
  wrap(async (req, res) => {
    const decision = req.body.decision === "reject" ? "reject" : "approve";
    res.json(await decide(Number(req.params.id), decision, String(req.body.decided_by || "admin").slice(0, 60), req.body.final_text));
  }),
);

app.post(
  "/api/admin/agent/stalled-followup/run",
  requireAdmin,
  wrap(async (_req, res) => {
    const runId = await startRun("stalled_learner_followup", "admin_manual", {});
    const learners = await stalledLearners();
    const ids = [];
    for (const l of learners) ids.push(await proposeNudge(runId, l.learner_id, l.suggested_draft));
    await finishRun(runId, "awaiting_approval", { stalled: learners.length, queued: ids });
    res.json({ agent_run_id: runId, queued: ids.length });
  }),
);

app.post(
  "/api/admin/payments/:ref/sync",
  requireAdmin,
  wrap(async (req, res) => {
    res.json(await syncPayment(String(req.params.ref), "admin"));
  }),
);

app.post(
  "/api/admin/learners/:id/test",
  requireAdmin,
  wrap(async (req, res) => {
    const isTest = !!req.body.is_test;
    await q("update learners set is_test=$1 where id=$2", [isTest, Number(req.params.id)]);
    await q("update sessions set is_test=$1 where learner_id=$2", [isTest, Number(req.params.id)]);
    await logEvent("admin.mark_test", { is_test: isTest }, Number(req.params.id));
    res.json({ ok: true });
  }),
);

app.use(express.static(path.resolve("public"), { extensions: ["html"] }));

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err?.message ?? err);
  res.status(err?.status ?? 500).json({ error: err?.status ? err.message : "Something went wrong" });
});

const port = Number(process.env.PORT || 3000);
await initDb();
app.listen(port, () => console.log(`listening on :${port} (db=${dbKind}, ai=${aiConfigured() ? "on" : "off"})`));
if (aiConfigured() && process.env.AI_PROBE !== "0") {
  // One startup probe to rank models by real latency. Free tiers have small daily
  // per-model quotas, so we don't re-probe; runtime failover handles later outages.
  probe(3).catch((e) => console.error("ai probe failed", e?.message));
}

// Free Render instances sleep after ~15 min without inbound traffic. Pinging our own
// public URL goes through Render's router, so it counts as inbound and keeps us warm.
const selfUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL;
if (selfUrl) {
  setInterval(() => {
    fetch(`${selfUrl.replace(/\/$/, "")}/health?ping=self`).catch((e) => console.error("keepalive failed", e?.message));
  }, 10 * 60 * 1000);
}


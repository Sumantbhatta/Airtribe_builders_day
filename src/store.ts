import crypto from "node:crypto";
import { q, one, logEvent } from "./db.js";
import { Effects, LearnerView, getConcept, topics } from "./engine.js";

export interface Learner {
  id: number;
  name: string;
  phone: string | null;
  wa_number: string | null;
  email: string | null;
  consent: boolean;
  token: string;
  is_test: boolean;
  goal: string | null;
  motivation: string | null;
  struggle: string | null;
  created_at: string;
}

/** Normalise Indian-style numbers to +91XXXXXXXXXX; leave other international numbers as +digits. */
export function normalizePhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const d = String(raw).replace(/[^\d]/g, "");
  if (d.length === 10) return `+91${d}`;
  if (d.length === 11 && d.startsWith("0")) return `+91${d.slice(1)}`;
  if (d.length >= 11 && d.length <= 15) return `+${d}`;
  return null;
}

export const newToken = () => crypto.randomBytes(18).toString("base64url");

export async function learnerByToken(token: string | undefined): Promise<Learner | undefined> {
  if (!token) return undefined;
  return one<Learner>("select * from learners where token = $1", [token]);
}

export async function learnerByPhone(phone: string | null): Promise<Learner | undefined> {
  if (!phone) return undefined;
  return one<Learner>("select * from learners where phone = $1 or wa_number = $1 order by id limit 1", [phone]);
}

export async function createLearner(fields: {
  name: string;
  phone: string | null;
  email?: string | null;
  consent: boolean;
  isTest: boolean;
  source: string;
}): Promise<Learner> {
  const l = (await one<Learner>(
    `insert into learners (name, phone, email, consent, token, is_test, source)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [fields.name, fields.phone, fields.email ?? null, fields.consent, newToken(), fields.isTest, fields.source],
  ))!;
  await logEvent("learner.signup", { source: fields.source, is_test: fields.isTest, has_phone: !!fields.phone }, l.id);
  return l;
}

export async function learnerView(l: Learner): Promise<LearnerView> {
  const facts = await q<{ concept: string; status: string }>("select concept, status from profile_facts where learner_id = $1", [l.id]);
  return { name: l.name, goal: l.goal, motivation: l.motivation, struggle: l.struggle, facts };
}

export function effectsFor(learner: Learner, sessionId: number | null, gradedBy = "engine"): Effects {
  return {
    async attempt(a) {
      await q(
        `insert into attempts (session_id, learner_id, topic, concept, phase, question_id, question, answer, correct, graded_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [sessionId, learner.id, a.topic, a.concept, a.phase, a.questionId, a.question, a.answer, a.correct, a.gradedBy ?? gradedBy],
      );
      await logEvent("learning.attempt", { concept: a.concept, phase: a.phase, correct: a.correct, graded_by: a.gradedBy ?? gradedBy }, learner.id, sessionId);
    },
    async fact(concept, status, kind, evidence) {
      const topic = topics().find((t) => t.concepts.some((c) => c.id === concept))?.id ?? null;
      await q(
        `insert into profile_facts (learner_id, topic, concept, status, kind, evidence, source)
         values ($1,$2,$3,$4,$5,$6,'engine')
         on conflict (learner_id, concept) do update set
           status = case when profile_facts.kind = 'demonstrated' and excluded.kind = 'inferred' then profile_facts.status else excluded.status end,
           kind = case when profile_facts.kind = 'demonstrated' then 'demonstrated' else excluded.kind end,
           evidence = case when profile_facts.kind = 'demonstrated' and excluded.kind = 'inferred' then profile_facts.evidence else excluded.evidence end,
           source = 'engine', updated_at = now()`,
        [learner.id, topic, concept, status, kind, evidence],
      );
      await logEvent("profile.fact", { concept, status, kind }, learner.id, sessionId);
    },
    async profile(fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (!["goal", "motivation", "struggle"].includes(k)) continue;
        await q(`update learners set ${k} = $1, updated_at = now() where id = $2`, [v, learner.id]);
        (learner as any)[k] = v;
      }
      await logEvent("profile.update", { fields: Object.keys(fields), by: "engine" }, learner.id, sessionId);
    },
    async outcome(o) {
      const ch = sessionId ? await one<{ channel: string }>("select channel from sessions where id=$1", [sessionId]) : undefined;
      await q(
        `insert into outcomes (session_id, learner_id, channel, topic, gap_concept, before_correct, after_correct, next_step, summary)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [sessionId, learner.id, ch?.channel ?? null, o.topic, o.gapConcept, o.beforeCorrect, o.afterCorrect, o.nextStep, o.summary],
      );
      await logEvent("learning.outcome", { gap: o.gapConcept, before: o.beforeCorrect, after: o.afterCorrect }, learner.id, sessionId);
    },
  };
}

export async function endSession(learnerId: number, channel = "web") {
  const rows = await q<{ id: number }>(
    "update sessions set ended_at = now() where learner_id=$1 and channel=$2 and ended_at is null returning id",
    [learnerId, channel],
  );
  for (const r of rows) await logEvent("session.end", { channel }, learnerId, r.id);
}

export async function profilePayload(l: Learner) {
  const [facts, outcomes, attempts, payments, feedback, inbox] = await Promise.all([
    q("select id, concept, status, kind, evidence, source, learner_note, updated_at from profile_facts where learner_id=$1 order by updated_at desc", [l.id]),
    q("select id, channel, gap_concept, before_correct, after_correct, next_step, summary, created_at from outcomes where learner_id=$1 order by id desc limit 20", [l.id]),
    q("select concept, phase, question, answer, correct, created_at from attempts where learner_id=$1 order by id desc limit 30", [l.id]),
    q("select id, product, amount_paise, status, created_at from payments where learner_id=$1 order by id desc", [l.id]),
    q("select final_text, decided_at from approvals where learner_id=$1 and kind='mentor_review' and status in ('approved','sent') order by id desc", [l.id]),
    q("select final_text as text, decided_at as at from approvals where learner_id=$1 and kind='stalled_nudge' and status='sent' order by id desc limit 5", [l.id]),
  ]);
  const named = (rows: any[]) =>
    rows.map((r) => {
      const c = r.concept ?? r.gap_concept;
      const concept = c ? getConcept("java-basics", c) : undefined;
      return { ...r, concept_name: concept?.name ?? c ?? null, lesson: concept?.lesson ?? null };
    });
  return {
    learner: { name: l.name, phone: l.phone, goal: l.goal, motivation: l.motivation, struggle: l.struggle, created_at: l.created_at },
    facts: named(facts),
    outcomes: named(outcomes),
    attempts,
    payments,
    mentor_feedback: feedback,
    inbox,
  };
}

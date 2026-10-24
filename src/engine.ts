import fs from "node:fs";
import path from "node:path";
import type { AiQuestion, LearnerCtx, Tutor } from "./tutor.js";

// DISCOVER -> DIAGNOSE -> TEACH -> RETEST -> UPDATE PROFILE -> NEXT STEP
// Config-driven curriculum. With an AI tutor, each step is personalised by the LLM
// (grounded in this config). Without one, or when a call fails, the step falls back
// to the config content and the turn is labelled "fallback" so nobody mistakes it
// for a live AI response.

export interface Question {
  id: string;
  prompt: string;
  accept: string[];
  reject?: string[];
  explain: string;
}
export interface Concept {
  id: string;
  name: string;
  keywords: string[];
  diagnose: Question;
  lesson: string;
  retest: Question;
  next_step: string;
}
export interface Topic {
  id: string;
  title: string;
  match: string[];
  discover: { key: "goal" | "motivation" | "struggle"; prompt: string }[];
  concepts: Concept[];
  all_clear_next_step: string;
}

export type Stage = "DISCOVER" | "DIAGNOSE" | "RETEST" | "DONE";
/** ai = produced by the LLM; fallback = config content because AI was off or failed. */
export type TurnSource = "ai" | "fallback";

/** The question currently waiting for an answer. */
export interface AskedQuestion {
  concept: string;
  phase: "diagnose" | "retest";
  prompt: string;
  answerKey: string;
  /** "config" questions can also be graded by the deterministic regex grader. */
  origin: "config" | "ai";
}

export interface EngineState {
  stage: Stage;
  topicId: string;
  discoverIdx: number;
  answers: Record<string, string>;
  queue: string[];
  tried: string[];
  demonstrated: string[];
  current?: string;
  gap?: string;
  before?: boolean;
  after?: boolean;
  asked?: AskedQuestion;
  language?: string;
  misconception?: string;
}

export interface LearnerView {
  name: string;
  goal?: string | null;
  motivation?: string | null;
  struggle?: string | null;
  facts: { concept: string; status: string }[];
}

export interface Attempt {
  topic: string;
  concept: string;
  phase: "diagnose" | "retest";
  questionId: string;
  question: string;
  answer: string;
  correct: boolean;
  gradedBy?: "ai" | "engine" | "engine_fallback";
}
export interface Outcome {
  topic: string;
  gapConcept: string | null;
  beforeCorrect: boolean | null;
  afterCorrect: boolean | null;
  nextStep: string;
  summary: string;
}

/** Side effects the engine asks the caller to persist. */
export interface Effects {
  attempt(a: Attempt): Promise<void>;
  fact(concept: string, status: "demonstrated" | "gap" | "inferred_gap", kind: "demonstrated" | "inferred", evidence: string): Promise<void>;
  profile(fields: Partial<Record<"goal" | "motivation" | "struggle", string>>): Promise<void>;
  outcome(o: Outcome): Promise<void>;
}

export interface TurnResult {
  state: EngineState;
  replies: string[];
  source: TurnSource;
}

const MAX_DIAGNOSE = 3;

const TOPICS: Topic[] = fs
  .readdirSync(path.resolve("topics"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(fs.readFileSync(path.resolve("topics", f), "utf8")));

export const topics = () => TOPICS;
export const defaultTopic = () => TOPICS[0];
export const getTopic = (id: string) => TOPICS.find((t) => t.id === id) ?? TOPICS[0];
export function getConcept(topicId: string, conceptId: string): Concept | undefined {
  return getTopic(topicId).concepts.find((c) => c.id === conceptId);
}

export function grade(q: Question, answer: string): boolean {
  const a = answer.toLowerCase().trim();
  if (!a) return false;
  const hit = (p: string) => new RegExp(p, "i").test(a);
  return q.accept.some(hit) && !(q.reject ?? []).some(hit);
}

/** Last-resort check for an AI-written question when the AI grader is unavailable. */
export function looseMatch(answerKey: string, answer: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}.=]+/gu, " ").trim();
  const key = norm(answerKey).split(" ").slice(0, 3).join(" ");
  const a = norm(answer);
  return !!key && a.length <= 80 && new RegExp(`(^| )${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(a);
}

/** Order concepts: known gaps first, then ones matching what the learner says is hard, skipping demonstrated ones. */
export function prioritize(topic: Topic, struggle: string, facts: LearnerView["facts"]): string[] {
  const s = struggle.toLowerCase();
  const status = new Map(facts.map((f) => [f.concept, f.status]));
  const score = (c: Concept) =>
    (status.get(c.id) === "gap" ? 100 : 0) +
    (status.get(c.id) === "inferred_gap" ? 50 : 0) +
    c.keywords.filter((k) => s.includes(k.toLowerCase())).length * 10 -
    (status.get(c.id) === "demonstrated" ? 1000 : 0);
  const ranked = topic.concepts.map((c, i) => ({ id: c.id, sc: score(c), i })).sort((x, y) => y.sc - x.sc || x.i - y.i);
  const fresh = ranked.filter((r) => r.sc > -500).map((r) => r.id);
  // If they've demonstrated everything, re-check the lot.
  return fresh.length ? fresh : ranked.map((r) => r.id);
}

/** Concepts the learner's own words point at (self-reported, not yet demonstrated). */
export function inferredGaps(topic: Topic, struggle: string): string[] {
  const s = struggle.toLowerCase();
  return topic.concepts.filter((c) => c.keywords.some((k) => s.includes(k.toLowerCase()))).map((c) => c.id);
}

function pickTopic(goal: string): Topic {
  const g = goal.toLowerCase();
  return TOPICS.find((t) => t.match.some((m) => g.includes(m))) ?? defaultTopic();
}

const configQ = (c: Concept, phase: "diagnose" | "retest"): AskedQuestion => {
  const q = phase === "retest" ? c.retest : c.diagnose;
  return { concept: c.id, phase, prompt: q.prompt, answerKey: q.explain, origin: "config" };
};
const aiQ = (c: Concept, phase: "diagnose" | "retest", q: AiQuestion): AskedQuestion => ({
  concept: c.id,
  phase,
  prompt: q.prompt,
  answerKey: q.answer_key,
  origin: "ai",
});

function ctxOf(s: EngineState, name: string): LearnerCtx {
  return { name, goal: s.answers.goal, motivation: s.answers.motivation, struggle: s.answers.struggle, language: s.language };
}

/** Choose the concept order and the first question (AI if possible, else config). */
async function planDiagnosis(s: EngineState, name: string, facts: LearnerView["facts"], ai?: Tutor): Promise<{ intro: string | null; ok: boolean }> {
  const t = getTopic(s.topicId);
  if (ai) {
    const status = Object.fromEntries(facts.map((f) => [f.concept, f.status]));
    const p = await ai.plan(ctxOf(s, name), t, status);
    if (p) {
      s.queue = p.order;
      s.current = p.order[0];
      s.asked = aiQ(getConcept(t.id, p.order[0])!, "diagnose", p.first);
      s.language = p.language;
      return { intro: p.intro, ok: true };
    }
  }
  s.queue = prioritize(t, s.answers.struggle ?? "", facts);
  s.current = s.queue[0];
  s.asked = configQ(getConcept(t.id, s.current)!, "diagnose");
  return { intro: null, ok: !ai };
}

export async function start(learner: LearnerView, ai?: Tutor): Promise<TurnResult> {
  const topic = defaultTopic();
  const returning = !!(learner.goal && learner.struggle);
  const state: EngineState = {
    stage: "DISCOVER",
    topicId: topic.id,
    discoverIdx: 0,
    answers: {},
    queue: [],
    tried: [],
    demonstrated: [],
  };
  if (returning) {
    state.answers = { goal: learner.goal!, motivation: learner.motivation ?? "", struggle: learner.struggle! };
    state.topicId = pickTopic(learner.goal!).id;
    state.stage = "DIAGNOSE";
    const { ok } = await planDiagnosis(state, learner.name, learner.facts, ai);
    return {
      state,
      source: ai && ok ? "ai" : "fallback",
      replies: [`Welcome back, ${learner.name}. Last time you said "${learner.struggle}" felt hard. Let's see where you are now.`, state.asked!.prompt],
    };
  }
  return {
    state,
    source: "fallback",
    replies: [
      `Hi ${learner.name}! I'm your learning companion. No forms. I'll ask a couple of quick questions, find the one thing tripping you up, and fix it with you. You can talk to me in any language.`,
      topic.discover[0].prompt,
    ],
  };
}

export async function step(state: EngineState, message: string, fx: Effects, ai?: Tutor, learnerName = "there"): Promise<TurnResult> {
  const s: EngineState = structuredClone(state);
  const topic = getTopic(s.topicId);
  const msg = message.trim();
  const replies: string[] = [];
  let aiFailed = !ai; // no tutor configured counts as fallback
  const done = (): TurnResult => ({ state: s, replies, source: aiFailed ? "fallback" : "ai" });

  if (s.stage === "DONE") {
    if (/\b(again|another|more|next|yes|continue|go|haan|ha|chalo|aur)\b/i.test(msg)) {
      s.queue = s.queue.filter((id) => id !== s.gap && !s.demonstrated.includes(id) && !s.tried.includes(id));
      if (!s.queue.length) {
        replies.push("You've worked through every concept I have for this topic today. Check your profile page for your next step.");
        return { state: s, replies, source: "fallback" };
      }
      Object.assign(s, { stage: "DIAGNOSE", tried: [], gap: undefined, before: undefined, after: undefined, misconception: undefined, current: s.queue[0] });
      const c = getConcept(s.topicId, s.queue[0])!;
      const q = ai ? await ai.ask(ctxOf(s, learnerName), c, "diagnose", [c.diagnose.prompt]) : null;
      if (ai && !q) aiFailed = true;
      s.asked = q ? aiQ(c, "diagnose", q) : configQ(c, "diagnose");
      replies.push("Let's find the next thing.", s.asked.prompt);
      return done();
    }
    replies.push(`We're done for this round. Type "again" for another check, or open your profile to see what we found.`);
    return { state: s, replies, source: "fallback" };
  }

  if (s.stage === "DISCOVER") {
    const d = topic.discover[s.discoverIdx];
    s.answers[d.key] = msg.slice(0, 300);
    await fx.profile({ [d.key]: msg.slice(0, 300) });
    if (d.key === "goal") s.topicId = pickTopic(msg).id;
    s.discoverIdx++;
    const t = getTopic(s.topicId);
    if (s.discoverIdx < t.discover.length) {
      const next = t.discover[s.discoverIdx];
      const r = ai ? await ai.discoverNext(ctxOf(s, learnerName), s.answers, next.key, next.prompt) : null;
      if (ai && !r) aiFailed = true;
      if (r) s.language = r.language;
      replies.push(r?.question ?? next.prompt);
      return done();
    }
    for (const c of inferredGaps(t, s.answers.struggle ?? "")) {
      await fx.fact(c, "inferred_gap", "inferred", `Learner said: "${s.answers.struggle}"`);
    }
    s.stage = "DIAGNOSE";
    const { intro, ok } = await planDiagnosis(s, learnerName, [], ai);
    if (ai && !ok) aiFailed = true;
    replies.push(intro || `Got it. Let me ask one quick ${t.title} question to find exactly where you're stuck. Just answer in your own words, and "I don't know" is a fine answer.`);
    replies.push(s.asked!.prompt);
    return done();
  }

  const c = getConcept(s.topicId, s.current!)!;
  const asked = s.asked ?? configQ(c, s.stage === "RETEST" ? "retest" : "diagnose");
  const phase = asked.phase;
  const nextId = phase === "diagnose" ? s.queue.find((id) => id !== c.id && !s.tried.includes(id)) : undefined;
  const canContinue = !!nextId && s.tried.length + 1 < MAX_DIAGNOSE;

  // ---- Grade: AI first (any language), deterministic grader as fallback / second opinion.
  const ev = ai
    ? await ai.evaluate({
        ctx: ctxOf(s, learnerName),
        concept: c,
        phase,
        question: { prompt: asked.prompt, answer_key: asked.answerKey },
        answer: msg,
        nextConcept: canContinue ? getConcept(s.topicId, nextId!) : undefined,
      })
    : null;
  if (ai && !ev) aiFailed = true;
  if (ev) s.language = ev.language;
  const detCorrect = asked.origin === "config" ? grade(phase === "retest" ? c.retest : c.diagnose, msg) : looseMatch(asked.answerKey, msg);
  const correct = ev ? ev.correct : detCorrect;
  const gradedBy = ev ? "ai" : asked.origin === "config" ? "engine" : "engine_fallback";
  const qid = asked.origin === "config" ? (phase === "retest" ? c.retest.id : c.diagnose.id) : `${c.id}_${phase}_ai`;
  await fx.attempt({ topic: s.topicId, concept: c.id, phase, questionId: qid, question: asked.prompt, answer: msg, correct, gradedBy });

  if (phase === "diagnose") {
    s.tried.push(c.id);
    if (correct) {
      s.demonstrated.push(c.id);
      await fx.fact(c.id, "demonstrated", "demonstrated", `Answered "${msg.slice(0, 120)}" to: ${asked.prompt}`);
      const feedback = ev?.feedback ?? `Correct. ${c.diagnose.explain}`;
      if (canContinue) {
        const nc = getConcept(s.topicId, nextId!)!;
        s.current = nc.id;
        if (ev && !ev.next_question) aiFailed = true;
        s.asked = ev?.next_question ? aiQ(nc, "diagnose", ev.next_question) : configQ(nc, "diagnose");
        replies.push(`${feedback} You've got that one. Next:`, s.asked.prompt);
        return done();
      }
      s.stage = "DONE";
      s.asked = undefined;
      const nextStep = topic.all_clear_next_step;
      await fx.outcome({ topic: s.topicId, gapConcept: null, beforeCorrect: null, afterCorrect: null, nextStep, summary: `No gap found in ${s.tried.length} checks; demonstrated: ${s.demonstrated.join(", ")}` });
      replies.push(feedback, `You didn't miss a single check today, so no gap to fix right now. Your next step: ${nextStep}`);
      return done();
    }
    // Gap found -> TEACH, then RETEST in the same turn.
    s.gap = c.id;
    s.before = false;
    s.stage = "RETEST";
    s.misconception = ev && ev.misconception !== "none" ? ev.misconception : undefined;
    await fx.fact(c.id, "gap", "demonstrated", `Missed: ${asked.prompt} (answered "${msg.slice(0, 120)}")${s.misconception ? `. Misconception: ${s.misconception}` : ""}`);
    if (ev && (!ev.lesson || !ev.retest)) aiFailed = true;
    s.asked = ev?.retest ? aiQ(c, "retest", ev.retest) : configQ(c, "retest");
    replies.push(ev ? `${ev.feedback} I found the gap: ${c.name}.` : `Not quite, and that's useful. I found the gap: ${c.name}. ${c.diagnose.explain}`);
    replies.push(ev?.lesson ?? `Here's the one-minute version. ${c.lesson}`);
    replies.push(`Let's check it stuck. ${s.asked.prompt}`);
    return done();
  }

  // ---- RETEST
  s.after = correct;
  s.stage = "DONE";
  s.asked = undefined;
  if (correct) {
    await fx.fact(c.id, "demonstrated", "demonstrated", `Missed it before the lesson, got it after: "${msg.slice(0, 120)}" to ${asked.prompt}`);
  }
  if (ev && !ev.next_step) aiFailed = true;
  const nextStep =
    ev?.next_step ??
    (correct ? c.next_step : `Re-read the lesson on ${c.name} on your profile page, then try one more question. Or book a human mentor review and someone will walk you through it.`);
  await fx.outcome({
    topic: s.topicId,
    gapConcept: c.id,
    beforeCorrect: false,
    afterCorrect: correct,
    nextStep,
    summary: `Gap: ${c.name}. Before: wrong. After lesson: ${correct ? "right" : "still wrong"}.${s.misconception ? ` Misconception: ${s.misconception}` : ""}`,
  });
  if (ev) replies.push(correct ? `${ev.feedback} Before the lesson you missed this, now you've got it.` : ev.feedback);
  else replies.push(correct ? `Yes! ${c.retest.explain} Before the lesson you missed this, now you've got it.` : `Not yet. ${c.retest.explain} That's okay, this one takes a couple of passes.`);
  replies.push(`I've saved this to your profile. Your next step: ${nextStep}`);
  replies.push(`Type "again" to find the next thing to work on.`);
  return done();
}

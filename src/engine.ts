import fs from "node:fs";
import path from "node:path";

// DISCOVER -> DIAGNOSE -> TEACH -> RETEST -> UPDATE PROFILE -> NEXT STEP
// Deterministic and config-driven, so the web chat works with no LLM key and
// the voice agent can pull the same questions/lessons through server tools.

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

export function start(learner: LearnerView): { state: EngineState; replies: string[] } {
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
    state.queue = prioritize(getTopic(state.topicId), learner.struggle!, learner.facts);
    state.stage = "DIAGNOSE";
    const first = getConcept(state.topicId, state.queue[0])!;
    state.current = first.id;
    return {
      state,
      replies: [
        `Welcome back, ${learner.name}. Last time you said "${learner.struggle}" felt hard. Let's see where you are now.`,
        first.diagnose.prompt,
      ],
    };
  }
  return {
    state,
    replies: [
      `Hi ${learner.name}! I'm your learning companion. No forms. I'll ask a couple of quick questions, find the one thing tripping you up, and fix it with you.`,
      topic.discover[0].prompt,
    ],
  };
}

export async function step(state: EngineState, message: string, fx: Effects): Promise<{ state: EngineState; replies: string[] }> {
  const s: EngineState = structuredClone(state);
  const topic = getTopic(s.topicId);
  const msg = message.trim();
  const replies: string[] = [];

  if (s.stage === "DONE") {
    if (/\b(again|another|more|next|yes|continue|go)\b/i.test(msg)) {
      s.queue = s.queue.filter((id) => id !== s.gap && !s.demonstrated.includes(id) && !s.tried.includes(id));
      if (!s.queue.length) {
        return { state: s, replies: ["You've worked through every concept I have for this topic today. Check your profile page for your next step."] };
      }
      Object.assign(s, { stage: "DIAGNOSE", tried: [], gap: undefined, before: undefined, after: undefined, current: s.queue[0] });
      return { state: s, replies: ["Let's find the next thing.", getConcept(s.topicId, s.queue[0])!.diagnose.prompt] };
    }
    return { state: s, replies: ["We're done for this round. Type \"again\" for another check, or open your profile to see what we found."] };
  }

  if (s.stage === "DISCOVER") {
    const d = topic.discover[s.discoverIdx];
    s.answers[d.key] = msg;
    await fx.profile({ [d.key]: msg });
    if (d.key === "goal") s.topicId = pickTopic(msg).id;
    s.discoverIdx++;
    const t = getTopic(s.topicId);
    if (s.discoverIdx < t.discover.length) {
      replies.push(t.discover[s.discoverIdx].prompt);
      return { state: s, replies };
    }
    for (const c of inferredGaps(t, s.answers.struggle ?? "")) {
      await fx.fact(c, "inferred_gap", "inferred", `Learner said: "${s.answers.struggle}"`);
    }
    s.queue = prioritize(t, s.answers.struggle ?? "", []);
    s.stage = "DIAGNOSE";
    s.current = s.queue[0];
    replies.push(`Got it. Let me ask one quick ${t.title} question to find exactly where you're stuck. Just answer in your own words, and "I don't know" is a fine answer.`);
    replies.push(getConcept(s.topicId, s.current)!.diagnose.prompt);
    return { state: s, replies };
  }

  const c = getConcept(s.topicId, s.current!)!;

  if (s.stage === "DIAGNOSE") {
    const ok = grade(c.diagnose, msg);
    s.tried.push(c.id);
    await fx.attempt({ topic: s.topicId, concept: c.id, phase: "diagnose", questionId: c.diagnose.id, question: c.diagnose.prompt, answer: msg, correct: ok });
    if (ok) {
      s.demonstrated.push(c.id);
      await fx.fact(c.id, "demonstrated", "demonstrated", `Answered "${msg}" to: ${c.diagnose.prompt}`);
      const nextId = s.queue.find((id) => !s.tried.includes(id));
      if (nextId && s.tried.length < MAX_DIAGNOSE) {
        s.current = nextId;
        replies.push(`Correct. ${c.diagnose.explain} You've got that one. Next:`);
        replies.push(getConcept(s.topicId, nextId)!.diagnose.prompt);
        return { state: s, replies };
      }
      s.stage = "DONE";
      const nextStep = topic.all_clear_next_step;
      await fx.outcome({ topic: s.topicId, gapConcept: null, beforeCorrect: null, afterCorrect: null, nextStep, summary: `No gap found in ${s.tried.length} checks; demonstrated: ${s.demonstrated.join(", ")}` });
      replies.push(`Correct again. ${c.diagnose.explain}`);
      replies.push(`You didn't miss a single check today, so no gap to fix right now. Your next step: ${nextStep}`);
      return { state: s, replies };
    }
    // Gap found -> TEACH, then RETEST in the same turn.
    s.gap = c.id;
    s.before = false;
    s.stage = "RETEST";
    await fx.fact(c.id, "gap", "demonstrated", `Missed: ${c.diagnose.prompt} (answered "${msg}")`);
    replies.push(`Not quite, and that's useful. I found the gap: ${c.name}. ${c.diagnose.explain}`);
    replies.push(`Here's the one-minute version. ${c.lesson}`);
    replies.push(`Let's check it stuck. ${c.retest.prompt}`);
    return { state: s, replies };
  }

  // RETEST
  const ok = grade(c.retest, msg);
  s.after = ok;
  s.stage = "DONE";
  await fx.attempt({ topic: s.topicId, concept: c.id, phase: "retest", questionId: c.retest.id, question: c.retest.prompt, answer: msg, correct: ok });
  if (ok) {
    await fx.fact(c.id, "demonstrated", "demonstrated", `Missed it before the lesson, got it after: "${msg}" to ${c.retest.prompt}`);
  }
  const nextStep = ok
    ? c.next_step
    : `Re-read the lesson on ${c.name} on your profile page, then try one more question. Or book a human mentor review and someone will walk you through it.`;
  await fx.outcome({
    topic: s.topicId,
    gapConcept: c.id,
    beforeCorrect: false,
    afterCorrect: ok,
    nextStep,
    summary: `Gap: ${c.name}. Before: wrong. After lesson: ${ok ? "right" : "still wrong"}.`,
  });
  replies.push(ok ? `Yes! ${c.retest.explain} Before the lesson you missed this, now you've got it.` : `Not yet. ${c.retest.explain} That's okay, this one takes a couple of passes.`);
  replies.push(`I've saved this to your profile. Your next step: ${nextStep}`);
  replies.push(`Type "again" to find the next thing to work on.`);
  return { state: s, replies };
}

// Engine tests with fake AI tutors (no network). Run: npx tsx scripts/engine-ai.ts
import { Attempt, Effects, EngineState, Outcome, looseMatch, start, step } from "../src/engine.js";
import { pickModel } from "../src/llm.js";
import type { Tutor } from "../src/tutor.js";

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

function recorder() {
  const log = { attempts: [] as Attempt[], outcomes: [] as Outcome[], facts: [] as string[], profile: {} as Record<string, string> };
  const fx: Effects = {
    async attempt(a) { log.attempts.push(a); },
    async fact(c, st, kind, ev) { log.facts.push(`${c}:${st}:${kind}:${ev}`); },
    async profile(f) { Object.assign(log.profile, f); },
    async outcome(o) { log.outcomes.push(o); },
  };
  return { fx, log };
}

// Fake tutor that answers in Hindi and treats "5"/"paanch" as the only right diagnose answer.
const hindi: Tutor = {
  async discoverNext(_c, _a, key) { return { question: `[ai] ${key} ke baare mein batao?`, language: "Hindi" }; },
  async plan(_c, t) {
    return { order: ["post_increment", ...t.concepts.map((c) => c.id).filter((x) => x !== "post_increment")], intro: "[ai] Chalo ek sawaal.", first: { prompt: "[ai] int a = 5; println(a++); kya print hoga?", answer_key: "5" }, language: "Hindi" };
  },
  async ask(_c, c) { return { prompt: `[ai] fresh question on ${c.id}`, answer_key: "x" }; },
  async evaluate({ phase, answer }) {
    const right = phase === "diagnose" ? /^(5|paanch)$/i.test(answer.trim()) : /^(10|das)$/i.test(answer.trim());
    return {
      correct: right,
      misconception: right ? "none" : "Thinks x++ increments before the value is used",
      feedback: right ? "[ai] Sahi!" : "[ai] Galat, jawab 5 hai.",
      language: "Hindi",
      lesson: right ? undefined : "[ai] Bakery token ki tarah socho...",
      retest: right ? undefined : { prompt: "[ai] int y = 10; int z = y++; z kya hai?", answer_key: "10" },
      next_question: right ? { prompt: "[ai] next concept question", answer_key: "false" } : undefined,
      next_step: phase === "retest" ? "[ai] Ek loop likho." : undefined,
    };
  },
};

const dead: Tutor = {
  async discoverNext() { return null; },
  async plan() { return null; },
  async ask() { return null; },
  async evaluate() { return null; },
};

const learner = { name: "Asha", facts: [] };

async function run(tutor: Tutor | undefined, answers: string[]) {
  const { fx, log } = recorder();
  let r = await start(learner, tutor);
  const turns = [r];
  let st: EngineState = r.state;
  for (const a of answers) {
    r = await step(st, a, fx, tutor, "Asha");
    st = r.state;
    turns.push(r);
  }
  return { turns, log, st };
}

// 1. Full AI path, multilingual, wrong -> lesson -> right
{
  const { turns, log, st } = await run(hindi, ["Java", "naukri ke liye", "operators confuse karte hain", "6", "10"]);
  check(turns[1].source === "ai" && turns[1].replies[0].startsWith("[ai]"), "AI personalises discovery question");
  check(turns[3].replies.join(" ").includes("[ai] int a = 5"), "AI plan picks concept + writes first diagnostic");
  check(turns[4].state.stage === "RETEST" && turns[4].replies.some((x) => x.includes("Bakery")), "AI lesson used after wrong answer");
  check(turns[4].replies.some((x) => x.includes("int y = 10")), "AI retest question used");
  check(log.attempts.every((a) => a.gradedBy === "ai"), "attempts graded by AI");
  check(log.facts.some((f) => f.includes("Misconception: Thinks x++")), "misconception stored as evidence");
  check(st.stage === "DONE" && log.outcomes[0]?.afterCorrect === true && log.outcomes[0]?.nextStep === "[ai] Ek loop likho.", "outcome before=wrong after=right with AI next step");
  check(turns.slice(1).every((t) => t.source === "ai"), "every AI turn labelled ai");
  check(st.language === "Hindi", "language tracked in state");
}

// 2. AI configured but failing -> config content, labelled fallback, deterministic grading
{
  const { turns, log, st } = await run(dead, ["Java", "job", "strings", "true", ".equals"]);
  check(turns.slice(1).every((t) => t.source === "fallback"), "failing AI -> every turn labelled fallback");
  check(turns[3].replies.join(" ").includes("new String"), "fallback routes 'strings' to config question");
  check(log.attempts[0].gradedBy === "engine" && log.attempts[0].correct === false, "fallback grades with regex engine");
  check(st.stage === "DONE" && log.outcomes[0]?.afterCorrect === true, "fallback loop completes");
}

// 3. No tutor at all (dev mode) behaves like the original engine
{
  const { turns, st, log } = await run(undefined, ["Java", "job", "arrays", "5", "9"]);
  check(turns.every((t) => t.source === "fallback"), "no tutor -> fallback label");
  check(st.stage === "DONE" && log.outcomes[0]?.gapConcept === "array_index" && log.outcomes[0]?.afterCorrect === true, "no tutor loop identical to original");
}

// 4. Partial AI failure: evaluate works but omits lesson/retest -> config lesson, labelled fallback
{
  const partial: Tutor = { ...hindi, async evaluate(a) { const e = await hindi.evaluate(a); return e && { ...e, lesson: undefined, retest: undefined }; } };
  const { turns } = await run(partial, ["Java", "job", "ops", "6"]);
  const last = turns[turns.length - 1];
  check(last.source === "fallback" && last.replies.some((x) => x.includes("token machine")), "missing AI lesson -> config lesson, labelled fallback");
}

// 5. AI-written question + AI outage at grading time -> loose match on answer key
{
  const flaky: Tutor = { ...hindi, async evaluate() { return null; } };
  const { log } = await run(flaky, ["Java", "job", "ops", "5"]);
  check(log.attempts[0].gradedBy === "engine_fallback" && log.attempts[0].correct === true, "AI outage on AI question -> loose answer-key match");
}

// 6. In-flight sessions saved before this change (no `asked`) still work
{
  const { fx, log } = recorder();
  const legacy: EngineState = { stage: "RETEST", topicId: "java-basics", discoverIdx: 3, answers: {}, queue: ["post_increment"], tried: ["post_increment"], demonstrated: [], current: "post_increment", gap: "post_increment", before: false };
  const r = await step(legacy, "10", fx, undefined, "Old");
  check(r.state.stage === "DONE" && log.outcomes[0]?.afterCorrect === true, "legacy state without asked question completes");
}

// 7. Helpers
check(looseMatch("10", "it is 10") && !looseMatch("10", "100") && !looseMatch("false", "true"), "looseMatch basic cases");
check(pickModel(["models/gemini-2.0-flash", "models/gemini-2.5-flash", "models/gemini-2.5-flash-lite", "models/gemini-2.5-flash-image", "models/gemini-2.5-pro"]) === "gemini-2.5-flash", "pickModel prefers newest stable flash");
check(pickModel(["models/gemini-2.5-flash"], "gemini-9-ultra") === "gemini-2.5-flash", "pickModel ignores unlisted GEMINI_MODEL");
check(pickModel(["models/gemini-2.5-pro", "models/text-embedding-004"]) === null, "pickModel returns null when no flash model listed");

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);

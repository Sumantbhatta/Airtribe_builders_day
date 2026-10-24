// Live conversation check against a running server (real AI provider).
// Usage: BASE_URL=http://localhost:3000 npx tsx scripts/convo.ts [scenario]
// Every learner created here is tagged is_test.
const BASE = process.env.BASE_URL || "http://localhost:3000";
const only = process.argv[2];

async function signup(name: string) {
  const r = await fetch(`${BASE}/api/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, phone: String(Math.floor(6e9 + Math.random() * 3.9e9)), consent: true, test: true, source: "convo-test" }),
  });
  return ((await r.json()) as any).token as string;
}

async function turn(token: string, message: string) {
  const t0 = Date.now();
  let first = 0;
  const r = await fetch(`${BASE}/api/chat/stream`, { method: "POST", headers: { "content-type": "application/json", "x-learner-token": token }, body: JSON.stringify({ message }) });
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let done: any = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = JSON.parse(line.slice(5));
      if (ev.type === "delta" && !first) first = Date.now() - t0;
      if (ev.type === "done" || ev.type === "error") done = ev;
    }
  }
  const total = Date.now() - t0;
  console.log(`\n> LEARNER: ${message}`);
  console.log(`< MENTOR [${done?.source}${done?.ai ? ` ${done.ai.provider}/${done.ai.model} first=${first}ms total=${total}ms extract=${done.ai.extract_ok}` : ` total=${total}ms`} stage=${done?.stage}]:\n${(done?.replies ?? [done?.error]).join("\n")}`);
  return done;
}

async function profile(token: string) {
  const p = (await (await fetch(`${BASE}/api/me`, { headers: { "x-learner-token": token } })).json()) as any;
  console.log(`\n== PROFILE: goal=${JSON.stringify(p.learner.goal)} struggle=${JSON.stringify(p.learner.struggle)}`);
  for (const f of p.facts) console.log(`   fact ${f.concept}: ${f.status}/${f.kind} — ${String(f.evidence).slice(0, 140)}`);
  for (const o of p.outcomes) console.log(`   outcome ${o.gap_concept}: before=${o.before_correct} after=${o.after_correct} next="${String(o.next_step).slice(0, 80)}"`);
  for (const a of p.attempts.slice(0, 6)) console.log(`   attempt ${a.concept}/${a.phase}: "${a.answer}" correct=${a.correct}`);
  return p;
}

const scenarios: Record<string, () => Promise<void>> = {
  async english() {
    console.log("\n######## ENGLISH: follow-ups, re-explain, practice, wrong then right, returning learner");
    const t = await signup("Test Ravi");
    await turn(t, "Hi, I'm learning Java for campus placements. What's the actual difference between == and .equals for Strings?");
    await turn(t, "I still don't get it. Can you explain it a different way?");
    await turn(t, "Okay, give me a practice question.");
    await turn(t, "I think it's true");
    await turn(t, "ohh. ok let me try that one: false?");
    await profile(t);
    await fetch(`${BASE}/api/chat/reset`, { method: "POST", headers: { "x-learner-token": t } }).then((r) => r.json()).then((j: any) => console.log(`\n== NEW SESSION greeting [${j.source}]: ${j.replies.join(" ")}`));
    await turn(t, "What did we work on last time, and what should I practice next?");
  },
  async hindi() {
    console.log("\n######## HINDI");
    const t = await signup("Test Priya");
    await turn(t, "मैं जावा सीख रही हूँ। array का index 0 से क्यों शुरू होता है?");
    await turn(t, "एक आसान उदाहरण दो और फिर मुझसे एक सवाल पूछो।");
    await turn(t, "शायद 5?");
    await profile(t);
  },
  async hinglish() {
    console.log("\n######## HINGLISH + uncertainty");
    const t = await signup("Test Aman");
    await turn(t, "bhai x++ aur ++x mein bahut confusion hai, samjhao na");
    await turn(t, "quiz karo mujhe");
    await turn(t, "10 aayega");
    await turn(t, "Java mein String.reverseWords() method kya karta hai?");
    await profile(t);
  },
};

for (const [name, fn] of Object.entries(scenarios)) if (!only || only === name) await fn();
export {};

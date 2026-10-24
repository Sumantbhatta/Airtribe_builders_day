// Simulates ElevenLabs calling our Custom LLM endpoint (no speech). Usage: npx tsx scripts/voice-check.ts
import "dotenv/config";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const SECRET = process.env.VOICE_LLM_SECRET || "";
let failures = 0;
const check = (c: unknown, label: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${label}`); if (!c) failures++; };

const signup: any = await (await fetch(`${BASE}/api/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Test Voice", phone: String(8e9 + Math.floor(Math.random() * 1e9)), consent: true, test: true, source: "voice-check" }) })).json();
const H = { "content-type": "application/json", "x-learner-token": signup.token };

const sess = await fetch(`${BASE}/api/voice/session`, { method: "POST", headers: H });
const s: any = await sess.json();
check(sess.status === 200 && /^wss:\/\//.test(s.signedUrl ?? "") && /^lr_\d+_[0-9a-f]{32}$/.test(s.userId ?? ""), `voice session returns signed wss URL + signed learner id (${sess.status})`);

async function llm(messages: any[], extra: any, bearer = SECRET, userId = s.userId) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ model: "callmentor-mentor", stream: true, messages, user_id: userId, elevenlabs_extra_body: extra }),
  });
  if (r.status !== 200) return { status: r.status, text: "", first: 0, total: 0, done: false };
  const raw = await r.text();
  const lines = raw.split("\n\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
  const text = lines.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
  return { status: r.status, text, done: raw.includes("data: [DONE]") && lines.some((c) => c.choices?.[0]?.finish_reason === "stop"), total: Date.now() - t0 };
}

const bad = await llm([{ role: "user", content: "hi" }], { learner: s.userId }, "wrong-secret");
check(bad.status === 401, "rejects wrong bearer secret");

const forged = await llm([{ role: "user", content: "hi" }], { learner: "lr_1_00000000000000000000000000000000" }, SECRET, "lr_1_00000000000000000000000000000000");
check(forged.status === 200 && /couldn't find your CallMentor profile/.test(forged.text), "forged learner id gets no profile access");

const turns = [
  "Hi, I'm learning Java. Mujhe x plus plus aur plus plus x mein confusion hai.",
  "Okay, ask me a quick question on it.",
  "I think it prints six.",
];
const history: any[] = [{ role: "system", content: "agent prompt" }, { role: "assistant", content: "Hi Test! I'm your CallMentor." }];
for (const t of turns) {
  history.push({ role: "user", content: t });
  const r = await llm(history, { learner: s.userId });
  console.log(`\n> ${t}\n< (${r.total}ms) ${r.text}`);
  check(r.status === 200 && r.done && r.text.length > 10, "streamed OpenAI-style SSE reply ending in [DONE]");
  check(!/###EVIDENCE|[*`#]/.test(r.text), "no evidence block or markdown symbols in speech");
  history.push({ role: "assistant", content: r.text });
}

const me: any = await (await fetch(`${BASE}/api/me`, { headers: H })).json();
check(me.attempts.some((a: any) => a.concept === "post_increment"), "voice answer graded and saved to the learner profile");
console.log("facts:", JSON.stringify(me.facts.map((f: any) => [f.concept, f.status])));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);

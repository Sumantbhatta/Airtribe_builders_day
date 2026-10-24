// End-to-end check of the learning loop over HTTP. All learners it creates are tagged is_test.
const BASE = process.env.BASE_URL || "http://localhost:3000";
const TOOL = process.env.TOOL_SECRET || "local-dev-tool-secret";
const ADMIN = process.env.ADMIN_PASSWORD || "local-dev-only";
let failures = 0;
const check = (cond: unknown, label: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};
const rand = () => String(Math.floor(6e9 + Math.random() * 3.9e9));

// 1. Web signup + chat loop: wrong diagnose -> lesson -> right retest
const phone = rand();
const s = await post("/api/signup", { name: "E2E Test", phone, consent: true, test: true, source: "e2e" });
check(s.status === 200 && s.json.token, "signup returns token");
const H = { "x-learner-token": s.json.token };
const say = async (m: string | null) => (await post("/api/chat", { message: m }, H)).json;
let r = await say(null);
check(r.stage === "DISCOVER", "session opens in DISCOVER");
await say("Java, beginner level");
await say("to get my first developer job");
r = await say("I get confused by Strings and comparing them");
check(r.stage === "DIAGNOSE" && /new String/.test(r.replies.join(" ")), "struggle routes diagnose to string_equality");
r = await say("true");
check(r.stage === "RETEST" && /houses/.test(r.replies.join(" ")), "wrong answer -> gap + lesson + retest");
r = await say("dot equals");
check(r.stage === "DONE" && /next step/i.test(r.replies.join(" ")), "right retest -> DONE with next step");
const me = await (await fetch(BASE + "/api/me", { headers: H })).json() as any;
const o = me.outcomes[0];
check(o && o.gap_concept === "string_equality" && o.before_correct === false && o.after_correct === true, "outcome stored before=wrong after=right");
check(me.facts.some((f: any) => f.concept === "string_equality" && f.status === "demonstrated" && f.kind === "demonstrated"), "fact upgraded to demonstrated");
const fact = me.facts[0];
const corr = await post(`/api/me/facts/${fact.id}`, { status: "gap", note: "still shaky" }, H);
check(corr.status === 200, "learner can correct a profile fact");

// 2. Voice tools as ElevenLabs would call them
const T = { "x-tool-secret": TOOL };
const vphone = "+91" + rand();
const unauth = await post("/tools/get_profile", { phone: vphone }, { "x-tool-secret": "wrong" });
check(unauth.status === 401, "tool rejects bad secret");
const gp = await post("/tools/get_profile", { phone: vphone, conversation_id: "e2e-" + vphone }, T);
check(gp.status === 200 && gp.json.is_new && gp.json.plan.length === 3, "get_profile creates caller + returns 3-concept plan");
const ra = await post("/tools/record_attempt", { phone: vphone, conversation_id: "e2e-" + vphone, concept: "post_increment", phase: "diagnose", answer: "six" }, T);
check(ra.status === 200 && ra.json.correct === false, "record_attempt grades 'six' as wrong");
const rb = await post("/tools/record_attempt", { phone: vphone, conversation_id: "e2e-" + vphone, concept: "post_increment", phase: "retest", answer: "ten" }, T);
check(rb.json.correct === true, "record_attempt grades retest 'ten' as right");
const so = await post("/tools/save_outcome", { phone: vphone, conversation_id: "e2e-" + vphone, name: "E2E Voice Test", goal: "Java", struggle: "operators", gap_concept: "post_increment", before_correct: false, after_correct: true, next_step: "practice loops", summary: "e2e" }, T);
check(so.status === 200 && so.json.saved, "save_outcome saves");

// 3. Admin
const adm = await fetch(BASE + "/api/admin/summary", { headers: { authorization: "Basic " + Buffer.from("admin:" + ADMIN).toString("base64") } });
check(adm.status === 200, "admin summary with password");
const noadm = await fetch(BASE + "/api/admin/summary");
check(noadm.status === 401, "admin summary blocked without password");

// Mark the voice caller as test too (voice signups can't self-tag).
const sum = (await adm.json()) as any;
const vl = sum.learners.find((l: any) => l.phone === vphone);
if (vl) await fetch(BASE + `/api/admin/learners/${vl.id}/test`, { method: "POST", headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from("admin:" + ADMIN).toString("base64") }, body: JSON.stringify({ is_test: true }) });

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
export {};

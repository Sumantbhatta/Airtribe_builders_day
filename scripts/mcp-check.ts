// Exercises the MCP connector the way AgenticOrg would. Run against a server started with
// STALL_MINUTES=0 and AI off. The stalled learner it creates is a real-learner row in the
// LOCAL dev DB only (needed because the agent ignores test learners), then marked test.
import "dotenv/config";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const KEY = process.env.AGENT_SECRET || "local-dev-agent-secret";
const ADMIN = "Basic " + Buffer.from("admin:" + (process.env.ADMIN_PASSWORD || "local-dev-only")).toString("base64");
let failures = 0;
const check = (c: unknown, label: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${label}`); if (!c) failures++; };
let id = 0;
const rpc = async (method: string, params: any = {}, headers: Record<string, string> = { authorization: `Bearer ${KEY}` }) => {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  return { status: r.status, json: r.status === 202 ? null : ((await r.json()) as any) };
};
const tool = async (name: string, args: any = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const c = r.json?.result;
  return { isError: !!c?.isError, data: c && !c.isError ? JSON.parse(c.content[0].text) : c?.content?.[0]?.text };
};

check((await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test" } }, {})).status === 401, "rejects missing key");
check((await rpc("initialize", {}, { "x-api-key": KEY })).json?.result?.serverInfo?.name === "callmentor", "accepts key via x-api-key");
const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test" } });
check(init.json?.result?.protocolVersion === "2025-03-26" && init.json?.result?.capabilities?.tools, "initialize returns protocol + tools capability");
check((await rpc("notifications/initialized")).status === 202, "notifications/initialized -> 202");
const list = await rpc("tools/list");
check(list.json?.result?.tools?.map((t: any) => t.name).join(",") === "list_stalled_learners,get_learner_progress,send_learner_nudge", "tools/list returns 3 tools");

// Create a learner who stalls mid-diagnosis.
const s: any = await (await fetch(`${BASE}/api/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Mcp Stall", phone: String(9e9 + Math.floor(Math.random() * 9e8)), consent: true }) })).json();
const H = { "content-type": "application/json", "x-learner-token": s.token };
for (const m of [null, "Java", "job", "strings"]) await fetch(`${BASE}/api/chat`, { method: "POST", headers: H, body: JSON.stringify({ message: m }) });

const stalled = await tool("list_stalled_learners");
const me = stalled.data?.learners?.find((l: any) => l.first_name === "Mcp");
check(!stalled.isError && me && me.stuck_on, `list_stalled_learners finds the stalled learner (stuck on: ${me?.stuck_on})`);
const prog = await tool("get_learner_progress", { learner_id: me?.learner_id });
check(!prog.isError && prog.data.first_name === "Mcp" && Array.isArray(prog.data.recent_messages), "get_learner_progress returns profile + recent messages");

const noApprover = await tool("send_learner_nudge", { learner_id: me?.learner_id, message: "hi", approved_by: "" });
check(noApprover.isError, "send refused without a named human approver");
const notListed = await tool("send_learner_nudge", { learner_id: 1, message: "hi", approved_by: "Sumant" });
check(notListed.isError, "send refused for a learner not listed as stalled");
const sent = await tool("send_learner_nudge", { learner_id: me?.learner_id, message: "Hi Mcp, you were one question away on Strings. 2 minutes?", approved_by: "Sumant", agent_run_id: stalled.data.agent_run_id });
check(!sent.isError && sent.data.delivered, "approved nudge delivered");
const inbox: any = await (await fetch(`${BASE}/api/me`, { headers: H })).json();
check(inbox.inbox?.[0]?.text?.includes("one question away"), "nudge appears in the learner's inbox");

const sum: any = await (await fetch(`${BASE}/api/admin/summary`, { headers: { authorization: ADMIN } })).json();
const run = sum.agentRuns.find((r: any) => r.id === stalled.data.agent_run_id);
check(run?.status === "completed" && run?.output?.sent?.[0]?.approved_by === "Sumant", "agent run logged as completed with approver");
const l = sum.learners.find((x: any) => x.name === "Mcp Stall");
if (l) await fetch(`${BASE}/api/admin/learners/${l.id}/test`, { method: "POST", headers: { authorization: ADMIN, "content-type": "application/json" }, body: JSON.stringify({ is_test: true }) });

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);

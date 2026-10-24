import crypto from "node:crypto";
import type { Request, Response } from "express";
import { q, one, logEvent } from "./db.js";
import { finishRun, stalledLearners, startRun } from "./agent.js";
import { getConcept, defaultTopic } from "./engine.js";

// Minimal MCP server (JSON-RPC 2.0 over streamable HTTP, JSON responses) so the
// AgenticOrg "Nudge" agent can use CallMentor as a connector. Tools read real learner
// data and deliver approved nudges; every call is logged in agent_runs/events.

const PROTOCOL = "2025-03-26";

const TOOLS = [
  {
    name: "list_stalled_learners",
    description:
      "List CallMentor learners who stopped a learning session before their retest (consented, real learners only). Returns learner_id, first name, the concept they were stuck on, where they stopped, and a suggested draft. Starts an agent run record.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_learner_progress",
    description: "Read one learner's goal, struggles, skill gaps with evidence, before/after outcomes and their last few messages, to personalise a follow-up.",
    inputSchema: { type: "object", properties: { learner_id: { type: "integer" } }, required: ["learner_id"], additionalProperties: false },
  },
  {
    name: "send_learner_nudge",
    description:
      "Deliver a follow-up message to a learner's CallMentor inbox. Only call this AFTER a human mentor approved the exact text. Requires approved_by (the human's name). Only works for learners returned by list_stalled_learners in the last 24 hours.",
    inputSchema: {
      type: "object",
      properties: {
        learner_id: { type: "integer" },
        message: { type: "string", maxLength: 400 },
        approved_by: { type: "string", description: "Name of the human who approved this exact message" },
        agent_run_id: { type: "integer" },
      },
      required: ["learner_id", "message", "approved_by"],
      additionalProperties: false,
    },
  },
];

function authed(req: Request): { ok: boolean; via: string } {
  const secret = process.env.AGENT_SECRET || "";
  const h = (n: string) => String(req.header(n) ?? "");
  const auth = h("authorization");
  const candidates: [string, string][] = [
    ["authorization_bearer", auth.startsWith("Bearer ") ? auth.slice(7) : ""],
    ["authorization_raw", auth && !auth.includes(" ") ? auth : ""],
    ["x-api-key", h("x-api-key")],
    ["api-key", h("api-key")],
    ["x-agent-secret", h("x-agent-secret")],
  ];
  for (const [via, v] of candidates) {
    if (secret && v && v.length === secret.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(secret))) return { ok: true, via };
  }
  return { ok: false, via: candidates.filter(([, v]) => v).map(([n]) => n).join(",") || "none" };
}

const text = (o: unknown) => ({ content: [{ type: "text", text: JSON.stringify(o, null, 1) }] });
const toolError = (msg: string) => ({ content: [{ type: "text", text: msg }], isError: true });

async function callTool(name: string, args: any) {
  if (name === "list_stalled_learners") {
    const learners = await stalledLearners();
    const runId = await startRun("agenticorg_nudge", "agenticorg_mcp", { tool: name });
    await finishRun(runId, "listed", { learner_ids: learners.map((l) => l.learner_id), count: learners.length });
    return text({
      agent_run_id: runId,
      count: learners.length,
      learners: learners.map((l) => ({
        learner_id: l.learner_id,
        first_name: l.first_name,
        stopped_at_stage: l.stopped_at_stage,
        last_active_at: l.last_active_at,
        stuck_on: l.gap_name ?? l.gap_concept,
        goal: l.goal,
        suggested_draft: l.suggested_draft,
      })),
    });
  }

  if (name === "get_learner_progress") {
    const id = Number(args?.learner_id);
    const l = await one<any>("select id, name, goal, motivation, struggle from learners where id=$1 and consent and not is_test", [id]);
    if (!l) return toolError("No consented learner with that id.");
    const [facts, outcomes, msgs] = await Promise.all([
      q<any>("select concept, status, kind, evidence from profile_facts where learner_id=$1 and status<>'removed' order by updated_at desc limit 8", [id]),
      q<any>("select gap_concept, before_correct, after_correct, next_step, created_at from outcomes where learner_id=$1 order by id desc limit 3", [id]),
      q<any>(
        `select e.t->>'role' as role, e.t->>'text' as text from sessions s cross join lateral jsonb_array_elements(s.transcript) with ordinality as e(t, ord)
          where s.learner_id=$1 order by s.id desc, e.ord desc limit 6`,
        [id],
      ),
    ]);
    await logEvent("agent.read_progress", { via: "agenticorg_mcp" }, id);
    const name = (c: string) => getConcept(defaultTopic().id, c)?.name ?? c;
    return text({
      learner_id: id,
      first_name: String(l.name).split(" ")[0],
      goal: l.goal,
      motivation: l.motivation,
      struggle: l.struggle,
      skills: facts.map((f) => ({ concept: name(f.concept), status: f.status, kind: f.kind, evidence: String(f.evidence ?? "").slice(0, 160) })),
      outcomes: outcomes.map((o) => ({ concept: o.gap_concept ? name(o.gap_concept) : null, before_correct: o.before_correct, after_correct: o.after_correct, at: o.created_at })),
      recent_messages: msgs.reverse().map((m) => ({ role: m.role, text: String(m.text ?? "").slice(0, 200) })),
    });
  }

  if (name === "send_learner_nudge") {
    const id = Number(args?.learner_id);
    const message = String(args?.message ?? "").trim();
    const approvedBy = String(args?.approved_by ?? "").trim();
    if (!message || message.length > 400) return toolError("message is required (max 400 characters).");
    if (!approvedBy) return toolError("approved_by is required: a human must approve the exact text before sending.");
    // Only learners this agent was shown as stalled in the last 24h (no messaging arbitrary users).
    const listed = await one<{ id: number }>(
      `select id from agent_runs where agent='agenticorg_nudge' and created_at > now() - interval '24 hours'
         and output->'learner_ids' @> to_jsonb($1::int) order by id desc limit 1`,
      [id],
    );
    if (!listed) return toolError("This learner was not returned by list_stalled_learners in the last 24 hours.");
    const runId = args?.agent_run_id ? Number(args.agent_run_id) : listed.id;
    const a = (await one<{ id: number }>(
      `insert into approvals (agent_run_id, learner_id, kind, draft, final_text, status, decided_by, decided_at)
       values ($1,$2,'stalled_nudge',$3,$3,'sent',$4,now()) returning id`,
      [runId, id, message, `${approvedBy.slice(0, 60)} (AgenticOrg HITL)`],
    ))!;
    await logEvent("approval.approved", { approval_id: a.id, by: approvedBy, via: "agenticorg" }, id);
    await logEvent("nudge.delivered", { approval_id: a.id, channel: "profile_inbox", text: message, via: "agenticorg" }, id);
    await q("update agent_runs set status='completed', output = output || $1::jsonb, finished_at=now() where id=$2", [
      JSON.stringify({ sent: [{ learner_id: id, approval_id: a.id, approved_by: approvedBy }] }),
      runId,
    ]);
    return text({ delivered: true, channel: "profile_inbox", approval_id: a.id });
  }

  return toolError(`Unknown tool: ${name}`);
}

export async function mcpHandler(req: Request, res: Response) {
  if (req.method !== "POST") return res.status(405).set("allow", "POST").json({ error: "Use POST (MCP streamable HTTP, JSON responses)" });
  const auth = authed(req);
  if (!auth.ok) {
    await logEvent("mcp.unauthorized", { headers_present: auth.via });
    return res.status(401).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } });
  }
  const msg = req.body ?? {};
  const reply = (result: unknown) => res.json({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const fail = (code: number, message: string) => res.json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });

  await logEvent("mcp.request", { method: msg.method, tool: msg.params?.name ?? null, auth_via: auth.via });
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion || PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "callmentor", version: "1.0.0" },
        instructions: "CallMentor learner-success tools. Always get human approval before send_learner_nudge.",
      });
    case "notifications/initialized":
      return res.status(202).end();
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call":
      try {
        return reply(await callTool(String(msg.params?.name ?? ""), msg.params?.arguments ?? {}));
      } catch (e: any) {
        console.error("mcp tool failed:", e?.message ?? e);
        return reply(toolError("Tool failed on the CallMentor side."));
      }
    default:
      if (typeof msg.method === "string" && msg.method.startsWith("notifications/")) return res.status(202).end();
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

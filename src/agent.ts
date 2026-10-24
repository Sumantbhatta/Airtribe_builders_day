import { q, one, logEvent } from "./db.js";
import { getConcept, defaultTopic } from "./engine.js";

// Stalled-learner follow-up agent. The agent (AgenticOrg) finds learners who stopped
// before RETEST, drafts a nudge, and a HUMAN must approve before anything is sent.
// Our API is the system of record: every run, draft, decision and send is logged here.

export const STALL_MINUTES = Number(process.env.STALL_MINUTES || 10);

/** Internal test runs may include is_test learners; they stay tagged and excluded from traction counts. */
export async function stalledLearners(opts: { includeTest?: boolean; minIdleMinutes?: number } = {}) {
  const rows = await q<any>(
    `select distinct on (l.id) l.id as learner_id, l.is_test, l.name, l.phone, l.goal, l.struggle, s.id as session_id, s.channel, s.stage,
            s.state, s.updated_at as last_active_at
       from sessions s join learners l on l.id = s.learner_id
      where s.stage in ('DIAGNOSE','TEACH','RETEST')
        and s.updated_at < now() - ($1 || ' minutes')::interval
        and (not l.is_test or $2) and l.consent
        and not exists (select 1 from approvals a where a.learner_id = l.id and a.kind = 'stalled_nudge' and a.created_at > now() - interval '24 hours')
        and not exists (select 1 from outcomes o where o.learner_id = l.id and o.created_at > s.started_at)
      order by l.id, s.updated_at desc`,
    [String(opts.minIdleMinutes ?? STALL_MINUTES), !!opts.includeTest],
  );
  return rows.map((r) => {
    // Mentor sessions keep gap/current at the top level (pending.concept for a waiting
    // question); offline-mode turns keep the scripted engine's state under state.engine.
    const st = r.state ?? {};
    const gapId = st.gap ?? st.pending?.concept ?? st.current ?? st.engine?.gap ?? st.engine?.current ?? null;
    const facts = gapId ? getConcept(defaultTopic().id, gapId) : undefined;
    return {
      learner_id: r.learner_id,
      is_test: !!r.is_test,
      first_name: String(r.name).split(" ")[0],
      channel: r.channel,
      stopped_at_stage: r.stage,
      last_active_at: r.last_active_at,
      goal: r.goal,
      struggle: r.struggle,
      gap_concept: gapId,
      gap_name: facts?.name ?? null,
      lesson_hint: facts?.lesson?.split(". ").slice(0, 2).join(". ") ?? null,
      suggested_draft: draftNudge(String(r.name).split(" ")[0], r.stage, facts?.name ?? null),
    };
  });
}

export function draftNudge(firstName: string, stage: string, gapName: string | null): string {
  if (stage === "RETEST" && gapName) {
    return `Hi ${firstName}, you were one question away from locking in "${gapName}". It takes 2 minutes: open your CallMentor page or call us and say "continue".`;
  }
  if (gapName) {
    return `Hi ${firstName}, last time we started on "${gapName}", which trips up most beginners. Want to finish it in 3 minutes? Open your CallMentor page or give us a call.`;
  }
  return `Hi ${firstName}, you started a CallMentor check but didn't finish. One more question and we'll know exactly what to work on next. Pick up where you left off on your page or by calling.`;
}

export async function startRun(agent: string, trigger: string, input: Record<string, unknown>) {
  const r = (await one<{ id: number }>("insert into agent_runs (agent, trigger, status, input) values ($1,$2,'running',$3) returning id", [
    agent,
    trigger,
    JSON.stringify(input),
  ]))!;
  await logEvent("agent.run_start", { agent_run_id: r.id, agent, trigger });
  return r.id;
}

export async function finishRun(id: number, status: string, output: Record<string, unknown>) {
  await q("update agent_runs set status=$1, output=$2, finished_at=now() where id=$3", [status, JSON.stringify(output), id]);
  await logEvent("agent.run_finish", { agent_run_id: id, status });
}

/** Agent proposes a message. Nothing reaches the learner until a human approves it. */
export async function proposeNudge(agentRunId: number | null, learnerId: number, draft: string) {
  const a = (await one<{ id: number }>(
    "insert into approvals (agent_run_id, learner_id, kind, draft) values ($1,$2,'stalled_nudge',$3) returning id",
    [agentRunId, learnerId, draft.slice(0, 1000)],
  ))!;
  await logEvent("approval.requested", { approval_id: a.id, agent_run_id: agentRunId, kind: "stalled_nudge" }, learnerId);
  return a.id;
}

/** Human decision. Approve (optionally edited) delivers the nudge; reject records why. */
export async function decide(approvalId: number, decision: "approve" | "reject", by: string, finalText?: string) {
  const a = await one<any>("select * from approvals where id=$1", [approvalId]);
  if (!a) throw Object.assign(new Error("approval not found"), { status: 404 });
  if (a.status !== "pending") throw Object.assign(new Error(`already ${a.status}`), { status: 409 });
  const text = (finalText?.trim() || a.draft).slice(0, 1000);
  if (decision === "reject") {
    await q("update approvals set status='rejected', decided_by=$1, decided_at=now() where id=$2", [by, approvalId]);
    await logEvent("approval.rejected", { approval_id: approvalId, by }, a.learner_id);
    return { status: "rejected" };
  }
  await q("update approvals set status='approved', final_text=$1, decided_by=$2, decided_at=now() where id=$3", [text, by, approvalId]);
  await logEvent("approval.approved", { approval_id: approvalId, by, edited: text !== a.draft }, a.learner_id);
  const delivery = await deliver(a.learner_id, text, approvalId);
  await q("update approvals set status='sent' where id=$1", [approvalId]);
  return { status: "sent", delivery };
}

/** Delivery channel: the learner's CallMentor inbox (shown on their profile page). */
async function deliver(learnerId: number, text: string, approvalId: number) {
  await logEvent("nudge.delivered", { approval_id: approvalId, channel: "profile_inbox", text }, learnerId);
  return { channel: "profile_inbox" };
}

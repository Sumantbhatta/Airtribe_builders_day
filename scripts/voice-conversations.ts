// Lists recent conversations of the voice agent (no secrets printed).
import dotenv from "dotenv";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
dotenv.config({ path: ".env.local" });
dotenv.config();
const c = new ElevenLabsClient();
const r: any = await c.conversationalAi.conversations.list({ agentId: process.env.ELEVENLABS_AGENT_ID!, pageSize: 5 });
for (const conv of r.conversations ?? []) {
  const d: any = await c.conversationalAi.conversations.get(conv.conversationId);
  const start = new Date((d.metadata?.startTimeUnixSecs ?? conv.startTimeUnixSecs) * 1000).toISOString();
  console.log(`\n${conv.conversationId} ${start} status=${d.status} msgs=${(d.transcript ?? []).length}`);
  for (const t of (d.transcript ?? []).slice(0, 6)) console.log(`  ${t.role}: ${String(t.message ?? "").slice(0, 120)}`);
  const err = d.metadata?.error ?? d.metadata?.terminationReason;
  if (err) console.log("  end:", JSON.stringify(err).slice(0, 300));
}

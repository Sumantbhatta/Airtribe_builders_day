// Text-only simulation through ElevenLabs -> our custom LLM (no audio). Prints the transcript.
import dotenv from "dotenv";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
dotenv.config({ path: ".env.local" });
dotenv.config();
const r: any = await new ElevenLabsClient().conversationalAi.agents.simulateConversation(process.env.ELEVENLABS_AGENT_ID!, {
  simulationSpecification: {
    simulatedUserConfig: {
      firstMessage: "Hi! I'm learning Java and == versus .equals confuses me. Can you explain?",
      language: "en",
      prompt: { prompt: "You are a beginner Java learner. Ask one follow-up question, then say thanks and goodbye. Keep it to 3 turns." },
    } as any,
  },
  newTurnsLimit: 4,
} as any);
for (const t of r.simulatedConversation ?? []) console.log(`${t.role}: ${String(t.message ?? "").slice(0, 220)}`);
console.log("analysis:", JSON.stringify(r.analysis?.callSuccessful ?? r.analysis ?? {}).slice(0, 200));

// Prints the non-secret parts of the voice agent's config.
import dotenv from "dotenv";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
dotenv.config({ path: ".env.local" });
dotenv.config();
const a: any = await new ElevenLabsClient().conversationalAi.agents.get(process.env.ELEVENLABS_AGENT_ID!);
const ag = a.conversationConfig.agent;
console.log("first:", ag.firstMessage);
console.log("dynvars:", JSON.stringify(ag.dynamicVariables));
console.log("llm:", ag.prompt.llm, ag.prompt.customLlm?.url);

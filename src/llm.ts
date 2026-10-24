// Back-compat shim: the structured tutor (src/tutor.ts) uses generateJson; everything
// now goes through the provider router in src/ai.
import { aiStatus, completeJson } from "./ai/index.js";

export { rankGemini as pickModelRank } from "./ai/gemini.js";

export async function generateJson<T>(system: string, user: string, schema: object): Promise<T | null> {
  const r = await completeJson<T>({ system, messages: [{ role: "user", text: user }], jsonSchema: schema, temperature: 0.3 });
  return r?.data ?? null;
}

export const llmStatus = aiStatus;

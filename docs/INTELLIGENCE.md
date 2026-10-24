# Intelligence layer

## How a turn works
`src/engine.ts` runs DISCOVER → DIAGNOSE → TEACH → RETEST → UPDATE PROFILE → NEXT STEP.
The curriculum (concepts, reference questions, answers, lessons) lives in `topics/*.json`.

When `GEMINI_API_KEY` is set, `src/tutor.ts` makes one Gemini call per learner turn, grounded in the
concept's reference facts:

| Step | AI does | Fallback (no key / call failed / invalid output) |
|---|---|---|
| Discover | Personalised follow-up question in the learner's language | Fixed prompt from config |
| Diagnose | Orders concepts from what the learner said; writes the first question | Keyword ranking; config question |
| Grade | Judges meaning in any language; names the misconception | Regex grader (config questions) or answer-key match (AI questions) |
| Teach | ≤90-word lesson with an analogy tied to the learner's goal | Config lesson |
| Retest | Fresh question on the same concept, with answer key | Config retest question |
| Next step | Personalised practice task | Config next step |

Every chat turn is labelled `source: "ai" | "fallback"` in the API response and the session transcript.
The learner UI shows "offline mode" on fallback turns. `attempts.graded_by` records `ai`, `engine` or
`engine_fallback`. `/health` reports whether AI is configured, the selected model, and the failure count.

The model is chosen at runtime from Gemini's `ListModels` response: the newest stable `gemini-*-flash`
text model, or `GEMINI_MODEL` if that exact ID is listed. The key goes only in the `x-goog-api-key` header.

Voice and WhatsApp use the ElevenLabs agent's own LLM. They read the same curriculum through
`/tools/get_profile` and write through `/tools/record_attempt` and `/tools/save_outcome`.

## LearningMAP: evaluated, not integrated (24 Oct 2026)
Source checked: github.com/ai-for-edu/LearningMAP @ 68f6e38 (Apache-2.0).

- **Verified in source:** a LangGraph pipeline with `knowledge_graph`, `quiz`, `grading`, `diagnosis`,
  `lesson` and `review` nodes (`src/agent/graph.py`), a FastAPI `/chat` API, SQLite session storage
  (`src/api/store.py`), and an optional memory microservice (`student_memory/`).
- **Why not:** `grading_node` only accepts A/B/C/D, and anything else returns "Please enter A, B, C,
  or D". That can't grade spoken, free-form or non-English answers, which is our core interaction.
  Using it would also mean a second Python service with its own SQLite sessions and its own
  OpenAI-compatible LLM key, plus syncing state into our Postgres learner records.
- **What we took:** the idea of answering in the student's own language (their chat prompt says
  "Respond in the same language as the student").

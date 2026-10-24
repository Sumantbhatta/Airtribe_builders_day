# Intelligence layer

## Conversational mentor (src/mentor.ts)
Web chat (`/api/chat`, `/api/chat/stream`) is a free-form conversation with a grounded LLM mentor.
Each turn:
1. **Context from Postgres, not model memory:** profile (goal, motivation, struggle), skills and gaps with
   evidence and learner corrections, recent outcomes, misconceptions this session, the waiting practice
   question, and the last 24 transcript messages across sessions and channels.
2. **One streamed LLM call.** The system prompt makes the mentor conversational, mirror English, Hindi
   or Hinglish, re-explain differently on "I don't get it", offer practice only when it helps (no forced
   MCQ), stay consistent with the verified reference notes in `topics/*.json`, and admit uncertainty
   instead of inventing APIs or outputs.
3. **Evidence.** The reply ends with a hidden `###EVIDENCE###` JSON block that is stripped before the
   learner sees it. It carries: was the waiting question answered and was it correct, the misconception,
   any new practice question with its answer key, explicit confusions, and explicitly stated profile
   details. If the block is missing or malformed, a separate extraction call runs, but only when evidence
   is possible (a waiting question, or the reply asked one).
4. **Persistence:** attempts (`graded_by='ai'`), profile facts (demonstrated vs inferred, with evidence),
   before/after outcomes when a missed concept is retested, profile fields, transcript entries labelled
   with `source` and `model`, and `events`.

If every provider fails, the turn runs the deterministic engine (`src/engine.ts`) and is labelled
`fallback`, with an "offline" note shown to the learner.

## Providers (src/ai/)
- `gemini.ts` (Generative Language REST) and `groq.ts` (OpenAI-compatible) keep their formats separate.
  Keys go only in request headers.
- `index.ts` routes across `AI_PROVIDERS` (default `gemini,groq`) and their models. Candidates come
  from each provider's live model list, ordered by a one-time startup latency probe. 404/429/503/timeout
  cool a model down; a **daily-quota** 429 cools it for 6 h. Streaming has a 10 s first-token watchdog
  and a 25 s budget per turn.
- `GET /api/ai/status` reports provider, model health and latency, never keys. `/health` shows the
  active provider and model.

Measured 24 Oct 2026 on the free Gemini tier: quota is **20 requests/day per model per project**;
`gemini-3.8-flash` returned 503, `gemini-3.7-flash` and `gemini-flash-latest` took 40–50 s,
`gemini-2.5-flash` returned 404 for new users, `gemini-pro-latest` returned 429. Working models
streamed first tokens in about 3.8–7.2 s.

## Voice
The ElevenLabs agent uses its own LLM but the same memory: `/tools/get_profile` returns the learner's
facts, misconceptions, outcomes, the reference plan, and the last 10 messages from any channel.
`record_attempt` and `save_outcome` write to the same tables.

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

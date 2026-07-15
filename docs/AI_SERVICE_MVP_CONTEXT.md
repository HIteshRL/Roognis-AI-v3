# Roognis AI Service MVP Context

Last updated: 2026-07-08

This file is the working context for building the Roognis AI Service in small, safe parts. Use it before coding so we do not forget the current scope, accidentally overbuild production features, or mix old design documents with the latest MVP plan.

## Current Goal

Build the AI Service MVP for Roognis.

The MVP should support the investor/user journey:

1. Student logs in through Auth Service.
2. Student creates a chat session.
3. Student asks the AI tutor a question.
4. AI answers through SSE streaming.
5. Chat history is saved.
6. Student can access demo video topics.
7. Student can submit feedback.
8. Student can create an image job and poll status.
9. AI Service fires analytics events without blocking the user flow.

## Current Snapshot

As of 2026-07-08:

- Completed through Phase 4 backend implementation.
- Current working branch is `feature/ai-safety-layer`.
- Auth and infrastructure are implemented.
- AI Service foundation, chat/session/history/SSE, video topics, feedback, image jobs, and Gemini provider switches are implemented.
- Chat now preserves the RAG-first flow and calls Gemini as the default LLM provider.
- Image generation now uses Gemini as the default image provider while keeping ComfyUI fallback support.
- AI Service now has an MVP child-safety layer for chat input, chat output, Gemini safety settings, image prompts, safe refusals, and safety analytics events.
- Frontend is intentionally not part of the current work because another person will handle it later.
- We are not focusing on video generation. Existing video work is curated educational video metadata/routes only.
- Next backend priority is real Gemini key verification and end-to-end AI Service integration testing.

Phase status:

```text
Phase 1: Auth + infra                         Done
Phase 2: AI service foundation                Done
Phase 3: Chat core / RAG prompt / SSE         Done
Phase 4: Video + feedback + image MVP         Done
Phase 5: Safety + Gemini integration verify   Safety done, Gemini verify pending
Phase 6: Frontend MVP integration             Later / separate owner
Phase 7: Final demo polish + remaining gaps   Later
```

## Progress

Completed:

- Part 1: AI Service foundation.
  - Added AI service `package.json`.
  - Added AI Prisma schema for `chat_sessions`, `messages`, `image_jobs`, and `feedback`.
  - Added AI JWT middleware.
  - Replaced AI stub server with a real Express foundation.
  - Aligned AI Dockerfile with the Auth service install/generate pattern.
  - Verified Prisma generation, Prisma schema validation, and `/health`.
- Part 2 implementation: Chat session, chat history, and SSE chat MVP.
  - Added `POST /api/ai/chat/session`.
  - Added `GET /api/ai/chat/:sessionId/history`.
  - Added `POST /api/ai/chat` with SSE streaming.
  - Added student-only auth checks.
  - Added session ownership checks.
  - Added RAG retrieval with timeout and empty-result fallback.
  - Added Roognis tutor prompt construction.
  - Added Ollama streaming parser.
  - Added user/assistant message persistence.
  - Added fire-and-forget analytics event call.
- Part 3 implementation: Video recommendations and feedback.
  - Added curated trusted-source video library metadata.
  - Added `GET /api/ai/video/topics`.
  - Added `GET /api/ai/video/:topic`.
  - Added `POST /api/ai/feedback`.
  - Feedback stores rating/comment against assistant messages.
  - Feedback fires analytics events without blocking the response.
  - Video view/like metrics are placeholders until YouTube/DIKSHA/provider API refresh is added.
- Part 4 implementation: Image MVP.
  - Added `POST /api/ai/image`.
  - Added `GET /api/ai/image/:jobId/status`.
  - Added `GET /api/ai/images/:filename`.
  - Image requests create queued DB jobs and return immediately.
  - Node background processing submits a ComfyUI workflow, polls history, saves the image to file storage, and marks the job done.
  - ComfyUI failures mark jobs failed with an explicit reason.
  - Added timeout cleanup for stuck processing jobs.
  - Image generation fires analytics events without blocking the response.
- Gemini provider implementation for MVP demo simplicity.
  - Added `LLM_PROVIDER=gemini` chat path while preserving the RAG prompt flow.
  - Added `IMAGE_PROVIDER=gemini` image path while preserving image job/status/image URL APIs.
  - Kept Ollama and ComfyUI as optional local fallback providers.
  - Updated Docker Compose so the default stack does not wait for Ollama or ComfyUI.
- Child-safety layer implementation.
  - Added chat input safety checks before RAG/Gemini.
  - Added image prompt safety checks before image job creation.
  - Added safe refusal response for blocked prompts/outputs.
  - Changed Gemini chat to generate internally, validate, then server-stream approved SSE chunks.
  - Added strict Gemini safety settings for chat generation.
  - Added output validation for Gemini and Ollama fallback responses before streaming to the student.
  - Added non-blocking analytics events for blocked chat input, blocked chat output, and blocked image prompts.
  - Added focused Node tests for chat safety, output safety, image prompt safety, and Gemini safety settings.

Next:

- Full integration verification with Postgres, Auth cookie, RAG stub, Analytics stub, and a real `GEMINI_API_KEY`.
- Docker verification for chat, feedback, video routes, image jobs, file storage, and Gemini image generation.
- Tighten Gemini image API request shape if real-key testing shows the current provider contract needs adjustment.
- Then frontend integration and quiz-related backend work.

## Child Safety Plan

Safety belongs in the AI Service for the MVP because the AI Service owns the student prompt, RAG prompt construction, Gemini request, generated answer, image prompt, image generation request, persistence, and analytics event.

Do not move this to RAG, Auth, or Analytics for MVP:

- Auth identifies the user and role.
- RAG retrieves school context.
- Analytics records events.
- AI Service decides whether a student request can safely reach Gemini and whether a model output can be returned.

Required AI Service safety controls before real student/demo usage:

1. Input safety guard for chat.
   - Reject clearly unsafe or non-school requests before RAG/Gemini.
   - Block sexual content, self-harm, hate/harassment, weapons, drugs, graphic violence, adult content, and unsafe instructions.
   - Return a safe, age-appropriate refusal instead of calling Gemini.

2. Strong tutor prompt rules.
   - Identify Roognis as a safe school tutor.
   - Require age-appropriate language.
   - Require answers to stay educational and school-related.
   - Require answers to use only retrieved RAG context.
   - If context is missing or irrelevant, answer: `I don't have information on that yet.`

3. Gemini safety settings.
   - Configure strict model safety thresholds for harassment, hate speech, sexually explicit content, dangerous content, and any other supported safety categories.
   - Keep these settings in one helper so chat and image paths are easy to audit.

4. Output safety guard for chat.
   - Prefer non-stream Gemini generation internally for child safety, then stream approved text from our server as SSE chunks.
   - This avoids sending unsafe partial tokens directly to the browser before validation.
   - If output fails safety validation, do not save it as an assistant answer; return a safe refusal.

5. Image prompt safety guard.
   - Allow only educational diagram-style prompts for MVP.
   - Reject requests involving realistic people, children, celebrities, sexual content, violence, gore, weapons, drugs, hate, brand/logo generation, or photo-realistic identity content.
   - Wrap allowed prompts with a safe educational diagram instruction before calling Gemini image generation.

6. Analytics and audit events.
   - Fire non-blocking analytics events for blocked prompts and blocked outputs.
   - Suggested event types: `safety_input_blocked`, `safety_output_blocked`, `image_prompt_blocked`.
   - Store enough metadata for debugging without storing sensitive unsafe text verbatim unless explicitly needed later.

7. Safe defaults.
   - If safety code is unsure, refuse safely.
   - If Gemini API key/model is missing, fail clearly.
   - Do not bypass RAG grounding for chat.

Safety refusal copy:

```text
I can only help with safe school-related learning questions. Try asking me about a topic from your class.
```

Recommended next implementation branch:

```text
feature/ai-safety-layer
```

Safety implementation checklist:

1. Add `validateStudentMessageSafety(message)`. Done.
2. Add `validateImagePromptSafety(prompt)`. Done.
3. Add shared safe refusal helpers. Done.
4. Add Gemini safety settings helper. Done.
5. Change Gemini chat path from direct provider streaming to generate-then-server-stream. Done.
6. Add output safety validation before saving/streaming assistant text. Done.
7. Add analytics events for blocked inputs/outputs. Done.
8. Add local tests or curl checks for safe/refused chat and image prompts. Local safety tests done; full endpoint verification pending real Gemini key.
9. Update README and this context with the safety behavior. Done.

## Source Of Truth

Use the latest design documents from:

- `/Users/chirag.sathish_int/Downloads/roognis-design/parts`
- `/Users/chirag.sathish_int/Downloads/roognis-design/roognis-design-with-quiz.pdf`

Important note: `roognis-design-with-quiz.pdf` is a reordered bundle of the same 32 pages from `parts`.

Older repo-root PDFs are useful background, but they are not fully current because they mention 8 fixes and do not include the final quiz-aware design. The latest plan mentions 9 fixes and adds Quiz Service.

## Local Repo

Repository path:

```text
/Users/chirag.sathish_int/Documents/roognis
```

Git remote:

```text
git@github.com:chiru0631/roognis
```

Current branch:

```text
feature/ai-safety-layer
```

## Current Repo State

Implemented:

- `services/auth` is implemented.
- Auth has login, register, logout, `/me`, parent-child linking, seed users, JWT cookie auth, and Prisma schema.
- `services/ai` has service foundation, chat session/history/SSE routes, curated video recommendation routes, feedback route, and image job routes.
- `services/ai` defaults to Gemini for chat and image generation, with Ollama/ComfyUI fallback support.
- `services/ai` has MVP child-safety checks for chat input, chat output, image prompts, Gemini strict chat safety settings, and safety analytics events.
- AI has Prisma schema for chat sessions, messages, image jobs, and feedback.
- `docker-compose.yml` has service wiring for frontend, auth, ai, rag, analytics, postgres, chromadb, and traefik, with Ollama/ComfyUI available behind the optional `local-ai` profile.
- `services/rag` has a stub `/api/rag/retrieve` that returns empty chunks.
- `services/analytics` has a stub `/api/analytics/event` that accepts events.

Not implemented yet:

- `services/ai` notes generation endpoint is not implemented yet.
- `services/ai` quiz internal endpoints are not implemented yet.
- `frontend` is still a stub.
- `seed-data` does not yet contain PDFs or image assets.

Known design/repo mismatch:

- Latest design expects `grade_level` in student JWT for quiz scoping.
- Current Auth schema and seed do not include `grade_level`.
- This is not required for the first AI chat MVP.
- Patch Auth before quiz-related work.

## MVP Boundary

Build now:

- AI service foundation.
- AI database schema.
- JWT-protected student APIs.
- Chat session creation.
- Chat history.
- SSE chat with Gemini after RAG prompt construction.
- RAG call with safe fallback when RAG is empty or unavailable.
- Analytics fire-and-forget calls.
- Video topics and video serving route.
- Feedback endpoint.
- Basic async image job endpoints.

Skip for now:

- Quiz endpoints.
- Redis/BullMQ.
- S3/object storage.
- Kubernetes hardening.
- Full metrics dashboard.
- Full production observability stack.
- Full RAG implementation.
- Full Analytics implementation.
- Full frontend.
- Enterprise service-to-service auth.

Principle: build a production-shaped MVP, not a full production system.

## AI Service Endpoints For MVP

Health:

- `GET /health`

Chat:

- `POST /api/ai/chat/session`
- `POST /api/ai/chat`
- `GET /api/ai/chat/:sessionId/history`

Video:

- `GET /api/ai/video/topics`
- `GET /api/ai/video/:topic`

Feedback:

- `POST /api/ai/feedback`

Image:

- `POST /api/ai/image`
- `GET /api/ai/image/:jobId/status`
- `GET /api/ai/images/:filename`

Defer:

- `POST /api/ai/quiz/generate`
- `POST /api/ai/quiz/grade`

## AI DB Schema Needed

Use Prisma with schema `ai_db`.

Tables:

- `chat_sessions`
  - `id`
  - `student_id`
  - `school_id`
  - `subject`
  - `created_at`

- `messages`
  - `id`
  - `session_id`
  - `role` as `user` or `assistant`
  - `content`
  - `created_at`

- `image_jobs`
  - `id`
  - `student_id`
  - `school_id`
  - `prompt`
  - `status` as `queued`, `processing`, `done`, or `failed`
  - `image_url`
  - `failure_reason`
  - `created_at`
  - `updated_at`

- `feedback`
  - `id`
  - `message_id`
  - `student_id`
  - `school_id`
  - `rating`
  - `comment`
  - `created_at`

MVP rule: every student-owned row should include `student_id` and `school_id` where applicable.

## Build Plan

### Part 1: AI Service Foundation

Files:

- Add `services/ai/package.json`.
- Add `services/ai/prisma/schema.prisma`.
- Add `services/ai/middleware/auth.js`.
- Replace `services/ai/server.js`.

Build:

- Express app.
- JSON parser.
- Cookie parser.
- Prisma client.
- JWT middleware copied from `services/auth/middleware/auth.js`.
- `GET /health`.
- Basic centralized helpers for env, async errors, and role checks if needed.

Done when:

- `services/ai` can install dependencies.
- Prisma client can generate.
- `GET /health` returns `{ status: "ok", service: "ai" }`.
- Protected routes reject missing/invalid cookies.

### Part 2: Chat Core

Build:

- `POST /api/ai/chat/session`
- `GET /api/ai/chat/:sessionId/history`
- `POST /api/ai/chat` with SSE

Rules:

- Only `student` role can create sessions and chat.
- Subject is required.
- Message is required and max 500 characters.
- Session must belong to `req.user.userId`.
- Load last 10 messages.
- Call RAG:

```text
GET {RAG_SERVICE_URL}/api/rag/retrieve?q={message}&schoolId={schoolId}&subject={subject}&top=5
```

- If RAG returns empty chunks, use a safe fallback context.
- Call Gemini by default:

```text
POST https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse
```

- Stream tokens to browser through SSE.
- Save user message and full assistant message.
- Fire analytics event without awaiting success.

Done when:

- Student can create a session.
- Student can send a chat message and receive SSE.
- Chat history returns saved messages.
- RAG stub returning empty chunks does not break chat.

### Part 3: Video And Feedback

Build:

- `GET /api/ai/video/topics`
- `GET /api/ai/video/:topic`
- `POST /api/ai/feedback`

Video topics:

- `photosynthesis`
- `fractions`
- `water-cycle`
- `parts-of-speech`
- `solar-system`

Feedback rules:

- Only students can submit feedback.
- Rating must be 1 to 5.
- Message must belong to the student's session.
- Save feedback.
- Fire `feedback_submitted` analytics event.

Done when:

- Topics endpoint returns the hardcoded demo list.
- Video route returns video URL or a clear 404 if the file is missing.
- Feedback is stored and analytics failure does not break the response.

### Part 4: Image MVP

Build:

- `POST /api/ai/image`
- `GET /api/ai/image/:jobId/status`
- `GET /api/ai/images/:filename`

MVP behavior:

- Create image job with `queued` status.
- Return `jobId` immediately.
- Process in background in the Node process for now.
- Use Gemini image generation by default.
- If `IMAGE_PROVIDER=comfyui`, submit the local ComfyUI workflow and mark failures explicitly.
- Polling endpoint returns status and image URL when done.
- Add a timeout cleanup for stuck jobs if simple enough.

Done when:

- Student can create an image job.
- Student can poll job status.
- Failure is explicit and does not leave spinner forever.

### Part 5: Verification

Minimum local checks:

1. AI service dependency install succeeds.
2. Prisma generate succeeds.
3. AI service boots.
4. `/health` works.
5. Unauthenticated protected endpoint returns 401.
6. Auth login gives cookie.
7. Student can create chat session with cookie.
8. Student can call SSE chat route.
9. History contains saved messages.
10. Feedback endpoint works.

Docker checks:

```sh
docker-compose up --build ai
docker-compose logs -f ai
```

Full stack check later:

```sh
docker-compose up --build
```

## Important Implementation Notes

Use existing repo style:

- Node.js 20.
- Express.
- Prisma.
- CommonJS `require`, not ESM.
- `cookie-parser`.
- `jsonwebtoken`.
- `@prisma/client`.

Do not introduce heavy abstractions yet.

Use simple helpers only when they reduce repeated code:

- `fireAnalyticsEvent`
- `fetchWithTimeout`
- `buildTutorPrompt`
- `sendSseEvent`

## Prompt Rules

System behavior from design:

```text
You are Roognis, an AI tutor for school students.
Rules:
- Answer ONLY based on the provided context below.
- If the answer is not in the context, say:
  "I don't have information on that yet."
- Be concise, friendly, and use simple language suitable for school students.
- Never make up facts.
- Format answers with bullet points when listing.
```

MVP adjustment:

- Because RAG is currently stubbed, if no chunks are returned, the prompt can say that textbook context is not available yet and answer only in a limited, clearly educational way, or return the configured fallback phrase.
- Do not pretend NCERT context exists when RAG returned none.

## Analytics Event Types

Fire-and-forget to:

```text
POST {ANALYTICS_URL}/api/analytics/event
```

Events needed now:

- `chat_message`
- `feedback_submitted`
- `image_generated`

Failure to send analytics must never fail the user request.

## Risks To Remember

- RAG is a stub, so real curriculum-grounded answers are not possible yet.
- Gemini API calls require `GEMINI_API_KEY` and the configured models to be enabled for the account.
- Ollama model startup can be slow when using local fallback.
- SSE must handle client disconnects.
- The current Auth JWT does not include `grade_level`.
- Seed data videos are missing.
- ComfyUI model download is large and may not be available on every machine when using local fallback.
- Local Docker volume storage is fine for MVP, not final production.

## Next Coding Step

Finish Part 4 verification before starting frontend or quiz work.

Do not implement quiz in the same PR as image MVP.

Next coding checkpoint:

1. Add `GEMINI_API_KEY` to `.env`.
2. Start Postgres, Auth, Traefik, Analytics, RAG stub, and AI.
3. Confirm AI DB push has created `image_jobs`.
4. Login as `arjun@demo.com`.
5. Call chat and confirm SSE tokens come from Gemini after RAG retrieval.
6. Call `POST /api/ai/image` with an educational diagram prompt.
7. Poll `GET /api/ai/image/:jobId/status`.
8. Confirm status becomes `done` and `imageUrl` serves the generated PNG.
9. Confirm missing auth returns `401` for chat/image routes.

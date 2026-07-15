# AI Service LLD

Service path: `services/ai`

## Purpose

AI owns model calls and child safety:

- tutor chat
- RAG-based prompt construction
- generated text safety
- diagram image jobs
- curated video metadata
- feedback persistence
- AI-generated quiz drafts for teacher review

AI should not own classroom assignment lifecycle. That belongs to Quiz Service.

## Current Repo State

Implemented:

- `POST /api/ai/chat/session`
- `GET /api/ai/chat/:sessionId/history`
- `POST /api/ai/chat`
- `GET /api/ai/video/topics`
- `GET /api/ai/video/:topic`
- `POST /api/ai/feedback`
- `POST /api/ai/image`
- `GET /api/ai/image/:jobId/status`
- `GET /api/ai/images/:filename`

Current schema:

- `ChatSession`
- `Message`
- `ImageJob`
- `Feedback`

Safety:

- chat input guard
- image prompt guard
- Gemini strict safety settings
- output guard before server-streaming SSE
- safety tests in `services/ai/test/safety.test.js`

## Gaps

Missing for quiz story:

- Teacher-safe AI quiz generation endpoint.
- JSON schema validation for generated quiz drafts.
- Lesson-aware RAG retrieval.
- Weak-area tags per question.
- Event emission for quiz generation.
- Internal contract with Quiz Service.

## Required API

Add:

```text
POST /api/ai/quiz/draft
```

Role:

- teacher for browser/API calls
- later: service token for Quiz Service internal calls

Request:

```json
{
  "classroomId": "uuid",
  "lessonId": "uuid",
  "subject": "Science",
  "grade": "6",
  "lessonTitle": "Plants and nutrition",
  "questionCount": 5,
  "difficulty": "grade_6_basics"
}
```

Response:

```json
{
  "questions": [
    {
      "type": "mcq",
      "prompt": "Which gas do plants release during photosynthesis?",
      "options": ["Oxygen", "Carbon dioxide", "Nitrogen", "Hydrogen"],
      "correctAnswer": "Oxygen",
      "explanation": "Plants release oxygen as a product of photosynthesis.",
      "conceptTag": "photosynthesis_outputs",
      "weakAreaLabel": "Outputs of photosynthesis",
      "marks": 1
    }
  ],
  "sourceChunks": [
    {
      "chunkId": "uuid-or-vector-id",
      "source": "NCERT Science Grade 6"
    }
  ]
}
```

## Prompt Rules For Quiz Draft

System behavior:

```text
You are Roognis, a safe school tutor assistant helping a teacher create a classroom quiz.
Use only the provided lesson context.
Generate age-appropriate questions for the given grade.
Return strict JSON only.
Each question must include type, prompt, correctAnswer, explanation, conceptTag, weakAreaLabel, and marks.
If context is insufficient, return an empty question list with a clear reason.
```

## Validation

Before calling Gemini:

- validate teacher role
- validate subject, grade, lesson title length
- reject unsafe lesson/prompt values through safety helpers

After Gemini:

- parse JSON
- validate every question shape
- enforce max `questionCount`
- reject if options do not include `correctAnswer`
- reject unsafe generated text
- do not return raw model text on parse failure

## RAG Contract

Preferred call once RAG exists:

```text
GET /api/rag/lessons/:lessonId/context?top=8
```

Fallback until lesson RAG exists:

```text
GET /api/rag/retrieve?q={lessonTitle}&schoolId={schoolId}&subject={subject}&top=8
```

If RAG returns empty:

- for demo, allow only seeded/static lesson draft if explicitly configured
- otherwise return clear error:

```json
{
  "error": "Lesson context is not available yet."
}
```

## Events

Emit to Analytics:

```text
quiz_draft_generated
quiz_draft_generation_failed
```

Metadata:

```json
{
  "classroomId": "uuid",
  "lessonId": "uuid",
  "questionCount": 5,
  "subject": "Science",
  "model": "gemini-3.5-flash"
}
```

## Done Criteria

- Teacher can request a quiz draft.
- AI returns strict JSON.
- Unsafe request is refused.
- RAG empty state is explicit.
- Quiz Service can call this endpoint and persist returned questions.
- Unit tests cover safe request, unsafe request, bad JSON, and empty context.

## Tests

Add tests for:

- safe quiz draft prompt passes.
- unsafe quiz prompt is blocked.
- generated JSON schema validation.
- generated unsafe question is blocked.
- RAG empty response returns explicit failure.


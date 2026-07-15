# Roognis Backend Service Workstreams

Last updated: 2026-07-09

Use this folder when multiple people are working in parallel. Each file is scoped to one backend service/workstream and can be shared with the person owning that part.

The combined review is still available at:

- `docs/MVP_BACKEND_ALIGNMENT_LLD.md`

## Current Backend Reality

| Workstream | Repo status | Needed for current dashboard story |
|---|---|---|
| Auth Service | Implemented for login/users/parent links | Needs teacher classroom roster |
| AI Service | Implemented for chat, image, video metadata, feedback, safety | Needs quiz-draft generation support |
| Quiz Service | Missing | Required |
| Analytics / Learning Progress | Stub in current branch; PR #8 is partial | Needs quiz/progress analytics |
| RAG / EKE Service | Stub only | Needed for grounded chat and quiz quality |
| Backend Infra | Docker/K8s exists for current services | Needs Quiz service wiring and cleanup |

## Recommended Build Order

1. Auth roster foundation.
2. Quiz service MVP.
3. Analytics / learning progress APIs.
4. AI quiz-draft generation endpoint.
5. RAG lesson-context implementation.
6. Frontend API wiring after contracts are stable.

## Files

- ~~`AUTH_SERVICE_LLD.md`~~ — removed along with the auth service (see root README)
- `AI_SERVICE_LLD.md`
- `QUIZ_SERVICE_LLD.md`
- `ANALYTICS_SERVICE_LLD.md`
- `RAG_SERVICE_LLD.md`
- `RAG_EKE_INGESTION_CONTRACT.md`
- `INFRA_BACKEND_LLD.md`

## Cross-Service Ownership Rules

- Auth owns identity, roles, parent links, and class roster.
- AI owns model calls, child safety, tutor responses, image generation, and AI-generated quiz drafts.
- Quiz owns quiz lifecycle, assignments, student attempts, grading, and quiz review source-of-truth.
- Analytics owns dashboard aggregation, streaks, time spent, weak-area rollups, and parent/teacher/student summaries.
- RAG / EKE owns lesson/document ingestion, educational entities, and retrieval context.
- Frontend should not infer permissions from hardcoded email strings once backend wiring begins.


# Roognis AI

**An AI-powered educational tutor for school students** — built on NCERT curriculum, designed for scale.

Roognis delivers personalised AI tutoring through role-based portals for students, teachers, and parents. Students chat with an AI tutor grounded in real NCERT textbooks, request educational diagrams, and watch curated video lessons. Teachers monitor class engagement and flag struggling students automatically. Parents track their child's progress in real time.

---

> ## ⚠️ Auth has been removed — local demo build
>
> **This build has no authentication of any kind. Do not deploy it.**
>
> The `auth` service, all JWT verification, the login screen, and every role
> guard have been deleted. What that means in practice:
>
> - **Every API endpoint is open.** Anyone who can reach a service can read or
>   write any data in it, including all student records.
> - **There are no accounts, roles, or parent-child links.** Each role is a
>   separate frontend on its own port (3000/3001/3002). That is process
>   separation for demo convenience, not a permission boundary — all three call
>   the same open APIs, so opening the teacher port grants teacher screens to
>   anyone who can reach it.
> - **Chat sessions and image jobs have no owner.** `studentId`/`schoolId` were
>   dropped from the `ai` schema, so any caller can read any session.
> - **The student roster is a fixture.** It used to live in `auth_db.users`;
>   it now lives in `services/analytics/lib/demo-roster.js`.
> - **Services run as one fixed demo tenant** via `DEMO_SCHOOL_ID`,
>   `DEMO_STUDENT_ID`, and `DEMO_TEACHER_ID` (see `.env.example`). These are
>   placeholders for the identity the JWT used to supply — they are not secrets.
>
> `INTERNAL_SERVICE_TOKEN` still guards `POST /api/analytics/event`, but that is
> service-to-service only and is not user auth.
>
> To restore auth, recover `services/auth` from the pre-removal backup and revert
> the `req.user` call sites in `services/ai` and `services/analytics`.

---

## System Architecture

```
Browser
  ├── Student portal :3000 ─┐
  ├── Teacher portal :3001 ─┤  same image, PORTAL_ROLE differs.
  ├── Parent  portal :3002 ─┤  each proxies /api/* to Traefik.
  │                         │
  └── Traefik API Gateway (:80)
        ├── /api/ai        → AI Service        :3002  (Node.js + Prisma)
        ├── /api/rag       → RAG Service       :3003  (Python + FastAPI)
        ├── /api/analytics → Analytics Service :3004  (Node.js + Prisma)
        ├── /api/classroom → Classroom Service :3005  (Node.js + Prisma) — LMS from v2
        └── /              → Student portal    :3000  (static HTML + Node http)

Data Layer
  ├── PostgreSQL :5432     — 3 isolated schemas (ai_db, rag_db, analytics_db)
  ├── ChromaDB   :8000     — Vector store for NCERT PDF embeddings
  └── Docker Volume        — /data (PDFs, generated images, seed videos)

AI Layer
  ├── Gemini API          — default MVP provider for chat + image generation
  ├── Ollama     :11434   — optional local fallback for text chat
  └── ComfyUI    :8188    — optional local fallback for image generation
```

### Request Flow — AI Chat

```
Student sends message
  → Traefik routes to AI Service
    → AI Service validates JWT (student role, ≤500 chars)
    → AI Service fetches top-5 NCERT chunks from RAG Service
    → AI Service builds prompt: system rules + NCERT context + last 10 messages
    → Gemini streams response tokens via SSE → browser renders live
    → AI Service saves messages + fires analytics event (async, non-blocking)
```

### Role-Based Access

| Role | What they see | What they can do |
|---|---|---|
| **Student** | AI chat, image generation, video lessons | Chat with Roognis AI, request diagrams, watch videos, rate responses |
| **Teacher** | Class dashboard, intervention alerts | Mark attendance, enter scores, assign students, upload PDFs, view trends |
| **Parent** | Child's progress dashboard | View child's scores, attendance, and AI usage stats |

On login, the browser is redirected to the appropriate dashboard based on the user's role. The JWT contains the user's role, school ID, and (for parents) their linked student IDs — downstream services authorise requests without additional database calls.

---

## What Is Built (Auth + Infrastructure)

The following is complete and production-ready:

### Auth Service (`services/auth/`) — `:3001`

A fully implemented authentication and identity service.

**Endpoints:**

| Method | Path | Description | Auth |
|---|---|---|---|
| `GET` | `/health` | Health check | None |
| `POST` | `/api/auth/register` | Register student or parent | None |
| `POST` | `/api/auth/login` | Login — issues HttpOnly JWT cookie | None (rate-limited) |
| `POST` | `/api/auth/logout` | Logout — clears cookie | Required |
| `GET` | `/api/auth/me` | Get current user profile | Required |
| `POST` | `/api/auth/link-parent` | Link a parent account to a student | Teacher or Parent |
| `GET` | `/api/auth/parent/:id/students` | List students linked to a parent | Teacher or Parent |

**Security:**
- Passwords hashed with bcrypt (cost 12)
- JWT stored in `HttpOnly; SameSite=Strict` cookie — inaccessible to JavaScript
- JWT payload: `{ userId, role, schoolId, studentIds? }` — 24-hour expiry
- Login rate-limited to 10 attempts per minute per IP
- Teacher accounts cannot self-register — created via seed script only

**JWT Middleware (shared pattern for all services):**

Every service that needs to validate JWTs should copy `services/auth/middleware/auth.js`. It reads the `jwt` cookie and verifies it against `JWT_SECRET`. Usage:

```js
const requireAuth = require('./middleware/auth');

// Require any authenticated user
router.get('/protected', requireAuth, handler);

// Require a specific role
router.post('/teacher-only', requireAuth, requireAuth.requireRole('teacher'), handler);
```

**Database Schema (`auth_db`):**

```
schools         — id, name
users           — id, name, email, password_hash, role, school_id, created_at
parent_student  — parent_id, student_id  (composite PK, idempotent linking)
```

**Demo Seed Accounts** (auto-seeded on first boot):

| Email | Password | Role | Notes |
|---|---|---|---|
| `teacher@demo.com` | `demo1234` | Teacher | Seed-only; cannot self-register |
| `arjun@demo.com` | `demo1234` | Student | Linked to parent1 |
| `priya@demo.com` | `demo1234` | Student | Linked to parent2 |
| `rahul@demo.com` | `demo1234` | Student | No parent linked |
| `parent1@demo.com` | `demo1234` | Parent | Linked to Arjun |
| `parent2@demo.com` | `demo1234` | Parent | Linked to Priya |

---

### Infrastructure

**`docker-compose.yml`** — 10-service orchestration covering the full stack. The default MVP path uses Gemini, so Ollama and ComfyUI are behind the optional `local-ai` profile.

**`traefik/traefik.yml`** — API gateway config. Routes requests by path prefix to the correct service. CORS configured for `localhost:3000`. Dashboard available at `http://localhost:8080`.

**`scripts/ollama-init.sh`** — Optional local fallback entrypoint for Ollama. Starts the server, waits for the API, pulls `qwen2.5` and `nomic-embed-text` (idempotent — skips if already in the volume), then keeps the container alive.

**`scripts/comfyui-model-download.sh`** — Optional local fallback script to download the Stable Diffusion v1.5 checkpoint (~4GB) into the `comfy_models` Docker volume.

**`kubernetes/`** — Full Kubernetes manifests for production deployment. See [Cloud Deployment](#cloud-deployment--kubernetes) below.

---

## Quick Start

### Prerequisites

- Docker Desktop or Docker + `docker-compose`
- Gemini API key for MVP chat and image generation
- Disk space for the Ollama embedding model used by RAG ingestion; more disk space if using optional ComfyUI image fallback

### 1. Configure environment

```sh
cp .env.example .env
# Edit .env — set a strong JWT_SECRET at minimum
```

Add Gemini settings:

```sh
LLM_PROVIDER=gemini
IMAGE_PROVIDER=gemini
GEMINI_API_KEY=<your Gemini API key>
GEMINI_TEXT_MODEL=<your Gemini text model>
GEMINI_IMAGE_MODEL=gemini-3.1-flash-image
```

Child-safety behavior is enforced inside the AI Service. Chat requests are checked before RAG/Gemini, Gemini chat uses strict safety settings, model text is validated before the service streams SSE chunks to the browser, and image prompts are limited to safe educational diagram requests.

### 2. Optional: run local image generation fallback

Only needed if you set `IMAGE_PROVIDER=comfyui`.

```sh
sh scripts/comfyui-model-download.sh
```

### 3. Start the full stack

Default Gemini MVP startup starts Ollama for RAG embeddings and ChromaDB for vector storage. ComfyUI remains behind the optional `local-ai` profile.

```sh
docker-compose up --build
```

To use local fallback providers:

```sh
LLM_PROVIDER=ollama IMAGE_PROVIDER=comfyui docker-compose --profile local-ai up --build
```

Optional: seed a demo classroom so the LMS boots with living data — one class
(join code `SCIDEM6`), the roster enrolled, a pinned stream post, a rubric, and
three assignments (one graded, one awaiting grading, one open):

```sh
docker compose exec classroom npm run seed
```

### 4. Access the application

Each role is served by its own frontend process on its own port. There is no login
and no role switcher — **the port you open is the portal you get.**

| Service | URL | Description |
|---|---|---|
| Student portal | http://localhost:3000 | Tutor chat, diagrams, videos |
| Teacher portal | http://localhost:3001 | Class overview, PDF ingestion |
| Parent portal | http://localhost:3002 | Linked child progress |
| API Gateway | http://localhost:80 | All API requests |
| Traefik Dashboard | http://localhost:8080 | Live routing view |
| ComfyUI | http://localhost:8188 | Optional local image generation UI |

`http://localhost/` also serves the student portal, via Traefik.

The sidebar of each portal links to the other two. Those links are a demo
convenience, **not** a boundary — every portal is open to anyone who can reach its
port, and all three call the same unauthenticated APIs.

To run the portals without Docker:

```sh
cd frontend
npm run start:all        # all three: 3000 / 3001 / 3002
npm run start:teacher    # or just one
```

Ports are configurable with `STUDENT_PORT`, `TEACHER_PORT`, and `PARENT_PORT`.
Set them consistently across all three processes, since each portal builds its
sidebar links from that map.

> **Port clash if you run the backends outside Docker.** The parent portal's
> `3002` is also the AI service's default `PORT`. Under `docker compose` there is
> no conflict — the AI service is only reachable inside the Docker network and is
> never published to the host. But if you run `services/ai` directly on your
> machine alongside the portals, one of them will fail to bind. Move either:
> `PARENT_PORT=3005 npm run start:all`.

---

## Classroom LMS (ported from Roognis v2)

The classroom service (`services/classroom/`, `:3005`, `/api/classroom`) brings
the v2 Google-Classroom-parity core into this stack, adapted to the no-auth demo
tenancy. What works end to end across the three portals:

| Feature | Teacher portal (:3001) | Student portal (:3000) | Parent portal (:3002) |
|---|---|---|---|
| Classes | create, archive/restore, join-code rotate/disable, roster | join by code, leave | — |
| Stream | post, draft, publish, pin, delete | read (published only) | — |
| Classwork | assignment/homework/quiz/exam/practice set; draft → scheduled → published → archived; duplicate | list published, see own status | — |
| Submissions | list per assignment, download grade view | turn in text, resubmit (attempt++), withdraw before due | — |
| Grading | score + comment + private feedback, rubric scoring, return; append-only grade history | see returned grade + rubric breakdown | recent grades |
| Rubrics | reusable library, attach to assignment (copies criteria) | rubric shown on assignment | — |
| Gradebook | matrix, class average, CSV export | per-class "My grades" | — |
| Calendar | — | next-30-days due list across classes | — |
| Guardians | link/remove guardian emails per student | — | upcoming / missing / recent-grades digest |

Faithfully ported v2 rules: late submissions honour `allowLate` after the due
date; a submission needs `withdraw`/`resubmit` once turned in; withdrawing is
blocked after the deadline; grades are append-only (a regrade adds history, the
latest wins); gradebook averages count **returned** grades only; students never
see drafts or scheduled items; scheduled work auto-publishes lazily on read.

Not ported (out of scope for the demo): file-upload submissions and materials
(needs shared file storage on this path), discussions/comments, notifications,
polls, topics, co-teachers, invitations and join-request approval, institutions,
and the admin console.

## EKE Ingestion Setup and Verification

The RAG service now includes the Educational Knowledge Engine ingestion path. Teachers can upload textbook PDFs, the service persists document/job lifecycle rows in `rag_db`, extracts educational entities, generates retrieval chunks, embeds them with Ollama, stores vectors in ChromaDB, and serves AI-compatible retrieval chunks back to the AI service.

### RAG/EKE environment variables

Docker Compose sets the runtime defaults for local development. Override these only when changing storage, database, or embedding infrastructure:

| Variable | Default in local stack | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:<DB_PASSWORD>@postgres:5432/roognis` | SQLAlchemy connection for `rag_db` tables |
| `RAG_DB_SCHEMA` | `rag_db` | PostgreSQL schema for documents, jobs, entities, relationships, and chunks |
| `JWT_SECRET` | from `.env` | Verifies teacher JWT cookies for ingestion endpoints |
| `CHROMA_URL` | `http://chromadb:8000` | ChromaDB HTTP endpoint for vector writes/queries |
| `OLLAMA_URL` | `http://ollama:11434` | Ollama endpoint for embedding generation |
| `OLLAMA_EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model used for chunks and retrieve queries |
| `FILE_STORAGE_PATH` | `/app/storage` | Shared volume path for uploaded PDFs |
| `RAG_MAX_UPLOAD_MB` | `50` | Maximum PDF upload size |
| `RAG_COLLECTION_PREFIX` | `school` | Prefix for per-school/per-subject Chroma collections |
| `RAG_TEST_MODE` | `false` | Test-only deterministic embedding mode used by pytest |

For local EKE ingestion, make sure the embedding service is available. The default stack starts ChromaDB and Ollama; the bundled Ollama init script pulls `nomic-embed-text` idempotently before RAG starts:

```sh
LLM_PROVIDER=ollama IMAGE_PROVIDER=comfyui docker-compose --profile local-ai up --build
```

### Frontend teacher flow

1. Open `http://localhost:3001` — the teacher portal. No login; the port selects the role.
2. In the teacher sidebar, open `Ingestion`.
4. Select a PDF and fill the required metadata fields: board, curriculum, grade, subject, book, chapter, chapter name, language, and edition.
5. Click `Upload`.
6. Watch the latest upload panel move through upload/processing states until it shows `Ready for retrieval` or a failure message.
7. Use `Refresh` or the status icon beside any document to reload document status, entity count, chunk count, and ready/failed state.

### Curl examples

All requests go through Traefik at `http://localhost`. Use a real PDF path for `file=@...`.

```sh
# Login as teacher and save the JWT cookie
curl -s -c /tmp/roognis-teacher-cookies.txt -X POST http://localhost/api/auth/login -H "Content-Type: application/json" -d '{"email":"teacher@demo.com","password":"demo1234"}'

# Upload a PDF chapter for ingestion
curl -s -b /tmp/roognis-teacher-cookies.txt -X POST http://localhost/api/rag/upload -F "file=@/absolute/path/to/chapter.pdf;type=application/pdf" -F "board=CBSE" -F "curriculum=NCERT" -F "grade=8" -F "subject=Science" -F "book=Curiosity" -F "chapterNumber=10" -F "chapterName=Light: Mirrors and Lenses" -F "language=English" -F "edition=2026-27"

# Check one upload; replace DOC_ID with the documentId from the upload response
curl -s -b /tmp/roognis-teacher-cookies.txt http://localhost/api/rag/upload/DOC_ID/status

# List uploaded documents for the teacher's school
curl -s -b /tmp/roognis-teacher-cookies.txt "http://localhost/api/rag/documents?subject=Science&grade=8&status=ready"

# Retrieve AI-compatible chunks; this endpoint intentionally does not require JWT
curl -s "http://localhost/api/rag/retrieve?q=dentist%20mirror&schoolId=550e8400-e29b-41d4-a716-446655440000&subject=Science&grade=8&chapterNumber=10&top=5"
```

Expected retrieval shape:

```json
{
  "chunks": [
    {
      "text": "Uses of Concave Mirror...\nDentists use concave mirrors...",
      "source": "NCERT Science Grade 8, Curiosity, Chapter 10, p.1",
      "score": 0.8,
      "metadata": {
        "schoolId": "550e8400-e29b-41d4-a716-446655440000",
        "grade": 8,
        "subject": "Science",
        "chapterNumber": 10
      }
    }
  ]
}
```

### Verification steps

Use these checks before raising or reviewing the EKE ingestion PR:

```sh
# Python RAG service tests
python -m pytest services/rag/tests

# Python syntax check
python -m compileall -q services/rag

# Frontend inline script and server syntax
node -e "const fs=require('fs'); const html=fs.readFileSync('frontend/index.html','utf8'); const m=html.match(/<script>([\\s\\S]*)<\\/script>/); if(!m) throw new Error('script not found'); new Function(m[1]); console.log('inline script ok');"
node --check frontend/server.js
```

Manual verification:

- Uploading without a teacher cookie returns `401`; uploading with a student cookie returns `403`.
- Non-PDF, empty PDF, invalid grade, and invalid chapter metadata are rejected.
- A successful upload returns `status: "ready"`, `entitiesCreated`, `chunksCreated`, `chunksEmbedded`, and `collection`.
- `GET /api/rag/upload/:docId/status` reports progress and failure details.
- `GET /api/rag/documents` is school-scoped and shows entity/chunk counts.
- `GET /api/rag/retrieve` returns `{ "chunks": [...] }` where each chunk includes `text`, `source`, and `score`, preserving the AI service contract.

---

## Team Handoff Guide

This section is for team members implementing the remaining services.

### Environment Variables Available to Your Service

Every service receives these variables from `docker-compose.yml`. You do not need to set them manually:

```sh
# Your service's database schema
DATABASE_URL=postgresql://postgres:<DB_PASSWORD>@postgres:5432/roognis?schema=<your_schema>

# Shared JWT secret — use this to verify tokens
JWT_SECRET=<from .env>

# Internal service URLs
LLM_PROVIDER=gemini
IMAGE_PROVIDER=gemini
GEMINI_API_KEY=<from .env>
GEMINI_TEXT_MODEL=<from .env>
GEMINI_IMAGE_MODEL=<from .env>
OLLAMA_URL=http://ollama:11434        # optional fallback
RAG_SERVICE_URL=http://rag:3003
ANALYTICS_URL=http://analytics:3004
COMFYUI_URL=http://comfyui:8188       # optional fallback

# File storage
FILE_STORAGE_PATH=/app/storage
```

### Adding JWT Auth to Your Service

Copy `services/auth/middleware/auth.js` into your service's `middleware/` folder. No changes needed.

```sh
# From your service directory
cp ../auth/middleware/auth.js middleware/auth.js
```

Then use it in your routes:

```js
const requireAuth = require('./middleware/auth');

router.get('/api/ai/chat/:id/history', requireAuth, requireAuth.requireRole('student'), handler);
```

### AI Service — What to Build

**File:** `services/ai/server.js` (replace the stub)  
**Schema:** `ai_db` — chat_sessions, messages, image_jobs, feedback  
**Key dependencies:** `express`, `@prisma/client`, `node-cron`, `cookie-parser`, `jsonwebtoken`

See `roognis-ai-design-complete.pdf → LLD v3 → AI Service :3002` for full endpoint specs and system prompt. The current MVP defaults to Gemini for text and image generation while keeping Ollama/ComfyUI fallback support.

The AI Service owns MVP child safety: it blocks unsafe chat/image prompts before provider calls, validates generated chat output before SSE streaming, returns a safe refusal for blocked content, and emits non-blocking safety analytics events.

### RAG / EKE Service — Current Surface

**Files:** `services/rag/main.py`, `services/rag/eke_pipeline.py`, `services/rag/chunking.py`, `services/rag/retrieval.py`

**Schema:** `rag_db` — SQLAlchemy-managed documents, ingestion jobs, educational entities, relationships, and retrieval chunks

**Key dependencies:** `fastapi`, `uvicorn`, `pymupdf`, `chromadb`, `ollama`, `pyjwt`, `sqlalchemy`

Implemented endpoints:

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/rag/upload` | Teacher JWT | Upload a PDF and run EKE ingestion |
| `GET` | `/api/rag/upload/:docId/status` | Teacher JWT | Poll document/job lifecycle status |
| `GET` | `/api/rag/documents` | Teacher JWT | List school-scoped uploaded documents |
| `GET` | `/api/rag/retrieve` | None | Return AI-compatible `{ chunks }` with `text`, `source`, and `score` |

The retrieve endpoint is called internally by the AI Service without JWT. Document management remains teacher-only and school-scoped.

Detailed contract: `docs/backend-services/RAG_EKE_INGESTION_CONTRACT.md`.

### Analytics Service — What to Build

**File:** `services/analytics/server.js` (replace the stub)  
**Schema:** `analytics_db` — events, attendance, scores, class_assignments  
**Key dependencies:** `express`, `@prisma/client`, `cookie-parser`, `jsonwebtoken`

The `/api/analytics/event` endpoint accepts fire-and-forget events from other services without JWT. The stub already accepts these so the AI Service does not crash before Analytics is implemented.

The intervention rule flags a student if: `AVG(feedback rating) < 3.0` OR `COUNT(DISTINCT session_id) < 3` in the last 7 days — calculated at query time, no cron needed.

### Frontend — Current Surface

**File:** `frontend/index.html` served by `frontend/server.js`

**API base URL:** `http://localhost/api` (configured via `NEXT_PUBLIC_API_URL` in compose)

All requests should be made with `credentials: 'include'` so the browser sends the HttpOnly JWT cookie:

```js
fetch('http://localhost/api/auth/me', { credentials: 'include' })
```

After login, the single-page frontend switches workspace based on `role`:
- `student` → tutor chat, diagrams, videos, and feedback
- `teacher` → EKE ingestion workspace and document library
- `parent` → linked-child placeholder pending Analytics/Quiz data

### Rebuilding a Single Service

You do not need to restart the entire stack when working on one service:

```sh
docker-compose up --build ai       # Rebuild and restart only the AI service
docker-compose logs -f analytics   # Follow logs for a specific service
docker-compose ps                  # Check status of all services
```

---

## API Reference

All requests go through Traefik at `http://localhost:80`. The JWT cookie is set automatically on login and sent with every subsequent request.

### Authentication

> **Note:** Use single-line curl commands (no backslash line breaks) in zsh/macOS Terminal.

```sh
# Register a student
curl -s -X POST http://localhost/api/auth/register -H "Content-Type: application/json" -d '{"name":"Test User","email":"test@school.com","password":"pass1234","role":"student","schoolId":"550e8400-e29b-41d4-a716-446655440000"}'

# Login as student — saves JWT cookie to /tmp/cookies.txt
curl -s -c /tmp/cookies.txt -X POST http://localhost/api/auth/login -H "Content-Type: application/json" -d '{"email":"arjun@demo.com","password":"demo1234"}'

# Login as teacher
curl -s -c /tmp/cookies.txt -X POST http://localhost/api/auth/login -H "Content-Type: application/json" -d '{"email":"teacher@demo.com","password":"demo1234"}'

# Login as parent
curl -s -c /tmp/cookies.txt -X POST http://localhost/api/auth/login -H "Content-Type: application/json" -d '{"email":"parent1@demo.com","password":"demo1234"}'

# Get current user (uses saved cookie)
curl -s -b /tmp/cookies.txt http://localhost/api/auth/me

# Logout
curl -s -b /tmp/cookies.txt -X POST http://localhost/api/auth/logout
```

### JWT Payload Structure

```json
{
  "userId": "uuid",
  "role": "student | teacher | parent",
  "schoolId": "uuid",
  "studentIds": ["uuid"],   
  "iat": 1720000000,
  "exp": 1720086400
}
```

`studentIds` is present only for parent accounts — contains the UUIDs of all linked children.

---

## Cloud Deployment — Kubernetes

The entire stack is designed for zero-code cloud migration. Every infrastructure dependency is driven by a single environment variable.

### Cloud Swap Table

| Component | Local (Docker Compose) | Cloud (Kubernetes + AWS) | How to swap |
|---|---|---|---|
| PostgreSQL | `postgres` container | AWS RDS | Change `DATABASE_URL` in K8s Secret |
| Vector DB | ChromaDB container | Pinecone | Set `PINECONE_API_KEY` + `PINECONE_ENV` |
| LLM | Gemini API | Ollama fallback or other hosted API | Set `LLM_PROVIDER` + provider key |
| File Storage | Docker volume | AWS S3 | Set `AWS_S3_BUCKET` + credentials |
| Routing | Traefik (Docker labels) | nginx-ingress | `kubernetes/ingress/ingress.yaml` |

No code changes required — only Kubernetes Secret values differ per environment.

### Deploy to Kubernetes

```sh
# 1. Create secrets (see kubernetes/secrets/README.md for full reference)
kubectl create secret generic auth-secrets \
  --namespace roognis \
  --from-literal=DATABASE_URL="postgresql://..." \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=DEMO_SCHOOL_ID="550e8400-e29b-41d4-a716-446655440000"

# 2. Build and push images to your registry
docker build -t your-registry/roognis-auth:latest services/auth
docker push your-registry/roognis-auth:latest

# 3. Apply all manifests
kubectl apply -k kubernetes/

# 4. Verify
kubectl get pods -n roognis
kubectl get ingress -n roognis
```

### Scaling

The Auth service HPA scales from 2 to 10 replicas automatically at 70% CPU utilisation. Extend the same pattern to other services by adding `hpa.yaml` files in their Kubernetes folders.

```sh
kubectl get hpa -n roognis
```

---

## Project Structure

```
roognis/
├── .env.example                    — Environment variable template
├── docker-compose.yml              — Full local stack (10 services)
├── traefik/
│   └── traefik.yml                 — API gateway config + CORS
├── scripts/
│   ├── ollama-init.sh              — Pull local fallback AI models
│   └── comfyui-model-download.sh  — Download local fallback SD v1.5 model
├── seed-data/                      — Add NCERT PDFs + demo videos here
├── services/
│   ├── auth/                       ✅ Complete — Auth & identity service
│   │   ├── Dockerfile
│   │   ├── server.js
│   │   ├── middleware/auth.js      — Copy this to other services
│   │   ├── routes/auth.routes.js
│   │   ├── prisma/schema.prisma
│   │   └── scripts/seed.js
│   ├── ai/                         🔧 Stub — implement per LLD v3
│   ├── rag/                        Complete — RAG/EKE ingestion and retrieval
│   └── analytics/                  🔧 Stub — implement per LLD v3
├── frontend/                       MVP single-page app with teacher ingestion
└── kubernetes/                     — Production K8s manifests
    ├── kustomization.yaml
    ├── namespace.yaml
    ├── auth/    {deployment, service, hpa}
    ├── ai/      {deployment, service}
    ├── rag/     {deployment, service}
    ├── analytics/ {deployment, service}
    ├── frontend/  {deployment, service}
    ├── postgres/  {statefulset, service, pvc}
    ├── ingress/   {ingress.yaml}
    └── secrets/   README.md
```

---

## Design Documents

The full system design is documented in three PDFs at the repo root:

| Document | Contents |
|---|---|
| `Roognis_AI_HLD.pdf` | High-level architecture, service overview, request flows, cloud migration path |
| `roognis-ai-design-complete.pdf` | Full LLD v3 — every endpoint, DB schema, env var, and implementation detail for all 4 services |
| `roognis-system-flows.pdf` | Plain-English walkthrough of all 8 user flows (login, chat, image gen, video, feedback, teacher dashboard, parent dashboard, PDF upload) |

---

## Technical Decisions

**Why HttpOnly cookies for JWT instead of localStorage?**  
`localStorage` is vulnerable to XSS attacks — any injected script can read the token. An `HttpOnly` cookie is inaccessible to JavaScript entirely. Combined with `SameSite=Strict`, this prevents both XSS token theft and CSRF attacks.

**Why one PostgreSQL instance with multiple schemas?**  
Single-node simplicity during development — one container, one volume, one backup. Each service owns and migrates its own schema (`auth_db`, `ai_db`, etc.) using Prisma's `?schema=` query parameter, so there is no cross-service data coupling. The cloud migration path simply changes each service's `DATABASE_URL` to point at a dedicated RDS instance.

**Why `bcryptjs` instead of `bcrypt`?**  
`bcryptjs` is a pure JavaScript implementation requiring no native build tools. This keeps Dockerfiles simple and cross-platform — no `node-gyp`, no OS-specific compilation. At cost 12, hashing takes ~300ms, which is intentionally slow for password hashing.

**Why Traefik instead of nginx?**  
Traefik reads Docker labels directly and reconfigures routing dynamically when containers start or stop. The entire routing table is co-located with each service in `docker-compose.yml`, making it easy for each team member to own their own routing rules without touching a shared config file.

**Why `prisma db push` instead of migrations?**  
During early development, `db push` is schema-forward — it applies the current schema without requiring a migration history. When the schema stabilises pre-launch, switch to `prisma migrate deploy` with committed migration files for reproducible, auditable schema changes.

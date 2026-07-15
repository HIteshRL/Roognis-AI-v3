# Roognis Analytics Service

Port: `3004`  
Schema: `analytics_db`  
Gateway path: `/api/analytics`

## Responsibilities (MVP)

- Accept fire-and-forget events from internal services (AI Service)
- Store teacher-entered attendance and scores
- Manage teacher class assignments
- Provide teacher and parent dashboards (scoped, bounded responses)
- Identify intervention candidates from recent activity
- Expose subject/usage trend queries for teachers

Authentication is handled by Auth Service JWT cookies. Analytics validates JWTs locally and enforces role + school scoping on every protected route.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL URL with `?schema=analytics_db` |
| `JWT_SECRET` | Yes | Shared secret with Auth Service |
| `INTERNAL_SERVICE_TOKEN` | Yes | Shared secret for `/api/analytics/event` |
| `PORT` | No | Default `3004` |

Local development:

```sh
copy .env.example .env
```

Root `roognis/.env` must also define `DB_PASSWORD`, `JWT_SECRET`, and `INTERNAL_SERVICE_TOKEN` for Docker Compose.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Service health check |
| `POST` | `/api/analytics/event` | Internal token | Fire-and-forget event ingestion |
| `POST` | `/api/analytics/class/assign` | Teacher JWT | Assign student to teacher class |
| `POST` | `/api/analytics/attendance` | Teacher JWT | Mark/update attendance (upsert) |
| `POST` | `/api/analytics/score` | Teacher JWT | Enter test score |
| `GET` | `/api/analytics/student/:studentId` | Teacher or Parent JWT | Student profile summary |
| `GET` | `/api/analytics/teacher/dashboard` | Teacher JWT | Class dashboard for assigned students |
| `GET` | `/api/analytics/teacher/interventions` | Teacher JWT | Intervention flags (7-day window) |
| `GET` | `/api/analytics/parent/dashboard?studentId=` | Parent JWT | Linked child progress |
| `GET` | `/api/analytics/queries/trends` | Teacher JWT | Usage stats and subject trends (30 days) |

## Access Rules

### Internal event ingestion

- Header: `X-Internal-Service-Token: <INTERNAL_SERVICE_TOKEN>`
- No JWT cookie required
- Returns `202 { received: true }` on success
- AI Service sends events fire-and-forget and must not block user flows on failure

### Teacher routes

- JWT role must be `teacher`
- Writes require the student to exist in `auth_db.users` as a `student` in the teacher's `schoolId`
- Writes also require an existing `class_assignments` row for that teacher + student
- Dashboards and interventions operate on assigned students only

### Parent routes

- JWT role must be `parent`
- `studentId` must appear in JWT `studentIds` (populated by Auth on login)
- No access to unlinked children

## Event Ingestion Contract

```json
{
  "type": "chat_message",
  "studentId": "uuid",
  "schoolId": "uuid",
  "subject": "Science",
  "sessionId": "uuid",
  "metadata": {}
}
```

`type` is stored as a free-form string so new event types do not require schema changes.

Known event types from AI Service today:

- `chat_message`
- `feedback_submitted`
- `image_generated`
- `safety_input_blocked`
- `safety_output_blocked`
- `image_prompt_blocked`

## Intervention Rule

Calculated at query time for the last **7 days**, per assigned student:

- Flag `low_feedback_rating` if average `metadata.rating` from `feedback_submitted` events is **< 3.0**
- Flag `low_session_count` if distinct `sessionId` from `chat_message` events is **< 3**
- Assigned students with **zero events** are still evaluated (zero sessions is flagged)

## Database Models

- `events` — generic analytics events
- `attendance` — teacher-marked attendance (unique per student + date)
- `scores` — teacher-entered scores
- `class_assignments` — teacher-to-student class mapping

Student school validation reads `auth_db.users` in the shared PostgreSQL instance (read-only cross-schema query).

## Scripts

```sh
npm run db:generate   # Generate Prisma client
npm run db:push       # Apply schema to Postgres
npm start             # Run service
npm test              # Run unit and HTTP tests
```

## Docker

```sh
cd roognis
docker compose up --build analytics
```

## MVP Status

**Complete**

- Event ingestion with internal token protection
- Class assignment, attendance, scores
- Teacher dashboard, parent dashboard, interventions, trends
- Student profile endpoint
- Request validation, bounded dashboard responses, Prisma shutdown

**Deferred**

- Automated CI workflow (run `npm test` locally before merge)
- Deep analytics aggregations beyond current summaries

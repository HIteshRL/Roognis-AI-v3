# Roognis MVP Backend Alignment Review And LLD

Last updated: 2026-07-09

This document reviews the current repository against the latest product story:

- Student logs in and sees a learning dashboard.
- Student can use tutor chat, diagrams, videos, and teacher-assigned quizzes.
- Teacher selects a class lesson, asks AI to generate a quiz, reviews it, publishes it to registered students, and reviews student performance.
- Parent sees a linked child's learning progress and recent activity.

This is intentionally backend-focused. The current `frontend/index.html` is a static prototype and should not be treated as proof that the backend is ready.

## Executive Summary

The repo is ready for auth and partially ready for student AI tutoring. It is not ready for the current dashboard story.

Current backend readiness:

| Area | Current status | MVP alignment |
|---|---|---|
| Auth login / role JWT | Implemented | Mostly aligned |
| Parent-child link | Implemented | Partially aligned |
| Teacher-class-student roster | Missing | Required |
| Student chat | Implemented | Needs RAG for quality |
| Chat safety | Implemented | Good MVP base |
| Diagram image jobs | Implemented | Needs real-key verification |
| Curated videos | Basic hardcoded metadata | MVP acceptable, but not tracked |
| RAG | Stub only | Required for grounded chat and quiz generation |
| Analytics | Stub in current branch, PR #8 has partial analytics | Needs redesign for learning progress and quizzes |
| Quiz generation / assignment / grading | Missing | Required for current UI |
| Student dashboard metrics | Missing | Required |
| Teacher quiz review dashboard | Missing | Required |
| Parent progress dashboard | Missing / partial in PR #8 | Required |
| Frontend integration | Static prototype | Must be wired to APIs |

Recommended next backend scope:

1. Add classroom roster support in Auth.
2. Add a new Quiz Service.
3. Upgrade Analytics into Learning Progress analytics.
4. Wire Frontend to real APIs.
5. Implement RAG for lesson-grounded quiz/chat quality.

## Current Repository Inventory

Current branch inspected: `feature/ai-safety-layer`

Implemented/stubbed services:

- `services/auth`
- `services/ai`
- `services/rag`
- `services/analytics`
- `frontend`
- `docker-compose.yml`
- `kubernetes/*`

Important current files:

- `services/auth/routes/auth.routes.js`
- `services/auth/prisma/schema.prisma`
- `services/auth/scripts/seed.js`
- `services/ai/server.js`
- `services/ai/safety.js`
- `services/ai/prisma/schema.prisma`
- `services/rag/main.py`
- `services/analytics/server.js`
- `frontend/index.html`
- `docs/AI_SERVICE_MVP_CONTEXT.md`

## Product Flow Target

### Student

1. Login through Auth.
2. Role redirects to student workspace.
3. Dashboard shows:
   - learning streak
   - time spent
   - lessons completed
   - practice / quiz progress
   - current assigned quiz
   - recent tutor/video/diagram activity
4. Student opens teacher-assigned quiz.
5. Student submits answers.
6. Student sees simple feedback.
7. Student progress updates.

### Teacher

1. Login through Auth.
2. Role redirects to teacher workspace.
3. Teacher sees own class/student roster.
4. Teacher selects class + lesson.
5. AI generates quiz draft from lesson context.
6. Teacher reviews/edits questions.
7. Teacher publishes quiz to registered students.
8. Teacher sees:
   - assigned/opened/submitted/pending counts
   - class average
   - per-student scores
   - weak areas
   - follow-up actions

### Parent

1. Login through Auth.
2. Parent sees only linked child/children.
3. Parent dashboard shows:
   - learning streak
   - time spent
   - quiz status/results
   - lesson progress
   - recent safe learning activity
4. For current seed data, `parent1@demo.com` should show only Arjun. Priya belongs to `parent2@demo.com`.

## High-Level Target Architecture

```text
Browser
  -> Traefik
    -> /api/auth       Auth Service
    -> /api/ai         AI Service
    -> /api/rag        RAG Service
    -> /api/quiz       Quiz Service       NEW
    -> /api/analytics  Analytics Service
    -> /               Frontend

PostgreSQL schemas:
  auth_db
  ai_db
  rag_db
  quiz_db          NEW
  analytics_db

AI providers:
  Gemini default
  Ollama optional fallback
  ComfyUI optional image fallback
```

Why a separate Quiz Service:

- Quiz has classroom workflow state, not only model generation.
- Teacher authorization must be tied to class/student roster.
- Student attempts and grading need transactional persistence.
- Analytics needs clean quiz events, but should not own quiz source-of-truth records.
- AI Service should remain responsible for model/safety behavior, not assignment lifecycle.

## Service LLD: Auth Service

### Current State

Implemented:

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/auth/link-parent`
- `GET /api/auth/parent/:id/students`

Current schema:

- `School`
- `User`
- `ParentStudent`
- `Role`

Current seed:

- One teacher.
- Three students.
- Two parents.
- `parent1` linked to Arjun.
- `parent2` linked to Priya.

### Gaps Against Current Product Story

Missing:

- Teacher-to-class relationship.
- Class-to-student enrollment.
- Grade/section metadata.
- Subject ownership for teacher classes.
- A safe way for teacher APIs to know which students are "registered under" that teacher.
- Parent child switcher should use actual linked children; current prototype must not hardcode Priya for `parent1`.

### Required Auth Schema Additions

Add to `services/auth/prisma/schema.prisma`:

```prisma
model Classroom {
  id        String   @id @default(uuid()) @db.Uuid
  schoolId  String   @map("school_id") @db.Uuid
  teacherId String   @map("teacher_id") @db.Uuid
  name      String   @db.VarChar(120)
  grade     String   @db.VarChar(20)
  section   String?  @db.VarChar(20)
  subject   String?  @db.VarChar(80)
  createdAt DateTime @default(now()) @map("created_at")

  school  School @relation(fields: [schoolId], references: [id])
  teacher User   @relation("TeacherClassrooms", fields: [teacherId], references: [id])
  enrollments ClassroomEnrollment[]

  @@index([schoolId, teacherId])
  @@map("classrooms")
  @@schema("auth_db")
}

model ClassroomEnrollment {
  classroomId String   @map("classroom_id") @db.Uuid
  studentId   String   @map("student_id") @db.Uuid
  status      String   @default("active") @db.VarChar(20)
  createdAt   DateTime @default(now()) @map("created_at")

  classroom Classroom @relation(fields: [classroomId], references: [id], onDelete: Cascade)
  student   User      @relation("StudentClassrooms", fields: [studentId], references: [id])

  @@id([classroomId, studentId])
  @@index([studentId])
  @@map("classroom_enrollments")
  @@schema("auth_db")
}
```

Update `User` relations:

```prisma
teachingClassrooms Classroom[] @relation("TeacherClassrooms")
studentClassrooms  ClassroomEnrollment[] @relation("StudentClassrooms")
```

Optional but useful:

```prisma
model StudentProfile {
  userId     String @id @map("user_id") @db.Uuid
  grade      String @db.VarChar(20)
  section    String? @db.VarChar(20)
  rollNumber String? @map("roll_number") @db.VarChar(40)

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("student_profiles")
  @@schema("auth_db")
}
```

### Required Auth APIs

Add:

```text
GET  /api/auth/teacher/classes
GET  /api/auth/classes/:classroomId/students
POST /api/auth/classes
POST /api/auth/classes/:classroomId/students
GET  /api/auth/student/classes
```

Authorization:

- Teacher can access only classrooms where `teacherId = req.user.userId`.
- Student can access only classes where enrolled.
- Parent can access only linked child metadata.

### Seed Updates

Create:

- `Class 6 Science`
- teacher `teacher@demo.com` owns it
- Arjun, Priya, Rahul enrolled
- parent links remain:
  - parent1 -> Arjun only
  - parent2 -> Priya only

## Service LLD: AI Service

### Current State

Implemented:

- Student chat session creation.
- Chat history.
- SSE chat.
- Gemini text provider.
- Ollama fallback.
- RAG retrieval call.
- Feedback.
- Video metadata routes.
- Image generation jobs.
- Gemini image provider.
- ComfyUI fallback.
- Child-safety layer.
- Safety tests.

Current endpoints:

```text
GET  /health
POST /api/ai/chat/session
GET  /api/ai/chat/:sessionId/history
POST /api/ai/chat
GET  /api/ai/video/topics
GET  /api/ai/video/:topic
POST /api/ai/feedback
POST /api/ai/image
GET  /api/ai/image/:jobId/status
GET  /api/ai/images/:filename
```

Current schema:

- `ChatSession`
- `Message`
- `ImageJob`
- `Feedback`

### Gaps Against Current Product Story

Missing:

- Teacher-safe quiz generation capability.
- Strict JSON output validation for quiz questions.
- Lesson-aware quiz prompt.
- Weak-area tagging in generated quiz questions.
- Integration with RAG by lesson/topic, not only `subject`.
- Internal service trust model for Quiz Service calling AI.

### Required AI Changes

Add teacher/internal quiz-draft generation:

```text
POST /api/ai/quiz/draft
```

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
      "source": "NCERT Science Grade 6",
      "chunkId": "..."
    }
  ]
}
```

Authorization:

- For direct browser calls, require teacher role.
- If Quiz Service calls this internally, add a service token later.
- MVP can start with teacher JWT forwarded from Quiz Service.

Safety:

- Reuse current safety helpers.
- Add `validateQuizDraftSafety`.
- Reject unsafe lesson/topic strings.
- Require output JSON parse and schema validation before returning.
- Do not return raw model output if parsing fails.

Prompt requirements:

- Generate only school-appropriate questions.
- Use only RAG context.
- Include correct answer, explanation, concept tag, weak area label.
- Keep language suitable for grade level.
- Avoid trick/adult/unsafe content.

### AI Event Emissions

Add fire-and-forget analytics events:

```text
quiz_draft_generated
quiz_draft_generation_failed
```

## Service LLD: New Quiz Service

### Responsibility

Own quiz lifecycle:

- quiz draft
- teacher review
- publish to class
- student assignment
- student attempt
- grading
- teacher review
- parent/student quiz summary

Do not store chat history or raw RAG chunks here.

### New Service Files

```text
services/quiz/
  Dockerfile
  package.json
  server.js
  middleware/auth.js
  prisma/schema.prisma
  routes/quiz.routes.js
```

### Database Schema

Use schema `quiz_db`.

```prisma
model Lesson {
  id          String   @id @default(uuid()) @db.Uuid
  schoolId    String   @map("school_id") @db.Uuid
  subject     String   @db.VarChar(80)
  grade       String   @db.VarChar(20)
  title       String   @db.VarChar(180)
  topicKey    String?  @map("topic_key") @db.VarChar(120)
  createdAt   DateTime @default(now()) @map("created_at")

  quizzes Quiz[]

  @@index([schoolId, subject, grade])
  @@map("lessons")
  @@schema("quiz_db")
}

model Quiz {
  id            String     @id @default(uuid()) @db.Uuid
  schoolId      String     @map("school_id") @db.Uuid
  classroomId   String     @map("classroom_id") @db.Uuid
  teacherId     String     @map("teacher_id") @db.Uuid
  lessonId      String     @map("lesson_id") @db.Uuid
  title         String     @db.VarChar(180)
  status        QuizStatus @default(draft)
  questionCount Int        @map("question_count")
  difficulty    String     @db.VarChar(60)
  dueAt         DateTime?  @map("due_at")
  publishedAt   DateTime?  @map("published_at")
  createdAt     DateTime   @default(now()) @map("created_at")
  updatedAt     DateTime   @updatedAt @map("updated_at")

  lesson      Lesson @relation(fields: [lessonId], references: [id])
  questions   QuizQuestion[]
  assignments QuizAssignment[]

  @@index([schoolId, classroomId, status])
  @@index([teacherId, createdAt])
  @@map("quizzes")
  @@schema("quiz_db")
}

model QuizQuestion {
  id            String       @id @default(uuid()) @db.Uuid
  quizId        String       @map("quiz_id") @db.Uuid
  orderIndex    Int          @map("order_index")
  type          QuestionType
  prompt        String       @db.Text
  options       Json?
  correctAnswer Json         @map("correct_answer")
  explanation   String?      @db.Text
  conceptTag    String?      @map("concept_tag") @db.VarChar(120)
  weakAreaLabel String?      @map("weak_area_label") @db.VarChar(180)
  marks         Decimal      @default(1) @db.Decimal(5, 2)

  quiz    Quiz @relation(fields: [quizId], references: [id], onDelete: Cascade)
  answers QuizAnswer[]

  @@index([quizId, orderIndex])
  @@map("quiz_questions")
  @@schema("quiz_db")
}

model QuizAssignment {
  id               String           @id @default(uuid()) @db.Uuid
  quizId           String           @map("quiz_id") @db.Uuid
  studentId        String           @map("student_id") @db.Uuid
  status           AssignmentStatus @default(assigned)
  assignedAt       DateTime         @default(now()) @map("assigned_at")
  openedAt         DateTime?        @map("opened_at")
  submittedAt      DateTime?        @map("submitted_at")
  gradedAt         DateTime?        @map("graded_at")
  score            Decimal?         @db.Decimal(5, 2)
  maxScore         Decimal?         @map("max_score") @db.Decimal(5, 2)
  timeSpentSeconds Int?             @map("time_spent_seconds")

  quiz    Quiz @relation(fields: [quizId], references: [id], onDelete: Cascade)
  answers QuizAnswer[]

  @@unique([quizId, studentId])
  @@index([studentId, status])
  @@map("quiz_assignments")
  @@schema("quiz_db")
}

model QuizAnswer {
  id           String   @id @default(uuid()) @db.Uuid
  assignmentId String   @map("assignment_id") @db.Uuid
  questionId   String   @map("question_id") @db.Uuid
  answer       Json
  isCorrect    Boolean? @map("is_correct")
  score        Decimal? @db.Decimal(5, 2)
  feedback     String?  @db.Text
  createdAt    DateTime @default(now()) @map("created_at")

  assignment QuizAssignment @relation(fields: [assignmentId], references: [id], onDelete: Cascade)
  question   QuizQuestion   @relation(fields: [questionId], references: [id], onDelete: Cascade)

  @@unique([assignmentId, questionId])
  @@map("quiz_answers")
  @@schema("quiz_db")
}

enum QuizStatus {
  draft
  published
  closed
  archived

  @@schema("quiz_db")
}

enum QuestionType {
  mcq
  short_answer

  @@schema("quiz_db")
}

enum AssignmentStatus {
  assigned
  opened
  submitted
  graded

  @@schema("quiz_db")
}
```

### Quiz APIs

Teacher APIs:

```text
GET  /api/quiz/lessons?classroomId=...
POST /api/quiz/drafts
GET  /api/quiz/:quizId
PATCH /api/quiz/:quizId
PATCH /api/quiz/:quizId/questions/:questionId
POST /api/quiz/:quizId/publish
GET  /api/quiz/teacher/dashboard?classroomId=...
GET  /api/quiz/:quizId/review
POST /api/quiz/:quizId/reminders
```

Student APIs:

```text
GET  /api/quiz/student/assigned
GET  /api/quiz/student/assignments/:assignmentId
POST /api/quiz/student/assignments/:assignmentId/open
POST /api/quiz/student/assignments/:assignmentId/submit
```

Parent APIs:

```text
GET /api/quiz/parent/students/:studentId/summary
```

### Authorization Rules

Teacher:

- Can create quiz only for classrooms they own.
- Can publish only to students enrolled in that classroom.
- Can review only quizzes they created or own through classroom.

Student:

- Can read only assignments where `studentId = req.user.userId`.
- Can submit only own active assignment.

Parent:

- Can read only student IDs included in parent JWT `studentIds`.

### Grading Rules

MVP grading:

- MCQ: deterministic exact match.
- Short answer: start with simple normalized match against accepted answers.
- Later: add AI-assisted grading, but only after teacher/audit rules are designed.

Submission response:

```json
{
  "assignmentId": "uuid",
  "status": "graded",
  "score": 4,
  "maxScore": 5,
  "feedback": [
    {
      "questionId": "uuid",
      "isCorrect": true,
      "feedback": "Correct."
    }
  ],
  "weakAreas": [
    "Raw materials for photosynthesis"
  ]
}
```

### Events Emitted To Analytics

```text
quiz_draft_created
quiz_published
quiz_opened
quiz_submitted
quiz_graded
quiz_reminder_sent
```

Each event should include:

```json
{
  "schoolId": "uuid",
  "studentId": "uuid optional",
  "subject": "Science",
  "metadata": {
    "quizId": "uuid",
    "assignmentId": "uuid",
    "classroomId": "uuid",
    "lessonId": "uuid",
    "score": 4,
    "maxScore": 5,
    "weakAreas": ["Raw materials"]
  }
}
```

## Service LLD: Analytics / Learning Progress Service

### Current State

Current branch:

- `services/analytics/server.js` is a stub.
- Only accepts `POST /api/analytics/event`.

PR #8 branch:

- Adds `Event`, `Attendance`, `Score`.
- Adds teacher dashboard/interventions/parent dashboard.
- Still not aligned with latest quiz-first product story.

### Why PR #8 Is Not Enough

PR #8 is useful for generic events and scores, but current dashboards need:

- streak
- time spent
- lessons completed
- course progress
- quiz assigned/opened/submitted/pending counts
- quiz score
- weak-area rollups
- parent-safe linked-child summary
- teacher class-level review

Attendance should not appear in the MVP UI unless the product explicitly returns to school attendance tracking.

### Required Analytics Schema

Keep generic `Event`, but add normalized progress tables.

```prisma
model Event {
  id        String   @id @default(uuid()) @db.Uuid
  type      String   @db.VarChar(80)
  studentId String?  @map("student_id") @db.Uuid
  schoolId  String   @map("school_id") @db.Uuid
  subject   String?  @db.VarChar(80)
  sessionId String?  @map("session_id") @db.Uuid
  metadata  Json     @default("{}")
  createdAt DateTime @default(now()) @map("created_at")

  @@index([schoolId, type, createdAt])
  @@index([studentId, createdAt])
  @@map("events")
  @@schema("analytics_db")
}

model DailyStudentActivity {
  id               String   @id @default(uuid()) @db.Uuid
  studentId         String   @map("student_id") @db.Uuid
  schoolId          String   @map("school_id") @db.Uuid
  date              DateTime @db.Date
  activeSeconds     Int      @default(0) @map("active_seconds")
  tutorMessages     Int      @default(0) @map("tutor_messages")
  videosCompleted   Int      @default(0) @map("videos_completed")
  diagramsGenerated Int      @default(0) @map("diagrams_generated")
  quizzesSubmitted  Int      @default(0) @map("quizzes_submitted")
  updatedAt         DateTime @updatedAt @map("updated_at")

  @@unique([studentId, date])
  @@index([schoolId, date])
  @@map("daily_student_activity")
  @@schema("analytics_db")
}

model LessonProgress {
  id               String   @id @default(uuid()) @db.Uuid
  studentId         String   @map("student_id") @db.Uuid
  schoolId          String   @map("school_id") @db.Uuid
  lessonId          String   @map("lesson_id") @db.Uuid
  subject           String   @db.VarChar(80)
  progressPercent   Int      @default(0) @map("progress_percent")
  timeSpentSeconds  Int      @default(0) @map("time_spent_seconds")
  lastActivityType  String?  @map("last_activity_type") @db.VarChar(80)
  lastActiveAt      DateTime @default(now()) @map("last_active_at")

  @@unique([studentId, lessonId])
  @@index([schoolId, subject])
  @@map("lesson_progress")
  @@schema("analytics_db")
}
```

If the team wants to keep `Score`, keep it for teacher-entered offline assessments, but do not use it for the quiz-first MVP dashboard until the UX needs it.

### Analytics APIs

```text
POST /api/analytics/event
GET  /api/analytics/student/dashboard
GET  /api/analytics/teacher/dashboard?classroomId=...
GET  /api/analytics/parent/dashboard?studentId=...
GET  /api/analytics/teacher/interventions?classroomId=...
```

Student dashboard response:

```json
{
  "learningStreakDays": 6,
  "timeSpentSecondsThisWeek": 12000,
  "lessonsCompletedThisWeek": 12,
  "practiceProgressPercent": 68,
  "courseProgress": [
    {
      "subject": "Science",
      "progressPercent": 68,
      "next": "Photosynthesis recap"
    }
  ],
  "recentActivity": [
    {
      "type": "quiz_submitted",
      "label": "Plants and nutrition quiz submitted",
      "createdAt": "..."
    }
  ]
}
```

Teacher dashboard response:

```json
{
  "classroomId": "uuid",
  "studentCount": 28,
  "activeQuiz": {
    "quizId": "uuid",
    "title": "Plants and nutrition",
    "assigned": 28,
    "opened": 24,
    "submitted": 20,
    "pending": 8,
    "averageScorePercent": 76
  },
  "weakAreas": [
    {
      "label": "Raw materials",
      "studentCount": 9
    }
  ],
  "lessonEngagement": {
    "videoCompleted": 24,
    "tutorUsed": 18,
    "quizSubmitted": 20
  }
}
```

Parent dashboard response:

```json
{
  "studentId": "uuid",
  "studentName": "Arjun Sharma",
  "learningStreakDays": 6,
  "timeSpentSecondsThisWeek": 12000,
  "assignedQuizStatus": "submitted",
  "latestQuizScore": "4/5",
  "weakAreas": ["Stomata"],
  "recentActivity": []
}
```

### Event Ingestion Rules

`POST /api/analytics/event` should:

- validate required fields
- accept only known event types
- avoid storing sensitive raw prompt text
- update `DailyStudentActivity` / `LessonProgress` when event type is relevant
- remain non-blocking for AI/Quiz callers

Known event types for MVP:

```text
chat_message
feedback_submitted
image_generated
image_prompt_blocked
safety_input_blocked
safety_output_blocked
quiz_draft_created
quiz_published
quiz_opened
quiz_submitted
quiz_graded
video_opened
video_completed
lesson_started
lesson_completed
```

## Service LLD: RAG Service

### Current State

Current file:

- `services/rag/main.py`

Implemented:

- `GET /health`
- `GET /api/rag/retrieve` returns `[]`

### Gaps

Missing:

- document upload
- document status
- chunking
- embeddings
- Chroma collection management
- lesson/topic mapping
- retrieve-by-lesson for quiz generation
- teacher/school auth for document admin

### Required RAG APIs

```text
POST /api/rag/documents
GET  /api/rag/documents
GET  /api/rag/documents/:docId/status
GET  /api/rag/retrieve?q=...&schoolId=...&subject=...&top=...
GET  /api/rag/lessons/:lessonId/context?top=...
```

For quiz generation, `GET /api/rag/lessons/:lessonId/context` is more reliable than free-text retrieve because teacher picks a lesson first.

### RAG Schema

Use SQLAlchemy or Prisma, but choose one. Existing docs say SQLAlchemy.

Tables:

```text
documents
  id
  school_id
  subject
  grade
  title
  file_path
  status
  error_message
  created_by
  created_at
  updated_at

document_chunks
  id
  document_id
  school_id
  subject
  grade
  lesson_id
  chunk_index
  text
  source_page
  vector_id
  created_at
```

### RAG MVP Priority

For backend alignment excluding full RAG, stub can stay. But for real demo quality, quiz generation should not go live without lesson-grounded context.

Minimum useful MVP:

- seed one Science lesson context into DB/vector store
- support `lessonId -> top chunks`
- AI quiz generation uses those chunks

## Service LLD: Frontend

### Current State

Current frontend is static:

- `frontend/index.html`
- `frontend/server.js`
- `frontend/package.json`

It does not call backend APIs. It infers role from demo email strings client-side.

### Required Frontend Changes

Replace static demo logic with real calls:

Auth:

```text
POST /api/auth/login
GET  /api/auth/me
POST /api/auth/logout
```

Student:

```text
GET  /api/analytics/student/dashboard
GET  /api/quiz/student/assigned
GET  /api/quiz/student/assignments/:assignmentId
POST /api/quiz/student/assignments/:assignmentId/open
POST /api/quiz/student/assignments/:assignmentId/submit
POST /api/ai/chat/session
POST /api/ai/chat
GET  /api/ai/chat/:sessionId/history
POST /api/ai/image
GET  /api/ai/image/:jobId/status
GET  /api/ai/video/topics
GET  /api/ai/video/:topic
```

Teacher:

```text
GET  /api/auth/teacher/classes
GET  /api/auth/classes/:classroomId/students
GET  /api/analytics/teacher/dashboard?classroomId=...
POST /api/quiz/drafts
PATCH /api/quiz/:quizId/questions/:questionId
POST /api/quiz/:quizId/publish
GET  /api/quiz/:quizId/review
```

Parent:

```text
GET /api/auth/parent/:id/students
GET /api/analytics/parent/dashboard?studentId=...
GET /api/quiz/parent/students/:studentId/summary
```

### Parent UI Correction

Current prototype should not show Priya for `Parent One`.

MVP rule:

- If one linked child, show no child dropdown.
- If multiple linked children, show a proper app-level child switcher, not a native dropdown.
- Children must come from `GET /api/auth/parent/:id/students`.

## Service LLD: Infrastructure

### Docker Compose Changes

Add Quiz Service:

```yaml
quiz:
  build: ./services/quiz
  command: >
    sh -c "[ -f prisma/schema.prisma ] &&
           npx prisma db push --schema=prisma/schema.prisma ||
           true && node server.js"
  environment:
    DATABASE_URL: "postgresql://postgres:${DB_PASSWORD}@postgres:5432/roognis?schema=quiz_db"
    JWT_SECRET: ${JWT_SECRET}
    AI_SERVICE_URL: "http://ai:3002"
    ANALYTICS_URL: "http://analytics:3004"
    PORT: 3005
    NODE_ENV: production
  depends_on:
    postgres:
      condition: service_healthy
    ai:
      condition: service_started
    analytics:
      condition: service_started
  labels:
    - "traefik.enable=true"
    - "traefik.http.routers.quiz.rule=PathPrefix(`/api/quiz`)"
    - "traefik.http.routers.quiz.entrypoints=web"
    - "traefik.http.services.quiz.loadbalancer.server.port=3005"
    - "traefik.http.routers.quiz.middlewares=cors@file"
  restart: unless-stopped
```

Also update AI env if Quiz Service calls AI:

```yaml
QUIZ_SERVICE_URL: "http://quiz:3005"
```

### Kubernetes Changes

Add:

```text
kubernetes/quiz/deployment.yaml
kubernetes/quiz/service.yaml
```

Update:

```text
kubernetes/kustomization.yaml
kubernetes/ingress/ingress.yaml
kubernetes/secrets/README.md
```

Ingress route:

```yaml
- path: /api/quiz
  pathType: Prefix
  backend:
    service:
      name: quiz
      port:
        number: 3005
```

### Infra Risks

Current K8s Auth deployment is risky:

- container command runs `node scripts/seed.js`
- `postStart` runs `node server.js`
- this is not a reliable production startup pattern

Use one shell command instead:

```yaml
command: ["sh", "-c", "node scripts/seed.js && node server.js"]
```

Other risks:

- `chromadb/chroma:latest` is unpinned and caused local pull issues.
- `prisma db push` is okay for MVP but should move to migrations before production.
- Docker/K8s secrets docs still mention `ANTHROPIC_API_KEY`; repo currently uses Gemini.
- AI image Gemini endpoint shape needs real-key verification.

## Current UI To Backend Mapping

| UI element | Required backend | Current backend status |
|---|---|---|
| Student learning streak | Analytics daily activity | Missing |
| Student time spent | Analytics events + aggregation | Missing |
| Lessons done | LessonProgress | Missing |
| Practice progress | Quiz/LessonProgress | Missing |
| Assigned quiz on student dashboard | Quiz assignments | Missing |
| Student quiz submit | Quiz assignment submit/grade | Missing |
| Teacher create quiz | Quiz Service + AI generation | Missing |
| Teacher publish quiz | Quiz Service assignment fanout | Missing |
| Teacher quiz review | Quiz review + analytics rollup | Missing |
| Parent progress | Auth linked children + analytics summary | Missing/partial |
| Tutor chat | AI Service | Implemented but RAG stubbed |
| Diagrams | AI Service image jobs | Implemented, verify needed |
| Videos | AI Service hardcoded metadata | Basic |

## Implementation Plan

### Phase 1: Auth Roster Foundation

Goal:

- make "students registered under teacher" real.

Tasks:

1. Add classroom and enrollment schema.
2. Seed Class 6 Science with teacher and students.
3. Add teacher class/student APIs.
4. Fix parent UI contract to use real linked children.
5. Add tests for authorization.

Done when:

- teacher can query only own class students.
- parent1 sees only Arjun.
- student can see own enrolled classes.

### Phase 2: Quiz Service MVP

Goal:

- make teacher-assigned quiz flow real.

Tasks:

1. Add `services/quiz`.
2. Add quiz Prisma schema.
3. Add teacher draft endpoint.
4. Add AI quiz generation call.
5. Add teacher question edit endpoint.
6. Add publish endpoint that creates assignments.
7. Add student assigned quiz endpoint.
8. Add student submit endpoint with deterministic grading.
9. Emit analytics events.

Done when:

- teacher can generate/publish quiz.
- student can see and submit assigned quiz.
- teacher can see score/pending/weak-area review.

### Phase 3: Analytics Progress MVP

Goal:

- make dashboards real.

Tasks:

1. Replace Analytics stub or merge a reworked PR #8.
2. Add progress tables.
3. Add event ingestion validation.
4. Add student dashboard endpoint.
5. Add teacher dashboard endpoint.
6. Add parent dashboard endpoint.
7. Add intervention endpoint based on quiz weak areas + low engagement.

Done when:

- student dashboard no longer uses static streak/time values.
- teacher dashboard returns quiz review data.
- parent dashboard returns only linked child progress.

### Phase 4: Frontend API Wiring

Goal:

- turn static prototype into real app.

Tasks:

1. Replace email-role inference with Auth login.
2. Call `/me` on load.
3. Route by server role.
4. Load real dashboard data.
5. Wire quiz create/publish/submit/review.
6. Wire parent linked child list.
7. Handle loading/error/empty states.

Done when:

- data changes after backend actions.
- parent cannot see unlinked students.
- teacher cannot assign quizzes outside own class.

### Phase 5: RAG Lesson Grounding

Goal:

- make tutor and quizzes curriculum grounded.

Tasks:

1. Implement document ingestion.
2. Seed one or two demo lesson contexts.
3. Add lesson context retrieval.
4. Make AI quiz generation use lesson chunks.
5. Add citations/source metadata where useful.

Done when:

- quiz questions come from lesson context.
- chat no longer returns fallback for basic seeded lesson questions.

## Testing Plan

Auth:

- login success/failure
- parent child list authorization
- teacher class access authorization
- student class enrollment visibility

AI:

- safety unit tests already exist
- quiz draft safety and JSON schema tests
- image job status lifecycle tests
- chat SSE with RAG fallback tests

Quiz:

- teacher cannot publish to another teacher's class
- publish creates one assignment per enrolled student
- student cannot open another student's assignment
- submit grades MCQs correctly
- duplicate submit behavior is explicit
- review endpoint returns weak-area rollups

Analytics:

- event ingestion validates event type
- quiz events update dashboard rollups
- parent dashboard rejects unlinked student
- teacher dashboard is scoped to classroom

Frontend:

- login redirects by role from server response
- parent1 shows only Arjun
- teacher create quiz flow shows generated draft
- student assigned quiz appears after publish

## Main Risks

1. Current UI story depends on Quiz Service, which does not exist.
2. Current Analytics PR #8 is attendance/score oriented and does not match the latest quiz-first dashboard.
3. Current Auth cannot prove teacher ownership of students/classes.
4. Current RAG stub means AI can generate only fallback chat responses and non-grounded quiz drafts.
5. Current frontend is static and cannot validate real authorization rules.
6. Current parent dropdown idea is misleading with seed data because Parent One has only Arjun.
7. Gemini image API request shape still needs real-key validation.
8. Kubernetes Auth startup command should be corrected before serious deployment.

## Recommended Decision

Do not continue building more static dashboard UI until these backend contracts are accepted:

1. Auth owns roster/classroom relationships.
2. New Quiz Service owns quiz lifecycle.
3. Analytics owns progress/dashboard aggregation.
4. AI owns model generation and safety.
5. RAG owns lesson context.

After that, frontend can be implemented against stable APIs instead of changing its story repeatedly.

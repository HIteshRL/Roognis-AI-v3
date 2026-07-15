# Analytics / Learning Progress Service LLD

Service path: `services/analytics`

## Purpose

Analytics owns dashboards and learning progress aggregation:

- student streak
- time spent
- lessons completed
- course progress
- teacher quiz performance dashboard
- weak-area rollups
- parent linked-child summary
- intervention signals

It should not own quiz source-of-truth records. Quiz Service owns quiz/assignment/attempt state and emits events.

## Current Repo State

Current branch:

- Analytics is a stub.
- `POST /api/analytics/event` accepts events and returns `202`.

PR #8 branch:

- Adds `Event`, `Attendance`, `Score`.
- Adds basic teacher dashboard, interventions, parent dashboard.

## Gap

PR #8 is not aligned with the current quiz-first dashboard story. It is attendance/score oriented. The current UI story needs:

- learning streak
- time spent
- lesson progress
- quiz assigned/opened/submitted/pending
- average quiz score
- weak-area summary
- recent activity
- parent-safe child summary

Attendance should not appear in the current MVP UI.

## Required Schema

Keep a generic event table:

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
  @@index([sessionId])
  @@map("events")
  @@schema("analytics_db")
}
```

Add learning progress tables:

```prisma
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

Optional:

- Keep `Score` only for teacher-entered offline assessments.
- Do not show it in current quiz-first dashboard unless UX needs it later.

## Event Types

Accepted MVP events:

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

Reject unknown event types or store them only under a controlled `unknown` path with warning logs.

## APIs

```text
POST /api/analytics/event
GET  /api/analytics/student/dashboard
GET  /api/analytics/teacher/dashboard?classroomId=...
GET  /api/analytics/parent/dashboard?studentId=...
GET  /api/analytics/teacher/interventions?classroomId=...
```

### `GET /api/analytics/student/dashboard`

Role: student

Response:

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
  "recentActivity": []
}
```

### `GET /api/analytics/teacher/dashboard?classroomId=...`

Role: teacher

Response:

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

### `GET /api/analytics/parent/dashboard?studentId=...`

Role: parent

Rule:

- `studentId` must exist in parent JWT `studentIds`.

Response:

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

## Aggregation Rules

Learning streak:

- Count consecutive days with activity greater than zero.
- Use server timezone policy consistently. MVP can use UTC.

Time spent:

- Sum `activeSeconds` from events like quiz open/submit, video completed, chat session.
- Avoid trusting only client timers for production; MVP can start with client duration metadata.

Lesson progress:

- Quiz submitted increases lesson progress.
- Video completed increases lesson progress.
- Tutor chat on a lesson increases lesson progress.

Teacher weak areas:

- Use Quiz Service review data or `quiz_graded` metadata.
- Group by `weakAreaLabel`.

## Done Criteria

- Student dashboard values are generated by backend, not static UI.
- Teacher dashboard is quiz/performance focused.
- Parent dashboard is scoped to linked child.
- Unknown or unsafe events do not break callers.
- Analytics failure does not fail AI/Quiz flows.

## Tests

- Event validation.
- Streak calculation.
- Parent cannot query unlinked student.
- Teacher dashboard respects classroom ownership.
- Quiz events update dashboard response.


# Quiz Service LLD

Service path: `services/quiz` (new)

## Purpose

Quiz Service owns the classroom quiz lifecycle:

- teacher creates quiz draft
- AI generates questions
- teacher reviews/edits draft
- teacher publishes to class
- student receives assignment
- student opens/submits quiz
- backend grades attempt
- teacher reviews performance
- parent/student progress uses quiz data

Do not put this lifecycle inside AI Service. AI should generate the draft; Quiz should own records, assignment, attempts, grading, and review.

## New Service Files

```text
services/quiz/
  Dockerfile
  package.json
  server.js
  middleware/auth.js
  prisma/schema.prisma
  routes/quiz.routes.js
```

## Dependencies

Use same Node stack as Auth/AI:

- Express
- Prisma
- cookie-parser
- jsonwebtoken

Internal services:

- Auth: classroom/student ownership checks
- AI: quiz draft generation
- Analytics: fire-and-forget events

## Schema

Use Postgres schema `quiz_db`.

```prisma
model Lesson {
  id        String   @id @default(uuid()) @db.Uuid
  schoolId  String   @map("school_id") @db.Uuid
  subject   String   @db.VarChar(80)
  grade     String   @db.VarChar(20)
  title     String   @db.VarChar(180)
  topicKey  String?  @map("topic_key") @db.VarChar(120)
  createdAt DateTime @default(now()) @map("created_at")

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

## Teacher APIs

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

### `POST /api/quiz/drafts`

Role: teacher

Behavior:

1. Validate teacher owns classroom.
2. Validate lesson belongs to school/class subject.
3. Call AI `POST /api/ai/quiz/draft`.
4. Persist quiz as `draft`.
5. Persist questions.
6. Emit `quiz_draft_created`.

Request:

```json
{
  "classroomId": "uuid",
  "lessonId": "uuid",
  "questionCount": 5,
  "difficulty": "grade_6_basics"
}
```

Response:

```json
{
  "quizId": "uuid",
  "status": "draft",
  "questions": []
}
```

### `POST /api/quiz/:quizId/publish`

Role: teacher

Behavior:

1. Validate quiz belongs to teacher.
2. Validate status is `draft`.
3. Fetch enrolled students from Auth.
4. Create one `QuizAssignment` per student.
5. Mark quiz `published`.
6. Emit `quiz_published`.

Response:

```json
{
  "quizId": "uuid",
  "status": "published",
  "assignedCount": 28
}
```

## Student APIs

```text
GET  /api/quiz/student/assigned
GET  /api/quiz/student/assignments/:assignmentId
POST /api/quiz/student/assignments/:assignmentId/open
POST /api/quiz/student/assignments/:assignmentId/submit
```

### `GET /api/quiz/student/assigned`

Role: student

Response:

```json
[
  {
    "assignmentId": "uuid",
    "quizId": "uuid",
    "title": "Plants and nutrition",
    "subject": "Science",
    "status": "assigned",
    "questionCount": 5,
    "dueAt": "2026-07-09T18:00:00.000Z"
  }
]
```

### `POST /api/quiz/student/assignments/:assignmentId/submit`

Role: student

Behavior:

1. Validate assignment belongs to student.
2. Validate not already submitted or define idempotent behavior.
3. Grade MCQ deterministically.
4. Grade short answers with simple accepted-answer matching for MVP.
5. Save answers.
6. Update assignment score/status.
7. Emit `quiz_submitted` and `quiz_graded`.

Response:

```json
{
  "assignmentId": "uuid",
  "status": "graded",
  "score": 4,
  "maxScore": 5,
  "weakAreas": ["Raw materials for photosynthesis"],
  "feedback": [
    {
      "questionId": "uuid",
      "isCorrect": true,
      "feedback": "Correct."
    }
  ]
}
```

## Parent APIs

```text
GET /api/quiz/parent/students/:studentId/summary
```

Rule:

- Parent can query only if `studentId` exists in parent JWT `studentIds`.

## Review APIs

### `GET /api/quiz/:quizId/review`

Role: teacher

Response:

```json
{
  "quizId": "uuid",
  "title": "Plants and nutrition",
  "assigned": 28,
  "opened": 24,
  "submitted": 20,
  "pending": 8,
  "averageScorePercent": 76,
  "students": [
    {
      "studentId": "uuid",
      "name": "Arjun Sharma",
      "status": "graded",
      "score": 4,
      "maxScore": 5,
      "timeSpentSeconds": 360,
      "weakAreas": ["Stomata"]
    }
  ],
  "weakAreaSummary": [
    {
      "weakAreaLabel": "Raw materials",
      "studentCount": 9
    }
  ]
}
```

## Events

Emit to Analytics:

- `quiz_draft_created`
- `quiz_published`
- `quiz_opened`
- `quiz_submitted`
- `quiz_graded`
- `quiz_reminder_sent`

## Done Criteria

- Teacher can generate draft.
- Teacher can edit/review draft.
- Teacher can publish to enrolled students.
- Student sees assigned quiz.
- Student submits quiz.
- Teacher sees per-student review and weak areas.
- Parent can see linked child quiz status.

## Tests

- Teacher cannot create quiz for another teacher's class.
- Publish creates correct assignment count.
- Student cannot open another student's assignment.
- Duplicate submit is handled explicitly.
- MCQ grading is deterministic.
- Review endpoint returns correct pending/submitted counts.


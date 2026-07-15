// Classwork: coursework lifecycle, submissions, grading, rubrics, gradebook.
// Ported from v2 CourseworkService / SubmissionService / RubricService /
// GradebookService with the same rules:
//
//   coursework: draft → (scheduled) → published → archived; scheduled items
//   auto-publish lazily on read; duplicate produces a fresh draft.
//   submissions: one row per (coursework, student); resubmit bumps attempt;
//   withdraw only before the deadline. Grades are append-only — a regrade adds
//   a row and the latest one wins, so history stays auditable.
//
// Auth removed: studentId/teacherId are explicit parameters with demo
// defaults; enrollment is still checked (it's roster data, not identity).

const express = require('express');
const prisma = require('../lib/prisma');
const {
  COURSEWORK_TYPES, GRADEABLE_TYPES,
  acceptsSubmissionsAt, isLateAt, isVisibleToStudents,
  validateCriteria, rubricMaxPoints,
  assembleGradebook, gradebookToCsv,
} = require('../lib/domain');
const { isUuid, nonEmptyString, parseDate } = require('../lib/validation');
const {
  DEMO_TEACHER_ID, DEMO_STUDENT_ID, DEMO_STUDENTS, findStudentUser, studentName,
} = require('../lib/demo-roster');

const router = express.Router();

function toCourseworkResponse(c, extra = {}) {
  return {
    id: c.id,
    classroomId: c.classroomId,
    authorId: c.authorId,
    type: c.type,
    title: c.title,
    body: c.body,
    status: c.status,
    scheduledAt: c.scheduledAt,
    publishedAt: c.publishedAt,
    dueAt: c.dueAt,
    allowLate: c.allowLate,
    maxMarks: c.maxMarks,
    rubric: c.rubric,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    ...extra,
  };
}

function gradeToResponse(g) {
  return {
    id: g.id,
    graderId: g.graderId,
    score: g.score,
    maxMarks: g.maxMarks,
    rubricScores: g.rubricScores,
    comment: g.comment,
    privateFeedback: g.privateFeedback,
    isReturned: g.isReturned,
    isRegrade: g.isRegrade,
    createdAt: g.createdAt,
  };
}

function toSubmissionResponse(s, { withStudent = false } = {}) {
  const grades = (s.grades || []).map(gradeToResponse);
  return {
    id: s.id,
    courseworkId: s.courseworkId,
    studentId: s.studentId,
    studentName: withStudent ? studentName(s.studentId) : undefined,
    status: s.status,
    textAnswer: s.textAnswer,
    attempt: s.attempt,
    isLate: s.isLate,
    submittedAt: s.submittedAt,
    grade: grades[0] || null,
    gradeHistory: grades,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

async function getLiveCoursework(id) {
  if (!isUuid(id)) return null;
  const cw = await prisma.coursework.findUnique({ where: { id } });
  return cw && !cw.isDeleted ? cw : null;
}

async function getLiveClass(id) {
  if (!isUuid(id)) return null;
  const classroom = await prisma.classroom.findUnique({ where: { id } });
  return classroom && !classroom.isDeleted ? classroom : null;
}

async function isEnrolled(classroomId, studentId) {
  const enrollment = await prisma.enrollment.findUnique({
    where: { classroomId_studentId: { classroomId, studentId } },
  });
  return Boolean(enrollment && enrollment.status === 'active');
}

// Lazily flip scheduled items whose time has passed (v2 _auto_publish_due).
async function autoPublishDue(classroomId) {
  await prisma.coursework.updateMany({
    where: {
      classroomId, status: 'scheduled', isDeleted: false,
      scheduledAt: { lte: new Date() },
    },
    data: { status: 'published', publishedAt: new Date(), scheduledAt: null },
  });
}

const LATEST_GRADE = { grades: { orderBy: { createdAt: 'desc' } } };

// ── Coursework lifecycle ─────────────────────────────────────────────────────

router.post('/classes/:id/coursework', async (req, res) => {
  const classroom = await getLiveClass(req.params.id);
  if (!classroom) return res.status(404).json({ error: 'Classroom not found' });

  const { type, title } = req.body || {};
  if (!COURSEWORK_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of ${COURSEWORK_TYPES.join(', ')}` });
  }
  if (!nonEmptyString(title, 200)) return res.status(400).json({ error: 'title is required' });

  const dueAt = req.body.dueAt !== undefined ? parseDate(req.body.dueAt) : null;
  if (req.body.dueAt !== undefined && req.body.dueAt !== null && !dueAt) {
    return res.status(400).json({ error: 'dueAt must be an ISO-8601 date' });
  }
  const maxMarks = req.body.maxMarks == null ? null : Number(req.body.maxMarks);
  if (maxMarks !== null && (Number.isNaN(maxMarks) || maxMarks < 0)) {
    return res.status(400).json({ error: 'maxMarks must be a non-negative number' });
  }
  let rubric = null;
  if (req.body.rubric != null) {
    const problem = validateCriteria(req.body.rubric);
    if (problem) return res.status(400).json({ error: problem });
    rubric = req.body.rubric;
  }

  const data = {
    classroomId: classroom.id,
    authorId: req.body.teacherId || DEMO_TEACHER_ID,
    type,
    title: title.trim(),
    body: nonEmptyString(req.body.body) ? req.body.body.trim() : null,
    dueAt,
    allowLate: req.body.allowLate !== false,
    maxMarks,
    rubric,
  };
  if (req.body.publish) {
    data.status = 'published';
    data.publishedAt = new Date();
  } else if (req.body.scheduledAt) {
    const scheduledAt = parseDate(req.body.scheduledAt);
    if (!scheduledAt) return res.status(400).json({ error: 'scheduledAt must be an ISO-8601 date' });
    data.status = 'scheduled';
    data.scheduledAt = scheduledAt;
  }

  const coursework = await prisma.coursework.create({ data });
  res.status(201).json(toCourseworkResponse(coursework));
});

router.get('/classes/:id/coursework', async (req, res) => {
  const classroom = await getLiveClass(req.params.id);
  if (!classroom) return res.status(404).json({ error: 'Classroom not found' });
  await autoPublishDue(classroom.id);

  const studentView = req.query.role === 'student';
  const studentId = req.query.studentId || DEMO_STUDENT_ID;
  if (studentView && !(await isEnrolled(classroom.id, studentId))) {
    return res.status(403).json({ error: 'Not enrolled in this class' });
  }

  const where = { classroomId: classroom.id, isDeleted: false };
  if (studentView) where.status = 'published';
  else if (req.query.status) where.status = String(req.query.status);
  if (req.query.type) where.type = String(req.query.type);

  const items = await prisma.coursework.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  if (studentView) {
    // Student list carries their own submission status per item (v2 my_submission_status).
    const submissions = await prisma.submission.findMany({
      where: { studentId, courseworkId: { in: items.map(i => i.id) } },
    });
    const byId = new Map(submissions.map(s => [s.courseworkId, s]));
    return res.json({
      items: items.map(cw => toCourseworkResponse(cw, {
        mySubmissionStatus: byId.get(cw.id)?.status || null,
      })),
      total: items.length,
    });
  }

  // Teacher list carries submitted/graded counts (v2 with_stats).
  const gradeable = items.filter(i => GRADEABLE_TYPES.has(i.type)).map(i => i.id);
  const submissions = gradeable.length
    ? await prisma.submission.findMany({ where: { courseworkId: { in: gradeable } } })
    : [];
  const counts = new Map();
  for (const s of submissions) {
    const entry = counts.get(s.courseworkId) || { submitted: 0, returned: 0 };
    if (s.status === 'submitted' || s.status === 'returned') entry.submitted += 1;
    if (s.status === 'returned') entry.returned += 1;
    counts.set(s.courseworkId, entry);
  }
  res.json({
    items: items.map(cw => {
      const stat = counts.get(cw.id);
      return toCourseworkResponse(cw, GRADEABLE_TYPES.has(cw.type) ? {
        submissionCount: stat ? stat.submitted : 0,
        gradedCount: stat ? stat.returned : 0,
      } : {});
    }),
    total: items.length,
  });
});

router.get('/coursework/:id', async (req, res) => {
  const coursework = await getLiveCoursework(req.params.id);
  if (!coursework) return res.status(404).json({ error: 'Coursework not found' });
  if (req.query.role === 'student' && !isVisibleToStudents(coursework)) {
    return res.status(404).json({ error: 'Coursework not found' });
  }
  res.json(toCourseworkResponse(coursework));
});

router.patch('/coursework/:id', async (req, res) => {
  const coursework = await getLiveCoursework(req.params.id);
  if (!coursework) return res.status(404).json({ error: 'Coursework not found' });

  const data = {};
  if (req.body?.title !== undefined) {
    if (!nonEmptyString(req.body.title, 200)) return res.status(400).json({ error: 'title cannot be empty' });
    data.title = req.body.title.trim();
  }
  if (req.body?.body !== undefined) {
    data.body = nonEmptyString(req.body.body) ? req.body.body.trim() : null;
  }
  if (req.body?.dueAt !== undefined) {
    if (req.body.dueAt === null) data.dueAt = null;
    else {
      const dueAt = parseDate(req.body.dueAt);
      if (!dueAt) return res.status(400).json({ error: 'dueAt must be an ISO-8601 date' });
      data.dueAt = dueAt;
    }
  }
  if (req.body?.allowLate !== undefined) data.allowLate = Boolean(req.body.allowLate);
  if (req.body?.maxMarks !== undefined) {
    const maxMarks = req.body.maxMarks == null ? null : Number(req.body.maxMarks);
    if (maxMarks !== null && (Number.isNaN(maxMarks) || maxMarks < 0)) {
      return res.status(400).json({ error: 'maxMarks must be a non-negative number' });
    }
    data.maxMarks = maxMarks;
  }
  if (req.body?.rubric !== undefined) {
    if (req.body.rubric === null) data.rubric = null;
    else {
      const problem = validateCriteria(req.body.rubric);
      if (problem) return res.status(400).json({ error: problem });
      data.rubric = req.body.rubric;
    }
  }
  if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to update' });

  const updated = await prisma.coursework.update({ where: { id: coursework.id }, data });
  res.json(toCourseworkResponse(updated));
});

router.post('/coursework/:id/publish', async (req, res) => {
  const coursework = await getLiveCoursework(req.params.id);
  if (!coursework) return res.status(404).json({ error: 'Coursework not found' });
  if (coursework.status === 'published') return res.json(toCourseworkResponse(coursework));
  const updated = await prisma.coursework.update({
    where: { id: coursework.id },
    data: { status: 'published', publishedAt: new Date(), scheduledAt: null },
  });
  res.json(toCourseworkResponse(updated));
});

router.post('/coursework/:id/schedule', async (req, res) => {
  const coursework = await getLiveCoursework(req.params.id);
  if (!coursework) return res.status(404).json({ error: 'Coursework not found' });
  if (coursework.status === 'published') {
    return res.status(400).json({ error: 'Already published' });
  }
  const scheduledAt = parseDate(req.body?.scheduledAt);
  if (!scheduledAt) return res.status(400).json({ error: 'scheduledAt must be an ISO-8601 date' });
  const updated = await prisma.coursework.update({
    where: { id: coursework.id },
    data: { status: 'scheduled', scheduledAt },
  });
  res.json(toCourseworkResponse(updated));
});

router.post('/coursework/:id/archive', async (req, res) => {
  const coursework = await getLiveCoursework(req.params.id);
  if (!coursework) return res.status(404).json({ error: 'Coursework not found' });
  const updated = await prisma.coursework.update({
    where: { id: coursework.id },
    data: { status: 'archived' },
  });
  res.json(toCourseworkResponse(updated));
});

router.post('/coursework/:id/duplicate', async (req, res) => {
  const original = await getLiveCoursework(req.params.id);
  if (!original) return res.status(404).json({ error: 'Coursework not found' });
  const copy = await prisma.coursework.create({
    data: {
      classroomId: original.classroomId,
      authorId: req.body?.teacherId || DEMO_TEACHER_ID,
      type: original.type,
      title: `${original.title} (copy)`,
      body: original.body,
      dueAt: original.dueAt,
      allowLate: original.allowLate,
      maxMarks: original.maxMarks,
      rubric: original.rubric ?? undefined,
      // A duplicate is always a fresh draft (v2 duplicate()).
      status: 'draft',
    },
  });
  res.status(201).json(toCourseworkResponse(copy));
});

router.delete('/coursework/:id', async (req, res) => {
  const coursework = await getLiveCoursework(req.params.id);
  if (!coursework) return res.status(404).json({ error: 'Coursework not found' });
  await prisma.coursework.update({
    where: { id: coursework.id },
    data: { isDeleted: true, deletedAt: new Date() },
  });
  res.status(204).end();
});

// ── Submissions (student) ────────────────────────────────────────────────────

async function submittableCoursework(res, courseworkId, studentId) {
  const coursework = await getLiveCoursework(courseworkId);
  if (!coursework) {
    res.status(404).json({ error: 'Coursework not found' });
    return null;
  }
  if (!GRADEABLE_TYPES.has(coursework.type)) {
    res.status(400).json({ error: 'This item does not accept submissions' });
    return null;
  }
  if (!findStudentUser(studentId)) {
    res.status(404).json({ error: 'Student is not in the demo roster' });
    return null;
  }
  if (!(await isEnrolled(coursework.classroomId, studentId))) {
    res.status(403).json({ error: 'Not enrolled in this class' });
    return null;
  }
  if (!isVisibleToStudents(coursework)) {
    res.status(404).json({ error: 'Coursework not found' });
    return null;
  }
  return coursework;
}

router.post('/coursework/:id/submit', async (req, res) => {
  const studentId = req.body?.studentId || DEMO_STUDENT_ID;
  const coursework = await submittableCoursework(res, req.params.id, studentId);
  if (!coursework) return;

  const now = new Date();
  if (!acceptsSubmissionsAt(coursework, now)) {
    return res.status(400).json({ error: 'The deadline has passed and late submissions are off' });
  }
  const textAnswer = req.body?.textAnswer;
  if (!nonEmptyString(textAnswer, 50000)) {
    return res.status(400).json({ error: 'A submission needs a text answer' });
  }

  const existing = await prisma.submission.findUnique({
    where: { courseworkId_studentId: { courseworkId: coursework.id, studentId } },
  });
  if (existing && existing.status === 'submitted') {
    return res.status(409).json({ error: 'Already submitted — withdraw or resubmit instead' });
  }

  const fields = {
    textAnswer: textAnswer.trim(),
    status: 'submitted',
    submittedAt: now,
    isLate: isLateAt(coursework, now),
  };
  const submission = existing
    ? await prisma.submission.update({ where: { id: existing.id }, data: fields, include: LATEST_GRADE })
    : await prisma.submission.create({
      data: { courseworkId: coursework.id, studentId, ...fields },
      include: LATEST_GRADE,
    });
  res.status(201).json(toSubmissionResponse(submission));
});

router.post('/coursework/:id/resubmit', async (req, res) => {
  const studentId = req.body?.studentId || DEMO_STUDENT_ID;
  const coursework = await submittableCoursework(res, req.params.id, studentId);
  if (!coursework) return;

  const existing = await prisma.submission.findUnique({
    where: { courseworkId_studentId: { courseworkId: coursework.id, studentId } },
  });
  if (!existing) return res.status(404).json({ error: 'Nothing submitted yet — use submit' });

  const now = new Date();
  if (!acceptsSubmissionsAt(coursework, now)) {
    return res.status(400).json({ error: 'The deadline has passed and late submissions are off' });
  }
  const textAnswer = req.body?.textAnswer;
  if (!nonEmptyString(textAnswer, 50000)) {
    return res.status(400).json({ error: 'A submission needs a text answer' });
  }

  const submission = await prisma.submission.update({
    where: { id: existing.id },
    data: {
      textAnswer: textAnswer.trim(),
      status: 'submitted',
      attempt: existing.attempt + 1,
      submittedAt: now,
      isLate: isLateAt(coursework, now),
    },
    include: LATEST_GRADE,
  });
  res.json(toSubmissionResponse(submission));
});

router.post('/coursework/:id/withdraw', async (req, res) => {
  const studentId = req.body?.studentId || DEMO_STUDENT_ID;
  const coursework = await submittableCoursework(res, req.params.id, studentId);
  if (!coursework) return;

  const existing = await prisma.submission.findUnique({
    where: { courseworkId_studentId: { courseworkId: coursework.id, studentId } },
  });
  if (!existing || existing.status !== 'submitted') {
    return res.status(404).json({ error: 'No submitted work to withdraw' });
  }
  if (coursework.dueAt && new Date() > coursework.dueAt) {
    return res.status(400).json({ error: 'Cannot withdraw after the deadline' });
  }
  await prisma.submission.update({ where: { id: existing.id }, data: { status: 'withdrawn' } });
  res.status(204).end();
});

router.get('/coursework/:id/submission', async (req, res) => {
  const studentId = req.query.studentId || DEMO_STUDENT_ID;
  const coursework = await submittableCoursework(res, req.params.id, studentId);
  if (!coursework) return;
  const submission = await prisma.submission.findUnique({
    where: { courseworkId_studentId: { courseworkId: coursework.id, studentId } },
    include: LATEST_GRADE,
  });
  res.json({ submission: submission ? toSubmissionResponse(submission) : null });
});

router.get('/classes/:id/grades', async (req, res) => {
  const classroom = await getLiveClass(req.params.id);
  if (!classroom) return res.status(404).json({ error: 'Classroom not found' });
  const studentId = req.query.studentId || DEMO_STUDENT_ID;
  if (!(await isEnrolled(classroom.id, studentId))) {
    return res.status(403).json({ error: 'Not enrolled in this class' });
  }
  const submissions = await prisma.submission.findMany({
    where: { studentId, coursework: { classroomId: classroom.id, isDeleted: false } },
    include: { ...LATEST_GRADE, coursework: true },
    orderBy: { updatedAt: 'desc' },
  });
  res.json({
    items: submissions.map(s => ({
      ...toSubmissionResponse(s),
      courseworkTitle: s.coursework.title,
      courseworkType: s.coursework.type,
      maxMarks: s.coursework.maxMarks,
      dueAt: s.coursework.dueAt,
    })),
  });
});

// ── Submissions (teacher) ────────────────────────────────────────────────────

router.get('/coursework/:id/submissions', async (req, res) => {
  const coursework = await getLiveCoursework(req.params.id);
  if (!coursework) return res.status(404).json({ error: 'Coursework not found' });
  const where = { courseworkId: coursework.id };
  if (req.query.status) where.status = String(req.query.status);
  const submissions = await prisma.submission.findMany({
    where,
    include: LATEST_GRADE,
    orderBy: { submittedAt: 'desc' },
  });
  res.json({
    items: submissions.map(s => toSubmissionResponse(s, { withStudent: true })),
    total: submissions.length,
  });
});

router.post('/submissions/:id/grade', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Submission not found' });
  const submission = await prisma.submission.findUnique({
    where: { id: req.params.id },
    include: { coursework: true, grades: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  if (!submission) return res.status(404).json({ error: 'Submission not found' });

  const score = Number(req.body?.score);
  if (Number.isNaN(score) || score < 0) {
    return res.status(400).json({ error: 'score must be a non-negative number' });
  }
  const maxMarks = submission.coursework.maxMarks;
  if (maxMarks != null && score > maxMarks) {
    return res.status(400).json({ error: `Score exceeds max marks (${maxMarks})` });
  }
  let rubricScores = null;
  if (req.body?.rubricScores != null) {
    if (!Array.isArray(req.body.rubricScores)) {
      return res.status(400).json({ error: 'rubricScores must be [{criterion, points}]' });
    }
    for (const entry of req.body.rubricScores) {
      if (!entry || typeof entry.criterion !== 'string' || Number.isNaN(Number(entry.points))) {
        return res.status(400).json({ error: 'rubricScores must be [{criterion, points}]' });
      }
    }
    rubricScores = req.body.rubricScores;
  }

  const returnToStudent = Boolean(req.body?.returnToStudent);
  const [, updated] = await prisma.$transaction([
    prisma.grade.create({
      data: {
        submissionId: submission.id,
        graderId: req.body?.teacherId || DEMO_TEACHER_ID,
        score,
        maxMarks,
        rubricScores: rubricScores ?? undefined,
        comment: nonEmptyString(req.body?.comment) ? req.body.comment.trim() : null,
        privateFeedback: nonEmptyString(req.body?.privateFeedback) ? req.body.privateFeedback.trim() : null,
        isReturned: returnToStudent,
        isRegrade: submission.grades.length > 0,
      },
    }),
    prisma.submission.update({
      where: { id: submission.id },
      data: returnToStudent ? { status: 'returned' } : {},
      include: LATEST_GRADE,
    }),
  ]);
  res.json(toSubmissionResponse(updated, { withStudent: true }));
});

// Return ungraded work (e.g. asking for changes) — v2 return_submission.
router.post('/submissions/:id/return', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Submission not found' });
  const submission = await prisma.submission.findUnique({ where: { id: req.params.id } });
  if (!submission) return res.status(404).json({ error: 'Submission not found' });
  const updated = await prisma.submission.update({
    where: { id: submission.id },
    data: { status: 'returned' },
    include: LATEST_GRADE,
  });
  res.json(toSubmissionResponse(updated, { withStudent: true }));
});

// ── Rubrics ──────────────────────────────────────────────────────────────────

function toRubricResponse(r) {
  return {
    id: r.id,
    classroomId: r.classroomId,
    title: r.title,
    criteria: r.criteria,
    maxPoints: rubricMaxPoints(r.criteria),
    createdAt: r.createdAt,
  };
}

router.post('/classes/:id/rubrics', async (req, res) => {
  const classroom = await getLiveClass(req.params.id);
  if (!classroom) return res.status(404).json({ error: 'Classroom not found' });
  if (!nonEmptyString(req.body?.title, 200)) return res.status(400).json({ error: 'title is required' });
  const problem = validateCriteria(req.body?.criteria);
  if (problem) return res.status(400).json({ error: problem });

  const rubric = await prisma.rubric.create({
    data: {
      classroomId: classroom.id,
      teacherId: req.body?.teacherId || DEMO_TEACHER_ID,
      title: req.body.title.trim(),
      criteria: req.body.criteria,
    },
  });
  res.status(201).json(toRubricResponse(rubric));
});

router.get('/classes/:id/rubrics', async (req, res) => {
  const classroom = await getLiveClass(req.params.id);
  if (!classroom) return res.status(404).json({ error: 'Classroom not found' });
  const rubrics = await prisma.rubric.findMany({
    where: { classroomId: classroom.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ items: rubrics.map(toRubricResponse) });
});

router.patch('/rubrics/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Rubric not found' });
  const rubric = await prisma.rubric.findUnique({ where: { id: req.params.id } });
  if (!rubric) return res.status(404).json({ error: 'Rubric not found' });

  const data = {};
  if (req.body?.title !== undefined) {
    if (!nonEmptyString(req.body.title, 200)) return res.status(400).json({ error: 'title cannot be empty' });
    data.title = req.body.title.trim();
  }
  if (req.body?.criteria !== undefined) {
    const problem = validateCriteria(req.body.criteria);
    if (problem) return res.status(400).json({ error: problem });
    data.criteria = req.body.criteria;
  }
  if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to update' });
  const updated = await prisma.rubric.update({ where: { id: rubric.id }, data });
  res.json(toRubricResponse(updated));
});

router.delete('/rubrics/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Rubric not found' });
  const rubric = await prisma.rubric.findUnique({ where: { id: req.params.id } });
  if (!rubric) return res.status(404).json({ error: 'Rubric not found' });
  await prisma.rubric.delete({ where: { id: rubric.id } });
  res.status(204).end();
});

// Copy the rubric's criteria onto a coursework item (v2 attach_to_coursework):
// grading of that assignment then uses the inline-rubric path unchanged.
router.post('/rubrics/:id/attach/:courseworkId', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Rubric not found' });
  const rubric = await prisma.rubric.findUnique({ where: { id: req.params.id } });
  if (!rubric) return res.status(404).json({ error: 'Rubric not found' });
  const coursework = await getLiveCoursework(req.params.courseworkId);
  if (!coursework) return res.status(404).json({ error: 'Coursework not found' });
  if (coursework.classroomId !== rubric.classroomId) {
    return res.status(400).json({ error: 'Rubric and coursework are in different classrooms' });
  }
  await prisma.coursework.update({
    where: { id: coursework.id },
    data: { rubric: rubric.criteria },
  });
  res.json(toRubricResponse(rubric));
});

// ── Gradebook ────────────────────────────────────────────────────────────────

async function loadGradebook(classroomId, sortBy, order) {
  const [coursework, enrollments] = await Promise.all([
    prisma.coursework.findMany({
      where: { classroomId, status: 'published', isDeleted: false },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.enrollment.findMany({ where: { classroomId, status: 'active' } }),
  ]);
  const columns = coursework.filter(cw => GRADEABLE_TYPES.has(cw.type));
  const submissions = columns.length
    ? await prisma.submission.findMany({
      where: { courseworkId: { in: columns.map(c => c.id) } },
      include: LATEST_GRADE,
    })
    : [];
  const byKey = new Map(submissions.map(s => [`${s.courseworkId}:${s.studentId}`, s]));
  const students = enrollments.map(e => {
    const user = findStudentUser(e.studentId);
    return {
      studentId: e.studentId,
      name: user ? user.name : 'Unknown student',
      email: user ? user.email : '',
    };
  });
  return assembleGradebook(classroomId, columns, students, byKey, sortBy, order);
}

router.get('/classes/:id/gradebook', async (req, res) => {
  const classroom = await getLiveClass(req.params.id);
  if (!classroom) return res.status(404).json({ error: 'Classroom not found' });
  const book = await loadGradebook(
    classroom.id,
    req.query.sortBy === 'average' ? 'average' : 'name',
    req.query.order === 'desc' ? 'desc' : 'asc',
  );
  res.json(book);
});

router.get('/classes/:id/gradebook/export', async (req, res) => {
  const classroom = await getLiveClass(req.params.id);
  if (!classroom) return res.status(404).json({ error: 'Classroom not found' });
  const book = await loadGradebook(classroom.id, 'name', 'asc');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="gradebook-${classroom.id.slice(0, 8)}.csv"`);
  res.send(gradebookToCsv(book));
});

module.exports = router;

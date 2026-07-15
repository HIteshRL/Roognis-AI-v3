// Classroom management + enrollment (ported from v2 ClassroomService).
//
// Auth removed: teacherId/studentId arrive as explicit parameters with demo
// defaults instead of req.user. Ownership checks are gone with them — anyone
// who can reach the service can manage any class. Domain rules (join codes,
// archive semantics, roster membership) are kept intact.

const express = require('express');
const prisma = require('../lib/prisma');
const { generateJoinCode, CLASSROOM_COLORS } = require('../lib/domain');
const { isUuid, nonEmptyString } = require('../lib/validation');
const {
  DEMO_TEACHER_ID, DEMO_STUDENT_ID, DEMO_STUDENTS, findStudentUser,
} = require('../lib/demo-roster');

const router = express.Router();

const CLASS_FIELDS = ['name', 'subject', 'section', 'room', 'grade', 'description', 'color'];

function toClassResponse(c, extra = {}) {
  return {
    id: c.id,
    teacherId: c.teacherId,
    name: c.name,
    subject: c.subject,
    section: c.section,
    room: c.room,
    grade: c.grade,
    description: c.description,
    color: c.color,
    joinCode: c.joinCode,
    joinCodeEnabled: c.joinCodeEnabled,
    isArchived: c.isArchived,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    ...extra,
  };
}

async function getLiveClass(id) {
  if (!isUuid(id)) return null;
  const classroom = await prisma.classroom.findUnique({ where: { id } });
  return classroom && !classroom.isDeleted ? classroom : null;
}

// The demo roster is served here as well as from analytics, so the portals can
// render people pickers with only the classroom service running.
router.get('/students', (_req, res) => {
  res.json({
    students: DEMO_STUDENTS.map(s => ({ studentId: s.id, name: s.name, email: s.email })),
  });
});

// ── Classes (teacher) ────────────────────────────────────────────────────────

router.post('/classes', async (req, res) => {
  const { name, teacherId } = req.body || {};
  if (!nonEmptyString(name, 120)) {
    return res.status(400).json({ error: 'name is required (max 120 chars)' });
  }
  const owner = teacherId || DEMO_TEACHER_ID;
  if (!isUuid(owner)) return res.status(400).json({ error: 'teacherId must be a UUID' });

  const data = { teacherId: owner, name: name.trim(), joinCode: generateJoinCode() };
  for (const field of CLASS_FIELDS.slice(1)) {
    if (nonEmptyString(req.body[field], 500)) data[field] = req.body[field].trim();
  }
  if (data.color && !CLASSROOM_COLORS.includes(data.color)) {
    return res.status(400).json({ error: `color must be one of ${CLASSROOM_COLORS.join(', ')}` });
  }
  if (!data.color) {
    const count = await prisma.classroom.count({ where: { teacherId: owner } });
    data.color = CLASSROOM_COLORS[count % CLASSROOM_COLORS.length];
  }

  const classroom = await prisma.classroom.create({ data });
  res.status(201).json(toClassResponse(classroom, { studentCount: 0 }));
});

router.get('/classes', async (req, res) => {
  const teacherId = req.query.teacherId || DEMO_TEACHER_ID;
  if (!isUuid(teacherId)) return res.status(400).json({ error: 'teacherId must be a UUID' });
  const archived = req.query.archived === 'true';

  const classes = await prisma.classroom.findMany({
    where: { teacherId, isArchived: archived, isDeleted: false },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { enrollments: { where: { status: 'active' } } } } },
  });
  res.json({
    items: classes.map(c => toClassResponse(c, { studentCount: c._count.enrollments })),
    total: classes.length,
  });
});

router.get('/classes/:id', async (req, res) => {
  const classroom = await getLiveClass(req.params.id);
  if (!classroom) return res.status(404).json({ error: 'Classroom not found' });
  const studentCount = await prisma.enrollment.count({
    where: { classroomId: classroom.id, status: 'active' },
  });
  res.json(toClassResponse(classroom, { studentCount }));
});

router.patch('/classes/:id', async (req, res) => {
  const classroom = await getLiveClass(req.params.id);
  if (!classroom) return res.status(404).json({ error: 'Classroom not found' });

  const data = {};
  for (const field of CLASS_FIELDS) {
    if (req.body[field] === undefined) continue;
    if (field === 'name' && !nonEmptyString(req.body.name, 120)) {
      return res.status(400).json({ error: 'name cannot be empty' });
    }
    if (field === 'color' && !CLASSROOM_COLORS.includes(req.body.color)) {
      return res.status(400).json({ error: `color must be one of ${CLASSROOM_COLORS.join(', ')}` });
    }
    data[field] = typeof req.body[field] === 'string' ? req.body[field].trim() : req.body[field];
  }
  if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to update' });

  const updated = await prisma.classroom.update({ where: { id: classroom.id }, data });
  res.json(toClassResponse(updated));
});

for (const [action, value] of [['archive', true], ['unarchive', false]]) {
  router.post(`/classes/:id/${action}`, async (req, res) => {
    const classroom = await getLiveClass(req.params.id);
    if (!classroom) return res.status(404).json({ error: 'Classroom not found' });
    const updated = await prisma.classroom.update({
      where: { id: classroom.id },
      data: { isArchived: value },
    });
    res.json(toClassResponse(updated));
  });
}

router.post('/classes/:id/regenerate-code', async (req, res) => {
  const classroom = await getLiveClass(req.params.id);
  if (!classroom) return res.status(404).json({ error: 'Classroom not found' });
  const updated = await prisma.classroom.update({
    where: { id: classroom.id },
    data: { joinCode: generateJoinCode() },
  });
  res.json(toClassResponse(updated));
});

for (const [action, value] of [['enable', true], ['disable', false]]) {
  router.post(`/classes/:id/join-code/${action}`, async (req, res) => {
    const classroom = await getLiveClass(req.params.id);
    if (!classroom) return res.status(404).json({ error: 'Classroom not found' });
    const updated = await prisma.classroom.update({
      where: { id: classroom.id },
      data: { joinCodeEnabled: value },
    });
    res.json(toClassResponse(updated));
  });
}

router.delete('/classes/:id', async (req, res) => {
  const classroom = await getLiveClass(req.params.id);
  if (!classroom) return res.status(404).json({ error: 'Classroom not found' });
  await prisma.classroom.update({
    where: { id: classroom.id },
    data: { isDeleted: true, deletedAt: new Date() },
  });
  res.status(204).end();
});

// ── Roster ───────────────────────────────────────────────────────────────────

router.get('/classes/:id/roster', async (req, res) => {
  const classroom = await getLiveClass(req.params.id);
  if (!classroom) return res.status(404).json({ error: 'Classroom not found' });
  const enrollments = await prisma.enrollment.findMany({
    where: { classroomId: classroom.id, status: 'active' },
    orderBy: { joinedAt: 'asc' },
  });
  res.json({
    items: enrollments.map(e => {
      const student = findStudentUser(e.studentId);
      return {
        studentId: e.studentId,
        name: student ? student.name : 'Unknown student',
        email: student ? student.email : null,
        joinedAt: e.joinedAt,
      };
    }),
    total: enrollments.length,
  });
});

router.delete('/classes/:id/roster/:studentId', async (req, res) => {
  const classroom = await getLiveClass(req.params.id);
  if (!classroom) return res.status(404).json({ error: 'Classroom not found' });
  if (!isUuid(req.params.studentId)) {
    return res.status(400).json({ error: 'studentId must be a UUID' });
  }
  const removed = await prisma.enrollment.updateMany({
    where: { classroomId: classroom.id, studentId: req.params.studentId, status: 'active' },
    data: { status: 'removed' },
  });
  if (!removed.count) return res.status(404).json({ error: 'Student is not in this class' });
  res.status(204).end();
});

// ── Enrollment (student) ─────────────────────────────────────────────────────

router.post('/join', async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const studentId = req.body?.studentId || DEMO_STUDENT_ID;
  if (!code) return res.status(400).json({ error: 'A join code is required' });
  if (!findStudentUser(studentId)) {
    return res.status(404).json({ error: 'Student is not in the demo roster' });
  }

  const classroom = await prisma.classroom.findUnique({ where: { joinCode: code } });
  if (!classroom || classroom.isDeleted || classroom.isArchived) {
    return res.status(404).json({ error: 'No open class with that code' });
  }
  if (!classroom.joinCodeEnabled) {
    return res.status(400).json({ error: 'Joining with a code is turned off for this class' });
  }

  const existing = await prisma.enrollment.findUnique({
    where: { classroomId_studentId: { classroomId: classroom.id, studentId } },
  });
  if (existing && existing.status === 'active') {
    return res.status(409).json({ error: 'Already enrolled in this class' });
  }
  const enrollment = existing
    ? await prisma.enrollment.update({ where: { id: existing.id }, data: { status: 'active', joinedAt: new Date() } })
    : await prisma.enrollment.create({ data: { classroomId: classroom.id, studentId } });

  res.status(201).json({
    enrollmentId: enrollment.id,
    classroom: toClassResponse(classroom),
  });
});

router.get('/enrolled', async (req, res) => {
  const studentId = req.query.studentId || DEMO_STUDENT_ID;
  if (!isUuid(studentId)) return res.status(400).json({ error: 'studentId must be a UUID' });
  const enrollments = await prisma.enrollment.findMany({
    where: { studentId, status: 'active' },
    include: { classroom: true },
    orderBy: { joinedAt: 'desc' },
  });
  res.json({
    items: enrollments
      .filter(e => !e.classroom.isDeleted && !e.classroom.isArchived)
      .map(e => toClassResponse(e.classroom)),
  });
});

router.post('/classes/:id/leave', async (req, res) => {
  const classroom = await getLiveClass(req.params.id);
  if (!classroom) return res.status(404).json({ error: 'Classroom not found' });
  const studentId = req.body?.studentId || DEMO_STUDENT_ID;
  const removed = await prisma.enrollment.updateMany({
    where: { classroomId: classroom.id, studentId, status: 'active' },
    data: { status: 'removed' },
  });
  if (!removed.count) return res.status(404).json({ error: 'Not enrolled in this class' });
  res.status(204).end();
});

module.exports = router;

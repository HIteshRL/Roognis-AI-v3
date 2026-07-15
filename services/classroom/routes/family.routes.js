// Guardians + calendar (ported from v2 GuardianService / CalendarService).
//
// Auth removed: v2's invitation-token dance needs a guardian *account* to
// accept, and there are no accounts. A guardian link is therefore active on
// creation, and the summary endpoint takes a studentId directly instead of
// resolving "my linked students" from a logged-in guardian.

const express = require('express');
const prisma = require('../lib/prisma');
const { GRADEABLE_TYPES, groupCalendar, buildGuardianDigest } = require('../lib/domain');
const { isUuid, parseDate } = require('../lib/validation');
const { DEMO_STUDENT_ID, DEMO_TEACHER_ID, findStudentUser } = require('../lib/demo-roster');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toLinkResponse(g) {
  return {
    id: g.id,
    studentId: g.studentId,
    guardianEmail: g.guardianEmail,
    status: g.status,
    createdAt: g.createdAt,
  };
}

// ── Guardian links ───────────────────────────────────────────────────────────

router.post('/students/:studentId/guardians', async (req, res) => {
  const { studentId } = req.params;
  if (!findStudentUser(studentId)) {
    return res.status(404).json({ error: 'Student is not in the demo roster' });
  }
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid guardian email is required' });

  const existing = await prisma.guardianLink.findFirst({
    where: { studentId, guardianEmail: email, status: { not: 'removed' } },
  });
  if (existing) return res.status(409).json({ error: 'That guardian is already linked' });

  const link = await prisma.guardianLink.create({
    data: {
      studentId,
      guardianEmail: email,
      status: 'active',
      invitedBy: req.body?.invitedBy || DEMO_TEACHER_ID,
    },
  });
  res.status(201).json(toLinkResponse(link));
});

router.get('/students/:studentId/guardians', async (req, res) => {
  const { studentId } = req.params;
  if (!findStudentUser(studentId)) {
    return res.status(404).json({ error: 'Student is not in the demo roster' });
  }
  const links = await prisma.guardianLink.findMany({
    where: { studentId, status: { not: 'removed' } },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ items: links.map(toLinkResponse) });
});

router.delete('/guardians/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Guardian link not found' });
  const link = await prisma.guardianLink.findUnique({ where: { id: req.params.id } });
  if (!link || link.status === 'removed') {
    return res.status(404).json({ error: 'Guardian link not found' });
  }
  await prisma.guardianLink.update({ where: { id: link.id }, data: { status: 'removed' } });
  res.status(204).end();
});

// Read-only progress digest (v2 guardian summary): upcoming / missing /
// recent returned grades across the student's classes.
router.get('/students/:studentId/summary', async (req, res) => {
  const { studentId } = req.params;
  const student = findStudentUser(studentId);
  if (!student) return res.status(404).json({ error: 'Student is not in the demo roster' });

  const enrollments = await prisma.enrollment.findMany({
    where: { studentId, status: 'active' },
    include: { classroom: true },
  });
  const classrooms = enrollments
    .map(e => e.classroom)
    .filter(c => !c.isDeleted && !c.isArchived);

  const coursework = classrooms.length
    ? await prisma.coursework.findMany({
      where: {
        classroomId: { in: classrooms.map(c => c.id) },
        status: 'published',
        isDeleted: false,
        type: { in: [...GRADEABLE_TYPES] },
      },
    })
    : [];
  const submissions = coursework.length
    ? await prisma.submission.findMany({
      where: { studentId, courseworkId: { in: coursework.map(c => c.id) } },
      include: { grades: { orderBy: { createdAt: 'desc' } } },
    })
    : [];

  const classNames = new Map(classrooms.map(c => [c.id, c.name]));
  const submissionByCw = new Map(submissions.map(s => [s.courseworkId, s]));
  const items = coursework.map(cw => ({
    coursework: cw,
    classroomName: classNames.get(cw.classroomId) || 'Class',
    submission: submissionByCw.get(cw.id) || null,
  }));

  res.json(buildGuardianDigest(
    { id: studentId, name: student.name },
    items,
    new Date(),
  ));
});

// ── Calendar ─────────────────────────────────────────────────────────────────
//
// Due-date aggregation across the caller's classes (v2 CalendarService).
// role=student → enrolled classes; role=teacher → owned classes.

router.get('/calendar', async (req, res) => {
  const role = req.query.role === 'teacher' ? 'teacher' : 'student';
  const userId = req.query.userId || (role === 'teacher' ? DEMO_TEACHER_ID : DEMO_STUDENT_ID);
  if (!isUuid(userId)) return res.status(400).json({ error: 'userId must be a UUID' });

  const start = parseDate(req.query.start) || new Date();
  const end = parseDate(req.query.end) || new Date(start.getTime() + 30 * 24 * 3600 * 1000);
  if (end < start) return res.status(400).json({ error: 'end must be after start' });

  let classrooms;
  if (role === 'teacher') {
    classrooms = await prisma.classroom.findMany({
      where: { teacherId: userId, isDeleted: false },
    });
  } else {
    const enrollments = await prisma.enrollment.findMany({
      where: { studentId: userId, status: 'active' },
      include: { classroom: true },
    });
    classrooms = enrollments.map(e => e.classroom).filter(c => !c.isDeleted);
  }

  const coursework = classrooms.length
    ? await prisma.coursework.findMany({
      where: {
        classroomId: { in: classrooms.map(c => c.id) },
        status: 'published',
        isDeleted: false,
        type: { in: [...GRADEABLE_TYPES] },
        dueAt: { gte: start, lte: end },
      },
    })
    : [];

  const byId = new Map(classrooms.map(c => [c.id, c]));
  const entries = coursework.map(cw => ({ coursework: cw, classroom: byId.get(cw.classroomId) }));
  res.json(groupCalendar(start, end, entries));
});

module.exports = router;

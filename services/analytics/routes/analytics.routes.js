const express = require('express');
const prisma = require('../lib/prisma');
const requireInternalToken = require('../middleware/internal-token');
const {
  KNOWN_EVENT_TYPES,
  isValidUuid,
  parseDateOnly,
  validateEventType,
  validateAttendanceStatus,
  validateScorePair,
  normalizeSubject,
  normalizeOptionalString,
} = require('../lib/validation');
const {
  DEMO_SCHOOL_ID,
  DEMO_STUDENT_ID,
  DEMO_TEACHER_ID,
  DEMO_STUDENTS,
  findStudentUser,
  getSchoolStudentIds,
} = require('../lib/demo-roster');
const {
  RECENT_EVENT_LIMIT,
  daysAgo,
  sanitizeEvent,
  buildAttendanceSummary,
  buildScoreSummary,
  buildUsageSummary,
  buildSubjectTrends,
  buildStudentDashboard,
  buildTeacherDashboard,
  buildParentDashboard,
} = require('../lib/dashboard');
const {
  buildInterventionsForStudents,
  groupEventsByStudent,
  evaluateInterventionFlags,
} = require('../lib/interventions');

const router = express.Router();

// Auth removed: no role guards remain. Every route below is open, and any
// caller is treated as the single demo student/teacher. The only gate left is
// requireInternalToken on /event, which is service-to-service, not user auth.

// Rejects ids that aren't in the demo roster. This is a data-validity check so
// dashboards don't key on garbage — it is NOT an authorization check.
function resolveRosterStudent(studentId) {
  if (!isValidUuid(studentId))
    return { status: 400, error: 'studentId must be a valid UUID.' };

  const student = findStudentUser(studentId);
  if (!student)
    return { status: 404, error: 'Student not found in the demo roster.' };

  return { student };
}

// Class assignments are still real rows; only the teacher identity is fixed now.
async function getDemoTeacherAssignedStudentIds() {
  const assignments = await prisma.classAssignment.findMany({
    where: {
      teacherId: DEMO_TEACHER_ID,
      schoolId: DEMO_SCHOOL_ID,
    },
    select: { studentId: true },
  });

  return [...new Set(assignments.map(assignment => assignment.studentId))];
}

// POST /api/analytics/event — internal fire-and-forget ingestion
router.post('/event', requireInternalToken, async (req, res) => {
  try {
    const { type, studentId, schoolId, subject, sessionId, metadata } = req.body || {};

    const normalizedType = validateEventType(type);
    if (!normalizedType) {
      return res.status(400).json({
        error: `type must be one of: ${KNOWN_EVENT_TYPES.join(', ')}.`,
      });
    }

    if (!isValidUuid(schoolId))
      return res.status(400).json({ error: 'schoolId must be a valid UUID.' });

    if (studentId && !isValidUuid(studentId))
      return res.status(400).json({ error: 'studentId must be a valid UUID.' });

    if (sessionId && !isValidUuid(sessionId))
      return res.status(400).json({ error: 'sessionId must be a valid UUID.' });

    await prisma.event.create({
      data: {
        type: normalizedType,
        studentId: studentId || null,
        schoolId,
        subject: typeof subject === 'string' ? subject.trim() || null : null,
        sessionId: sessionId || null,
        metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {},
      },
    });

    return res.status(202).json({ received: true });
  } catch (err) {
    console.error('[analytics] event error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/analytics/students — demo roster.
//
// Auth removed: this replaces GET /api/auth/parent/:id/students, which returned
// the children linked to the signed-in parent. There are no accounts and no
// parent-child links now, so this returns the whole demo roster to any caller.
router.get('/students', (_req, res) => {
  return res.status(200).json({
    students: DEMO_STUDENTS.map(student => ({
      studentId: student.id,
      name: student.name,
      email: student.email,
    })),
  });
});

// POST /api/analytics/student/activity — active-time tracking for the demo student
router.post('/student/activity', async (req, res) => {
  try {
    const activeSeconds = Number(req.body?.activeSeconds);
    if (!Number.isFinite(activeSeconds) || activeSeconds < 5 || activeSeconds > 600) {
      return res.status(400).json({ error: 'activeSeconds must be between 5 and 600.' });
    }

    const subject = normalizeSubject(req.body?.subject);
    const route = normalizeOptionalString(req.body?.route, 80);

    await prisma.event.create({
      data: {
        type: 'study_time_tracked',
        studentId: DEMO_STUDENT_ID,
        schoolId: DEMO_SCHOOL_ID,
        subject,
        metadata: {
          activeSeconds: Math.round(activeSeconds),
          route,
        },
      },
    });

    return res.status(202).json({ received: true });
  } catch (err) {
    console.error('[analytics] student activity error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/analytics/class/assign — assign student to the demo teacher's class
router.post('/class/assign', async (req, res) => {
  try {
    const { studentId, className, subject } = req.body || {};
    const normalizedSubject = normalizeSubject(subject);

    const access = resolveRosterStudent(studentId);
    if (access.error) return res.status(access.status).json({ error: access.error });

    const assignment = await prisma.classAssignment.upsert({
      where: {
        teacherId_studentId_subject: {
          teacherId: DEMO_TEACHER_ID,
          studentId,
          subject: normalizedSubject,
        },
      },
      create: {
        schoolId: DEMO_SCHOOL_ID,
        teacherId: DEMO_TEACHER_ID,
        studentId,
        className: normalizeOptionalString(className, 120),
        subject: normalizedSubject,
      },
      update: {
        className: normalizeOptionalString(className, 120),
      },
      select: { id: true },
    });

    return res.status(201).json({ assignmentId: assignment.id });
  } catch (err) {
    console.error('[analytics] class assign error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/analytics/attendance — mark attendance
router.post('/attendance', async (req, res) => {
  try {
    const { studentId, date, status } = req.body || {};

    const access = resolveRosterStudent(studentId);
    if (access.error) return res.status(access.status).json({ error: access.error });

    const attendanceDate = parseDateOnly(date);
    if (!attendanceDate)
      return res.status(400).json({ error: 'date must be in YYYY-MM-DD format.' });

    const normalizedStatus = validateAttendanceStatus(status);
    if (!normalizedStatus)
      return res.status(400).json({ error: 'status must be one of: present, absent, late, excused.' });

    const record = await prisma.attendance.upsert({
      where: {
        studentId_date: {
          studentId,
          date: attendanceDate,
        },
      },
      create: {
        studentId,
        schoolId: DEMO_SCHOOL_ID,
        teacherId: DEMO_TEACHER_ID,
        date: attendanceDate,
        status: normalizedStatus,
      },
      update: {
        status: normalizedStatus,
        teacherId: DEMO_TEACHER_ID,
      },
      select: { id: true },
    });

    return res.status(201).json({ attendanceId: record.id });
  } catch (err) {
    console.error('[analytics] attendance error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/analytics/score — enter test score
router.post('/score', async (req, res) => {
  try {
    const { studentId, subject, testName, score, maxScore, testDate } = req.body || {};

    const access = resolveRosterStudent(studentId);
    if (access.error) return res.status(access.status).json({ error: access.error });

    const normalizedSubject = normalizeOptionalString(subject, 80);
    const normalizedTestName = normalizeOptionalString(testName, 120);
    if (!normalizedSubject)
      return res.status(400).json({ error: 'subject is required.' });
    if (!normalizedTestName)
      return res.status(400).json({ error: 'testName is required.' });

    const scoreValidation = validateScorePair(score, maxScore);
    if (scoreValidation.error)
      return res.status(400).json({ error: scoreValidation.error });

    const parsedTestDate = parseDateOnly(testDate);
    if (!parsedTestDate)
      return res.status(400).json({ error: 'testDate must be in YYYY-MM-DD format.' });

    const record = await prisma.score.create({
      data: {
        studentId,
        schoolId: DEMO_SCHOOL_ID,
        teacherId: DEMO_TEACHER_ID,
        subject: normalizedSubject,
        testName: normalizedTestName,
        score: scoreValidation.score,
        maxScore: scoreValidation.maxScore,
        testDate: parsedTestDate,
      },
      select: { id: true },
    });

    return res.status(201).json({ scoreId: record.id });
  } catch (err) {
    console.error('[analytics] score error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/analytics/student/dashboard
router.get('/student/dashboard', async (_req, res) => {
  try {
    const since30d = daysAgo(30);
    const events = await prisma.event.findMany({
      where: {
        studentId: DEMO_STUDENT_ID,
        schoolId: DEMO_SCHOOL_ID,
        createdAt: { gte: since30d },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    return res.status(200).json(buildStudentDashboard(events, {
      studentId: DEMO_STUDENT_ID,
    }));
  } catch (err) {
    console.error('[analytics] student dashboard error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/analytics/student/:studentId
router.get('/student/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;

    const access = resolveRosterStudent(studentId);
    if (access.error) return res.status(access.status).json({ error: access.error });

    const since7d = daysAgo(7);

    const [attendance, scores, events] = await Promise.all([
      prisma.attendance.findMany({
        where: { studentId, schoolId: DEMO_SCHOOL_ID },
        orderBy: { date: 'desc' },
        take: RECENT_EVENT_LIMIT,
      }),
      prisma.score.findMany({
        where: { studentId, schoolId: DEMO_SCHOOL_ID },
        orderBy: { testDate: 'desc' },
        take: RECENT_EVENT_LIMIT,
      }),
      prisma.event.findMany({
        where: { studentId, schoolId: DEMO_SCHOOL_ID, createdAt: { gte: since7d } },
        orderBy: { createdAt: 'desc' },
        take: RECENT_EVENT_LIMIT,
      }),
    ]);

    const interventionFlags = evaluateInterventionFlags(events);

    return res.status(200).json({
      studentId,
      attendanceSummary: buildAttendanceSummary(attendance),
      scoreSummary: buildScoreSummary(scores),
      usageSummary: buildUsageSummary(events),
      interventionFlags,
      recentEvents: events.map(sanitizeEvent),
    });
  } catch (err) {
    console.error('[analytics] student profile error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/analytics/teacher/dashboard
router.get('/teacher/dashboard', async (_req, res) => {
  try {
    const schoolId = DEMO_SCHOOL_ID;
    const since30d = daysAgo(30);
    let studentIds = await getDemoTeacherAssignedStudentIds();
    if (studentIds.length === 0) {
      studentIds = getSchoolStudentIds();
    }

    const events = studentIds.length === 0 ? [] : await prisma.event.findMany({
      where: {
        schoolId,
        studentId: { in: studentIds },
        createdAt: { gte: since30d },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    return res.status(200).json(buildTeacherDashboard(events, studentIds, { schoolId }));
  } catch (err) {
    console.error('[analytics] teacher dashboard error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/analytics/teacher/interventions
router.get('/teacher/interventions', async (_req, res) => {
  try {
    const schoolId = DEMO_SCHOOL_ID;
    const since7d = daysAgo(7);
    let assignedStudentIds = await getDemoTeacherAssignedStudentIds();
    if (assignedStudentIds.length === 0) {
      assignedStudentIds = getSchoolStudentIds();
    }

    const events = assignedStudentIds.length === 0 ? [] : await prisma.event.findMany({
      where: {
        schoolId,
        studentId: { in: assignedStudentIds },
        createdAt: { gte: since7d },
      },
      select: {
        studentId: true,
        type: true,
        sessionId: true,
        metadata: true,
      },
    });

    const eventsByStudent = groupEventsByStudent(events);
    const interventions = buildInterventionsForStudents(assignedStudentIds, eventsByStudent);

    return res.status(200).json({ schoolId, periodDays: 7, interventions });
  } catch (err) {
    console.error('[analytics] interventions error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/analytics/parent/dashboard?studentId=xxx
//
// Auth removed: parent-child links lived in auth_db and are gone, so there is no
// longer any notion of "your" child. Any caller can read any roster student.
router.get('/parent/dashboard', async (req, res) => {
  try {
    const { studentId } = req.query;

    if (!studentId)
      return res.status(400).json({ error: 'studentId is required.' });

    const access = resolveRosterStudent(studentId);
    if (access.error) return res.status(access.status).json({ error: access.error });

    const since30d = daysAgo(30);
    const events = await prisma.event.findMany({
      where: {
        studentId,
        schoolId: DEMO_SCHOOL_ID,
        createdAt: { gte: since30d },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    return res.status(200).json(buildParentDashboard(events, access.student));
  } catch (err) {
    console.error('[analytics] parent dashboard error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/analytics/queries/trends
router.get('/queries/trends', async (_req, res) => {
  try {
    const schoolId = DEMO_SCHOOL_ID;
    const since30d = daysAgo(30);
    let assignedStudentIds = await getDemoTeacherAssignedStudentIds();
    if (assignedStudentIds.length === 0) {
      assignedStudentIds = getSchoolStudentIds();
    }

    const events = assignedStudentIds.length === 0 ? [] : await prisma.event.findMany({
      where: {
        schoolId,
        studentId: { in: assignedStudentIds },
        createdAt: { gte: since30d },
      },
      select: {
        type: true,
        subject: true,
        studentId: true,
        sessionId: true,
        metadata: true,
      },
    });

    return res.status(200).json({
      schoolId,
      periodDays: 30,
      usageStats: buildUsageSummary(events),
      subjectTrends: buildSubjectTrends(events),
    });
  } catch (err) {
    console.error('[analytics] queries/trends error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

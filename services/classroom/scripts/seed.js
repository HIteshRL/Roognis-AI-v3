// Seed a demo classroom so the three portals have something to show on first
// boot: one class, the full roster enrolled, a pinned welcome post, a rubric,
// and three assignments in different states (graded, submitted, open).
//
// Idempotent: keyed on the class name, so re-running refreshes nothing and
// creates nothing new. Run with:  npm run seed

require('../load-env');

const prisma = require('../lib/prisma');
const { DEMO_TEACHER_ID, DEMO_STUDENT_ID, DEMO_STUDENTS } = require('../lib/demo-roster');

const CLASS_NAME = 'Science 6A';
const DAY = 24 * 3600 * 1000;

async function main() {
  const existing = await prisma.classroom.findFirst({
    where: { name: CLASS_NAME, teacherId: DEMO_TEACHER_ID, isDeleted: false },
  });
  if (existing) {
    console.log(`[seed] "${CLASS_NAME}" already exists (${existing.id}) — nothing to do.`);
    return;
  }

  const now = Date.now();
  const classroom = await prisma.classroom.create({
    data: {
      teacherId: DEMO_TEACHER_ID,
      name: CLASS_NAME,
      subject: 'Science',
      section: '6A',
      room: '104',
      grade: '6',
      description: 'NCERT Curiosity — Grade 6 Science',
      color: '#1e8e3e',
      joinCode: 'SCIDEM6',
    },
  });

  await prisma.enrollment.createMany({
    data: DEMO_STUDENTS.map(s => ({ classroomId: classroom.id, studentId: s.id })),
  });

  await prisma.announcement.create({
    data: {
      classroomId: classroom.id,
      authorId: DEMO_TEACHER_ID,
      title: 'Welcome to Science 6A',
      body: 'This term we cover chapters 1–6 of Curiosity. Check Classwork for the first assignment, and bring your lab notebook on Friday.',
      isPinned: true,
      publishedAt: new Date(now),
    },
  });

  const rubricCriteria = [
    { criterion: 'Scientific accuracy', description: 'Facts and terminology are correct', max_points: 5 },
    { criterion: 'Clarity', description: 'Explanation is easy to follow', max_points: 3 },
    { criterion: 'Examples', description: 'Uses relevant real-world examples', max_points: 2 },
  ];
  await prisma.rubric.create({
    data: {
      classroomId: classroom.id,
      teacherId: DEMO_TEACHER_ID,
      title: 'Written answer rubric',
      criteria: rubricCriteria,
    },
  });

  // Graded: due last week, Arjun submitted, teacher returned 8/10.
  const graded = await prisma.coursework.create({
    data: {
      classroomId: classroom.id,
      authorId: DEMO_TEACHER_ID,
      type: 'assignment',
      title: 'Describe the water cycle',
      body: 'Write 150–200 words on evaporation, condensation, and precipitation.',
      status: 'published',
      publishedAt: new Date(now - 10 * DAY),
      dueAt: new Date(now - 3 * DAY),
      maxMarks: 10,
      rubric: rubricCriteria,
    },
  });
  const gradedSubmission = await prisma.submission.create({
    data: {
      courseworkId: graded.id,
      studentId: DEMO_STUDENT_ID,
      status: 'returned',
      textAnswer: 'Water evaporates from oceans and lakes, rises, cools and condenses into clouds, then falls back as rain or snow. This repeating loop is the water cycle...',
      submittedAt: new Date(now - 4 * DAY),
    },
  });
  await prisma.grade.create({
    data: {
      submissionId: gradedSubmission.id,
      graderId: DEMO_TEACHER_ID,
      score: 8,
      maxMarks: 10,
      rubricScores: [
        { criterion: 'Scientific accuracy', points: 4 },
        { criterion: 'Clarity', points: 3 },
        { criterion: 'Examples', points: 1 },
      ],
      comment: 'Clear explanation. Add one more everyday example next time.',
      isReturned: true,
    },
  });

  // Submitted, awaiting grading: Priya turned it in yesterday.
  const pending = await prisma.coursework.create({
    data: {
      classroomId: classroom.id,
      authorId: DEMO_TEACHER_ID,
      type: 'homework',
      title: 'Chapter 2 questions 1–5',
      body: 'Answer in full sentences.',
      status: 'published',
      publishedAt: new Date(now - 5 * DAY),
      dueAt: new Date(now + 1 * DAY),
      maxMarks: 5,
    },
  });
  await prisma.submission.create({
    data: {
      courseworkId: pending.id,
      studentId: DEMO_STUDENTS[1].id,
      status: 'submitted',
      textAnswer: '1. Matter is anything that has mass and occupies space...',
      submittedAt: new Date(now - 1 * DAY),
    },
  });

  // Open: due next week, nobody has submitted.
  await prisma.coursework.create({
    data: {
      classroomId: classroom.id,
      authorId: DEMO_TEACHER_ID,
      type: 'assignment',
      title: 'Build a simple electric circuit',
      body: 'Photograph your circuit and describe each component. Submit the description as text.',
      status: 'published',
      publishedAt: new Date(now),
      dueAt: new Date(now + 7 * DAY),
      maxMarks: 10,
    },
  });

  await prisma.guardianLink.create({
    data: {
      studentId: DEMO_STUDENT_ID,
      guardianEmail: 'parent@demo.roognis.local',
      invitedBy: DEMO_TEACHER_ID,
    },
  });

  console.log(`[seed] Created "${CLASS_NAME}" (join code SCIDEM6) with roster, stream post, rubric, and 3 assignments.`);
}

main()
  .catch((err) => { console.error('[seed] failed:', err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

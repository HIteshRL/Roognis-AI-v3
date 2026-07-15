// End-to-end smoke test against a RUNNING classroom service + Postgres.
// Drives the full LMS loop over HTTP and asserts each step:
//
//   create class → student joins by code → announcement (pin) → rubric →
//   assignment (publish, rubric attached) → student submits → resubmit →
//   teacher grades with rubric + returns → student sees grade → gradebook +
//   CSV → calendar → guardian link + digest → archive class
//
// Usage:  node scripts/smoke.js [baseUrl]     (default http://127.0.0.1:3005)
// Exits non-zero on the first failed assertion. Creates real rows — demo DB only.

const BASE = process.argv[2] || 'http://127.0.0.1:3005';
const STUDENT = process.env.DEMO_STUDENT_ID || '00000000-0000-0000-0000-000000000002';
const STUDENT_2 = '00000000-0000-0000-0000-000000000004';

let step = 0;
function check(name, cond, detail) {
  step += 1;
  if (!cond) {
    console.error(`✗ ${step}. ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
    process.exit(1);
  }
  console.log(`✓ ${step}. ${name}`);
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json, text };
}

async function main() {
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  const health = await api('GET', '/health');
  check('service is healthy', health.status === 200 && health.body.service === 'classroom', health.body);

  // ── Class lifecycle ────────────────────────────────────────────────────────
  const created = await api('POST', '/api/classroom/classes', {
    name: `Smoke ${stamp}`, subject: 'Science', section: '6A',
  });
  check('teacher creates a class', created.status === 201 && created.body.joinCode?.length === 6, created.body);
  const classId = created.body.id;
  const joinCode = created.body.joinCode;
  check('join code avoids ambiguous chars', !/[O0I1]/.test(joinCode), joinCode);

  // ── Enrollment ─────────────────────────────────────────────────────────────
  const badJoin = await api('POST', '/api/classroom/join', { code: 'ZZZZZZ' });
  check('joining a nonexistent code 404s', badJoin.status === 404, badJoin.body);
  const join1 = await api('POST', '/api/classroom/join', { code: joinCode, studentId: STUDENT });
  check('student joins by code', join1.status === 201, join1.body);
  const join2 = await api('POST', '/api/classroom/join', { code: joinCode, studentId: STUDENT });
  check('double-join 409s', join2.status === 409, join2.body);
  await api('POST', '/api/classroom/join', { code: joinCode, studentId: STUDENT_2 });
  const enrolled = await api('GET', `/api/classroom/enrolled?studentId=${STUDENT}`);
  check('student sees the class in "enrolled"', enrolled.body.items?.some(c => c.id === classId), enrolled.body);
  const roster = await api('GET', `/api/classroom/classes/${classId}/roster`);
  check('roster resolves names from the demo roster', roster.body.items?.[0]?.name === 'Arjun Sharma', roster.body);

  // ── Stream ─────────────────────────────────────────────────────────────────
  const post = await api('POST', `/api/classroom/classes/${classId}/announcements`, {
    title: 'Welcome', body: 'First post', isPinned: true,
  });
  check('teacher posts a pinned announcement', post.status === 201 && post.body.isPinned, post.body);
  const draft = await api('POST', `/api/classroom/classes/${classId}/announcements`, {
    body: 'Draft post', status: 'draft',
  });
  check('teacher saves a draft post', draft.status === 201 && draft.body.status === 'draft', draft.body);
  const studentStream = await api('GET', `/api/classroom/classes/${classId}/announcements?role=student`);
  check('students see published posts only', studentStream.body.items.length === 1, studentStream.body);
  const teacherStream = await api('GET', `/api/classroom/classes/${classId}/announcements`);
  check('teacher sees drafts too', teacherStream.body.items.length === 2, teacherStream.body);
  const published = await api('POST', `/api/classroom/announcements/${draft.body.id}/publish`);
  check('draft publishes', published.body.status === 'published', published.body);

  // ── Rubric ─────────────────────────────────────────────────────────────────
  const rubric = await api('POST', `/api/classroom/classes/${classId}/rubrics`, {
    title: 'Answer rubric',
    criteria: [
      { criterion: 'Accuracy', max_points: 6 },
      { criterion: 'Clarity', max_points: 4 },
    ],
  });
  check('teacher creates a rubric (maxPoints summed)', rubric.status === 201 && rubric.body.maxPoints === 10, rubric.body);

  // ── Coursework ─────────────────────────────────────────────────────────────
  const dueSoon = new Date(Date.now() + 3600 * 1000).toISOString();
  const cw = await api('POST', `/api/classroom/classes/${classId}/coursework`, {
    type: 'assignment', title: 'Essay', body: 'Write it', dueAt: dueSoon, maxMarks: 10, publish: true,
  });
  check('teacher publishes an assignment', cw.status === 201 && cw.body.status === 'published', cw.body);
  const cwId = cw.body.id;
  const attach = await api('POST', `/api/classroom/rubrics/${rubric.body.id}/attach/${cwId}`);
  check('rubric attaches (copies criteria)', attach.status === 200, attach.body);
  const cwAfter = await api('GET', `/api/classroom/coursework/${cwId}`);
  check('coursework carries the copied rubric', cwAfter.body.rubric?.length === 2, cwAfter.body);

  const draftCw = await api('POST', `/api/classroom/classes/${classId}/coursework`, {
    type: 'homework', title: 'Hidden draft',
  });
  const studentWork = await api('GET', `/api/classroom/classes/${classId}/coursework?role=student&studentId=${STUDENT}`);
  check('students see published classwork only', studentWork.body.items.length === 1, studentWork.body);
  const dup = await api('POST', `/api/classroom/coursework/${cwId}/duplicate`);
  check('duplicate makes a fresh draft "(copy)"', dup.body.status === 'draft' && dup.body.title === 'Essay (copy)', dup.body);
  await api('DELETE', `/api/classroom/coursework/${dup.body.id}`);
  await api('DELETE', `/api/classroom/coursework/${draftCw.body.id}`);

  // ── Submission lifecycle ───────────────────────────────────────────────────
  const emptySub = await api('POST', `/api/classroom/coursework/${cwId}/submit`, { studentId: STUDENT });
  check('empty submission rejected', emptySub.status === 400, emptySub.body);
  const sub = await api('POST', `/api/classroom/coursework/${cwId}/submit`, {
    studentId: STUDENT, textAnswer: 'My first answer',
  });
  check('student turns in work', sub.status === 201 && sub.body.status === 'submitted' && !sub.body.isLate, sub.body);
  const subAgain = await api('POST', `/api/classroom/coursework/${cwId}/submit`, {
    studentId: STUDENT, textAnswer: 'again',
  });
  check('second submit 409s (use resubmit)', subAgain.status === 409, subAgain.body);
  const resub = await api('POST', `/api/classroom/coursework/${cwId}/resubmit`, {
    studentId: STUDENT, textAnswer: 'My better answer',
  });
  check('resubmit bumps attempt', resub.body.attempt === 2, resub.body);

  // ── Grading ────────────────────────────────────────────────────────────────
  const subs = await api('GET', `/api/classroom/coursework/${cwId}/submissions`);
  check('teacher lists submissions with student names', subs.body.items?.[0]?.studentName === 'Arjun Sharma', subs.body);
  const submissionId = subs.body.items[0].id;
  const tooHigh = await api('POST', `/api/classroom/submissions/${submissionId}/grade`, { score: 11 });
  check('score above maxMarks rejected', tooHigh.status === 400, tooHigh.body);
  const grade1 = await api('POST', `/api/classroom/submissions/${submissionId}/grade`, {
    score: 7, comment: 'Good start', rubricScores: [
      { criterion: 'Accuracy', points: 4 }, { criterion: 'Clarity', points: 3 },
    ],
    returnToStudent: false,
  });
  check('teacher grades without returning', grade1.status === 200 && grade1.body.status === 'submitted', grade1.body);
  const grade2 = await api('POST', `/api/classroom/submissions/${submissionId}/grade`, {
    score: 8, comment: 'Better after review', returnToStudent: true,
  });
  check('regrade flagged and returned', grade2.body.grade.isRegrade === true && grade2.body.status === 'returned', grade2.body);
  check('grade history is append-only (2 entries)', grade2.body.gradeHistory.length === 2, grade2.body.gradeHistory);

  const myGrades = await api('GET', `/api/classroom/classes/${classId}/grades?studentId=${STUDENT}`);
  check('student sees the returned grade', myGrades.body.items?.[0]?.grade?.score === 8, myGrades.body);

  // withdraw only works before deadline and on submitted work — returned work can't withdraw
  const withdrawReturned = await api('POST', `/api/classroom/coursework/${cwId}/withdraw`, { studentId: STUDENT });
  check('cannot withdraw returned work', withdrawReturned.status === 404, withdrawReturned.body);

  // ── Gradebook ──────────────────────────────────────────────────────────────
  const book = await api('GET', `/api/classroom/classes/${classId}/gradebook`);
  const arjunRow = book.body.rows?.find(r => r.student_name === 'Arjun Sharma');
  check('gradebook shows the returned score', arjunRow?.cells?.[cwId]?.score === 8, book.body);
  check('gradebook average counts returned only (80%)', arjunRow?.average_percent === 80, arjunRow);
  const priyaRow = book.body.rows?.find(r => r.student_name === 'Priya Nair');
  check('unsubmitted student shows missing', priyaRow?.cells?.[cwId]?.status === 'missing', priyaRow);
  const csv = await api('GET', `/api/classroom/classes/${classId}/gradebook/export`);
  check('CSV export has header + rows', csv.text.startsWith('Student,Email') && csv.text.includes('Arjun Sharma'), csv.text.slice(0, 120));

  // ── Calendar ───────────────────────────────────────────────────────────────
  const calStart = new Date(Date.now() - 3600 * 1000).toISOString();
  const calEnd = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  const cal = await api('GET', `/api/classroom/calendar?role=student&userId=${STUDENT}&start=${calStart}&end=${calEnd}`);
  check('calendar lists the due assignment', cal.body.days?.some(d => d.events.some(e => e.coursework_id === cwId)), cal.body);

  // ── Guardians ──────────────────────────────────────────────────────────────
  const gEmail = `guardian+${stamp}@example.com`;
  const gLink = await api('POST', `/api/classroom/students/${STUDENT}/guardians`, { email: gEmail });
  check('guardian links (active immediately)', gLink.status === 201 && gLink.body.status === 'active', gLink.body);
  const gDup = await api('POST', `/api/classroom/students/${STUDENT}/guardians`, { email: gEmail });
  check('duplicate guardian 409s', gDup.status === 409, gDup.body);
  const digest = await api('GET', `/api/classroom/students/${STUDENT}/summary`);
  check('guardian digest shows the returned grade', digest.body.recent_grades?.some(g => g.score === 8), digest.body);
  await api('DELETE', `/api/classroom/guardians/${gLink.body.id}`);

  // ── Archive ────────────────────────────────────────────────────────────────
  const archived = await api('POST', `/api/classroom/classes/${classId}/archive`);
  check('class archives', archived.body.isArchived === true, archived.body);
  const enrolledAfter = await api('GET', `/api/classroom/enrolled?studentId=${STUDENT}`);
  check('archived class leaves the student list', !enrolledAfter.body.items.some(c => c.id === classId), enrolledAfter.body);
  const joinArchived = await api('POST', '/api/classroom/join', { code: joinCode, studentId: STUDENT_2 });
  check('cannot join an archived class', joinArchived.status === 404, joinArchived.body);
  const restored = await api('POST', `/api/classroom/classes/${classId}/unarchive`);
  check('class restores', restored.body.isArchived === false, restored.body);

  console.log(`\nAll ${step} smoke checks passed against ${BASE}`);
}

main().catch((err) => { console.error('smoke failed:', err); process.exit(1); });

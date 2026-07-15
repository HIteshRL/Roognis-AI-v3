// Unit tests for the pure v2-ported domain rules. These are the behaviors the
// v2 codebase defines in core/models/lms.py and the learner services — keeping
// them green is what "feature parity" means here.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateJoinCode, CODE_ALPHABET,
  acceptsSubmissionsAt, isLateAt, isVisibleToStudents,
  rubricMaxPoints, validateCriteria,
  assembleGradebook, gradebookToCsv,
  groupCalendar, buildGuardianDigest,
} = require('../lib/domain');

const HOUR = 3600 * 1000;
const now = new Date('2026-07-15T12:00:00Z');
const past = new Date(now.getTime() - HOUR);
const future = new Date(now.getTime() + HOUR);

test('join codes', async (t) => {
  await t.test('are 6 chars from the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateJoinCode();
      assert.equal(code.length, 6);
      for (const ch of code) assert.ok(CODE_ALPHABET.includes(ch), `bad char ${ch}`);
    }
  });
  await t.test('never contain O, 0, I, or 1', () => {
    for (const banned of ['O', '0', 'I', '1']) {
      assert.ok(!CODE_ALPHABET.includes(banned));
    }
  });
});

test('coursework visibility and deadlines (v2 Coursework rules)', async (t) => {
  const published = { status: 'published', isDeleted: false, dueAt: null, allowLate: true };

  await t.test('drafts and archived items are invisible to students', () => {
    assert.equal(isVisibleToStudents({ ...published, status: 'draft' }), false);
    assert.equal(isVisibleToStudents({ ...published, status: 'archived' }), false);
    assert.equal(isVisibleToStudents({ ...published, isDeleted: true }), false);
    assert.equal(isVisibleToStudents(published), true);
  });

  await t.test('no due date → always accepts', () => {
    assert.equal(acceptsSubmissionsAt(published, now), true);
  });

  await t.test('past due + allowLate → accepts and marks late', () => {
    const cw = { ...published, dueAt: past, allowLate: true };
    assert.equal(acceptsSubmissionsAt(cw, now), true);
    assert.equal(isLateAt(cw, now), true);
  });

  await t.test('past due + late off → rejects', () => {
    const cw = { ...published, dueAt: past, allowLate: false };
    assert.equal(acceptsSubmissionsAt(cw, now), false);
  });

  await t.test('before due → accepts, not late', () => {
    const cw = { ...published, dueAt: future, allowLate: false };
    assert.equal(acceptsSubmissionsAt(cw, now), true);
    assert.equal(isLateAt(cw, now), false);
  });

  await t.test('unpublished never accepts, even without a deadline', () => {
    assert.equal(acceptsSubmissionsAt({ ...published, status: 'draft' }, now), false);
  });
});

test('rubrics', async (t) => {
  await t.test('max points sums criteria', () => {
    assert.equal(rubricMaxPoints([
      { criterion: 'Clarity', max_points: 4 },
      { criterion: 'Accuracy', max_points: 6 },
    ]), 10);
    assert.equal(rubricMaxPoints([]), 0);
  });

  await t.test('criteria validation matches v2 rules', () => {
    assert.equal(validateCriteria([{ criterion: 'A', max_points: 5 }]), null);
    assert.match(validateCriteria([]), /at least one criterion/);
    assert.match(validateCriteria([{ criterion: '', max_points: 5 }]), /needs a name/);
    assert.match(validateCriteria([{ criterion: 'A', max_points: -1 }]), /non-negative/);
    assert.match(validateCriteria([{ criterion: 'A' }]), /non-negative/);
  });
});

test('gradebook assembly (v2 GradebookService)', async (t) => {
  const cwId = 'cw-1';
  const columns = [{ id: cwId, title: 'Essay', type: 'assignment', maxMarks: 10, dueAt: past }];
  const students = [
    { studentId: 's-1', name: 'Arjun', email: 'a@x.io' },
    { studentId: 's-2', name: 'Priya', email: 'p@x.io' },
    { studentId: 's-3', name: 'Rahul', email: 'r@x.io' },
  ];
  const submissions = new Map([
    // returned with grade → counts toward average
    [`${cwId}:s-1`, { status: 'returned', grades: [{ score: 8, maxMarks: 10, isReturned: true }] }],
    // graded but NOT returned → visible score, does not count toward average
    [`${cwId}:s-2`, { status: 'submitted', grades: [{ score: 5, maxMarks: 10, isReturned: false }] }],
    // s-3 never submitted → missing
  ]);

  const book = assembleGradebook('class-1', columns, students, submissions);

  await t.test('cells carry status and score', () => {
    const row1 = book.rows.find(r => r.student_id === 's-1');
    assert.deepEqual(row1.cells[cwId], { status: 'returned', score: 8, returned: true });
    const row3 = book.rows.find(r => r.student_id === 's-3');
    assert.deepEqual(row3.cells[cwId], { status: 'missing', score: null, returned: false });
  });

  await t.test('averages only count returned grades', () => {
    assert.equal(book.rows.find(r => r.student_id === 's-1').average_percent, 80);
    assert.equal(book.rows.find(r => r.student_id === 's-2').average_percent, null);
  });

  await t.test('class average ignores students with no returned grades', () => {
    assert.equal(book.class_average_percent, 80);
  });

  await t.test('sorts by name asc by default', () => {
    assert.deepEqual(book.rows.map(r => r.student_name), ['Arjun', 'Priya', 'Rahul']);
  });

  await t.test('sort by average puts null-average students last', () => {
    const byAvg = assembleGradebook('class-1', columns, students, submissions, 'average', 'desc');
    assert.equal(byAvg.rows[0].student_id, 's-1');
    assert.equal(byAvg.rows[byAvg.rows.length - 1].average_percent, null);
  });

  await t.test('CSV has header, one line per student, and escapes commas', () => {
    const csvColumns = [{ ...columns[0], title: 'Essay, part 1' }];
    const csv = gradebookToCsv(assembleGradebook('c', csvColumns, students, submissions));
    const lines = csv.trim().split('\r\n');
    assert.equal(lines.length, 4);
    assert.ok(lines[0].includes('"Essay, part 1"'));
    assert.ok(lines[1].startsWith('Arjun,a@x.io,8,80'));
  });
});

test('calendar grouping (v2 CalendarService)', () => {
  const classroom = { id: 'c-1', name: 'Science 8A' };
  const mk = (id, dueAt) => ({
    coursework: { id, title: id, type: 'assignment', dueAt, maxMarks: 10 },
    classroom,
  });
  const result = groupCalendar(past, new Date(now.getTime() + 72 * HOUR), [
    mk('later-same-day', new Date('2026-07-16T15:00:00Z')),
    mk('early-same-day', new Date('2026-07-16T08:00:00Z')),
    mk('next-day', new Date('2026-07-17T09:00:00Z')),
  ]);
  assert.equal(result.total, 3);
  assert.deepEqual(result.days.map(d => d.date), ['2026-07-16', '2026-07-17']);
  assert.deepEqual(
    result.days[0].events.map(e => e.coursework_id),
    ['early-same-day', 'later-same-day'],
  );
});

test('guardian digest buckets (v2 GuardianService.summary)', () => {
  const mk = (id, dueAt, submission) => ({
    coursework: { id, title: id, dueAt },
    classroomName: 'Science 8A',
    submission,
  });
  const digest = buildGuardianDigest({ id: 's-1', name: 'Arjun' }, [
    mk('upcoming-1', future, null),
    mk('missing-1', past, null),
    mk('graded-1', past, { status: 'returned', grades: [{ score: 9, maxMarks: 10, isReturned: true }] }),
    // submitted but not yet returned → in none of the three buckets
    mk('pending-grade', past, { status: 'submitted', grades: [] }),
    // no due date and unsubmitted → in none of the buckets (matches v2)
    mk('undated', null, null),
  ], now);

  assert.deepEqual(digest.upcoming.map(e => e.coursework_id), ['upcoming-1']);
  assert.deepEqual(digest.missing.map(e => e.coursework_id), ['missing-1']);
  assert.deepEqual(digest.recent_grades.map(e => e.coursework_id), ['graded-1']);
  assert.equal(digest.recent_grades[0].score, 9);
  assert.equal(digest.student.name, 'Arjun');
});

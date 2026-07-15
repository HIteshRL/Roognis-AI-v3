// Pure domain rules ported from Roognis v2 (core/models/lms.py,
// core/models/classroom.py). No I/O — everything here is unit-testable.

const crypto = require('crypto');

const COURSEWORK_TYPES = [
  'announcement', 'assignment', 'homework', 'quiz', 'exam',
  'practice_set', 'discussion', 'poll',
];
const COURSEWORK_STATUSES = ['draft', 'scheduled', 'published', 'archived'];
const SUBMISSION_STATUSES = ['draft', 'submitted', 'returned', 'withdrawn'];
const GRADEABLE_TYPES = new Set(['assignment', 'homework', 'quiz', 'exam', 'practice_set']);

// Google-Classroom-style header colours (v2 CLASSROOM_COLORS).
const CLASSROOM_COLORS = [
  '#1967d2', '#1e8e3e', '#e52592', '#9334e6',
  '#e8710a', '#00897b', '#d93025', '#3949ab',
];

// Unambiguous alphabet — no O/0, I/1, so codes are easy to read out and type.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

function generateJoinCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

// ── Coursework lifecycle rules (v2 Coursework dataclass) ─────────────────────

function isVisibleToStudents(coursework) {
  return coursework.status === 'published' && !coursework.isDeleted;
}

function isLateAt(coursework, at) {
  return Boolean(coursework.dueAt && at > new Date(coursework.dueAt));
}

function acceptsSubmissionsAt(coursework, at) {
  if (!isVisibleToStudents(coursework)) return false;
  if (coursework.dueAt && at > new Date(coursework.dueAt)) return coursework.allowLate;
  return true;
}

// ── Rubrics ──────────────────────────────────────────────────────────────────

function rubricMaxPoints(criteria) {
  return (criteria || []).reduce((sum, c) => sum + (Number(c.max_points) || 0), 0);
}

// A criteria list is valid when every entry names a criterion and has a
// non-negative max_points. (v2 validated shape via pydantic DTOs.)
function validateCriteria(criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return 'A rubric needs at least one criterion';
  }
  for (const c of criteria) {
    if (!c || typeof c.criterion !== 'string' || !c.criterion.trim()) {
      return 'Every rubric criterion needs a name';
    }
    if (c.max_points == null || Number.isNaN(Number(c.max_points)) || Number(c.max_points) < 0) {
      return 'Every rubric criterion needs a non-negative max_points';
    }
  }
  return null;
}

// ── Gradebook assembly (v2 GradebookService.gradebook) ───────────────────────
//
// columns: published gradeable coursework. submissionsByKey: Map keyed
// `${courseworkId}:${studentId}` → submission with grades sorted newest-first.
// Averages count returned grades only, exactly like v2.
function assembleGradebook(classroomId, columnsSource, students, submissionsByKey, sortBy = 'name', order = 'asc') {
  const columns = columnsSource.map(cw => ({
    coursework_id: cw.id,
    title: cw.title,
    type: cw.type,
    max_marks: cw.maxMarks,
    due_at: cw.dueAt ? new Date(cw.dueAt).toISOString() : null,
  }));

  const rows = students.map(student => {
    const cells = {};
    let earned = 0;
    let possible = 0;
    for (const cw of columnsSource) {
      const submission = submissionsByKey.get(`${cw.id}:${student.studentId}`);
      const cell = { status: 'missing', score: null, returned: false };
      if (submission) {
        cell.status = submission.status;
        const grade = submission.grades && submission.grades[0];
        if (grade) {
          cell.score = grade.score;
          cell.returned = grade.isReturned;
          if (grade.isReturned) {
            earned += grade.score;
            possible += grade.maxMarks ?? (cw.maxMarks || 0);
          }
        }
      }
      cells[cw.id] = cell;
    }
    const average = possible ? Math.round((earned / possible) * 1000) / 10 : null;
    return {
      student_id: student.studentId,
      student_name: student.name,
      email: student.email,
      cells,
      average_percent: average,
    };
  });

  const reverse = order === 'desc';
  if (sortBy === 'average') {
    rows.sort((a, b) => {
      const aNull = a.average_percent == null;
      const bNull = b.average_percent == null;
      if (aNull !== bNull) return aNull ? 1 : -1;
      const diff = (a.average_percent || 0) - (b.average_percent || 0);
      return reverse ? -diff : diff;
    });
  } else {
    rows.sort((a, b) => {
      const diff = a.student_name.toLowerCase().localeCompare(b.student_name.toLowerCase());
      return reverse ? -diff : diff;
    });
  }

  const averages = rows.map(r => r.average_percent).filter(v => v != null);
  return {
    classroom_id: classroomId,
    columns,
    rows,
    class_average_percent: averages.length
      ? Math.round((averages.reduce((a, b) => a + b, 0) / averages.length) * 10) / 10
      : null,
    student_count: students.length,
  };
}

function gradebookToCsv(book) {
  const escape = (value) => {
    const s = String(value ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [];
  lines.push(['Student', 'Email', ...book.columns.map(c => c.title), 'Average %'].map(escape).join(','));
  for (const row of book.rows) {
    const cells = book.columns.map(col => {
      const cell = row.cells[col.coursework_id];
      return cell.score == null ? '' : cell.score;
    });
    lines.push([row.student_name, row.email, ...cells,
      row.average_percent == null ? '' : row.average_percent].map(escape).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// ── Calendar grouping (v2 CalendarService.events) ────────────────────────────
//
// entries: [{coursework, classroom}] already filtered to published gradeable
// items with a due date inside [start, end]. Groups by ISO date, sorts within
// each day by due time.
function groupCalendar(start, end, entries) {
  const byDate = new Map();
  for (const { coursework: cw, classroom } of entries) {
    const due = new Date(cw.dueAt);
    const day = due.toISOString().slice(0, 10);
    if (!byDate.has(day)) byDate.set(day, []);
    byDate.get(day).push({
      coursework_id: cw.id,
      classroom_id: classroom.id,
      classroom_name: classroom.name,
      title: cw.title,
      type: cw.type,
      due_at: due.toISOString(),
      max_marks: cw.maxMarks,
    });
  }
  const days = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, events]) => ({
      date,
      events: events.sort((a, b) => a.due_at.localeCompare(b.due_at)),
    }));
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    days,
    total: days.reduce((sum, d) => sum + d.events.length, 0),
  };
}

// ── Guardian digest (v2 GuardianService.summary) ─────────────────────────────
//
// items: [{coursework, classroomName, submission}] for every published
// gradeable item across the student's classes; submission carries grades
// sorted newest-first. Buckets exactly as v2: submitted+returned grade →
// recent_grades, unsubmitted past due → missing, unsubmitted future due →
// upcoming.
function buildGuardianDigest(student, items, now) {
  const upcoming = [];
  const missing = [];
  const recentGrades = [];
  for (const { coursework: cw, classroomName, submission } of items) {
    const entry = {
      coursework_id: cw.id,
      classroom_name: classroomName,
      title: cw.title,
      due_at: cw.dueAt ? new Date(cw.dueAt).toISOString() : null,
    };
    const submitted = Boolean(submission && ['submitted', 'returned'].includes(submission.status));
    if (submitted) {
      const grade = submission.grades && submission.grades[0];
      if (grade && grade.isReturned) {
        recentGrades.push({ ...entry, score: grade.score, max_marks: grade.maxMarks });
      }
    } else if (cw.dueAt && new Date(cw.dueAt) < now) {
      missing.push(entry);
    } else if (cw.dueAt && new Date(cw.dueAt) >= now) {
      upcoming.push(entry);
    }
  }
  upcoming.sort((a, b) => (a.due_at || '').localeCompare(b.due_at || ''));
  return {
    student,
    upcoming,
    missing,
    recent_grades: recentGrades.slice(-10),
    generated_at: now.toISOString(),
  };
}

module.exports = {
  COURSEWORK_TYPES,
  COURSEWORK_STATUSES,
  SUBMISSION_STATUSES,
  GRADEABLE_TYPES,
  CLASSROOM_COLORS,
  CODE_ALPHABET,
  generateJoinCode,
  isVisibleToStudents,
  isLateAt,
  acceptsSubmissionsAt,
  rubricMaxPoints,
  validateCriteria,
  assembleGradebook,
  gradebookToCsv,
  groupCalendar,
  buildGuardianDigest,
};

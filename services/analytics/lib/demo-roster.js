// Auth removed.
//
// The student roster used to live in auth_db.users, owned by the auth service.
// analytics read it cross-schema (SELECT ... FROM auth_db.users) to resolve
// student names and school membership. With the auth service deleted that table
// is gone, so the roster is defined here instead — otherwise the teacher and
// parent dashboards would only ever see orphan UUIDs.
//
// These ids must stay in sync with DEMO_STUDENT_ID / DEMO_SCHOOL_ID in
// services/ai/server.js, or analytics events won't line up with the roster.

const DEMO_SCHOOL_ID = process.env.DEMO_SCHOOL_ID || '00000000-0000-0000-0000-000000000001';
const DEMO_STUDENT_ID = process.env.DEMO_STUDENT_ID || '00000000-0000-0000-0000-000000000002';
const DEMO_TEACHER_ID = process.env.DEMO_TEACHER_ID || '00000000-0000-0000-0000-000000000003';

const DEMO_STUDENTS = [
  {
    id: DEMO_STUDENT_ID,
    name: 'Arjun Sharma',
    email: 'arjun.sharma@demo.roognis.local',
    schoolId: DEMO_SCHOOL_ID,
    role: 'student',
  },
  {
    id: '00000000-0000-0000-0000-000000000004',
    name: 'Priya Nair',
    email: 'priya.nair@demo.roognis.local',
    schoolId: DEMO_SCHOOL_ID,
    role: 'student',
  },
  {
    id: '00000000-0000-0000-0000-000000000005',
    name: 'Rahul Verma',
    email: 'rahul.verma@demo.roognis.local',
    schoolId: DEMO_SCHOOL_ID,
    role: 'student',
  },
];

function findStudentUser(studentId) {
  return DEMO_STUDENTS.find(student => student.id === studentId) || null;
}

function getSchoolStudentIds() {
  return DEMO_STUDENTS.map(student => student.id);
}

module.exports = {
  DEMO_SCHOOL_ID,
  DEMO_STUDENT_ID,
  DEMO_TEACHER_ID,
  DEMO_STUDENTS,
  findStudentUser,
  getSchoolStudentIds,
};

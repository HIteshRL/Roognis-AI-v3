// Auth removed platform-wide. This is the same fixed demo roster the analytics
// service uses (services/analytics/lib/demo-roster.js) — the classroom service
// needs it to resolve student names on rosters, submissions, and the gradebook,
// and to validate join/enrollment against known students. Keep the two files in
// sync, and keep the ids in sync with DEMO_* in services/ai.

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

const DEMO_TEACHER = {
  id: DEMO_TEACHER_ID,
  name: 'Demo Teacher',
  email: 'teacher@demo.roognis.local',
  role: 'teacher',
};

function findStudentUser(studentId) {
  return DEMO_STUDENTS.find(student => student.id === studentId) || null;
}

function studentName(studentId) {
  const student = findStudentUser(studentId);
  return student ? student.name : 'Unknown student';
}

module.exports = {
  DEMO_SCHOOL_ID,
  DEMO_STUDENT_ID,
  DEMO_TEACHER_ID,
  DEMO_STUDENTS,
  DEMO_TEACHER,
  findStudentUser,
  studentName,
};

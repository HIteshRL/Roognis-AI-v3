const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildStudentDashboard,
  buildTeacherDashboard,
  buildParentDashboard,
} = require('../lib/dashboard');

const now = new Date('2026-07-10T10:00:00.000Z');

function event(overrides) {
  return {
    id: overrides.id || `${overrides.type}-${overrides.studentId || 'student'}`,
    type: overrides.type,
    studentId: overrides.studentId || 'student-1',
    schoolId: 'school-1',
    subject: overrides.subject || 'Science',
    sessionId: overrides.sessionId || null,
    metadata: overrides.metadata || {},
    createdAt: overrides.createdAt || now,
  };
}

describe('dashboard builders', () => {
  it('builds student progress from learning events', () => {
    const dashboard = buildStudentDashboard([
      event({ type: 'chat_message', createdAt: now }),
      event({ type: 'image_generated', createdAt: now }),
      event({ type: 'quiz_submitted', createdAt: now, metadata: { quizId: 'q1' } }),
      event({
        type: 'quiz_graded',
        createdAt: now,
        metadata: { quizId: 'q1', score: 3, maxScore: 5, weakArea: 'Photosynthesis equation' },
      }),
    ], { studentId: 'student-1', now });

    assert.equal(dashboard.studentId, 'student-1');
    assert.equal(dashboard.learningStreakDays, 1);
    assert.equal(dashboard.timeSpentSecondsThisWeek, 0);
    assert.equal(dashboard.practiceProgressPercent, 60);
    assert.equal(dashboard.lessonsCompletedThisWeek, 1);
    assert.equal(dashboard.weakAreas[0].label, 'Photosynthesis equation');
  });

  it('builds teacher dashboard without attendance data', () => {
    const dashboard = buildTeacherDashboard([
      event({ type: 'chat_message', studentId: 'student-1', createdAt: now }),
      event({ type: 'video_recommended', studentId: 'student-2', createdAt: now }),
      event({ type: 'quiz_published', studentId: 'student-1', metadata: { quizId: 'q1', quizTitle: 'Plants quiz' }, createdAt: now }),
      event({ type: 'quiz_graded', studentId: 'student-1', metadata: { quizId: 'q1', scorePercent: 80 }, createdAt: now }),
    ], ['student-1', 'student-2'], { schoolId: 'school-1', now });

    assert.equal(dashboard.studentCount, 2);
    assert.equal(dashboard.usageStats.activeStudents7d, 2);
    assert.equal(dashboard.activeQuiz.title, 'Plants quiz');
    assert.equal(dashboard.activeQuiz.averageScorePercent, 80);
    assert.ok(dashboard.lessonEngagement.find(item => item.key === 'videos').count > 0);
  });

  it('counts only explicit active seconds for study time', () => {
    const dashboard = buildStudentDashboard([
      event({ type: 'chat_message', createdAt: now }),
      event({ type: 'study_time_tracked', createdAt: now, metadata: { activeSeconds: 45 } }),
    ], { studentId: 'student-1', now });

    assert.equal(dashboard.timeSpentSecondsThisWeek, 45);
  });

  it('builds parent summary for a linked child', () => {
    const dashboard = buildParentDashboard([
      event({ type: 'chat_message', createdAt: now }),
      event({ type: 'quiz_opened', metadata: { quizId: 'q1' }, createdAt: now }),
    ], { id: 'student-1', name: 'Arjun Sharma' }, { now });

    assert.equal(dashboard.studentName, 'Arjun Sharma');
    assert.equal(dashboard.learningStreakDays, 1);
    assert.equal(dashboard.assignedQuizStatus, 'Opened');
  });
});

const RECENT_EVENT_LIMIT = 50;

const SENSITIVE_METADATA_KEYS = new Set([
  'prompt',
  'message',
  'content',
  'comment',
  'userMessage',
  'assistantMessage',
]);

const LEARNING_EVENT_TYPES = new Set([
  'chat_message',
  'feedback_submitted',
  'image_generated',
  'video_recommended',
  'video_opened',
  'video_completed',
  'study_time_tracked',
  'lesson_started',
  'lesson_completed',
  'quiz_opened',
  'quiz_submitted',
  'quiz_graded',
]);

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function uniqueIds(ids) {
  return [...new Set(ids.filter(Boolean))];
}

function countBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};

  const safe = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_METADATA_KEYS.has(key)) continue;
    safe[key] = value;
  }
  return safe;
}

function sanitizeEvent(event) {
  return {
    id: event.id,
    type: event.type,
    studentId: event.studentId,
    schoolId: event.schoolId,
    subject: event.subject,
    sessionId: event.sessionId,
    metadata: sanitizeMetadata(event.metadata),
    createdAt: event.createdAt,
  };
}

function buildAttendanceSummary(records) {
  const byStatus = countBy(records, r => r.status);
  return {
    totalRecords: records.length,
    byStatus,
    recent: records.slice(0, 10).map(r => ({
      id: r.id,
      date: r.date,
      status: r.status,
    })),
  };
}

function buildScoreSummary(records) {
  if (records.length === 0) {
    return { totalRecords: 0, averagePercent: null, bySubject: {}, recent: [] };
  }

  const percents = records.map(r => {
    const score = Number(r.score);
    const maxScore = Number(r.maxScore) || 100;
    return maxScore > 0 ? (score / maxScore) * 100 : 0;
  });

  const averagePercent = percents.reduce((sum, p) => sum + p, 0) / percents.length;
  const bySubject = {};

  for (const record of records) {
    if (!bySubject[record.subject]) bySubject[record.subject] = { count: 0, averagePercent: 0, totalPercent: 0 };
    const score = Number(record.score);
    const maxScore = Number(record.maxScore) || 100;
    const percent = maxScore > 0 ? (score / maxScore) * 100 : 0;
    bySubject[record.subject].count += 1;
    bySubject[record.subject].totalPercent += percent;
  }

  for (const subject of Object.keys(bySubject)) {
    const entry = bySubject[subject];
    entry.averagePercent = entry.totalPercent / entry.count;
    delete entry.totalPercent;
  }

  return {
    totalRecords: records.length,
    averagePercent,
    bySubject,
    recent: records.slice(0, 10).map(r => ({
      id: r.id,
      subject: r.subject,
      testName: r.testName,
      score: Number(r.score),
      maxScore: Number(r.maxScore),
      testDate: r.testDate,
    })),
  };
}

function buildUsageSummary(events) {
  const sessionIds = uniqueIds(events.filter(e => e.type === 'chat_message' && e.sessionId).map(e => e.sessionId));

  return {
    totalEvents: events.length,
    byType: countBy(events, e => e.type),
    chatSessions: sessionIds.length,
    activeStudents: uniqueIds(events.map(e => e.studentId)).length,
  };
}

function buildSubjectTrends(events) {
  const bySubject = {};

  for (const event of events) {
    if (!event.subject) continue;
    if (!bySubject[event.subject]) {
      bySubject[event.subject] = {
        subject: event.subject,
        eventCount: 0,
        sessionIds: new Set(),
        ratings: [],
      };
    }

    const entry = bySubject[event.subject];
    entry.eventCount += 1;
    if (event.sessionId) entry.sessionIds.add(event.sessionId);
    if (event.type === 'feedback_submitted' && Number.isFinite(Number(event.metadata?.rating))) {
      entry.ratings.push(Number(event.metadata.rating));
    }
  }

  return Object.values(bySubject).map(entry => ({
    subject: entry.subject,
    eventCount: entry.eventCount,
    sessionCount: entry.sessionIds.size,
    avgRating: entry.ratings.length > 0
      ? entry.ratings.reduce((sum, r) => sum + r, 0) / entry.ratings.length
      : null,
  }));
}

function eventDate(event) {
  const parsed = new Date(event.createdAt || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysBetween(from, to) {
  return Math.floor((startOfUtcDay(to) - startOfUtcDay(from)) / 86_400_000);
}

function isWithinDays(event, days, now = new Date()) {
  const diff = daysBetween(eventDate(event), now);
  return diff >= 0 && diff < days;
}

function metadataNumber(metadata, keys) {
  if (!metadata || typeof metadata !== 'object') return null;

  for (const key of keys) {
    const value = Number(metadata[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function learningSubject(event) {
  const subject = event.subject || event.metadata?.subject;
  return typeof subject === 'string' && subject.trim() ? subject.trim() : 'General';
}

function eventActiveSeconds(event) {
  const explicit = metadataNumber(event.metadata, [
    'activeSeconds',
    'timeSpentSeconds',
    'durationSeconds',
    'watchSeconds',
  ]);
  if (explicit !== null) return Math.min(explicit, 7200);

  return 0;
}

function isLearningActivity(event) {
  return Boolean(event?.studentId) && LEARNING_EVENT_TYPES.has(event.type);
}

function sumActiveSeconds(events, now = new Date(), days = 7) {
  return events
    .filter(event => isLearningActivity(event) && isWithinDays(event, days, now))
    .reduce((sum, event) => sum + eventActiveSeconds(event), 0);
}

function buildLearningStreak(events, now = new Date()) {
  const activeDays = new Set(
    events
      .filter(isLearningActivity)
      .map(event => dayKey(eventDate(event)))
  );

  if (!activeDays.size) return 0;

  let cursor = startOfUtcDay(now);
  if (!activeDays.has(dayKey(cursor))) {
    cursor = new Date(cursor.getTime() - 86_400_000);
  }

  let streak = 0;
  while (activeDays.has(dayKey(cursor))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  return streak;
}

function scorePercentFromMetadata(metadata) {
  const direct = metadataNumber(metadata, ['scorePercent', 'percent', 'percentage']);
  if (direct !== null) return Math.min(Math.round(direct), 100);

  const score = metadataNumber(metadata, ['score', 'correctAnswers', 'correct']);
  const maxScore = metadataNumber(metadata, ['maxScore', 'totalQuestions', 'total']);
  if (score !== null && maxScore && maxScore > 0) {
    return Math.min(Math.round((score / maxScore) * 100), 100);
  }
  return null;
}

function weakAreasFromEvent(event) {
  const metadata = event.metadata || {};
  const raw = metadata.weakAreas || metadata.weakAreaLabels || metadata.weakArea || metadata.weakAreaLabel;
  const values = Array.isArray(raw) ? raw : [raw];

  return values
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim());
}

function buildWeakAreas(events) {
  const counts = {};

  for (const event of events) {
    for (const area of weakAreasFromEvent(event)) {
      counts[area] = (counts[area] || 0) + 1;
    }
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([label, count]) => ({ label, count }));
}

function latestQuizEvent(events) {
  return events.find(event => event.type === 'quiz_published' || event.type === 'quiz_draft_created')
    || events.find(event => event.type === 'quiz_graded' || event.type === 'quiz_submitted' || event.type === 'quiz_opened')
    || null;
}

function buildActiveQuiz(events, studentCount) {
  const quizEvent = latestQuizEvent(events);
  const quizId = quizEvent?.metadata?.quizId || quizEvent?.metadata?.lessonId || null;
  const matchingEvents = quizId
    ? events.filter(event => event.metadata?.quizId === quizId || event.metadata?.lessonId === quizId)
    : events;

  const opened = uniqueIds(matchingEvents.filter(event => event.type === 'quiz_opened').map(event => event.studentId)).length;
  const submitted = uniqueIds(matchingEvents.filter(event => event.type === 'quiz_submitted' || event.type === 'quiz_graded').map(event => event.studentId)).length;
  const gradedScores = matchingEvents
    .filter(event => event.type === 'quiz_graded')
    .map(event => scorePercentFromMetadata(event.metadata))
    .filter(score => score !== null);

  return {
    quizId,
    title: quizEvent?.metadata?.quizTitle || quizEvent?.metadata?.lessonTitle || quizEvent?.metadata?.topic || null,
    status: quizEvent ? 'active' : 'not_published',
    openedCount: opened,
    submittedCount: submitted,
    pendingCount: Math.max(studentCount - submitted, 0),
    averageScorePercent: gradedScores.length
      ? Math.round(gradedScores.reduce((sum, score) => sum + score, 0) / gradedScores.length)
      : null,
  };
}

function buildLessonEngagement(events) {
  const counts = buildUsageSummary(events).byType;
  return [
    { key: 'tutor_chat', label: 'Tutor chat', count: counts.chat_message || 0 },
    { key: 'diagrams', label: 'Diagrams', count: counts.image_generated || 0 },
    { key: 'videos', label: 'Videos', count: (counts.video_recommended || 0) + (counts.video_opened || 0) + (counts.video_completed || 0) },
    { key: 'practice_quiz', label: 'Practice quiz', count: (counts.quiz_opened || 0) + (counts.quiz_submitted || 0) + (counts.quiz_graded || 0) },
  ];
}

function buildCourseProgress(events) {
  const bySubject = {};

  for (const event of events.filter(isLearningActivity)) {
    const subject = learningSubject(event);
    if (!bySubject[subject]) {
      bySubject[subject] = {
        subject,
        activityCount: 0,
        chatCount: 0,
        diagramCount: 0,
        videoCount: 0,
        quizCount: 0,
        lessonCompletedCount: 0,
        lastActiveAt: null,
        progressPercent: 0,
        nextAction: 'Ask the tutor a lesson question',
      };
    }

    const entry = bySubject[subject];
    entry.activityCount += 1;
    if (event.type === 'chat_message') entry.chatCount += 1;
    if (event.type === 'image_generated') entry.diagramCount += 1;
    if (event.type === 'video_recommended' || event.type === 'video_opened' || event.type === 'video_completed') entry.videoCount += 1;
    if (event.type === 'quiz_opened' || event.type === 'quiz_submitted' || event.type === 'quiz_graded') entry.quizCount += 1;
    if (event.type === 'lesson_completed') entry.lessonCompletedCount += 1;

    const createdAt = eventDate(event);
    if (!entry.lastActiveAt || createdAt > entry.lastActiveAt) entry.lastActiveAt = createdAt;
  }

  return Object.values(bySubject)
    .map(entry => {
      const progress = (
        Math.min(entry.chatCount, 6) * 5
        + Math.min(entry.diagramCount, 3) * 8
        + Math.min(entry.videoCount, 4) * 8
        + Math.min(entry.quizCount, 4) * 10
        + Math.min(entry.lessonCompletedCount, 3) * 12
      );
      const nextAction = entry.quizCount > 0
        ? 'Review quiz mistakes'
        : entry.videoCount > 0
          ? 'Attempt practice quiz'
          : entry.diagramCount > 0
            ? 'Watch a support video'
            : 'Ask the tutor a follow-up question';

      return {
        ...entry,
        progressPercent: Math.min(progress, 100),
        lastActiveAt: entry.lastActiveAt,
        nextAction,
      };
    })
    .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
}

function buildPracticeProgressPercent(events) {
  const scores = events
    .filter(event => event.type === 'quiz_graded')
    .map(event => scorePercentFromMetadata(event.metadata))
    .filter(value => value !== null);

  if (!scores.length) return 0;
  return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}

function buildRecentActivity(events, limit = 6) {
  return events
    .filter(isLearningActivity)
    .slice(0, limit)
    .map(event => ({
      id: event.id,
      type: event.type,
      subject: learningSubject(event),
      title: event.metadata?.quizTitle
        || event.metadata?.lessonTitle
        || event.metadata?.topic
        || event.metadata?.imageProvider
        || event.type.replaceAll('_', ' '),
      createdAt: event.createdAt,
    }));
}

function buildStudentDashboard(events, options = {}) {
  const now = options.now || new Date();
  const recentEvents = events.filter(event => isWithinDays(event, 7, now));
  const courseProgress = buildCourseProgress(events);
  const completedThisWeek = recentEvents.filter(event => event.type === 'lesson_completed' || event.type === 'quiz_submitted').length;
  const averageProgress = courseProgress.length
    ? Math.round(courseProgress.reduce((sum, item) => sum + item.progressPercent, 0) / courseProgress.length)
    : 0;

  return {
    studentId: options.studentId || null,
    learningStreakDays: buildLearningStreak(events, now),
    timeSpentSecondsThisWeek: sumActiveSeconds(events, now, 7),
    lessonsCompletedThisWeek: completedThisWeek,
    learningProgressPercent: averageProgress,
    practiceProgressPercent: buildPracticeProgressPercent(recentEvents),
    courseProgress,
    recentActivity: buildRecentActivity(events),
    weakAreas: buildWeakAreas(events),
    usageSummary: buildUsageSummary(recentEvents),
  };
}

function buildTeacherDashboard(events, studentIds, options = {}) {
  const now = options.now || new Date();
  const recentEvents = events.filter(event => isWithinDays(event, 7, now));
  const studentCount = studentIds.length;
  const usageStats = {
    totalEvents7d: recentEvents.length,
    activeStudents7d: uniqueIds(recentEvents.map(event => event.studentId)).length,
    timeSpentSeconds7d: sumActiveSeconds(recentEvents, now, 7),
    byType: buildUsageSummary(recentEvents).byType,
  };
  const activeQuiz = buildActiveQuiz(events, studentCount);
  const weakAreas = buildWeakAreas(events);
  const safetyBlocks = recentEvents.filter(event => event.type === 'safety_input_blocked' || event.type === 'safety_output_blocked').length;
  const nextActions = [];

  if (weakAreas[0]) {
    nextActions.push({
      type: 'review_weak_area',
      title: `Review ${weakAreas[0].label}`,
      detail: `${weakAreas[0].count} recent quiz signal${weakAreas[0].count === 1 ? '' : 's'} mention this area.`,
    });
  }
  if (activeQuiz.status === 'not_published') {
    nextActions.push({
      type: 'create_quiz',
      title: 'Prepare a lesson quiz',
      detail: 'No quiz has been assigned for this class yet.',
    });
  } else if (activeQuiz.pendingCount > 0) {
    nextActions.push({
      type: 'remind_pending',
      title: 'Remind pending students',
      detail: `${activeQuiz.pendingCount} student${activeQuiz.pendingCount === 1 ? '' : 's'} have not submitted the latest quiz.`,
    });
  }
  if (safetyBlocks > 0) {
    nextActions.push({
      type: 'review_safety',
      title: 'Review safety blocks',
      detail: `${safetyBlocks} blocked prompt or response event${safetyBlocks === 1 ? '' : 's'} this week.`,
    });
  }

  return {
    schoolId: options.schoolId || null,
    studentCount,
    usageStats,
    activeQuiz,
    weakAreas,
    lessonEngagement: buildLessonEngagement(recentEvents),
    recentEvents: recentEvents.slice(0, RECENT_EVENT_LIMIT).map(sanitizeEvent),
    nextActions,
  };
}

function buildParentDashboard(events, studentProfile = {}, options = {}) {
  const student = buildStudentDashboard(events, {
    studentId: studentProfile.id,
    now: options.now,
  });
  const activeQuiz = buildActiveQuiz(events, 1);

  return {
    studentId: studentProfile.id || null,
    studentName: studentProfile.name || null,
    learningStreakDays: student.learningStreakDays,
    timeSpentSecondsThisWeek: student.timeSpentSecondsThisWeek,
    lessonsCompletedThisWeek: student.lessonsCompletedThisWeek,
    assignedQuizStatus: activeQuiz.status === 'not_published'
      ? 'No quiz assigned yet'
      : activeQuiz.submittedCount > 0
        ? 'Submitted'
        : activeQuiz.openedCount > 0
          ? 'Opened'
          : 'Assigned',
    latestQuizScorePercent: activeQuiz.averageScorePercent,
    weakAreas: student.weakAreas,
    courseProgress: student.courseProgress,
    recentActivity: student.recentActivity,
  };
}

module.exports = {
  RECENT_EVENT_LIMIT,
  daysAgo,
  uniqueIds,
  sanitizeEvent,
  buildAttendanceSummary,
  buildScoreSummary,
  buildUsageSummary,
  buildSubjectTrends,
  buildStudentDashboard,
  buildTeacherDashboard,
  buildParentDashboard,
  buildWeakAreas,
};

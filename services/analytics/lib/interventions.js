function uniqueIds(ids) {
  return [...new Set(ids.filter(Boolean))];
}

function evaluateInterventionFlags(studentEvents) {
  const flags = [];

  const feedbackEvents = studentEvents.filter(e => e.type === 'feedback_submitted');
  const ratings = feedbackEvents
    .map(e => Number(e.metadata?.rating))
    .filter(r => Number.isFinite(r));

  if (ratings.length > 0) {
    const avg = ratings.reduce((sum, r) => sum + r, 0) / ratings.length;
    if (avg < 3.0) flags.push('low_feedback_rating');
  }

  const sessionIds = uniqueIds(
    studentEvents
      .filter(e => e.type === 'chat_message' && e.sessionId)
      .map(e => e.sessionId)
  );

  if (sessionIds.length < 3) flags.push('low_session_count');

  return flags;
}

function buildInterventionsForStudents(studentIds, eventsByStudent) {
  const interventions = [];

  for (const studentId of studentIds) {
    const studentEvents = eventsByStudent[studentId] || [];
    const flags = evaluateInterventionFlags(studentEvents);
    if (flags.length > 0) interventions.push({ studentId, flags });
  }

  return interventions;
}

function groupEventsByStudent(events) {
  return events.reduce((acc, event) => {
    if (!event.studentId) return acc;
    if (!acc[event.studentId]) acc[event.studentId] = [];
    acc[event.studentId].push(event);
    return acc;
  }, {});
}

module.exports = {
  evaluateInterventionFlags,
  buildInterventionsForStudents,
  groupEventsByStudent,
};

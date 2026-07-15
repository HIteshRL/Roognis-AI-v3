const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const ATTENDANCE_STATUSES = new Set(['present', 'absent', 'late', 'excused']);

const KNOWN_EVENT_TYPES = [
  'chat_message',
  'feedback_submitted',
  'image_generated',
  'image_prompt_blocked',
  'safety_input_blocked',
  'safety_output_blocked',
  'video_recommended',
  'video_opened',
  'video_completed',
  'study_time_tracked',
  'lesson_started',
  'lesson_completed',
  'quiz_draft_created',
  'quiz_published',
  'quiz_opened',
  'quiz_submitted',
  'quiz_graded',
];

function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function parseDateOnly(value) {
  if (typeof value !== 'string' || !DATE_ONLY_RE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function validateAttendanceStatus(status) {
  if (typeof status !== 'string') return null;
  const normalized = status.trim().toLowerCase();
  return ATTENDANCE_STATUSES.has(normalized) ? normalized : null;
}

function validateEventType(type) {
  if (typeof type !== 'string') return null;
  const normalized = type.trim();
  return KNOWN_EVENT_TYPES.includes(normalized) ? normalized : null;
}

function validateScorePair(score, maxScore) {
  const numericScore = Number(score);
  const numericMax = maxScore === undefined || maxScore === null ? 100 : Number(maxScore);

  if (!Number.isFinite(numericScore) || !Number.isFinite(numericMax))
    return { error: 'score and maxScore must be numbers.' };

  if (numericMax <= 0)
    return { error: 'maxScore must be greater than 0.' };

  if (numericScore < 0)
    return { error: 'score must be greater than or equal to 0.' };

  if (numericScore > numericMax)
    return { error: 'score must be less than or equal to maxScore.' };

  return { score: numericScore, maxScore: numericMax };
}

function normalizeSubject(subject) {
  if (typeof subject !== 'string') return 'general';
  const trimmed = subject.trim();
  return trimmed || 'general';
}

function normalizeOptionalString(value, maxLength) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

module.exports = {
  ATTENDANCE_STATUSES,
  KNOWN_EVENT_TYPES,
  isValidUuid,
  parseDateOnly,
  validateEventType,
  validateAttendanceStatus,
  validateScorePair,
  normalizeSubject,
  normalizeOptionalString,
};

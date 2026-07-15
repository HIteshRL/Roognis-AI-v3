const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidUuid,
  parseDateOnly,
  validateEventType,
  validateAttendanceStatus,
  validateScorePair,
} = require('../lib/validation');

describe('validation', () => {
  it('accepts valid UUIDs', () => {
    assert.equal(isValidUuid('550e8400-e29b-41d4-a716-446655440000'), true);
  });

  it('rejects invalid UUIDs', () => {
    assert.equal(isValidUuid('not-a-uuid'), false);
    assert.equal(isValidUuid(''), false);
  });

  it('parses YYYY-MM-DD dates only', () => {
    assert.ok(parseDateOnly('2026-07-09'));
    assert.equal(parseDateOnly('07/09/2026'), null);
    assert.equal(parseDateOnly('2026-13-01'), null);
  });

  it('validates attendance status values', () => {
    assert.equal(validateAttendanceStatus('present'), 'present');
    assert.equal(validateAttendanceStatus('ABSENT'), 'absent');
    assert.equal(validateAttendanceStatus('excused'), 'excused');
    assert.equal(validateAttendanceStatus('unknown'), null);
  });

  it('validates MVP analytics event types', () => {
    assert.equal(validateEventType('chat_message'), 'chat_message');
    assert.equal(validateEventType('video_recommended'), 'video_recommended');
    assert.equal(validateEventType('study_time_tracked'), 'study_time_tracked');
    assert.equal(validateEventType('quiz_graded'), 'quiz_graded');
    assert.equal(validateEventType('unknown_event'), null);
  });

  it('validates score pairs', () => {
    assert.deepEqual(validateScorePair(80, 100), { score: 80, maxScore: 100 });
    assert.ok(validateScorePair(-1, 100).error);
    assert.ok(validateScorePair(101, 100).error);
    assert.ok(validateScorePair(10, 0).error);
  });
});

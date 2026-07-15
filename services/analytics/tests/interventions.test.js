const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateInterventionFlags,
  buildInterventionsForStudents,
} = require('../lib/interventions');

describe('interventions', () => {
  it('flags assigned student with zero sessions', () => {
    const flags = evaluateInterventionFlags([]);
    assert.deepEqual(flags, ['low_session_count']);
  });

  it('flags low feedback average below 3.0', () => {
    const flags = evaluateInterventionFlags([
      { type: 'feedback_submitted', sessionId: null, metadata: { rating: 2 } },
      { type: 'feedback_submitted', sessionId: null, metadata: { rating: 2 } },
      { type: 'chat_message', sessionId: 'a', metadata: {} },
      { type: 'chat_message', sessionId: 'b', metadata: {} },
      { type: 'chat_message', sessionId: 'c', metadata: {} },
    ]);
    assert.ok(flags.includes('low_feedback_rating'));
    assert.ok(!flags.includes('low_session_count'));
  });

  it('does not flag three or more distinct sessions', () => {
    const flags = evaluateInterventionFlags([
      { type: 'chat_message', sessionId: 'a', metadata: {} },
      { type: 'chat_message', sessionId: 'b', metadata: {} },
      { type: 'chat_message', sessionId: 'c', metadata: {} },
    ]);
    assert.ok(!flags.includes('low_session_count'));
  });

  it('includes assigned students with no events', () => {
    const result = buildInterventionsForStudents(
      ['student-1', 'student-2'],
      { 'student-2': [{ type: 'chat_message', sessionId: 'x', metadata: {} }] }
    );
    assert.deepEqual(result, [
      { studentId: 'student-1', flags: ['low_session_count'] },
      { studentId: 'student-2', flags: ['low_session_count'] },
    ]);
  });
});

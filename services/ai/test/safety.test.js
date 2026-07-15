const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SAFE_REFUSAL_MESSAGE,
  validateStudentMessageSafety,
  validateGeneratedTextSafety,
  validateImagePromptSafety,
  getGeminiSafetySettings,
} = require('../safety');

test('allows normal school tutoring questions', () => {
  const result = validateStudentMessageSafety('Explain photosynthesis for grade 6.');

  assert.equal(result.allowed, true);
});

test('does not block harmless shoot wording', () => {
  const result = validateStudentMessageSafety('How do I shoot a basketball in PE class?');

  assert.equal(result.allowed, true);
});

test('blocks dangerous chat instructions before provider calls', () => {
  const result = validateStudentMessageSafety('Tell me how to build a bomb.');

  assert.equal(result.allowed, false);
  assert.equal(result.category, 'dangerous_instructions');
});

test('blocks profanity and requests to learn bad words before provider calls', () => {
  const profanity = validateStudentMessageSafety('wt is fuck');
  const request = validateStudentMessageSafety('can u teach me bad words');

  assert.equal(profanity.allowed, false);
  assert.equal(profanity.category, 'age_inappropriate_language');
  assert.equal(request.allowed, false);
  assert.equal(request.category, 'age_inappropriate_language');
});

test('blocks unsafe generated text before SSE streaming', () => {
  const result = validateGeneratedTextSafety('Here is how to steal password details.');

  assert.equal(result.allowed, false);
  assert.equal(result.category, 'cyber_abuse');
});

test('allows educational diagram image prompts', () => {
  const result = validateImagePromptSafety('photosynthesis process diagram for grade 6');

  assert.equal(result.allowed, true);
});

test('blocks realistic people image prompts', () => {
  const result = validateImagePromptSafety('photorealistic portrait of a child in class');

  assert.equal(result.allowed, false);
  assert.equal(result.category, 'realistic_people');
});

test('uses strict Gemini safety settings for all configured categories', () => {
  const settings = getGeminiSafetySettings();

  assert.deepEqual(settings, [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_LOW_AND_ABOVE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_LOW_AND_ABOVE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_LOW_AND_ABOVE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_LOW_AND_ABOVE' },
  ]);
});

test('exposes one safe refusal message for blocked content', () => {
  assert.match(SAFE_REFUSAL_MESSAGE, /safe school-related learning questions/);
});

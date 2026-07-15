const SAFE_REFUSAL_MESSAGE = 'I can only help with safe school-related learning questions. Try asking me about a topic from your class.';
const GEMINI_STRICT_SAFETY_THRESHOLD = 'BLOCK_LOW_AND_ABOVE';

function validateStudentMessageSafety(message) {
  return validateSafetyText(message, getChatSafetyRules());
}

function validateGeneratedTextSafety(text) {
  return validateSafetyText(text, getChatSafetyRules());
}

function validateImagePromptSafety(prompt) {
  return validateSafetyText(prompt, getImageSafetyRules());
}

function validateSafetyText(text, rules) {
  const normalized = normalizeForSafety(text);
  if (!normalized) {
    return { allowed: false, category: 'empty', reason: 'Empty content is not allowed.' };
  }

  for (const rule of rules) {
    if (rule.patterns.some(pattern => pattern.test(normalized))) {
      return {
        allowed: false,
        category: rule.category,
        reason: rule.reason,
      };
    }
  }

  return { allowed: true };
}

function normalizeForSafety(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function getChatSafetyRules() {
  return [
    {
      category: 'self_harm',
      reason: 'Self-harm content is not appropriate for the AI tutor.',
      patterns: [
        /\b(kill myself|end my life|suicide|self[- ]?harm|cut myself|hurt myself)\b/i,
      ],
    },
    {
      category: 'sexual_content',
      reason: 'Sexual or adult content is not appropriate for school tutoring.',
      patterns: [
        /\b(porn|nude|naked|orgasm|masturbat|blowjob|handjob|sexual roleplay|explicit sex)\b/i,
      ],
    },
    {
      category: 'age_inappropriate_language',
      reason: 'Profanity or requests to learn bad words are not appropriate for school tutoring.',
      patterns: [
        /\b(teach|learn|show|tell)\b.{0,30}\b(bad words?|curse words?|swear words?|abusive words?|dirty words?)\b/i,
        /\b(fuck|shit|bitch|asshole|bastard|motherfucker|cunt|dick|pussy)\b/i,
      ],
    },
    {
      category: 'dangerous_instructions',
      reason: 'Dangerous instructions are not allowed.',
      patterns: [
        /\bhow to\b.{0,40}\b(bomb|explosive|gun|poison|weapon|stab)\b/i,
        /\bshoot\b.{0,20}\b(someone|person|people|teacher|student|classmate)\b/i,
        /\b(make|build|create|assemble|hide)\b.{0,40}\b(bomb|explosive|gun|poison|weapon)\b/i,
        /\b(kill someone|murder|torture|behead|gore)\b/i,
      ],
    },
    {
      category: 'drugs',
      reason: 'Drug-use content is not appropriate for school tutoring.',
      patterns: [
        /\b(cocaine|heroin|meth|lsd|ecstasy|drug dealer|get high)\b/i,
      ],
    },
    {
      category: 'hate_or_harassment',
      reason: 'Hate or harassment content is not allowed.',
      patterns: [
        /\b(hate speech|racial superiority|nazi propaganda|genocide)\b/i,
      ],
    },
    {
      category: 'cyber_abuse',
      reason: 'Cyber abuse instructions are not allowed.',
      patterns: [
        /\b(hack|steal password|phishing|bypass security|credit card fraud)\b/i,
      ],
    },
  ];
}

function getImageSafetyRules() {
  return [
    ...getChatSafetyRules(),
    {
      category: 'realistic_people',
      reason: 'Image generation is limited to educational diagrams without realistic people.',
      patterns: [
        /\b(photo|photorealistic|realistic|portrait|selfie|face|person|people|child|kid|boy|girl|man|woman|celebrity|actor|actress)\b/i,
      ],
    },
    {
      category: 'brands_or_logos',
      reason: 'Brand and logo generation is not allowed for MVP educational diagrams.',
      patterns: [
        /\b(logo|brand|trademark)\b/i,
      ],
    },
  ];
}

function getGeminiSafetySettings() {
  return [
    'HARM_CATEGORY_HARASSMENT',
    'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    'HARM_CATEGORY_DANGEROUS_CONTENT',
  ].map(category => ({
    category,
    threshold: GEMINI_STRICT_SAFETY_THRESHOLD,
  }));
}

module.exports = {
  SAFE_REFUSAL_MESSAGE,
  validateStudentMessageSafety,
  validateGeneratedTextSafety,
  validateImagePromptSafety,
  getGeminiSafetySettings,
};

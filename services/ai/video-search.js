const REQUEST_WORDS = new Set([
  'can',
  'could',
  'u',
  'you',
  'i',
  'me',
  'my',
  'get',
  'give',
  'find',
  'show',
  'recommend',
  'need',
  'want',
  'please',
  'best',
  'good',
  'video',
  'videos',
  'watch',
  'youtube',
  'playlist',
  'lecture',
  'lesson',
  'lessons',
  'learn',
  'study',
  'teach',
  'explain',
  'about',
  'on',
  'for',
  'to',
  'a',
  'an',
  'the',
  'in',
  'with',
  'from',
]);

const CONNECTOR_WORDS = new Set(['of', 'and', 'or', 'the', 'a', 'an']);
const ACADEMIC_NOISE_WORDS = new Set([
  'grade',
  'class',
  'std',
  'standard',
  'chapter',
  'ch',
  'science',
  'math',
  'maths',
  'english',
  'school',
]);

const BROAD_VIDEO_PATTERNS = [
  /\bfull\s+chapter\b/i,
  /\bcomplete\s+chapter\b/i,
  /\bone\s+shot\b/i,
  /\bchapter\s+\d+\b/i,
  /\bquick\s+revision\b/i,
];

function buildVideoSearchIntent(message, subject, grade) {
  const topicText = extractVideoTopicText(message, subject);
  if (!topicText) {
    return {
      topicText: '',
      topicLabel: '',
      query: '',
      topicTerms: [],
      wantsFullChapter: false,
    };
  }

  const normalizedTopic = normalizeSearchText(topicText);
  const topicTerms = tokenizeSearchText(normalizedTopic)
    .filter(token => !CONNECTOR_WORDS.has(token))
    .filter(token => !ACADEMIC_NOISE_WORDS.has(token))
    .map(canonicalSearchToken)
    .filter(Boolean);

  const subjectHint = normalizeSearchText(subject);
  const gradeHint = grade ? `grade ${grade}` : '';
  const wantsFullChapter = /\b(full chapter|complete chapter|one shot|chapter)\b/i.test(message);
  const query = [topicText, subjectHint, gradeHint, 'school lesson']
    .filter(Boolean)
    .join(' ');

  return {
    topicText,
    topicLabel: toHumanTopicLabel(topicText),
    query,
    topicTerms: [...new Set(topicTerms)],
    grade: Number.isFinite(Number(grade)) ? Number(grade) : null,
    wantsFullChapter,
  };
}

function extractVideoTopicText(message, subject) {
  let text = normalizeSearchText(message);
  const subjectText = normalizeSearchText(subject);

  text = text
    .replace(/\b(grade|class|std|standard)\s*\d+\b/g, ' ')
    .replace(/\b(chapter|ch)\s*\d+\b/g, ' ');

  const tokens = tokenizeSearchText(text)
    .filter(token => !REQUEST_WORDS.has(token))
    .filter(token => !ACADEMIC_NOISE_WORDS.has(token))
    .filter(token => token !== subjectText)
    .filter(token => !/^\d+$/.test(token));

  const cleaned = collapseConnectors(tokens).join(' ').trim();
  return cleaned;
}

function collapseConnectors(tokens) {
  const result = [];
  for (const token of tokens) {
    if (CONNECTOR_WORDS.has(token) && (!result.length || CONNECTOR_WORDS.has(result[result.length - 1]))) {
      continue;
    }
    result.push(token);
  }
  while (result.length && CONNECTOR_WORDS.has(result[0])) result.shift();
  while (result.length && CONNECTOR_WORDS.has(result[result.length - 1])) result.pop();
  return result;
}

function rankRealtimeVideos(videos, intent, options = {}) {
  const trustedChannels = Array.isArray(options.trustedChannels) ? options.trustedChannels : [];
  const scored = videos
    .map(video => {
      const relevance = scoreVideoRelevance(video, intent, trustedChannels);
      return {
        ...video,
        qualityScore: relevance.qualityScore,
        rankingScore: relevance.rankingScore,
        topicMatchScore: relevance.topicMatchScore,
        topicMatchReason: relevance.reason,
      };
    })
    .filter(video => video.topicMatchScore >= 45)
    .sort((a, b) => b.rankingScore - a.rankingScore || b.viewCount - a.viewCount);

  return scored;
}

function scoreVideoRelevance(video, intent, trustedChannels = []) {
  const title = normalizeSearchText(video.title);
  const description = normalizeSearchText(video.description);
  const source = normalizeSearchText(video.source);
  const topicText = normalizeSearchText(intent.topicText);
  const compactTopic = compactSearchText(topicText);
  const titleCompact = compactSearchText(title);
  const titleTerms = new Set(tokenizeSearchText(title).map(canonicalSearchToken));
  const descriptionTerms = new Set(tokenizeSearchText(description).map(canonicalSearchToken));
  const topicTerms = intent.topicTerms || [];

  const titleHits = topicTerms.filter(term => titleTerms.has(term)).length;
  const descriptionHits = topicTerms.filter(term => descriptionTerms.has(term)).length;
  const titleCoverage = topicTerms.length ? titleHits / topicTerms.length : 0;
  const totalCoverage = topicTerms.length
    ? [...new Set([...topicTerms.filter(term => titleTerms.has(term)), ...topicTerms.filter(term => descriptionTerms.has(term))])].length / topicTerms.length
    : 0;

  let topicMatchScore = 0;
  const reasons = [];

  if (topicText && title.includes(topicText)) {
    topicMatchScore += 72;
    reasons.push('exact title phrase');
  } else if (compactTopic && titleCompact.includes(compactTopic)) {
    topicMatchScore += 62;
    reasons.push('compact title phrase');
  }

  topicMatchScore += Math.round(titleCoverage * 58);
  topicMatchScore += Math.round(totalCoverage * 24);
  if (titleCoverage === 1 && topicTerms.length > 1) topicMatchScore += 18;
  if (titleCoverage > 0) reasons.push(`${Math.round(titleCoverage * 100)}% title term match`);
  if (totalCoverage > titleCoverage) reasons.push('description supports topic');

  const durationSeconds = Number(video.durationSeconds || 0);
  if (durationSeconds >= 180 && durationSeconds <= 900) topicMatchScore += 6;
  if (!intent.wantsFullChapter && durationSeconds > 1500) topicMatchScore -= 12;
  if (!intent.wantsFullChapter && BROAD_VIDEO_PATTERNS.some(pattern => pattern.test(video.title || ''))) {
    topicMatchScore -= titleCoverage < 1 ? 24 : 8;
    reasons.push('broad chapter penalty');
  }
  const mentionedGrades = extractMentionedGrades(video.title);
  if (intent.grade && mentionedGrades.length) {
    if (mentionedGrades.includes(intent.grade)) {
      topicMatchScore += 8;
      reasons.push('grade match');
    } else {
      topicMatchScore -= 35;
      reasons.push('different grade penalty');
    }
  }

  const trusted = trustedChannels.some(channel => source.includes(normalizeSearchText(channel)));
  let rankingScore = topicMatchScore;
  if (trusted) rankingScore += 8;
  if (Number(video.viewCount || 0) > 100000) rankingScore += 4;
  if (durationSeconds >= 180 && durationSeconds <= 900) rankingScore += 5;

  return {
    topicMatchScore: Math.max(0, Math.min(topicMatchScore, 100)),
    rankingScore,
    qualityScore: Math.max(0, Math.min(rankingScore, 100)),
    titleCoverage,
    reason: reasons.join(', ') || 'weak topic match',
  };
}

function extractMentionedGrades(value) {
  const grades = [];
  const text = normalizeSearchText(value);
  const pattern = /\b(?:grade|class|std|standard)\s+(\d{1,2})\b/g;
  let match = pattern.exec(text);
  while (match) {
    const grade = Number(match[1]);
    if (Number.isInteger(grade)) grades.push(grade);
    match = pattern.exec(text);
  }
  return grades;
}

function normalizeSearchText(value) {
  const normalizedKnownTopics = normalizeKnownTopicSpellings(String(value || '').toLowerCase());
  return normalizedKnownTopics
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKnownTopicSpellings(value) {
  return String(value || '')
    .replace(/\bphoto\s*synth(?:e)?sis\b/g, ' photosynthesis ')
    .replace(/\bphotosynth(?:e)?sis\b/g, ' photosynthesis ')
    .replace(/\bphotosynthsis\b/g, ' photosynthesis ')
    .replace(/\bpythagor(?:a|e)?s?\s+therom\b/g, ' pythagorean theorem ')
    .replace(/\bpythagoras\s+theorem\b/g, ' pythagorean theorem ');
}

function tokenizeSearchText(value) {
  return normalizeSearchText(value).split(' ').filter(Boolean);
}

function compactSearchText(value) {
  return tokenizeSearchText(value)
    .filter(token => !CONNECTOR_WORDS.has(token))
    .map(canonicalSearchToken)
    .join(' ');
}

function canonicalSearchToken(token) {
  const normalized = normalizeSearchText(token);
  if (!normalized) return '';
  if (normalized.endsWith('ies') && normalized.length > 4) return `${normalized.slice(0, -3)}y`;
  if (/(ches|shes|sses|xes|zes)$/.test(normalized) && normalized.length > 4) return normalized.slice(0, -2);
  if (normalized.endsWith('s') && normalized.length > 3) return normalized.slice(0, -1);
  return normalized;
}

function toHumanTopicLabel(value) {
  const lowerWords = new Set(['of', 'and', 'or', 'the', 'a', 'an']);
  return tokenizeSearchText(value)
    .map((word, index) => {
      if (index > 0 && lowerWords.has(word)) return word;
      return `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
    })
    .join(' ');
}

module.exports = {
  buildVideoSearchIntent,
  rankRealtimeVideos,
  scoreVideoRelevance,
  normalizeSearchText,
  tokenizeSearchText,
  canonicalSearchToken,
};

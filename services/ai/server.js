const express = require('express');
const { PrismaClient } = require('@prisma/client');
const fs = require('fs/promises');
const path = require('path');

const {
  SAFE_REFUSAL_MESSAGE,
  validateStudentMessageSafety,
  validateGeneratedTextSafety,
  validateImagePromptSafety,
  getGeminiSafetySettings,
} = require('./safety');
const {
  buildVideoSearchIntent,
  rankRealtimeVideos,
} = require('./video-search');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3002;
const LLM_PROVIDER = normalizeProvider(process.env.LLM_PROVIDER, ['gemini', 'ollama'], 'gemini');
const IMAGE_PROVIDER = normalizeProvider(process.env.IMAGE_PROVIDER, ['gemini', 'comfyui'], 'gemini');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_API_BASE_URL = process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.1-flash-lite';
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
const GEMINI_TEXT_TIMEOUT_MS = Number(process.env.GEMINI_TEXT_TIMEOUT_MS || 30000);
const RAG_SERVICE_URL = process.env.RAG_SERVICE_URL || 'http://rag:3003';
const ANALYTICS_URL = process.env.ANALYTICS_URL || 'http://analytics:3004';
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || '';
const COMFYUI_URL = process.env.COMFYUI_URL || 'http://comfyui:8188';
const FILE_STORAGE_PATH = process.env.FILE_STORAGE_PATH || path.join(__dirname, 'storage');
const IMAGE_OUTPUT_DIR = path.join(FILE_STORAGE_PATH, 'images');
const GEMINI_IMAGE_MIME_TYPE = process.env.GEMINI_IMAGE_MIME_TYPE || 'image/jpeg';
const VIDEO_PROVIDER = normalizeProvider(process.env.VIDEO_PROVIDER, ['youtube'], 'youtube');
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const YOUTUBE_API_BASE_URL = process.env.YOUTUBE_API_BASE_URL || 'https://www.googleapis.com/youtube/v3';
const VIDEO_SEARCH_MAX_RESULTS = Math.min(Math.max(Number(process.env.VIDEO_SEARCH_MAX_RESULTS || 10), 1), 10);
const VIDEO_TRUSTED_CHANNELS = parseCsv(process.env.VIDEO_TRUSTED_CHANNELS || '');
const IMAGE_PROMPT_MAX_LENGTH = 300;
const IMAGE_JOB_TIMEOUT_MS = Number(process.env.IMAGE_JOB_TIMEOUT_MS || 5 * 60 * 1000);
const IMAGE_POLL_INTERVAL_MS = Number(process.env.IMAGE_POLL_INTERVAL_MS || 3000);
const IMAGE_TIMEOUT_CLEANUP_MS = Number(process.env.IMAGE_TIMEOUT_CLEANUP_MS || 2 * 60 * 1000);

// Auth removed. Nothing identifies the caller, so the demo runs as a single
// fixed student in a single school. These only feed analytics events and RAG
// retrieval filters, which still key on those ids as data.
const DEMO_STUDENT_ID = process.env.DEMO_STUDENT_ID || '00000000-0000-0000-0000-000000000002';
const DEMO_SCHOOL_ID = process.env.DEMO_SCHOOL_ID || '00000000-0000-0000-0000-000000000001';

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.locals.prisma = prisma;

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'ai' });
});

app.post('/api/ai/chat/session', asyncHandler(async (req, res) => {
  const subject = normalizeSubject(req.body?.subject);
  if (!subject) {
    return res.status(400).json({ error: 'subject is required and must be 1-80 characters.' });
  }
  const lessonContext = normalizeLessonContext(req.body || {});
  if (!lessonContext.ok) {
    return res.status(400).json({ error: lessonContext.error });
  }

  const session = await prisma.chatSession.create({
    data: {
      subject,
      ...lessonContext.data,
    },
    select: {
      id: true,
      subject: true,
      board: true,
      curriculum: true,
      grade: true,
      chapterNumber: true,
      chapterName: true,
    },
  });

  res.status(201).json({ sessionId: session.id, lessonContext: session });
}));

app.get('/api/ai/chat/sessions', asyncHandler(async (_req, res) => {
  const sessions = await prisma.chatSession.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      subject: true,
      board: true,
      curriculum: true,
      grade: true,
      chapterNumber: true,
      chapterName: true,
      createdAt: true,
      _count: { select: { messages: true } },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          role: true,
          content: true,
          createdAt: true,
        },
      },
    },
  });

  const ordered = sessions
    .map(session => {
      const lastMessage = session.messages[0] || null;
      return {
        sessionId: session.id,
        subject: session.subject,
        board: session.board,
        curriculum: session.curriculum,
        grade: session.grade,
        chapterNumber: session.chapterNumber,
        chapterName: session.chapterName,
        createdAt: session.createdAt,
        latestActivityAt: lastMessage?.createdAt || session.createdAt,
        messageCount: session._count.messages,
        lastMessage: lastMessage ? {
          role: lastMessage.role,
          content: lastMessage.content.slice(0, 180),
          timestamp: lastMessage.createdAt,
        } : null,
      };
    })
    .sort((a, b) => new Date(b.latestActivityAt) - new Date(a.latestActivityAt))
    .slice(0, 20);

  res.status(200).json({ sessions: ordered });
}));

app.get('/api/ai/chat/:sessionId/history', asyncHandler(async (req, res) => {
  const session = await findSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Chat session not found.' });

  const messages = await prisma.message.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      role: true,
      content: true,
      createdAt: true,
    },
  });

  res.status(200).json(messages.map(message => ({
    messageId: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.createdAt,
  })));
}));

app.post('/api/ai/chat', asyncHandler(async (req, res) => {
  const { sessionId } = req.body || {};
  const message = normalizeMessage(req.body?.message);

  if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });
  if (!message) return res.status(400).json({ error: 'message is required and must be 1-500 characters.' });

  const session = await findSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Chat session not found.' });

  const inputSafety = validateStudentMessageSafety(message);
  if (!inputSafety.allowed) {
    setSseHeaders(res);
    sendSseEvent(res, 'status', { status: 'refused' });
    sendSseEvent(res, 'token', { text: SAFE_REFUSAL_MESSAGE });
    sendSseEvent(res, 'done', '[DONE]');
    fireSafetyAnalyticsEvent('safety_input_blocked', req, {
      sessionId: session.id,
      subject: session.subject,
      category: inputSafety.category,
      reason: inputSafety.reason,
      promptLength: message.length,
    });
    return res.end();
  }

  const history = await loadRecentHistory(session.id);
  const userMessage = await prisma.message.create({
    data: {
      sessionId: session.id,
      role: 'user',
      content: message,
    },
    select: { id: true },
  });

  setSseHeaders(res);
  sendSseEvent(res, 'status', { status: 'loading' });

  const streamController = new AbortController();
  let clientClosed = false;
  res.on('close', () => {
    clientClosed = true;
    streamController.abort();
  });

  try {
    const videoRecommendation = await findVideoRecommendationForMessage(message, session);
    if (videoRecommendation) {
      const assistantContent = buildVideoRecommendationContent(videoRecommendation);
      if (videoRecommendation.videos.length) {
        sendSseEvent(res, 'video_recommendations', buildVideoRecommendationPayload(videoRecommendation));
      }
      await streamTextAsSse(assistantContent, res, () => clientClosed);

      if (clientClosed) return;

      const assistantMessage = await prisma.message.create({
        data: {
          sessionId: session.id,
          role: 'assistant',
          content: assistantContent,
        },
        select: { id: true },
      });

      fireAnalyticsEvent({
        type: 'video_recommended',
        studentId: DEMO_STUDENT_ID,
        schoolId: DEMO_SCHOOL_ID,
        subject: session.subject,
        sessionId: session.id,
        metadata: {
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
          topic: videoRecommendation.topic.topic,
          videoIds: videoRecommendation.videos.map(video => video.id),
          provider: videoRecommendation.provider,
          resultCount: videoRecommendation.videos.length,
          unavailableReason: videoRecommendation.unavailableReason,
        },
      });

      sendSseEvent(res, 'done', '[DONE]');
      return res.end();
    }

    const chunks = await retrieveRagChunks({
      q: message,
      schoolId: DEMO_SCHOOL_ID,
      subject: session.subject,
      board: session.board,
      curriculum: session.curriculum,
      grade: session.grade,
      chapterNumber: session.chapterNumber,
      top: 5,
    });
    sendSseEvent(res, 'answer_context', {
      source: chunks.length ? 'rag' : 'general',
      ragChunkCount: chunks.length,
      subject: session.subject,
      grade: session.grade,
      chapterNumber: session.chapterNumber,
    });

    const prompt = buildTutorPrompt({
      chunks,
      history,
      question: message,
      session,
    });

    const llmResult = await streamLlmResponse({
      prompt,
      res,
      signal: streamController.signal,
      isClientClosed: () => clientClosed,
    });

    if (clientClosed) return;

    if (llmResult.safetyBlocked) {
      fireSafetyAnalyticsEvent('safety_output_blocked', req, {
        sessionId: session.id,
        subject: session.subject,
        category: llmResult.safety?.category,
        reason: llmResult.safety?.reason,
        outputLength: llmResult.originalContentLength,
      });
    }

    const assistantContent = llmResult.content;
    const finalAssistantContent = assistantContent.trim() || "I don't have information on that yet.";
    const assistantMessage = await prisma.message.create({
      data: {
        sessionId: session.id,
        role: 'assistant',
        content: finalAssistantContent,
      },
      select: { id: true },
    });

    fireAnalyticsEvent({
      type: 'chat_message',
      studentId: DEMO_STUDENT_ID,
      schoolId: DEMO_SCHOOL_ID,
      subject: session.subject,
      sessionId: session.id,
      metadata: {
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        messageLength: message.length,
        ragChunkCount: chunks.length,
      },
    });

    sendSseEvent(res, 'done', '[DONE]');
    res.end();
  } catch (err) {
    if (clientClosed) return;

    console.error('[ai] chat stream error:', err);
    sendSseEvent(res, 'error', { error: buildChatClientError(err) });
    sendSseEvent(res, 'done', '[DONE]');
    res.end();
  }
}));

app.get('/api/ai/video/topics', (_req, res) => {
  res.status(200).json([]);
});

app.get('/api/ai/video/:topic', (req, res) => {
  res.status(410).json({
    error: 'Static video topics are disabled. Ask the tutor chat for a real-time video recommendation.',
  });
});

app.post('/api/ai/feedback', asyncHandler(async (req, res) => {
  const { messageId, sessionId } = req.body || {};
  const rating = Number(req.body?.rating);
  const comment = normalizeOptionalComment(req.body?.comment);

  if (!messageId) return res.status(400).json({ error: 'messageId is required.' });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'rating must be an integer from 1 to 5.' });
  }
  if (comment === false) {
    return res.status(400).json({ error: 'comment must be a string up to 1000 characters.' });
  }

  const message = await prisma.message.findFirst({
    where: {
      id: messageId,
      role: 'assistant',
    },
    select: {
      id: true,
      sessionId: true,
      session: {
        select: {
          id: true,
          subject: true,
        },
      },
    },
  });

  if (!message) return res.status(404).json({ error: 'Assistant message not found.' });
  if (sessionId && sessionId !== message.sessionId) {
    return res.status(400).json({ error: 'sessionId does not match message session.' });
  }

  const feedback = await prisma.feedback.create({
    data: {
      messageId: message.id,
      rating,
      comment: comment || null,
    },
    select: { id: true },
  });

  fireAnalyticsEvent({
    type: 'feedback_submitted',
    studentId: DEMO_STUDENT_ID,
    schoolId: DEMO_SCHOOL_ID,
    subject: message.session.subject,
    sessionId: message.session.id,
    metadata: {
      messageId: message.id,
      feedbackId: feedback.id,
      rating,
      hasComment: Boolean(comment),
    },
  });

  res.status(201).json({ feedbackId: feedback.id });
}));

app.post('/api/ai/image', asyncHandler(async (req, res) => {
  const prompt = normalizeImagePrompt(req.body?.prompt);
  if (!prompt) {
    return res.status(400).json({ error: `prompt is required and must be 1-${IMAGE_PROMPT_MAX_LENGTH} characters.` });
  }

  const promptSafety = validateImagePromptSafety(prompt);
  if (!promptSafety.allowed) {
    fireSafetyAnalyticsEvent('image_prompt_blocked', req, {
      category: promptSafety.category,
      reason: promptSafety.reason,
      promptLength: prompt.length,
    });
    return res.status(400).json({ error: SAFE_REFUSAL_MESSAGE });
  }

  const job = await prisma.imageJob.create({
    data: {
      prompt,
      status: 'queued',
    },
    select: {
      id: true,
      status: true,
    },
  });

  runImageJobInBackground(job.id);

  res.status(202).json({
    jobId: job.id,
    status: job.status,
  });
}));

app.get('/api/ai/image/:jobId/status', asyncHandler(async (req, res) => {
  if (!isValidUuid(req.params.jobId)) {
    return res.status(404).json({ error: 'Image job not found.' });
  }

  const job = await prisma.imageJob.findFirst({
    where: {
      id: req.params.jobId,
    },
    select: {
      id: true,
      status: true,
      imageUrl: true,
      failureReason: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!job) return res.status(404).json({ error: 'Image job not found.' });

  res.status(200).json({
    jobId: job.id,
    status: job.status,
    imageUrl: job.imageUrl,
    failureReason: job.failureReason,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });
}));

app.get('/api/ai/images/:filename', asyncHandler(async (req, res) => {
  const filename = req.params.filename;
  if (!isValidImageFilename(filename)) {
    return res.status(404).json({ error: 'Image not found.' });
  }

  const jobId = extractImageJobId(filename);
  const job = await prisma.imageJob.findFirst({
    where: {
      id: jobId,
      status: 'done',
    },
    select: {
      id: true,
    },
  });

  if (!job) return res.status(404).json({ error: 'Image not found.' });

  const imagePath = path.join(IMAGE_OUTPUT_DIR, filename);
  try {
    const image = await fs.readFile(imagePath);
    res.type(getImageResponseType(filename)).status(200).send(image);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Image not found.' });
    throw err;
  }
}));

app.use('/api/ai', (_req, res) => {
  res.status(404).json({ error: 'AI endpoint not implemented yet.' });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  console.error('[ai] unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`[ai] Service running on :${PORT}`);
});

const imageTimeoutTimer = setInterval(() => {
  cleanupStaleImageJobs().catch(err => {
    console.warn('[ai] image timeout cleanup failed:', err.message);
  });
}, IMAGE_TIMEOUT_CLEANUP_MS);
imageTimeoutTimer.unref?.();

async function shutdown(signal) {
  console.log(`[ai] ${signal} received. Shutting down...`);
  clearInterval(imageTimeoutTimer);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function normalizeProvider(provider, allowedProviders, fallbackProvider) {
  const normalized = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  if (allowedProviders.includes(normalized)) return normalized;
  return fallbackProvider;
}

function normalizeSubject(subject) {
  if (typeof subject !== 'string') return null;
  const trimmed = subject.trim();
  if (!trimmed || trimmed.length > 80) return null;
  return trimmed;
}

function normalizeLessonContext(body) {
  const board = normalizeOptionalText(body.board, 40, 'board');
  if (board === false) return { ok: false, error: 'board must be a string up to 40 characters.' };

  const curriculum = normalizeOptionalText(body.curriculum, 80, 'curriculum');
  if (curriculum === false) return { ok: false, error: 'curriculum must be a string up to 80 characters.' };

  const chapterName = normalizeOptionalText(body.chapterName, 160, 'chapterName');
  if (chapterName === false) return { ok: false, error: 'chapterName must be a string up to 160 characters.' };

  const grade = normalizeOptionalInteger(body.grade, 1, 12);
  if (grade === false) return { ok: false, error: 'grade must be an integer from 1 to 12.' };

  const chapterNumber = normalizeOptionalInteger(body.chapterNumber, 1, 500);
  if (chapterNumber === false) return { ok: false, error: 'chapterNumber must be a positive integer.' };

  return {
    ok: true,
    data: {
      board,
      curriculum,
      grade,
      chapterNumber,
      chapterName,
    },
  };
}

function normalizeOptionalText(value, maxLength) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) return false;
  return trimmed;
}

function normalizeOptionalInteger(value, min, max) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) return false;
  return numeric;
}

function normalizeMessage(message) {
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 500) return null;
  return trimmed;
}

function normalizeOptionalComment(comment) {
  if (comment == null) return null;
  if (typeof comment !== 'string') return false;
  const trimmed = comment.trim();
  if (trimmed.length > 1000) return false;
  return trimmed || null;
}

function normalizeImagePrompt(prompt) {
  if (typeof prompt !== 'string') return null;
  const trimmed = prompt.trim();
  if (!trimmed || trimmed.length > IMAGE_PROMPT_MAX_LENGTH) return null;
  return trimmed;
}

async function findVideoRecommendationForMessage(message, session) {
  if (!isVideoRequest(message)) return null;

  const subject = session?.subject || 'General';
  const grade = session?.grade || null;
  const intent = buildVideoSearchIntent(message, subject, grade);
  if (!intent.query) {
    return buildUnavailableVideoRecommendation(
      'lesson video',
      'Ask for a clear school topic, for example "photosynthesis" or "physical and chemical changes".',
      subject,
      grade
    );
  }

  if (VIDEO_PROVIDER === 'youtube') {
    return searchYoutubeVideoRecommendation(intent, subject, grade);
  }

  return buildUnavailableVideoRecommendation(intent.topicText || intent.query, 'Real-time video search provider is not configured.', subject, grade);
}

function isVideoRequest(message) {
  return /\b(video|videos|watch|youtube|playlist|lecture)\b/i.test(message);
}

const VIDEO_STOP_WORDS = new Set([
  'can',
  'u',
  'you',
  'get',
  'give',
  'find',
  'show',
  'recommend',
  'me',
  'video',
  'videos',
  'watch',
  'learn',
  'study',
  'for',
  'of',
  'the',
  'a',
  'an',
  'and',
  'or',
  'in',
  'with',
  'from',
  'to',
  'on',
  'about',
  'please',
  'best',
]);

async function searchYoutubeVideoRecommendation(intent, subject, grade) {
  if (!YOUTUBE_API_KEY) {
    return buildUnavailableVideoRecommendation(
      intent.topicText || intent.query,
      'YouTube real-time search is not configured yet. Add YOUTUBE_API_KEY to enable live video lookup.',
      subject,
      grade
    );
  }

  try {
    const params = new URLSearchParams({
      part: 'snippet',
      q: intent.query,
      type: 'video',
      maxResults: String(VIDEO_SEARCH_MAX_RESULTS),
      safeSearch: 'strict',
      videoCategoryId: '27',
      relevanceLanguage: 'en',
      order: 'relevance',
      key: YOUTUBE_API_KEY,
    });

    const searchResult = await fetchJsonWithTimeout(
      `${YOUTUBE_API_BASE_URL}/search?${params.toString()}`,
      { method: 'GET' },
      10000
    );

    const rawItems = Array.isArray(searchResult?.items) ? searchResult.items : [];
    const candidateItems = rawItems.filter(isUsableYoutubeSearchItem);
    const detailById = await loadYoutubeVideoDetails(candidateItems.map(item => item.id.videoId));
    const candidateVideos = candidateItems
      .map(item => toRealtimeYoutubeVideo(item, detailById.get(item.id.videoId)))
      .filter(Boolean)
      .filter(video => isTrustedVideoResult(video));
    const videos = rankRealtimeVideos(candidateVideos, intent, {
      trustedChannels: VIDEO_TRUSTED_CHANNELS,
    })
      .slice(0, 2);

    if (!videos.length) {
      return buildUnavailableVideoRecommendation(
        intent.topicText || intent.query,
        VIDEO_TRUSTED_CHANNELS.length
          ? 'No safe result from trusted education channels matched this topic closely enough.'
          : 'No safe education video result matched this topic closely enough.',
        subject,
        grade
      );
    }

    return {
      provider: 'youtube',
      query: intent.query,
      topic: {
        topic: slugifyTopic(intent.topicText),
        label: intent.topicLabel || toTitleCase(intent.topicText),
        subject: subject || 'General',
        gradeLevel: grade || null,
        description: 'Real-time safe-search video recommendation from YouTube.',
      },
      videos,
    };
  } catch (err) {
    console.warn('[ai] real-time video search failed:', err.message);
    return buildUnavailableVideoRecommendation(intent.topicText || intent.query, 'Real-time video search failed. Please try again.', subject, grade);
  }
}

async function loadYoutubeVideoDetails(videoIds) {
  const uniqueIds = [...new Set(videoIds)].filter(Boolean);
  if (!uniqueIds.length) return new Map();

  const params = new URLSearchParams({
    part: 'contentDetails,statistics,status',
    id: uniqueIds.join(','),
    key: YOUTUBE_API_KEY,
  });

  const result = await fetchJsonWithTimeout(
    `${YOUTUBE_API_BASE_URL}/videos?${params.toString()}`,
    { method: 'GET' },
    10000
  );

  const detailById = new Map();
  for (const item of result?.items || []) {
    if (item?.id) detailById.set(item.id, item);
  }
  return detailById;
}

function isUsableYoutubeSearchItem(item) {
  const videoId = item?.id?.videoId;
  const snippet = item?.snippet;
  if (!videoId || !snippet?.title || !snippet?.channelTitle) return false;

  const titleSafety = validateGeneratedTextSafety(snippet.title);
  const descriptionSafety = validateGeneratedTextSafety(snippet.description || '');
  return titleSafety.allowed && descriptionSafety.allowed;
}

function toRealtimeYoutubeVideo(item, details) {
  const videoId = item?.id?.videoId;
  const snippet = item?.snippet;
  if (!videoId || !snippet) return null;

  const embeddable = details?.status?.embeddable;
  if (embeddable === false) return null;

  const durationSeconds = parseYoutubeDuration(details?.contentDetails?.duration);
  const viewCount = Number(details?.statistics?.viewCount || 0);
  const title = decodeHtmlEntities(snippet.title);
  const source = decodeHtmlEntities(snippet.channelTitle);
  const description = decodeHtmlEntities(snippet.description || '');

  return {
    id: `youtube-${videoId}`,
    providerVideoId: videoId,
    title,
    source,
    description,
    sourceType: 'youtube_realtime',
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    thumbnailUrl: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || null,
    durationSeconds,
    viewCount,
    language: 'English',
    ageBand: 'school',
    qualityScore: 0,
    reviewStatus: 'provider_safe_search',
  };
}

function isTrustedVideoResult(video) {
  if (!VIDEO_TRUSTED_CHANNELS.length) return true;
  const source = normalizeSearchText(video.source);
  return VIDEO_TRUSTED_CHANNELS.some(channel => source.includes(normalizeSearchText(channel)));
}

function scoreRealtimeVideo({ source, viewCount, durationSeconds }) {
  let score = 70;
  if (VIDEO_TRUSTED_CHANNELS.some(channel => normalizeSearchText(source).includes(normalizeSearchText(channel)))) {
    score += 15;
  }
  if (viewCount > 100000) score += 8;
  if (durationSeconds && durationSeconds >= 120 && durationSeconds <= 900) score += 7;
  return Math.min(score, 100);
}

function buildUnavailableVideoRecommendation(query, reason, subject, grade = null) {
  return {
    provider: VIDEO_PROVIDER,
    query,
    unavailableReason: reason,
    topic: {
      topic: slugifyTopic(query),
      label: toTitleCase(removeSearchSuffix(query, subject)),
      subject: subject || 'General',
      gradeLevel: grade || null,
      description: 'Real-time video search did not return a safe result.',
    },
    videos: [],
  };
}

function removeSearchSuffix(query, subject) {
  const suffixes = ['school lesson'];
  if (subject) suffixes.push(normalizeSearchText(subject));
  let cleaned = normalizeSearchText(query);
  for (const suffix of suffixes) {
    cleaned = cleaned.replace(new RegExp(`\\b${escapeRegExp(suffix)}\\b`, 'g'), ' ');
  }
  return cleaned.replace(/\s+/g, ' ').trim() || query;
}

function buildVideoRecommendationContent(recommendation) {
  if (!recommendation.videos.length) {
    return `I could not find a safe real-time video for ${recommendation.topic.label || 'that topic'}.\n\n${recommendation.unavailableReason}`;
  }

  const [primary, secondary] = recommendation.videos;
  const lines = [
    `I found safe real-time video results for ${recommendation.topic.label}.`,
    '',
    `Best pick: ${primary.title}`,
    `Source: ${primary.source}`,
  ];

  if (secondary) {
    lines.push('', `Also useful: ${secondary.title}`, `Source: ${secondary.source}`);
  }

  lines.push('', 'Open the video card below. I also added this recommendation to the Videos tab.');
  return lines.join('\n');
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeSearchText(value) {
  return normalizeSearchText(value).split(' ').filter(Boolean);
}

function buildVideoRecommendationPayload(recommendation) {
  return {
    topic: {
      topic: recommendation.topic.topic,
      label: recommendation.topic.label,
      subject: recommendation.topic.subject,
      gradeLevel: recommendation.topic.gradeLevel,
      description: recommendation.topic.description,
    },
    videos: recommendation.videos.map(toPublicVideo),
  };
}

function toPublicVideo(video) {
  return {
    id: video.id,
    title: video.title,
    source: video.source,
    url: video.url,
    thumbnailUrl: video.thumbnailUrl,
    durationSeconds: video.durationSeconds,
    qualityScore: video.qualityScore,
    reviewStatus: video.reviewStatus,
  };
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseYoutubeDuration(duration) {
  if (typeof duration !== 'string') return null;
  const match = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function slugifyTopic(value) {
  return normalizeSearchText(value)
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '') || 'video-search';
}

function toTitleCase(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map(word => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ') || 'Video Search';
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runImageJobInBackground(jobId) {
  setImmediate(() => {
    processImageJob(jobId).catch(err => {
      console.error(`[ai] image job ${jobId} failed unexpectedly:`, err);
    });
  });
}

async function processImageJob(jobId) {
  const claimed = await prisma.imageJob.updateMany({
    where: {
      id: jobId,
      status: 'queued',
    },
    data: {
      status: 'processing',
      failureReason: null,
    },
  });

  if (claimed.count !== 1) return;

  const job = await prisma.imageJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      prompt: true,
    },
  });

  if (!job) return;

  try {
    await fs.mkdir(IMAGE_OUTPUT_DIR, { recursive: true });

    const image = await generateImage(job);
    const filename = `${job.id}.${getImageFileExtension()}`;
    const imageUrl = `/api/ai/images/${filename}`;

    await fs.writeFile(path.join(IMAGE_OUTPUT_DIR, filename), image);

    await prisma.imageJob.update({
      where: { id: job.id },
      data: {
        status: 'done',
        imageUrl,
        failureReason: null,
      },
    });

    fireAnalyticsEvent({
      type: 'image_generated',
      studentId: DEMO_STUDENT_ID,
      schoolId: DEMO_SCHOOL_ID,
      metadata: {
        jobId: job.id,
        imageProvider: IMAGE_PROVIDER,
        promptLength: job.prompt.length,
      },
    });
  } catch (err) {
    console.warn(`[ai] image job ${job.id} failed:`, err.message);
    await prisma.imageJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        failureReason: buildImageFailureReason(err),
      },
    }).catch(updateErr => {
      console.warn(`[ai] image job ${job.id} failure update failed:`, updateErr.message);
    });
  }
}

async function generateImage(job) {
  if (IMAGE_PROVIDER === 'gemini') {
    return generateGeminiImage(job.prompt);
  }

  const promptId = await submitComfyPrompt(job.prompt, job.id);
  const outputImage = await waitForComfyOutput(promptId);
  return downloadComfyImage(outputImage);
}

async function generateGeminiImage(prompt) {
  ensureGeminiApiKey('image generation');

  const response = await fetchJsonWithTimeout(
    `${GEMINI_API_BASE_URL}/interactions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        model: GEMINI_IMAGE_MODEL,
        input: [
          {
            type: 'text',
            text: buildGeminiImagePrompt(prompt),
          },
        ],
        response_format: {
          type: 'image',
          mime_type: GEMINI_IMAGE_MIME_TYPE,
          aspect_ratio: '1:1',
          image_size: '1K',
        },
      }),
    },
    IMAGE_JOB_TIMEOUT_MS
  );

  const imageData = extractGeminiImageData(response);
  if (!imageData) throw new Error('Gemini did not return image data.');

  return decodeBase64Image(imageData);
}

function buildGeminiImagePrompt(prompt) {
  return [
    'Create a clear educational diagram for a school student.',
    `Topic: ${prompt}`,
    'Use a colorful, simple, textbook-friendly visual style.',
    'Make the main concept visually obvious.',
    'Avoid distracting decorative elements, unsafe content, watermarks, and brand logos.',
  ].join('\n');
}

function extractGeminiImageData(response) {
  if (typeof response?.output_image?.data === 'string') return response.output_image.data;
  if (typeof response?.outputImage?.data === 'string') return response.outputImage.data;

  const seen = new Set();
  const queue = [response];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);

    const mimeType = current.mime_type || current.mimeType || '';
    if (
      typeof current.data === 'string' &&
      (current.type === 'image' || String(mimeType).startsWith('image/'))
    ) {
      return current.data;
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }

  return null;
}

function decodeBase64Image(imageData) {
  const base64 = imageData.includes(',') ? imageData.split(',').pop() : imageData;
  return Buffer.from(base64, 'base64');
}

async function submitComfyPrompt(prompt, jobId) {
  const response = await fetchJsonWithTimeout(
    `${COMFYUI_URL}/api/prompt`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildComfyWorkflow(prompt, jobId)),
    },
    10000
  );

  const promptId = response?.prompt_id;
  if (!promptId) throw new Error('ComfyUI did not return a prompt_id.');
  return promptId;
}

function buildComfyWorkflow(prompt, jobId) {
  return {
    prompt: {
      '4': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: 'v1-5-pruned-emaonly.ckpt' },
      },
      '5': {
        class_type: 'EmptyLatentImage',
        inputs: { width: 512, height: 512, batch_size: 1 },
      },
      '6': {
        class_type: 'CLIPTextEncode',
        inputs: {
          clip: ['4', 1],
          text: `${prompt}, educational, colorful, diagram style`,
        },
      },
      '7': {
        class_type: 'CLIPTextEncode',
        inputs: {
          clip: ['4', 1],
          text: 'ugly, blurry, nsfw, text, watermark, low quality',
        },
      },
      '3': {
        class_type: 'KSampler',
        inputs: {
          model: ['4', 0],
          positive: ['6', 0],
          negative: ['7', 0],
          latent_image: ['5', 0],
          seed: 42,
          steps: 20,
          cfg: 7,
          sampler_name: 'euler',
          scheduler: 'normal',
          denoise: 1,
        },
      },
      '8': {
        class_type: 'VAEDecode',
        inputs: { samples: ['3', 0], vae: ['4', 2] },
      },
      '9': {
        class_type: 'SaveImage',
        inputs: {
          filename_prefix: `roognis_${jobId}`,
          images: ['8', 0],
        },
      },
    },
  };
}

async function waitForComfyOutput(promptId) {
  const deadline = Date.now() + IMAGE_JOB_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const history = await fetchJsonWithTimeout(
      `${COMFYUI_URL}/history/${encodeURIComponent(promptId)}`,
      { method: 'GET' },
      10000
    );
    const image = findComfyOutputImage(history, promptId);
    if (image) return image;
    await sleep(IMAGE_POLL_INTERVAL_MS);
  }

  throw new Error('Image generation timed out.');
}

function findComfyOutputImage(history, promptId) {
  const promptHistory = history?.[promptId] || history;
  const outputs = promptHistory?.outputs;
  if (!outputs || typeof outputs !== 'object') return null;

  for (const output of Object.values(outputs)) {
    if (!Array.isArray(output?.images)) continue;
    const image = output.images.find(item => typeof item?.filename === 'string');
    if (image) return image;
  }

  return null;
}

async function downloadComfyImage(image) {
  if (!image?.filename) throw new Error('ComfyUI output image is missing a filename.');

  const params = new URLSearchParams({
    filename: image.filename,
    type: image.type || 'output',
  });
  if (image.subfolder) params.set('subfolder', image.subfolder);

  return fetchBufferWithTimeout(`${COMFYUI_URL}/view?${params.toString()}`, 30000);
}

async function cleanupStaleImageJobs() {
  const cutoff = new Date(Date.now() - IMAGE_JOB_TIMEOUT_MS);
  const result = await prisma.imageJob.updateMany({
    where: {
      status: 'processing',
      updatedAt: {
        lt: cutoff,
      },
    },
    data: {
      status: 'failed',
      failureReason: 'Image generation timed out.',
    },
  });

  if (result.count > 0) {
    console.warn(`[ai] marked ${result.count} stale image job(s) as failed`);
  }
}

function buildImageFailureReason(err) {
  if (err?.name === 'AbortError') return 'Image generation service timed out.';
  const message = typeof err?.message === 'string' ? err.message : '';
  if (!message) return 'Image generation failed.';
  const normalized = message.toLowerCase();
  if (normalized.includes('quota') || normalized.includes('429') || normalized.includes('too_many_requests')) {
    return 'Gemini image quota is exhausted for this project. Try again after quota resets or switch IMAGE_PROVIDER to another configured provider.';
  }
  if (normalized.includes('mime_type') || normalized.includes('response_format')) {
    return 'Image provider rejected the requested output format.';
  }
  if (message.length > 500) return `${message.slice(0, 497)}...`;
  return message;
}

function buildChatClientError(err) {
  const message = typeof err?.message === 'string' ? err.message : '';
  const normalized = message.toLowerCase();

  if (normalized.includes('timed out')) {
    return 'AI provider timed out. Please try again.';
  }
  if (normalized.includes('quota') || normalized.includes('429')) {
    return 'AI provider quota is exhausted for now.';
  }
  if (normalized.includes('503') || normalized.includes('unavailable')) {
    return 'AI provider is temporarily busy. Please try again.';
  }

  return 'AI response failed. Please try again.';
}

function getImageFileExtension() {
  if (IMAGE_PROVIDER === 'gemini' && GEMINI_IMAGE_MIME_TYPE === 'image/jpeg') return 'jpg';
  return 'png';
}

function getImageResponseType(filename) {
  return /\.(jpe?g)$/i.test(filename) ? 'jpeg' : 'png';
}

function extractImageJobId(filename) {
  return filename.replace(/\.(png|jpe?g)$/i, '');
}

function isValidImageFilename(filename) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g)$/i.test(filename);
}

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Auth removed: there is no caller identity to check ownership against, so this
// looks the session up by id alone. Any caller can reach any session.
async function findSession(sessionId) {
  if (!sessionId) return null;
  return prisma.chatSession.findFirst({
    where: {
      id: sessionId,
    },
    select: {
      id: true,
      subject: true,
      board: true,
      curriculum: true,
      grade: true,
      chapterNumber: true,
      chapterName: true,
    },
  });
}

async function loadRecentHistory(sessionId) {
  const messages = await prisma.message.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      role: true,
      content: true,
      createdAt: true,
    },
  });

  return messages.reverse();
}

async function retrieveRagChunks({ q, schoolId, subject, board, curriculum, grade, chapterNumber, top }) {
  const params = new URLSearchParams({
    q,
    schoolId,
    subject,
    top: String(top),
  });
  if (board) params.set('board', board);
  if (curriculum) params.set('curriculum', curriculum);
  if (grade) params.set('grade', String(grade));
  if (chapterNumber) params.set('chapterNumber', String(chapterNumber));

  try {
    const response = await fetchJsonWithTimeout(
      `${RAG_SERVICE_URL}/api/rag/retrieve?${params.toString()}`,
      { method: 'GET' },
      5000
    );
    const chunks = Array.isArray(response) ? response : response?.chunks;
    if (!Array.isArray(chunks)) return [];

    return chunks
      .map(chunk => ({
        text: typeof chunk?.text === 'string' ? chunk.text.trim() : '',
        source: typeof chunk?.source === 'string' ? chunk.source : 'unknown',
        score: chunk?.score,
      }))
      .filter(chunk => chunk.text)
      .slice(0, top);
  } catch (err) {
    console.warn('[ai] RAG retrieve failed, continuing without chunks:', err.message);
    return [];
  }
}

function buildTutorPrompt({ chunks, history, question, session }) {
  const hasChunks = chunks.length > 0;
  const ragContext = hasChunks
    ? chunks.map((chunk, index) => `[${index + 1}] ${chunk.text} (source: ${chunk.source})`).join('\n\n')
    : 'No retrieved textbook context is available for this question yet.';

  const historyText = history.length
    ? history.map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`).join('\n')
    : 'No previous conversation.';
  const lessonContext = formatLessonContextForPrompt(session);

  const noContextRule = hasChunks
    ? [
        '- Use the provided context first.',
        '- If the context does not fully answer a normal school-learning question, you may add brief general curriculum knowledge.',
        '- Do not claim that unsupported general knowledge came from the provided context.',
      ].join('\n')
    : [
        '- No textbook context was retrieved yet, so answer only if this is a normal school-learning question.',
        '- Use age-appropriate general curriculum knowledge for school topics.',
        '- If the question is not a school-learning question or you are unsure, say: "I do not have information on that yet."',
      ].join('\n');

  return `You are Roognis, an AI tutor for school students.
Rules:
${noContextRule}
- Be clear, useful, and respectful. Do not sound babyish.
- Match the student's level when they mention a grade or class. If no grade is given, assume middle-school to early high-school depth.
- Use correct academic terms, then explain them in plain language.
- Never make up facts.
- Use short paragraphs, numbered steps, and bullet lists when useful.
- Do not show raw Markdown symbols such as **bold**, leading asterisks, or LaTeX dollar signs.
- Teach like a strong school tutor: practical, accurate, and easy to revise from.
- For concept questions, use this flow:
  1. Start with a direct answer in 1 to 2 sentences.
  2. Explain the important idea or formula, including what each term means.
  3. Give a concrete example or worked example.
  4. Add a common mistake or exam tip when it helps.
  5. End with one short practice question only when it is useful.
- Keep the answer easy to scan. Avoid long paragraphs.
- For one-word or unclear questions, ask one focused follow-up instead of giving a childish generic answer.

Lesson context:
${lessonContext}

Context:
${ragContext}

Conversation so far:
${historyText}

Student question:
${question}`;
}

function formatLessonContextForPrompt(session) {
  const parts = [
    session?.subject ? `Subject: ${session.subject}` : null,
    session?.grade ? `Grade: ${session.grade}` : null,
    session?.chapterNumber ? `Chapter: ${session.chapterNumber}` : null,
    session?.chapterName ? `Chapter name: ${session.chapterName}` : null,
    session?.board ? `Board: ${session.board}` : null,
    session?.curriculum ? `Curriculum: ${session.curriculum}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join('\n') : 'No explicit lesson context was selected.';
}

function setSseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

function sendSseEvent(res, event, data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  res.write(`event: ${event}\n`);
  res.write(`data: ${payload}\n\n`);
}

async function streamLlmResponse({ prompt, res, signal, isClientClosed }) {
  if (LLM_PROVIDER === 'gemini') {
    return streamGeminiResponse({ prompt, res, signal, isClientClosed });
  }

  return streamOllamaResponse({ prompt, res, signal, isClientClosed });
}

async function streamGeminiResponse({ prompt, res, signal, isClientClosed }) {
  const geminiResult = await generateGeminiTextResponse({ prompt, signal });

  if (geminiResult.safetyBlocked) {
    const content = await streamTextAsSse(SAFE_REFUSAL_MESSAGE, res, isClientClosed);
    return {
      content,
      safetyBlocked: true,
      safety: geminiResult.safety,
      originalContentLength: geminiResult.originalContentLength,
    };
  }

  const outputSafety = validateGeneratedTextSafety(geminiResult.content);
  if (!outputSafety.allowed) {
    const content = await streamTextAsSse(SAFE_REFUSAL_MESSAGE, res, isClientClosed);
    return {
      content,
      safetyBlocked: true,
      safety: outputSafety,
      originalContentLength: geminiResult.content.length,
    };
  }

  const content = await streamTextAsSse(geminiResult.content, res, isClientClosed);
  return {
    content,
    safetyBlocked: false,
  };
}

async function generateGeminiTextResponse({ prompt, signal }) {
  ensureGeminiApiKey('chat completion');

  const model = normalizeGeminiModelName(GEMINI_TEXT_MODEL);
  const requestAbort = new AbortController();
  const timeout = setTimeout(() => requestAbort.abort(new Error('Gemini request timed out.')), GEMINI_TEXT_TIMEOUT_MS);
  const abortFromClient = () => requestAbort.abort(signal.reason);
  if (signal?.aborted) {
    abortFromClient();
  } else {
    signal?.addEventListener('abort', abortFromClient, { once: true });
  }

  const request = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
      },
      safetySettings: getGeminiSafetySettings(),
    }),
    signal: requestAbort.signal,
  };

  let response;
  try {
    response = await fetchGeminiWithRetry(
      `${GEMINI_API_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`,
      request
    );
  } catch (err) {
    if (requestAbort.signal.aborted && !signal?.aborted) {
      throw new Error('Gemini request timed out. Please try again.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.('abort', abortFromClient);
  }

  const parsed = await response.json();
  const promptBlockReason = parsed?.promptFeedback?.blockReason;
  if (promptBlockReason) {
    return {
      content: '',
      safetyBlocked: true,
      safety: {
        category: 'gemini_prompt_filter',
        reason: `Gemini blocked the prompt: ${promptBlockReason}`,
      },
      originalContentLength: 0,
    };
  }

  const candidate = parsed?.candidates?.[0];
  if (candidate?.finishReason === 'SAFETY') {
    return {
      content: '',
      safetyBlocked: true,
      safety: {
        category: 'gemini_response_filter',
        reason: 'Gemini blocked the response for safety.',
      },
      originalContentLength: 0,
    };
  }

  const content = extractGeminiCandidateText(candidate);
  return {
    content,
    safetyBlocked: false,
    originalContentLength: content.length,
  };
}

async function fetchGeminiWithRetry(url, request) {
  const maxAttempts = 3;
  let lastErrorBody = '';
  let lastStatus = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(url, request);
    if (response.ok) return response;

    lastStatus = response.status;
    lastErrorBody = await response.text().catch(() => '');

    if (!isTransientGeminiStatus(response.status) || attempt === maxAttempts) {
      break;
    }

    await sleep(650 * attempt);
  }

  throw new Error(`Gemini request failed with ${lastStatus}: ${lastErrorBody}`);
}

function isTransientGeminiStatus(status) {
  return [429, 500, 502, 503, 504].includes(status);
}

function extractGeminiCandidateText(candidate) {
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(part => part.text || '').join('');
}

async function streamTextAsSse(text, res, isClientClosed) {
  const chunks = chunkText(text, 120);
  for (const chunk of chunks) {
    if (isClientClosed()) break;
    sendSseEvent(res, 'token', { text: chunk });
  }
  return text;
}

function chunkText(text, maxLength) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const splitAt = findChunkBoundary(remaining, maxLength);
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function findChunkBoundary(text, maxLength) {
  const window = text.slice(0, maxLength + 1);
  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace > Math.floor(maxLength * 0.6)) return lastSpace + 1;
  return maxLength;
}

function normalizeGeminiModelName(model) {
  const trimmed = String(model || '').trim();
  if (trimmed.startsWith('models/')) return trimmed.slice('models/'.length);
  return trimmed;
}

function ensureGeminiApiKey(action) {
  if (!GEMINI_API_KEY) {
    throw new Error(`GEMINI_API_KEY is required for Gemini ${action}.`);
  }
}

async function streamOllamaResponse({ prompt, res, signal, isClientClosed }) {
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
    }),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Ollama request failed with ${response.status}: ${errorBody}`);
  }

  const parsed = await response.json();
  const content = parsed?.response || '';
  const outputSafety = validateGeneratedTextSafety(content);
  if (!outputSafety.allowed) {
    const safeContent = await streamTextAsSse(SAFE_REFUSAL_MESSAGE, res, isClientClosed);
    return {
      content: safeContent,
      safetyBlocked: true,
      safety: outputSafety,
      originalContentLength: content.length,
    };
  }

  const safeContent = await streamTextAsSse(content, res, isClientClosed);
  return {
    content: safeContent,
    safetyBlocked: false,
  };
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errorBody}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBufferWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errorBody}`);
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

function fireAnalyticsEvent(event) {
  fetchJsonWithTimeout(
    `${ANALYTICS_URL}/api/analytics/event`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
      },
      body: JSON.stringify(event),
    },
    3000
  ).catch(err => {
    console.warn('[ai] analytics event failed:', err.message);
  });
}

function fireSafetyAnalyticsEvent(type, req, metadata = {}) {
  fireAnalyticsEvent({
    type,
    studentId: DEMO_STUDENT_ID,
    schoolId: DEMO_SCHOOL_ID,
    subject: metadata.subject,
    sessionId: metadata.sessionId,
    metadata: {
      category: metadata.category || 'unknown',
      reason: metadata.reason || 'Safety policy blocked the request.',
      promptLength: metadata.promptLength,
      outputLength: metadata.outputLength,
    },
  });
}

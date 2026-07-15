// Stream — classroom announcements (ported from v2 StreamService).
//
// Drafts, scheduling, pinning, publish-now. Students see published posts only,
// pinned first. Scheduled posts auto-publish lazily on read (v2 ran a
// background hook; a lazy flip on list is the same observable behaviour).

const express = require('express');
const prisma = require('../lib/prisma');
const { isUuid, nonEmptyString, parseDate } = require('../lib/validation');
const { DEMO_TEACHER_ID } = require('../lib/demo-roster');

const router = express.Router();

const STATUSES = ['draft', 'scheduled', 'published'];

function toResponse(a) {
  return {
    id: a.id,
    classroomId: a.classroomId,
    authorId: a.authorId,
    title: a.title,
    body: a.body,
    attachments: a.attachments,
    status: a.status,
    scheduledFor: a.scheduledFor,
    isPinned: a.isPinned,
    publishedAt: a.publishedAt,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

async function getLive(id) {
  if (!isUuid(id)) return null;
  const a = await prisma.announcement.findUnique({ where: { id } });
  return a && !a.isDeleted ? a : null;
}

// Attachments are [{type: 'link', url, title}] — file uploads are out of scope
// for the demo build (no shared file storage on this path).
function cleanAttachments(raw) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const item of raw) {
    if (!item || typeof item.url !== 'string' || !/^https?:\/\//i.test(item.url)) return null;
    out.push({ type: 'link', url: item.url, title: typeof item.title === 'string' ? item.title : item.url });
  }
  return out;
}

async function publishDueScheduled(classroomId) {
  await prisma.announcement.updateMany({
    where: {
      classroomId, status: 'scheduled', isDeleted: false,
      scheduledFor: { lte: new Date() },
    },
    data: { status: 'published', publishedAt: new Date(), scheduledFor: null },
  });
}

router.post('/classes/:id/announcements', async (req, res) => {
  const classroom = isUuid(req.params.id)
    ? await prisma.classroom.findUnique({ where: { id: req.params.id } })
    : null;
  if (!classroom || classroom.isDeleted) {
    return res.status(404).json({ error: 'Classroom not found' });
  }

  const { title, body, isPinned } = req.body || {};
  if (!nonEmptyString(body)) return res.status(400).json({ error: 'body is required' });
  const status = req.body?.status || 'published';
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
  }
  let scheduledFor = null;
  if (status === 'scheduled') {
    scheduledFor = parseDate(req.body?.scheduledFor);
    if (!scheduledFor) {
      return res.status(400).json({ error: 'A scheduled post needs a valid scheduledFor time' });
    }
  }
  const attachments = cleanAttachments(req.body?.attachments);
  if (attachments === null) {
    return res.status(400).json({ error: 'attachments must be [{url, title?}] with http(s) urls' });
  }

  const announcement = await prisma.announcement.create({
    data: {
      classroomId: classroom.id,
      authorId: req.body?.authorId || DEMO_TEACHER_ID,
      title: nonEmptyString(title, 200) ? title.trim() : null,
      body: body.trim(),
      attachments: attachments ?? [],
      status,
      scheduledFor,
      isPinned: Boolean(isPinned),
      publishedAt: status === 'published' ? new Date() : null,
    },
  });
  res.status(201).json(toResponse(announcement));
});

router.get('/classes/:id/announcements', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Classroom not found' });
  await publishDueScheduled(req.params.id);
  // Teachers see drafts/scheduled they can manage; students see published only.
  const studentView = req.query.role === 'student';
  const items = await prisma.announcement.findMany({
    where: {
      classroomId: req.params.id,
      isDeleted: false,
      ...(studentView ? { status: 'published' } : {}),
    },
    orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
    take: 100,
  });
  res.json({ items: items.map(toResponse), total: items.length });
});

router.patch('/announcements/:id', async (req, res) => {
  const announcement = await getLive(req.params.id);
  if (!announcement) return res.status(404).json({ error: 'Announcement not found' });

  const data = {};
  if (req.body?.body !== undefined) {
    if (!nonEmptyString(req.body.body)) return res.status(400).json({ error: 'body cannot be empty' });
    data.body = req.body.body.trim();
  }
  if (req.body?.title !== undefined) {
    data.title = nonEmptyString(req.body.title, 200) ? req.body.title.trim() : null;
  }
  if (req.body?.attachments !== undefined) {
    const attachments = cleanAttachments(req.body.attachments);
    if (attachments === null) {
      return res.status(400).json({ error: 'attachments must be [{url, title?}] with http(s) urls' });
    }
    data.attachments = attachments;
  }
  if (req.body?.isPinned !== undefined) data.isPinned = Boolean(req.body.isPinned);
  if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to update' });

  const updated = await prisma.announcement.update({ where: { id: announcement.id }, data });
  res.json(toResponse(updated));
});

router.delete('/announcements/:id', async (req, res) => {
  const announcement = await getLive(req.params.id);
  if (!announcement) return res.status(404).json({ error: 'Announcement not found' });
  await prisma.announcement.update({
    where: { id: announcement.id },
    data: { isDeleted: true, deletedAt: new Date() },
  });
  res.status(204).end();
});

router.post('/announcements/:id/pin', async (req, res) => {
  const announcement = await getLive(req.params.id);
  if (!announcement) return res.status(404).json({ error: 'Announcement not found' });
  const updated = await prisma.announcement.update({
    where: { id: announcement.id },
    data: { isPinned: req.body?.pinned !== false },
  });
  res.json(toResponse(updated));
});

router.post('/announcements/:id/publish', async (req, res) => {
  const announcement = await getLive(req.params.id);
  if (!announcement) return res.status(404).json({ error: 'Announcement not found' });
  if (announcement.status === 'published') return res.json(toResponse(announcement));
  const updated = await prisma.announcement.update({
    where: { id: announcement.id },
    data: { status: 'published', publishedAt: new Date(), scheduledFor: null },
  });
  res.json(toResponse(updated));
});

module.exports = router;

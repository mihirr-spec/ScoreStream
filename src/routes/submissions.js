// Submissions: each team can share a GitHub repo link and upload its slides
// (PDF, PowerPoint, Word, Excel/CSV or an image) for every event it is in.
// Judges see both while scoring, in the in-page viewer (public/js/common.js).
//
// The slide FILES are stored in MongoDB itself with GridFS: the file is split into
// 255 KB chunks in "slides.chunks", and "slides.files" holds its name, size and type.
// So no separate file server is needed, and files survive server redeploys.
// The "submissions" collection keeps one small document per team per event that
// points at the file (slides.fileId) and holds the repo URL.

const path = require('path');
const jwt = require('jsonwebtoken');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const express = require('express');
const { GridFSBucket } = require('mongodb');
const config = require('../config');
const { getDb } = require('../db');
const { requireAdmin, assertEventAccess, requireJudge, findJudgeSeat, requireTeam } = require('../middleware/auth');
const { httpError, parseId } = require('../middleware/validate');

const router = express.Router();

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB
const SLIDE_TYPES = {
  '.pdf': 'application/pdf',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};
const TYPE_LIST = 'PDF, PowerPoint, Word, Excel, CSV, PNG or JPG';
// https://github.com/owner/repo (optionally with a deeper path like /tree/main)
const GITHUB_URL = /^https:\/\/(www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[^\s]*)?$/;

const slidesBucket = () => new GridFSBucket(getDb(), { bucketName: 'slides' });

// The team's place in this event (its "teams" document), or 404.
async function teamInEvent(req) {
  const eventId = parseId(req.params.eventId, 'event id');
  const team = await getDb().collection('teams').findOne({ eventId, accountId: req.teamAccount._id }, { projection: { _id: 1, eventId: 1 } });
  if (!team) throw httpError(404, 'Your team is not in this event');
  return team;
}

// Submissions can change until the event ends.
async function assertOpen(eventId) {
  const event = await getDb().collection('events').findOne({ _id: eventId }, { projection: { status: 1 } });
  if (!event) throw httpError(404, 'Event not found');
  if (event.status === 'closed') throw httpError(409, 'This event has ended, so submissions are locked');
}

// What every page needs to show a submission (no internal ids except the file's).
function publicSubmission(doc) {
  if (!doc) return { githubUrl: '', slides: null };
  return {
    githubUrl: doc.githubUrl || '',
    slides: doc.slides ? { filename: doc.slides.filename, size: doc.slides.size, uploadedAt: doc.slides.uploadedAt } : null,
    updatedAt: doc.updatedAt,
  };
}

// Sends a stored slides file to the browser.
async function sendSlides(res, teamId) {
  const submission = await getDb().collection('submissions').findOne({ teamId }, { projection: { slides: 1 } });
  if (!submission || !submission.slides) throw httpError(404, 'No slides uploaded yet');
  const { fileId, filename, contentType, size } = submission.slides;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', size);
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  await pipeline(slidesBucket().openDownloadStream(fileId), res);
}

// PowerPoint and Word files are shown with Microsoft's Office viewer, which has to
// fetch the file itself - without our login token. So a signed-in user can ask for a
// VIEW LINK: a URL holding a token that opens only this one file, for 15 minutes.
// (role 'file' means this token can never pass requireAdmin/requireJudge/requireTeam.)
async function viewLink(req, teamId) {
  const submission = await getDb().collection('submissions').findOne({ teamId }, { projection: { slides: 1 } });
  if (!submission || !submission.slides) throw httpError(404, 'No slides uploaded yet');
  const token = jwt.sign({ role: 'file', teamId: teamId.toString() }, config.jwtSecret, { expiresIn: '15m' });
  // Behind Render's proxy the original protocol is in x-forwarded-proto.
  const origin = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
  // The file name at the end tells the Office viewer what kind of file it is.
  return { url: `${origin}/api/files/${token}/${encodeURIComponent(submission.slides.filename)}` };
}

// Deletes a team's submission and its file (used when a team leaves or an event is deleted).
async function deleteSubmissions(filter) {
  const db = getDb();
  const docs = await db.collection('submissions').find(filter, { projection: { 'slides.fileId': 1 } }).toArray();
  for (const doc of docs) {
    if (doc.slides) await slidesBucket().delete(doc.slides.fileId).catch(() => {});
  }
  await db.collection('submissions').deleteMany(filter);
}

// ---------- Team ----------

// PUT /api/team/events/:eventId/submission  { githubUrl }   ('' removes the link)
router.put('/team/events/:eventId/submission', requireTeam, async (req, res) => {
  const team = await teamInEvent(req);
  await assertOpen(team.eventId);
  const { githubUrl } = req.body || {};
  if (typeof githubUrl !== 'string' || githubUrl.length > 300) throw httpError(400, 'githubUrl must be text');
  const url = githubUrl.trim();
  if (url && !GITHUB_URL.test(url)) throw httpError(400, 'Use a GitHub link like https://github.com/your-team/your-repo');

  const update = url ? { $set: { githubUrl: url, updatedAt: new Date() } } : { $unset: { githubUrl: '' }, $set: { updatedAt: new Date() } };
  // Upsert: the first save creates the team's submission document.
  const doc = await getDb()
    .collection('submissions')
    .findOneAndUpdate({ eventId: team.eventId, teamId: team._id }, update, { upsert: true, returnDocument: 'after' });
  res.json(publicSubmission(doc));
});

// PUT /api/team/events/:eventId/slides?name=deck.pptx   body = the raw file
// The browser sends the file itself as the request body; we stream it into GridFS
// chunk by chunk (never the whole file in memory) and stop at MAX_BYTES.
router.put('/team/events/:eventId/slides', requireTeam, async (req, res) => {
  const team = await teamInEvent(req);
  await assertOpen(team.eventId);

  const original = String(req.query.name || '');
  const ext = path.extname(original).toLowerCase();
  if (!SLIDE_TYPES[ext]) throw httpError(400, `Upload a ${TYPE_LIST} file`);
  const declared = Number(req.headers['content-length']);
  if (!declared) throw httpError(400, 'The file is empty');
  if (declared > MAX_BYTES) throw httpError(413, 'Slides must be 20 MB or smaller');
  // Keep the name readable but safe to put in a download header.
  const filename = path.basename(original).replace(/[^A-Za-z0-9 ._()-]/g, '_').slice(-100) || `slides${ext}`;

  const upload = slidesBucket().openUploadStream(filename, {
    metadata: { eventId: team.eventId, teamId: team._id, contentType: SLIDE_TYPES[ext] },
  });
  let size = 0;
  const limit = new Transform({
    transform(chunk, encoding, done) {
      size += chunk.length;
      if (size > MAX_BYTES) done(httpError(413, 'Slides must be 20 MB or smaller'));
      else done(null, chunk);
    },
  });
  try {
    await pipeline(req, limit, upload);
  } catch (err) {
    await upload.abort().catch(() => {}); // remove the chunks written so far
    throw err.status ? err : httpError(400, 'The upload did not finish. Please try again');
  }

  const db = getDb();
  const slides = { fileId: upload.id, filename, size, contentType: SLIDE_TYPES[ext], uploadedAt: new Date() };
  const previous = await db
    .collection('submissions')
    .findOneAndUpdate({ eventId: team.eventId, teamId: team._id }, { $set: { slides, updatedAt: new Date() } }, { upsert: true, returnDocument: 'before' });
  // Replacing slides: delete the old file only after the new one is saved.
  if (previous && previous.slides) await slidesBucket().delete(previous.slides.fileId).catch(() => {});

  res.status(201).json(publicSubmission({ ...previous, slides, updatedAt: new Date() }));
});

// DELETE /api/team/events/:eventId/slides
router.delete('/team/events/:eventId/slides', requireTeam, async (req, res) => {
  const team = await teamInEvent(req);
  await assertOpen(team.eventId);
  const doc = await getDb()
    .collection('submissions')
    .findOneAndUpdate({ eventId: team.eventId, teamId: team._id }, { $unset: { slides: '' }, $set: { updatedAt: new Date() } }, { returnDocument: 'before' });
  if (!doc || !doc.slides) throw httpError(404, 'No slides uploaded yet');
  await slidesBucket().delete(doc.slides.fileId).catch(() => {});
  res.json({ message: 'Slides removed' });
});

// GET /api/team/events/:eventId/slides  -> download your own slides
router.get('/team/events/:eventId/slides', requireTeam, async (req, res) => {
  const team = await teamInEvent(req);
  await sendSlides(res, team._id);
});

// ---------- Judge + admin downloads ----------

// GET /api/team/events/:eventId/slides/link  -> a view link for the Office viewer
router.get('/team/events/:eventId/slides/link', requireTeam, async (req, res) => {
  const team = await teamInEvent(req);
  res.json(await viewLink(req, team._id));
});

// A judge may open a team's slides only in events they judge.
async function judgeTeam(req) {
  const teamId = parseId(req.params.teamId, 'team id');
  const team = await getDb().collection('teams').findOne({ _id: teamId }, { projection: { eventId: 1 } });
  if (!team) throw httpError(404, 'Team not found');
  await findJudgeSeat(req, team.eventId);
  return teamId;
}

// The admin may open a team's slides only in their own events.
async function adminTeam(req) {
  const teamId = parseId(req.params.teamId, 'team id');
  const team = await getDb().collection('teams').findOne({ _id: teamId }, { projection: { eventId: 1 } });
  if (!team) throw httpError(404, 'Team not found');
  await assertEventAccess(req, team.eventId);
  return teamId;
}

// GET /api/judge/teams/:teamId/slides (+ /link)  -> a judge opens a team's slides
router.get('/judge/teams/:teamId/slides', requireJudge, async (req, res) => sendSlides(res, await judgeTeam(req)));
router.get('/judge/teams/:teamId/slides/link', requireJudge, async (req, res) => res.json(await viewLink(req, await judgeTeam(req))));

// GET /api/teams/:teamId/slides (+ /link)  -> the admin opens a team's slides
router.get('/teams/:teamId/slides', requireAdmin, async (req, res) => sendSlides(res, await adminTeam(req)));
router.get('/teams/:teamId/slides/link', requireAdmin, async (req, res) => res.json(await viewLink(req, await adminTeam(req))));

// GET /api/files/:token/:filename  -> the file behind a view link (no login; the token is the permission)
router.get('/files/:token/:filename', async (req, res) => {
  let payload;
  try {
    payload = jwt.verify(req.params.token, config.jwtSecret);
  } catch {
    throw httpError(401, 'This view link has expired. Open the file again from ScoreStream.');
  }
  if (payload.role !== 'file') throw httpError(401, 'Not a file link');
  await sendSlides(res, parseId(payload.teamId, 'team id'));
});

module.exports = { router, publicSubmission, deleteSubmissions };

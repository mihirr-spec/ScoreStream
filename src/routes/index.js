// Collects every API router in one place. app.js mounts this under /api.
// Each router file writes its full path (e.g. '/events/:id'), so they can
// all be mounted at the same level.

const express = require('express');

const router = express.Router();

router.use(require('./auth'));
router.use(require('./events'));
router.use(require('./teams'));
router.use(require('./invitations'));
router.use(require('./judges'));
router.use(require('./scores'));
router.use(require('./leaderboard'));
router.use(require('./feedback'));

module.exports = router;

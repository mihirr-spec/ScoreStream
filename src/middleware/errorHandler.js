// Error handling for the whole API, in one place.
// Logs details on the server, but only sends a friendly message to the client
// (never a stack trace).

// Any /api URL we don't know -> JSON 404 (not an HTML page).
function notFound(req, res) {
  res.status(404).json({ error: 'Route not found' });
}

// Express recognises an error handler because it has FOUR arguments.
// Express 5 sends errors thrown in async route handlers here automatically.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Bad JSON in the request body is the client's fault -> 400.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body is not valid JSON' });
  }
  // 121 = the document failed a $jsonSchema validator in MongoDB.
  if (err.code === 121) {
    return res.status(400).json({ error: 'Data rejected by database validation rules' });
  }
  // 11000 = duplicate key (a UNIQUE index blocked the write).
  if (err.code === 11000) {
    return res.status(409).json({ error: 'This entry already exists' });
  }
  // Errors we created with httpError() have a safe message for the client.
  if (err.expose) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
}

module.exports = { notFound, errorHandler };

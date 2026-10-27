// Server-Sent Events (SSE): keeps a list of browsers watching each event's leaderboard,
// and pushes new data to them. SSE is a normal HTTP response that is never closed;
// the server keeps writing "data: ...\n\n" messages into it, and the browser's
// EventSource receives each one. One-way (server -> browser), which is all we need.

// Map of eventId (string) -> Set of open response objects.
const clientsByEvent = new Map();

function addClient(eventId, res) {
  if (!clientsByEvent.has(eventId)) {
    clientsByEvent.set(eventId, new Set());
  }
  clientsByEvent.get(eventId).add(res);
}

function removeClient(eventId, res) {
  const clients = clientsByEvent.get(eventId);
  if (!clients) return;
  clients.delete(res);
  if (clients.size === 0) clientsByEvent.delete(eventId);
}

// Writes one SSE message to one browser.
// Format: "event: <name>\ndata: <json>\n\n" (the blank line ends the message).
function sendTo(res, eventName, data) {
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Sends the same message to every browser watching this event.
function broadcast(eventId, eventName, data) {
  const clients = clientsByEvent.get(eventId);
  if (!clients) return;
  for (const res of clients) {
    sendTo(res, eventName, data);
  }
}

function clientCount(eventId) {
  const clients = clientsByEvent.get(eventId);
  return clients ? clients.size : 0;
}

// Each judge ACCOUNT also has its own channel ("judge:<accountId>"), so their dashboard
// hears about new or withdrawn invitations and event changes the moment they happen.
function judgeChannel(accountId) {
  return `judge:${accountId}`;
}

// Tells these judge accounts' open dashboards to reload their invitations and events.
function notifyJudges(accountIds) {
  for (const id of new Set(accountIds.map(String))) broadcast(judgeChannel(id), 'changed', {});
}

module.exports = { addClient, removeClient, sendTo, broadcast, clientCount, judgeChannel, notifyJudges };

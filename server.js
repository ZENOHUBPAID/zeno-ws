const http = require('http');
const WebSocket = require('ws');
const PORT = process.env.PORT || 10000;
const SECRET = process.env.WS_SECRET || "ZENO_SECURE_9xK2mP7q";
const PATH = "/joiner_zeno/ws";
let jobs = new Map();
let clients = new Set();
let activeUsers = new Map();
function broadcast(obj, except = null) {
  const data = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws !== except && ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch(e) {}
    }
  }
}
function sendSnapshot(ws) {
  const jobsArray = Array.from(jobs.entries()).map(([jobId, j]) => ({
    jobId, animals: j.animals, job_start_time: j.job_start_time, payload: { animals: j.animals }
  }));
  ws.send(JSON.stringify({ op: "SNAPSHOT", jobs: jobsArray, active_users: activeUsers.size, server_time: Math.floor(Date.now()/1000) }));
}
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health' || req.url === '/status') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ ok: true, status: 'healthy', clients: clients.size, jobs: jobs.size, uptime: process.uptime() }));
    return;
  }
  if (req.url.endsWith('/time')) {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end(String(Math.floor(Date.now()/1000)));
    return;
  }
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('ZENO WS Server is running');
});
const wss = new WebSocket.Server({ server, path: PATH });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const userId = url.searchParams.get('userId') || 'unknown';
  const key = url.searchParams.get('key') || '';
  if (SECRET && key !== SECRET && key !== 'public-test') {
    ws.send(JSON.stringify({ op: "KICK", reason: "[ZENO WS] Key invalide" }));
    ws.close(); return;
  }
  clients.add(ws);
  activeUsers.set(userId, { userId, lastSeen: Date.now() });
  sendSnapshot(ws);
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch(e) { return; }
    if (msg.op === "JOB") {
      const jobId = msg.jobId || (msg.payload && msg.payload.jobId);
      if (!jobId) return;
      jobs.set(jobId, { animals: (msg.payload && msg.payload.animals) || msg.animals || [], job_start_time: msg.job_start_time || Math.floor(Date.now()/1000), payload: msg.payload });
      broadcast({ op: "JOB", jobId: jobId, job_start_time: jobs.get(jobId).job_start_time, payload: msg.payload }, ws);
    }
    if (msg.op === "DELETE" && msg.jobId) { jobs.delete(msg.jobId); broadcast({ op: "DELETE", job_id: msg.jobId }, ws); }
  });
  ws.on('close', () => { clients.delete(ws); });
});
server.listen(PORT, () => { console.log('[ZENO WS] Listening on ' + PORT); });

// ZENO WS Server - Serveur WebSocket pour finder Steal a Brainrot
// Deploie sur Render / Railway en 2 min, gratuit
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const SECRET = process.env.WS_SECRET || "ZENO_SECURE_9xK2mP7q";
const fs = require("fs");
let KEYS={};
try{KEYS=JSON.parse(fs.readFileSync("keys.json","utf8"));}catch(e){}
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
    jobId,
    animals: j.animals,
    job_start_time: j.job_start_time,
    payload: { animals: j.animals }
  }));
  ws.send(JSON.stringify({
    op: "SNAPSHOT",
    jobs: jobsArray,
    active_users: activeUsers.size,
    users: Array.from(activeUsers.keys()),
    server_time: Math.floor(Date.now()/1000)
  }));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health' || req.url === '/status') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ ok: true, status: 'healthy', clients: clients.size, jobs: jobs.size, uptime: process.uptime() }));
    return;
  }
  if (req.url.startsWith('/validate')) {
    const u = new URL(req.url, 'http://' + req.headers.host);
    const k = u.searchParams.get('key');
    const hwid = u.searchParams.get('hwid') || '';
    let valid = false, plan = null, expires = null, status = 'Invalid', reason = 'invalid';
    if (k === SECRET) { valid = true; plan = 'master'; expires = 9999999999; status='Active'; reason='ok'; }
    else if (KEYS && KEYS[k]) { const e = KEYS[k]; plan = e.plan;
      // Si la key a une duree mais pas encore de expires, le timer commence AU PREMIER LOGIN
      if (e.duration && !e.expires) { e.expires = Math.floor(Date.now()/1000) + e.duration; try { fs.writeFileSync('keys.json', JSON.stringify(KEYS, null, 2)); } catch(_){} console.log('[KEY] First login, timer start for', k, 'expires', e.expires); }
      expires = e.expires;
      if (e.expires && e.expires < Math.floor(Date.now()/1000)) { valid=false; status='Expired'; reason='expired'; } else { valid=true; status='Active'; reason='ok'; if (!e.hwid && hwid) { e.hwid = hwid; try { fs.writeFileSync('keys.json', JSON.stringify(KEYS, null, 2)); } catch(e){} } } }
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({valid, plan, expires, slot: '1/1', status, reason}));
    return;
  }
  if (req.url.endsWith('/time')) {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end(String(Math.floor(Date.now()/1000)));
    return;
  }
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('ZENO WS Server is running. Connect via ws://host' + PATH);
});

const wss = new WebSocket.Server({ server, path: PATH });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const userId = url.searchParams.get('userId') || 'unknown';
  const key = url.searchParams.get('key') || '';

  if (SECRET && key !== SECRET && key !== 'public-test') {
    ws.send(JSON.stringify({ op: "KICK", reason: "[ZENO WS] Key invalide" }));
    ws.close();
    console.log('[REJECT] userId=' + userId);
    return;
  }

  console.log('[CONNECT] ' + userId + ' total=' + (clients.size+1));
  clients.add(ws);
  activeUsers.set(userId, { userId, lastSeen: Date.now() });
  sendSnapshot(ws);
  ws.send(JSON.stringify({ op: "STATUS", server_time: Math.floor(Date.now()/1000), active_users: activeUsers.size }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch(e) { return; }
    activeUsers.set(userId, { userId, lastSeen: Date.now() });

    if (msg.op === "JOB") {
      const jobId = msg.jobId || (msg.payload && msg.payload.jobId);
      if (!jobId) return;
      jobs.set(jobId, {
        animals: (msg.payload && msg.payload.animals) || msg.animals || [],
        job_start_time: msg.job_start_time || Math.floor(Date.now()/1000),
        payload: msg.payload
      });
      broadcast({ op: "JOB", jobId: jobId, job_start_time: jobs.get(jobId).job_start_time, payload: msg.payload, userId: userId, active_users: activeUsers.size, users: Array.from(activeUsers.keys()) }, ws);
      console.log('[JOB] ' + jobId + ' from ' + userId);
    }

    if (msg.op === "STEAL") {
      broadcast({ op: "STEAL", payload: msg.payload, sig: msg.sig, ts: msg.ts }, ws);
    }

    if (msg.op === "PING") {
      ws.send(JSON.stringify({ op: "PONG", server_time: Math.floor(Date.now()/1000) }));
    }

    if (msg.op === "DELETE" && msg.jobId) {
      jobs.delete(msg.jobId);
      broadcast({ op: "DELETE", job_id: msg.jobId }, ws);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    setTimeout(() => {
      const u = activeUsers.get(userId);
      if (u && Date.now() - u.lastSeen > 60000) activeUsers.delete(userId);
    }, 60000);
    console.log('[DISCONNECT] ' + userId);
  });
});

setInterval(() => {
  const now = Math.floor(Date.now()/1000);
  for (const [jobId, j] of jobs) {
    if (now - j.job_start_time > 600) {
      jobs.delete(jobId);
      broadcast({ op: "DELETE", job_id: jobId });
    }
  }
}, 60000);

server.listen(PORT, () => {
  console.log('[ZENO WS] Listening on port ' + PORT);
  console.log('[ZENO WS] Path: ' + PATH);
  console.log('[ZENO WS] WS URL: ws://localhost:' + PORT + PATH);
});
        

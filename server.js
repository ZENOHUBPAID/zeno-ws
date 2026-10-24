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
let bestToday = { name: null, value: 0, jobId: null, ts: 0 };
let seenPets = new Map(); // dedupe : key = name|gen|jobId -> ts, evite d'envoyer 10x le meme pet

function getPriority(animal) {
  // Secret et OG en priorite, pas Brainrot God
  const rarity = (animal.Rarity || animal.rarity || "").toLowerCase();
  const name = (animal.DisplayName || animal.name || "").toLowerCase();
  if (rarity.includes("og") || name.includes(" og") || rarity === "og") return 100;
  if (rarity.includes("secret") || name.includes("secret")) return 95;
  // 100M+ aussi prioritaire
  const val = parseFloat((animal.Generation || "").toString().replace(/[^0-9.]/g,"")) || 0;
  const mult = (animal.Generation || "").toString().includes("M") ? 1e6 : (animal.Generation || "").toString().includes("B") ? 1e9 : 1;
  const total = val * mult;
  if (total >= 100e6) return 90;
  if (total >= 10e6) return 80;
  return 0;
}

function getMutationStr(animal) {
  // Mutation dans les logs et webhook : Rainbow, Gold, Diamond, Galaxy, etc.
  const mut = animal.Mutation || animal.mutation || animal.Mutations || "";
  if (Array.isArray(mut)) return mut.join(", ");
  return mut.toString();
}

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
  const usersArray = Array.from(activeUsers.entries()).map(([uid, info]) => ({ user_id: uid, division_name: info.division || "1/1", plan: info.plan || "active" }));
  ws.send(JSON.stringify({
    op: "SNAPSHOT", bestToday,
    jobs: jobsArray,
    active_users: activeUsers.size,
    users: usersArray,
    server_time: Math.floor(Date.now()/1000)
  }));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health' || req.url === '/status') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ ok: true, status: 'healthy', clients: clients.size, jobs: jobs.size, uptime: process.uptime(), bestToday }));
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

  if (req.url.startsWith('/finder')) {
    const u = new URL(req.url, 'http://' + req.headers.host);
    const k = u.searchParams.get('key');
    let valid = false;
    if (k === SECRET) valid = true;
    else if (KEYS && KEYS[k]) { const e = KEYS[k]; if (!e.expires || e.expires > Math.floor(Date.now()/1000)) valid = true; }
    if (!valid) { res.writeHead(403, {'Content-Type':'text/plain'}); res.end('-- Invalid key'); return; }
    // Le finder est servi depuis le fichier ZENO_V47_WS_FULL.lua sur le serveur
    try {
      const code = fs.readFileSync('finder.lua', 'utf8');
      res.writeHead(200, {'Content-Type':'text/plain'});
      res.end(code);
    } catch(e) {
      res.writeHead(500, {'Content-Type':'text/plain'}); res.end('-- Finder not found on server, upload finder.lua');
    }
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

  // Accepte SECRET + toutes les cles ZENO valides de keys.json (pas que SECRET, sinon KaWaifu reste Offline)
  const isZenoKey = KEYS && KEYS[key];
  // Sans LuaProtect, script_key est vide -> on autorise aussi vide / public-test pour le test
  if (SECRET && key !== SECRET && key !== 'public-test' && key !== '' && !isZenoKey) {
    ws.send(JSON.stringify({ op: "KICK", reason: "[ZENO WS] Key invalide" }));
    ws.close();
    console.log('[REJECT] userId=' + userId + ' key=' + key);
    return;
  }

  console.log('[CONNECT] ' + userId + ' total=' + (clients.size+1));
  clients.add(ws);
  activeUsers.set(userId, { userId, lastSeen: Date.now() });
  // KaWaifu attend INIT pour passer en Live - on envoie INIT + SNAPSHOT + STATUS
  const jobsArrayInit = Array.from(jobs.entries()).map(([jobId, j]) => ({ jobId, _enc: null, jid: jobId, animals: j.animals, job_start_time: j.job_start_time, payload: { animals: j.animals } }));
  ws.send(JSON.stringify({ op: "INIT", data: { server_time: Math.floor(Date.now()/1000), jobs: jobsArrayInit, active_users: activeUsers.size } }));
  sendSnapshot(ws);
  ws.send(JSON.stringify({ op: "STATUS", server_time: Math.floor(Date.now()/1000), active_users: activeUsers.size }));

  ws.on('message', (raw) => {
    const rawStr = raw.toString();
    if (rawStr === "READY") {
      // KaWaifu envoie READY en string apres connexion, on repond INIT pour passer en Live
      const jobsArrayInit = Array.from(jobs.entries()).map(([jobId, j]) => ({ jobId, _enc: null, jid: jobId, animals: j.animals, job_start_time: j.job_start_time, payload: { animals: j.animals } }));
      try { ws.send(JSON.stringify({ op: "INIT", data: { server_time: Math.floor(Date.now()/1000), jobs: jobsArrayInit, active_users: activeUsers.size } })); } catch(e) {}
      return;
    }
    let msg;
    try { msg = JSON.parse(rawStr); } catch(e) { return; }
    activeUsers.set(userId, { userId, lastSeen: Date.now() });

    if (msg.op === "JOB") {
      const jobId = msg.jobId || (msg.payload && msg.payload.jobId);
      if (!jobId) return;
      const animals = (msg.payload && msg.payload.animals) || msg.animals || [];
      // Dedupe : si meme pet deja vu il y a moins de 30s, on skip
      for (const a of animals) {
        const key = (a.DisplayName || a.name || "") + "|" + (a.Generation || "") + "|" + jobId;
        if (seenPets.has(key) && Date.now() - seenPets.get(key) < 30000) continue;
        seenPets.set(key, Date.now());
        // Best today
        const val = parseFloat((a.Generation || "").toString().replace(/[^0-9.]/g,"")) || 0;
        const mult = (a.Generation || "").toString().includes("B") ? 1e9 : (a.Generation || "").toString().includes("M") ? 1e6 : 1;
        const total = val * mult;
        if (total > bestToday.value) bestToday = { name: a.DisplayName || a.name, value: total, jobId, ts: Date.now() };
        // Ajoute mutation et priorite pour les logs et webhook
        a.mutation_str = getMutationStr(a);
        a.priority = getPriority(a);
        a.is_og = getPriority(a) >= 100;
        a.is_secret = getPriority(a) >= 95 && getPriority(a) < 100;
      }
      // Trie par priorite : Secret et OG d'abord
      animals.sort((x,y) => (y.priority||0) - (x.priority||0));
      jobs.set(jobId, {
        animals: animals,
        job_start_time: msg.job_start_time || Math.floor(Date.now()/1000),
        payload: msg.payload
      });
      broadcast({ op: "JOB", jobId: jobId, job_start_time: jobs.get(jobId).job_start_time, payload: msg.payload, userId: userId, active_users: activeUsers.size, users: Array.from(activeUsers.entries()).map(([uid, info]) => ({ user_id: uid, division_name: info.division || '1/1' })) }, ws);
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
    if (now - j.job_start_time > 300) { // 5 min au lieu de 60s, on garde plus longtemps
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

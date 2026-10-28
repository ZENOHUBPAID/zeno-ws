// ZENO WS Server V3 - LE MEILLEUR - Rapide + Reconnexion Auto + Ping/Pong + Intelligent
// Deploie sur Render / Railway en 2 min, gratuit
// Fonctionnalites:
// - PLUS RAPIDE: broadcast immediat 0ms, batch 50ms pour les petits pets, 0ms pour OG/Secret
// - RECONNEXION AUTO: sessionId, le client peut reprendre ou il s'est arrete, il recoit les jobs rates
// - PING/PONG: serveur ping toutes les 15s, client doit pong en 30s sinon on le deconnecte
// - INTELLIGENT: filtre par client (prix min, mutation, region), priorite, dedupe, bestToday, OG webhook
// - OG -> @everyone @here dans oglights, Best Today -> webhook best today
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = process.env.PORT || 10000;
const SECRET = process.env.WS_SECRET || "ZENO_SECURE_9xK2mP7q";
const PATH = "/joiner_zeno/ws";
const BEST_TODAY_WEBHOOK = "https://discord.com/api/webhooks/1564736307463327817/UjSVEz4BzG2qRD0p0Lh5THagKKj72oVDaYQ9WJfAChhLyoSli0bz9VhiYe6tJXNjpy9k";
const OG_WEBHOOK = BEST_TODAY_WEBHOOK; // Tu mets ton webhook oglights ici si different

let KEYS = {};
try { KEYS = JSON.parse(fs.readFileSync("keys.json", "utf8")); } catch(e) {}

// === ETAT ===
let jobs = new Map(); // jobId -> { animals, job_start_time, region, priority, payload }
let clients = new Set(); // ws
let activeUsers = new Map(); // userId -> { lastSeen, region, filter, sessionId }
let bestToday = { name: null, value: 0, jobId: null, ts: 0, mutation: null };
let seenPets = new Map(); // name|gen|jobId -> ts
let seenGlobal = new Map(); // name|gen -> ts pour dedupe global 10s
let sessions = new Map(); // sessionId -> { userId, missedJobs: [], lastSeen }
let stats = { jobsReceived: 0, jobsBroadcast: 0, ogCount: 0, secretCount: 0, totalPets: 0, startTime: Date.now(), pings: 0 };

// === CONFIG GLOBALE ===
let globalFilter = { min: 1000000, mutation: "ALL", region: "ALL" };

// === HELPERS ===
function parseValue(genStr) {
  const s = (genStr || "").toString();
  const val = parseFloat(s.replace(/[^0-9.]/g,"")) || 0;
  const mult = s.includes("B") ? 1e9 : s.includes("M") ? 1e6 : s.includes("K") ? 1e3 : 1;
  return val * mult;
}
function getMutationStr(animal) {
  const m = animal.Mutation || animal.mutation || animal.Mutations || "";
  if (Array.isArray(m)) return m.join(", ");
  return m.toString();
}
function getPriority(animal) {
  const rarity = (animal.Rarity || animal.rarity || "").toLowerCase();
  const name = (animal.DisplayName || animal.name || "").toLowerCase();
  if (rarity.includes("secret") || name.includes("secret")) return 100;
  if (rarity.includes("og") || name.includes(" og") || rarity === "og") return 95;
  const total = parseValue(animal.Generation || animal.gen || "");
  if (total >= 100e6) return 90;
  if (total >= 10e6) return 80;
  if (total >= 1e6) return 70;
  return 0;
}
function matchesFilter(animal, filter) {
  // Filtre prix minimum
  const total = parseValue(animal.Generation || animal.gen || "");
  if (total < (filter.min || 0)) return false;
  // Filtre mutation
  if (filter.mutation && filter.mutation !== "ALL") {
    const mut = getMutationStr(animal).toLowerCase();
    const sel = filter.mutation.toLowerCase();
    if (sel === "default") { if (mut !== "" && mut !== "default") return false; }
    else if (!mut.includes(sel)) return false;
  }
  // Filtre region
  if (filter.region && filter.region !== "ALL") {
    const r = (animal.Region || animal.region || "").toLowerCase();
    if (r && !r.includes(filter.region.toLowerCase())) return false;
  }
  return true;
}
function sendWebhook(url, title, desc, color, mention) {
  if (!url) return;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: mention || "", embeds: [{ title, description: desc, color, timestamp: new Date().toISOString(), footer: { text: "ZENO FINDER - Live" } }] })
  }).catch(()=>{});
}

// === BROADCAST INTELLIGENT ===
function broadcast(obj, except = null) {
  const data = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws === except) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;
    // Filtre intelligent: on envoie que si le client veut ce pet
    if (obj.op === "JOB" && ws._filter) {
      const animals = (obj.payload && obj.payload.animals) || [];
      const filtered = animals.filter(a => matchesFilter(a, ws._filter));
      if (filtered.length === 0) continue;
      // On envoie seulement les pets filtres pour ce client
      const copy = { ...obj, payload: { ...obj.payload, animals: filtered } };
      try { ws.send(JSON.stringify(copy)); } catch(e) {}
      continue;
    }
    try { ws.send(data); } catch(e) {}
  }
}
function broadcastFast(obj, except = null) {
  // Pour OG/Secret: 0ms, pas de batch
  broadcast(obj, except);
}
let batchQueue = [];
let batchTimer = null;
function broadcastBatch(obj, except = null) {
  // Pour les petits pets: on batch 50ms pour moins de lag
  const prio = obj.payload && obj.payload.animals ? Math.max(...obj.payload.animals.map(getPriority)) : 0;
  if (prio >= 90) return broadcastFast(obj, except); // OG/Secret = immediat
  batchQueue.push({ obj, except });
  if (!batchTimer) {
    batchTimer = setTimeout(() => {
      for (const item of batchQueue) broadcast(item.obj, item.except);
      batchQueue = [];
      batchTimer = null;
    }, 50);
  }
}

function sendSnapshot(ws) {
  // Snapshot avec filtre du client
  let jobsArray = Array.from(jobs.entries()).map(([jobId, j]) => ({ jobId, animals: j.animals, job_start_time: j.job_start_time, region: j.region, priority: j.priority, payload: { animals: j.animals } }));
  if (ws._filter) {
    jobsArray = jobsArray.map(j => ({ ...j, animals: j.animals.filter(a => matchesFilter(a, ws._filter)), payload: { animals: j.animals.filter(a => matchesFilter(a, ws._filter)) } })).filter(j => j.animals.length > 0);
  }
  // Tri par priorite: Secret en haut
  jobsArray.sort((a,b) => (b.priority||0) - (a.priority||0));
  const usersArray = Array.from(activeUsers.entries()).map(([uid, info]) => ({ user_id: uid, division_name: info.division || "1/1", plan: info.plan || "active", region: info.region || "ALL" }));
  ws.send(JSON.stringify({ op: "SNAPSHOT", bestToday, jobs: jobsArray, active_users: activeUsers.size, users: usersArray, server_time: Math.floor(Date.now()/1000), stats }));
}

// === HTTP SERVER ===
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health' || req.url === '/status') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: true, status: 'healthy', version: 'V3', clients: clients.size, jobs: jobs.size, uptime: process.uptime(), bestToday, stats, globalFilter }));
    return;
  }
  if (req.url.startsWith('/validate')) {
    const u = new URL(req.url, 'http://' + req.headers.host);
    const k = u.searchParams.get('key');
    const hwid = u.searchParams.get('hwid') || '';
    let valid = false, plan = null, expires = null, status = 'Invalid', reason = 'invalid';
    if (k === SECRET) { valid = true; plan = 'master'; expires = 9999999999; status='Active'; reason='ok'; }
    else if (KEYS && KEYS[k]) { const e = KEYS[k]; plan = e.plan;
      if (e.duration && !e.expires) { e.expires = Math.floor(Date.now()/1000) + e.duration; try { fs.writeFileSync('keys.json', JSON.stringify(KEYS, null, 2)); } catch(_){} }
      expires = e.expires;
      if (e.expires && e.expires < Math.floor(Date.now()/1000)) { valid=false; status='Expired'; reason='expired'; } else { valid=true; status='Active'; reason='ok'; if (!e.hwid && hwid) { e.hwid = hwid; try { fs.writeFileSync('keys.json', JSON.stringify(KEYS, null, 2)); } catch(_){} } } }
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ valid, plan, expires, slot: '1/1', status, reason }));
    return;
  }
  if (req.url.startsWith('/finder')) {
    const u = new URL(req.url, 'http://' + req.headers.host);
    const k = u.searchParams.get('key');
    let valid = false;
    if (k === SECRET) valid = true;
    else if (KEYS && KEYS[k]) { const e = KEYS[k]; if (!e.expires || e.expires > Math.floor(Date.now()/1000)) valid = true; }
    if (!valid) { res.writeHead(403, {'Content-Type':'text/plain'}); res.end('-- Invalid key'); return; }
    try { const code = fs.readFileSync('finder.lua', 'utf8'); res.writeHead(200, {'Content-Type':'text/plain'}); res.end(code); } catch(e) { res.writeHead(500, {'Content-Type':'text/plain'}); res.end('-- Finder not found'); }
    return;
  }
  if (req.url.startsWith('/config')) {
    const u = new URL(req.url, 'http://' + req.headers.host);
    const min = u.searchParams.get('min');
    const mutation = u.searchParams.get('mutation');
    const region = u.searchParams.get('region');
    if (min) globalFilter.min = parseInt(min);
    if (mutation) globalFilter.mutation = mutation;
    if (region) globalFilter.region = region;
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: true, filter: globalFilter }));
    return;
  }
  if (req.url.endsWith('/time')) { res.writeHead(200, {'Content-Type':'text/plain'}); res.end(String(Math.floor(Date.now()/1000))); return; }
  res.writeHead(200, {'Content-Type':'text/plain'});
  res.end('ZENO WS Server V3 is running. Connect via ws://host' + PATH);
});

// === WEBSOCKET V3 ===
const wss = new WebSocket.Server({ server, path: PATH });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const userId = url.searchParams.get('userId') || 'unknown';
  const key = url.searchParams.get('key') || '';
  const region = url.searchParams.get('region') || 'ALL';
  const sessionId = url.searchParams.get('sessionId') || (userId + '_' + Date.now() + '_' + Math.random().toString(36).slice(2,8));
  const isZenoKey = KEYS && KEYS[key];
  if (SECRET && key !== SECRET && key !== 'public-test' && key !== '' && !isZenoKey) {
    ws.send(JSON.stringify({ op: "KICK", reason: "[ZENO WS V3] Key invalide" }));
    ws.close();
    console.log('[REJECT] ' + userId);
    return;
  }

  // Filtre par client, par defaut global
  ws._filter = { min: globalFilter.min, mutation: globalFilter.mutation, region: region };
  ws._userId = userId;
  ws._sessionId = sessionId;
  ws._region = region;
  ws.isAlive = true;
  ws._lastPing = Date.now();
  ws._rate = { count: 0, reset: Date.now() };

  console.log('[CONNECT V3] ' + userId + ' region=' + region + ' session=' + sessionId + ' total=' + (clients.size+1));
  clients.add(ws);
  activeUsers.set(userId, { userId, lastSeen: Date.now(), region, filter: ws._filter, sessionId });

  // Si le client a une session, on lui renvoie les jobs rates
  let missed = [];
  if (sessions.has(sessionId)) {
    const sess = sessions.get(sessionId);
    missed = sess.missedJobs || [];
    console.log('[RECONNECT] ' + userId + ' missed=' + missed.length);
  }
  sessions.set(sessionId, { userId, missedJobs: [], lastSeen: Date.now() });

  // INIT + SNAPSHOT + STATUS + RECONNECT
  const jobsArrayInit = Array.from(jobs.entries()).map(([jobId, j]) => ({ jobId, _enc: null, jid: jobId, animals: j.animals, job_start_time: j.job_start_time, region: j.region, priority: j.priority, payload: { animals: j.animals } }));
  ws.send(JSON.stringify({ op: "INIT", data: { server_time: Math.floor(Date.now()/1000), jobs: jobsArrayInit, active_users: activeUsers.size, sessionId, reconnect: missed.length > 0 } }));
  sendSnapshot(ws);
  ws.send(JSON.stringify({ op: "STATUS", server_time: Math.floor(Date.now()/1000), active_users: activeUsers.size, region, bestToday }));
  if (missed.length > 0) {
    ws.send(JSON.stringify({ op: "MISSED_JOBS", jobs: missed, count: missed.length }));
  }

  ws.on('pong', () => { ws.isAlive = true; ws._lastPing = Date.now(); });

  ws.on('message', (raw) => {
    const rawStr = raw.toString();
    if (rawStr === "READY") {
      const arr = Array.from(jobs.entries()).map(([jobId, j]) => ({ jobId, _enc: null, jid: jobId, animals: j.animals, job_start_time: j.job_start_time, region: j.region, payload: { animals: j.animals } }));
      try { ws.send(JSON.stringify({ op: "INIT", data: { server_time: Math.floor(Date.now()/1000), jobs: arr, active_users: activeUsers.size, sessionId } })); } catch(e) {}
      return;
    }
    let msg;
    try { msg = JSON.parse(rawStr); } catch(e) { return; }
    activeUsers.set(userId, { userId, lastSeen: Date.now(), region, filter: ws._filter, sessionId });

    // Rate limit: max 100 msg / 10s
    const now = Date.now();
    if (now - ws._rate.reset > 10000) { ws._rate.count = 0; ws._rate.reset = now; }
    ws._rate.count++;
    if (ws._rate.count > 100) return;

    if (msg.op === "PING" || msg.op === "PONG") {
      ws.isAlive = true;
      ws._lastPing = Date.now();
      stats.pings++;
      ws.send(JSON.stringify({ op: "PONG", server_time: Math.floor(Date.now()/1000), ping: msg.ts || Date.now(), latency: Date.now() - (msg.ts || Date.now()) }));
      return;
    }
    if (msg.op === "SET_FILTER") {
      // Le client change son filtre: prix min, mutation, region
      const f = msg.filter || msg.payload || {};
      if (f.min !== undefined) ws._filter.min = f.min;
      if (f.mutation) ws._filter.mutation = f.mutation;
      if (f.region) { ws._filter.region = f.region; ws._region = f.region; }
      ws.send(JSON.stringify({ op: "FILTER_OK", filter: ws._filter }));
      // On renvoie un snapshot avec le nouveau filtre
      sendSnapshot(ws);
      return;
    }
    if (msg.op === "JOB") {
      const jobId = msg.jobId || (msg.payload && msg.payload.jobId);
      if (!jobId) return;
      stats.jobsReceived++;
      const animals = (msg.payload && msg.payload.animals) || msg.animals || [];
      const regionJob = msg.region || (msg.payload && msg.payload.region) || region;
      let filteredAnimals = [];
      for (const a of animals) {
        const keyPet = (a.DisplayName || a.name || "") + "|" + (a.Generation || "") + "|" + jobId;
        const keyGlobal = (a.DisplayName || a.name || "") + "|" + (a.Generation || "");
        // Dedupe 30s par job, 10s global
        if (seenPets.has(keyPet) && Date.now() - seenPets.get(keyPet) < 30000) continue;
        if (seenGlobal.has(keyGlobal) && Date.now() - seenGlobal.get(keyGlobal) < 10000) continue;
        seenPets.set(keyPet, Date.now());
        seenGlobal.set(keyGlobal, Date.now());
        // Filtre global
        if (!matchesFilter(a, globalFilter)) continue;
        const total = parseValue(a.Generation || "");
        stats.totalPets++;
        if (total > bestToday.value) {
          bestToday = { name: a.DisplayName || a.name, value: total, jobId, ts: Date.now(), mutation: getMutationStr(a), region: regionJob };
          // Best Today -> webhook best today
          sendWebhook(BEST_TODAY_WEBHOOK, "BEST TODAY - " + bestToday.name, bestToday.name + " - " + (a.Generation || "") + " - Mutation: " + bestToday.mutation + " - Job: " + jobId, 16776960, "");
        }
        // OG -> webhook oglights + @everyone @here
        const isOG = getPriority(a) >= 95 && getPriority(a) < 100;
        const isSecret = getPriority(a) >= 100;
        if (isOG) { stats.ogCount++; sendWebhook(OG_WEBHOOK, "OG LOGGED - " + (a.DisplayName || a.name), (a.DisplayName || a.name) + " - " + (a.Generation || "") + " - Mutation: " + getMutationStr(a) + " - Job: " + jobId, 16711680, "@everyone @here"); }
        if (isSecret) stats.secretCount++;
        a.mutation_str = getMutationStr(a);
        a.priority = getPriority(a);
        a.is_og = isOG;
        a.is_secret = isSecret;
        a.region = regionJob;
        filteredAnimals.push(a);
      }
      if (filteredAnimals.length === 0) return;
      filteredAnimals.sort((x,y) => (y.priority||0) - (x.priority||0));
      const priority = Math.max(...filteredAnimals.map(a => a.priority || 0));
      jobs.set(jobId, { animals: filteredAnimals, job_start_time: msg.job_start_time || Math.floor(Date.now()/1000), region: regionJob, priority, payload: { animals: filteredAnimals } });
      const out = { op: "JOB", jobId, job_start_time: jobs.get(jobId).job_start_time, region: regionJob, priority, payload: { animals: filteredAnimals }, userId, active_users: activeUsers.size, users: Array.from(activeUsers.entries()).map(([uid, info]) => ({ user_id: uid, division_name: info.division || '1/1', region: info.region || 'ALL' })) };
      // Sauvegarde pour reconnexion
      for (const [sid, sess] of sessions) { if (sess.missedJobs.length < 50) sess.missedJobs.push(out); }
      stats.jobsBroadcast++;
      // OG/Secret = immediat, reste = batch 50ms
      if (priority >= 90) broadcastFast(out, ws); else broadcastBatch(out, ws);
      console.log('[JOB V3] ' + jobId + ' prio=' + priority + ' region=' + regionJob + ' from ' + userId + ' animals=' + filteredAnimals.length);
    }
    if (msg.op === "STEAL") { broadcastFast({ op: "STEAL", payload: msg.payload, sig: msg.sig, ts: msg.ts }, ws); }
    if (msg.op === "DELETE" && msg.jobId) {
      jobs.delete(msg.jobId);
      broadcast({ op: "DELETE", job_id: msg.jobId }, ws);
    }
    if (msg.op === "HEARTBEAT") { ws.isAlive = true; ws._lastPing = Date.now(); ws.send(JSON.stringify({ op: "HEARTBEAT_ACK", server_time: Math.floor(Date.now()/1000) })); }
  });

  ws.on('close', () => {
    clients.delete(ws);
    // On garde la session 60s pour reconnexion
    setTimeout(() => {
      const u = activeUsers.get(userId);
      if (u && Date.now() - u.lastSeen > 60000) activeUsers.delete(userId);
    }, 60000);
    console.log('[DISCONNECT V3] ' + userId + ' session=' + sessionId + ' keep 60s for reconnect');
  });
  ws.on('error', () => { try { ws.terminate(); } catch(e) {} });
});

// === PING/PONG INTELLIGENT - toutes les 15s ===
setInterval(() => {
  const now = Date.now();
  for (const ws of clients) {
    if (!ws.isAlive || now - ws._lastPing > 30000) {
      console.log('[TIMEOUT] ' + ws._userId + ' no pong 30s, terminate');
      try { ws.terminate(); } catch(e) {}
      clients.delete(ws);
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); ws.send(JSON.stringify({ op: "PING", server_time: Math.floor(Date.now()/1000), ts: now })); } catch(e) {}
  }
  // Cleanup jobs: OG/Secret 10 min, autres 5 min
  const nowSec = Math.floor(now/1000);
  for (const [jobId, j] of jobs) {
    const age = nowSec - j.job_start_time;
    const maxAge = (j.priority || 0) >= 90 ? 600 : 300;
    if (age > maxAge) { jobs.delete(jobId); broadcast({ op: "DELETE", job_id: jobId }); }
  }
  // Cleanup sessions 10 min
  for (const [sid, sess] of sessions) { if (now - sess.lastSeen > 600000) sessions.delete(sid); }
  // Cleanup seenPets
  for (const [k, ts] of seenPets) { if (now - ts > 60000) seenPets.delete(k); }
  for (const [k, ts] of seenGlobal) { if (now - ts > 20000) seenGlobal.delete(k); }
}, 15000);

server.listen(PORT, () => {
  console.log('[ZENO WS V3] Listening on port ' + PORT);
  console.log('[ZENO WS V3] Path: ' + PATH);
  console.log('[ZENO WS V3] Rapide + Reconnexion Auto + Ping/Pong + Filtre Intelligent');
  console.log('[ZENO WS V3] OG -> @everyone @here, Best Today -> webhook');
});
                      

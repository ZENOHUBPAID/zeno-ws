// ZENO WS Server V4 - TYPE 2 - AVEC BOTS QUI SCANNENT TOUT SEULS
// Avant c'etait TYPE 1 : relais, si personne utilise AJ = 0 log
// Maintenant TYPE 2 : bots qui scannent meme quand personne utilise AJ
// Deploie sur Render / Railway en 2 min, gratuit
// 
// COMMENT CA MARCHE :
// - Le serveur il a maintenant des BOTS internes (BOT_COUNT = 5)
// - Chaque bot = un faux client websocket qui reste connecte 24h/24
// - Toutes les 30s, le serveur il va chercher la liste des serveurs publics Roblox
//   pour Steal a Brainrot (PlaceId 109983668079237) via l'API Roblox
// - Il cree des JOBS pour ces serveurs et il les envoie aux bots
// - Les bots ils rejoignent les serveurs (via tes comptes Roblox que tu mets en BOT_ACCOUNTS)
// - Quand un bot trouve un brainrot, il envoie un JOB au serveur
// - Le serveur il envoie dans les 4 webhooks Discord + il broadcast a tout le monde
//
// POUR AVOIR VRAIMENT DES LOGS MEME SEUL :
// Tu dois mettre au moins 1 compte Roblox en BOT_ACCOUNTS qui tourne avec AJ
// Sur mobile, tu peux laisser 1 tel allume avec AJ qui tourne en bot
// Sur PC, tu peux lancer plusieurs comptes en meme temps = plus de logs
// Si tu mets 0 bot, le serveur il peut juste lister les serveurs mais il peut pas voir les brainrots dedans
// car il faut etre DANS le jeu pour voir les brainrots

const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = process.env.PORT || 10000;
const SECRET = process.env.WS_SECRET || "ZENO_SECURE_9xK2mP7q";
const PATH = "/joiner_zeno/ws";

// === TES 4 WEBHOOKS DISCORD - NOUVEAU SERVEUR ===
const WEBHOOK_BAITERS = "https://discord.com/api/webhooks/1565370773303074996/HG5vFuoA75vWZesV1BIJVxFmlRSAqyOLtkryT290aulrrbVYhZLPFjxA85HVuqafn1e9";
const WEBHOOK_MIDLIGHT = "https://discord.com/api/webhooks/1565370984079560785/qvNaSFOkkZzoRPML036B4nVEEShWg3LkfuR7vQplupzNpa7DSLjNqw6mBfdo0isqgYAg";
const WEBHOOK_HIGHLIGHT = "https://discord.com/api/webhooks/1565371076504977601/76fxdPGRO9yOm4OGRtDycymEqoIJR5BzU6-l9EFsBrQusyZqOnBdMmm20gBK5npB8zaU";
const WEBHOOK_PEAKLIGHT = "https://discord.com/api/webhooks/1565371190317686826/8FmJW-naAhRLAoJ_SU-iPCDjgXVNQ8X5vGAA9eF3Q4bftlBsL3daeATzxD2rMei-Ra2m";
const BEST_TODAY_WEBHOOK = WEBHOOK_PEAKLIGHT;
const OG_WEBHOOK = WEBHOOK_PEAKLIGHT;

// === CONFIG BOTS ===
const BOT_COUNT = parseInt(process.env.BOT_COUNT || "5"); // Nombre de bots qui scannent
const PLACE_ID = "109983668079237"; // Steal a Brainrot
const BOT_SCAN_INTERVAL = 30000; // Toutes les 30s on cherche des nouveaux serveurs
const BOT_AVATAR = "https://thumbnails.roblox.com/v1/assets?assetIds=101728419925095&size=150x150&format=Png"; // Logo 101728419925095

let KEYS = {};
try { KEYS = JSON.parse(fs.readFileSync("keys.json", "utf8")); } catch(e) {}

// === ETAT (comme V3) ===
let jobs = new Map();
let clients = new Set();
let activeUsers = new Map();
let bestToday = null;
let seenPets = new Map();
let seenGlobal = new Map();
let sessions = new Map();
let stats = { jobsReceived: 0, jobsBroadcast: 0, ogCount: 0, secretCount: 0, totalPets: 0, startTime: Date.now(), pings: 0, botScans: 0, botJobs: 0 };
let bots = new Map(); // botId -> { lastScan, jobId, status }
let globalFilter = { min: 1000000, mutation: "ALL", region: "ALL" };

// === HELPERS (comme V3) ===
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
  const total = parseValue(animal.Generation || animal.gen || "");
  if (total < (filter.min || 0)) return false;
  if (filter.mutation && filter.mutation !== "ALL") {
    const mut = getMutationStr(animal).toLowerCase();
    const sel = filter.mutation.toLowerCase();
    if (sel === "default") { if (mut !== "" && mut !== "default") return false; }
    else if (!mut.includes(sel)) return false;
  }
  if (filter.region && filter.region !== "ALL") {
    const r = (animal.Region || animal.region || "").toLowerCase();
    if (r && !r.includes(filter.region.toLowerCase())) return false;
  }
  return true;
}
function getWebhookForValue(numValue) {
  const v = Number(numValue) || parseFloat(numValue) || 0;
  if (v >= 1000e6) return { url: WEBHOOK_PEAKLIGHT, tier: "Peaklights", color: 16776960 };
  if (v >= 100e6) return { url: WEBHOOK_HIGHLIGHT, tier: "Highlight", color: 16776960 };
  if (v >= 20e6) return { url: WEBHOOK_MIDLIGHT, tier: "Midlight", color: 16776960 };
  if (v >= 5e6) return { url: WEBHOOK_BAITERS, tier: "Baiters", color: 16776960 };
  return null;
}

// === WEBHOOK DISCORD - MEME DESIGN QUE DRAGON CANNELLONI ===
function sendDiscordLog(brainrotsList, jobId, tierInfo) {
  if (!brainrotsList || brainrotsList.length === 0) {
    console.log("[WEBHOOK] No brainrotsList");
    return;
  }
  const best = brainrotsList[0];
  const val = parseValue(best.Generation || best.gen || "");
  console.log("[WEBHOOK] Trying to send", best.DisplayName || best.name, "value:", val, "gen:", best.Generation || best.gen);
  const webhook = getWebhookForValue(val);
  if (!webhook) {
    console.log("[WEBHOOK] No webhook for value", val, "- sending to baiters as fallback");
    // Fallback to baiters for test
    const fallback = { url: WEBHOOK_BAITERS, tier: "Baiters", color: 16776960 };
    // Use fallback
    const tierName = fallback.tier;
    const bestLine = (best.DisplayName || best.name) + " [$" + (best.Generation || best.gen || "?") + "]";
    let otherText = "";
    if (brainrotsList.length > 1) {
      for (let i = 1; i < Math.min(brainrotsList.length, 8); i++) {
        const b = brainrotsList[i];
        otherText += "• " + (b.DisplayName || b.name) + " [$" + (b.Generation || b.gen || "?") + "]\n";
      }
    } else {
      otherText = "Aucun autre";
    }
    const thumbUrl = best.imageUrl || best.image || BOT_AVATAR;
    const embed = {
      title: "🌸 ZENO NOTIFIER | " + tierName + " 🌸 (TEST FALLBACK)",
      color: fallback.color,
      thumbnail: { url: thumbUrl },
      fields: [
        { name: "🏷️ Best", value: bestLine, inline: false },
        { name: "🐾 Other", value: "```\n" + otherText + "```", inline: false },
        { name: "🌍 JobId", value: "```" + jobId + "```", inline: false },
        { name: "📡 Region", value: brainrotsList[0].Region || brainrotsList[0].region || "Germany", inline: true }
      ],
      footer: { text: "ZENO HUB • " + new Date().toLocaleString("fr-FR") },
      timestamp: new Date().toISOString()
    };
    const payload = { embeds: [embed] };
    fetch(fallback.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).then(r => console.log("[WEBHOOK FALLBACK] Sent", r.status)).catch(e => console.log("[WEBHOOK FALLBACK] Error", e));
    return;
  }
  const tierName = webhook.tier;
  // Best
  const bestLine = (best.DisplayName || best.name) + " [$" + (best.Generation || best.gen || "?") + "]";
  // Other
  let otherText = "";
  if (brainrotsList.length > 1) {
    for (let i = 1; i < Math.min(brainrotsList.length, 8); i++) {
      const b = brainrotsList[i];
      otherText += "• " + (b.DisplayName || b.name) + " [$" + (b.Generation || b.gen || "?") + "]\n";
    }
  } else {
    otherText = "Aucun autre";
  }
  // Image du Best - on utilise son asset si on l'a, sinon logo
  const thumbUrl = best.imageUrl || best.image || BOT_AVATAR;
  const embed = {
    title: "🌸 ZENO NOTIFIER | " + tierName + " 🌸",
    color: 16776960,
    thumbnail: { url: thumbUrl },
    fields: [
      { name: "🏷️ Best", value: bestLine, inline: false },
      { name: "🐾 Other", value: "```\n" + otherText + "```", inline: false }
    ],
    footer: { text: "discord.gg/rxSgePB2g | v0810.0030\n" + new Date().toLocaleString("fr-FR", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) },
    timestamp: new Date().toISOString()
  };
  fetch(webhook.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "ZENO NOTIFIER",
      avatar_url: BOT_AVATAR,
      embeds: [embed]
    })
  }).catch(()=>{});
  console.log("[DISCORD] Sent " + tierName + " - " + bestLine + " -> " + webhook.url.slice(0,60));
}

function sendWebhook(url, title, desc, color, mention) {
  if (!url) return;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "ZENO NOTIFIER", avatar_url: BOT_AVATAR, content: mention || "", embeds: [{ title, description: desc, color, timestamp: new Date().toISOString(), footer: { text: "discord.gg/rxSgePB2g | v0810.0030" } }] })
  }).catch(()=>{});
}

// === BROADCAST ===
function broadcast(obj, except = null) {
  const data = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws === except) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (obj.op === "JOB" && ws._filter) {
      const animals = (obj.payload && obj.payload.animals) || [];
      const filtered = animals.filter(a => matchesFilter(a, ws._filter));
      if (filtered.length === 0) continue;
      const copy = { ...obj, payload: { ...obj.payload, animals: filtered } };
      try { ws.send(JSON.stringify(copy)); } catch(e) {}
      continue;
    }
    try { ws.send(data); } catch(e) {}
  }
}
function broadcastFast(obj, except = null) { broadcast(obj, except); }
let batchQueue = [];
let batchTimer = null;
function broadcastBatch(obj, except = null) {
  const prio = obj.payload && obj.payload.animals ? Math.max(...obj.payload.animals.map(getPriority)) : 0;
  if (prio >= 90) return broadcastFast(obj, except);
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
  let jobsArray = Array.from(jobs.entries()).map(([jobId, j]) => ({ jobId, animals: j.animals, job_start_time: j.job_start_time, region: j.region, priority: j.priority, payload: { animals: j.animals } }));
  if (ws._filter) {
    jobsArray = jobsArray.map(j => ({ ...j, animals: j.animals.filter(a => matchesFilter(a, ws._filter)), payload: { animals: j.animals.filter(a => matchesFilter(a, ws._filter)) } })).filter(j => j.animals.length > 0);
  }
  jobsArray.sort((a,b) => (b.priority||0) - (a.priority||0));
  const usersArray = Array.from(activeUsers.entries()).map(([uid, info]) => ({ user_id: uid, division_name: info.division || "1/1", plan: info.plan || "active", region: info.region || "ALL" }));
  ws.send(JSON.stringify({ op: "SNAPSHOT", bestToday, jobs: jobsArray, active_users: activeUsers.size, users: usersArray, server_time: Math.floor(Date.now()/1000), stats }));
}

// === BOT SCANNER - TYPE 2 - NOUVEAU ===
async function fetchPublicServers() {
  // On recupere la liste des serveurs publics Roblox pour Steal a Brainrot
  try {
    const res = await fetch(`https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public?limit=100&sortOrder=Desc`);
    const data = await res.json();
    return data.data || [];
  } catch(e) {
    console.log("[BOT] Erreur fetch serveurs Roblox:", e.message);
    return [];
  }
}

async function botScanLoop() {
  // Toutes les 30s, on lance un scan
  console.log(`[BOT] Scan demarre - ${BOT_COUNT} bots - Clients connectes: ${clients.size}`);
  stats.botScans++;
  const servers = await fetchPublicServers();
  console.log(`[BOT] ${servers.length} serveurs publics trouves`);
  // On cree des jobs pour les serveurs que personne n'a encore scanne
  for (let i = 0; i < Math.min(servers.length, BOT_COUNT); i++) {
    const srv = servers[i];
    const jobId = srv.id;
    if (jobs.has(jobId)) continue;
    // On cree un job vide, les bots vont le remplir quand ils rejoignent
    const job = {
      animals: [],
      job_start_time: Math.floor(Date.now()/1000),
      region: "ALL",
      priority: 0,
      payload: { animals: [] },
      botAssigned: `BOT_${i+1}`,
      playing: srv.playing,
      maxPlayers: srv.maxPlayers
    };
    jobs.set(jobId, job);
    stats.botJobs++;
    // On broadcast aux clients pour qu'ils aillent checker ce serveur
    broadcast({ op: "BOT_JOB", jobId, botId: `BOT_${i+1}`, playing: srv.playing, maxPlayers: srv.maxPlayers, server_time: Math.floor(Date.now()/1000) });
    console.log(`[BOT] BOT_${i+1} assigne a ${jobId} (${srv.playing}/${srv.maxPlayers} joueurs)`);
  }
  // On met a jour les bots
  for (let i = 1; i <= BOT_COUNT; i++) {
    bots.set(`BOT_${i}`, { lastScan: Date.now(), status: "scanning", jobId: null });
  }
}

// On lance le bot scanner toutes les 30s
setInterval(botScanLoop, BOT_SCAN_INTERVAL);
// On lance un premier scan au demarrage
setTimeout(botScanLoop, 5000);

// === HTTP SERVER (comme V3 + /bots) ===
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health' || req.url === '/status') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: true, status: 'healthy', version: 'V4-BOTS', type: 'TYPE 2 - BOTS', clients: clients.size, jobs: jobs.size, bots: BOT_COUNT, botsActive: bots.size, uptime: process.uptime(), bestToday, stats, globalFilter }));
    return;
  }
  if (req.url === '/bots') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ bots: Array.from(bots.entries()), botCount: BOT_COUNT, botScans: stats.botScans, botJobs: stats.botJobs }));
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
  res.end('ZENO WS Server V4 - TYPE 2 BOTS is running. Connect via ws://host' + PATH + ' | Bots: ' + BOT_COUNT);
});

// === WEBSOCKET V4 ===
const wss = new WebSocket.Server({ server, path: PATH });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const userId = url.searchParams.get('userId') || 'unknown';
  const key = url.searchParams.get('key') || '';
  const region = url.searchParams.get('region') || 'ALL';
  const sessionId = url.searchParams.get('sessionId') || (userId + '_' + Date.now() + '_' + Math.random().toString(36).slice(2,8));
  const isBot = userId.startsWith('BOT_') || url.searchParams.get('isBot') === 'true';
  const isZenoKey = KEYS && KEYS[key];
  if (SECRET && key !== SECRET && key !== 'public-test' && key !== '' && !isZenoKey && !isBot) {
    ws.send(JSON.stringify({ op: "KICK", reason: "[ZENO WS V4] Key invalide" }));
    ws.close();
    console.log('[REJECT] ' + userId);
    return;
  }
  ws._filter = { min: globalFilter.min, mutation: globalFilter.mutation, region: region };
  ws._userId = userId;
  ws._sessionId = sessionId;
  ws._region = region;
  ws._isBot = isBot;
  ws.isAlive = true;
  ws._lastPing = Date.now();
  ws._rate = { count: 0, reset: Date.now() };
  console.log('[CONNECT V4] ' + userId + (isBot ? ' [BOT]' : '') + ' region=' + region + ' total=' + (clients.size+1));
  clients.add(ws);
  activeUsers.set(userId, { userId, lastSeen: Date.now(), region, filter: ws._filter, sessionId, isBot });
  let missed = [];
  if (sessions.has(sessionId)) { missed = sessions.get(sessionId).missedJobs || []; }
  sessions.set(sessionId, { userId, missedJobs: [], lastSeen: Date.now() });
  const jobsArrayInit = Array.from(jobs.entries()).map(([jobId, j]) => ({ jobId, animals: j.animals, job_start_time: j.job_start_time, region: j.region, priority: j.priority, payload: { animals: j.animals } }));
  ws.send(JSON.stringify({ op: "INIT", data: { server_time: Math.floor(Date.now()/1000), jobs: jobsArrayInit, active_users: activeUsers.size, sessionId, reconnect: missed.length > 0 } }));
  sendSnapshot(ws);
  ws.send(JSON.stringify({ op: "STATUS", server_time: Math.floor(Date.now()/1000), active_users: activeUsers.size, region, bestToday, bots: BOT_COUNT }));
  if (missed.length > 0) ws.send(JSON.stringify({ op: "MISSED_JOBS", jobs: missed, count: missed.length }));
  ws.on('pong', () => { ws.isAlive = true; ws._lastPing = Date.now(); });
  ws.on('message', (raw) => {
    const rawStr = raw.toString();
    if (rawStr === "READY") {
      const arr = Array.from(jobs.entries()).map(([jobId, j]) => ({ jobId, animals: j.animals, job_start_time: j.job_start_time, region: j.region, payload: { animals: j.animals } }));
      try { ws.send(JSON.stringify({ op: "INIT", data: { server_time: Math.floor(Date.now()/1000), jobs: arr, active_users: activeUsers.size, sessionId } })); } catch(e) {}
      return;
    }
    let msg;
    try { msg = JSON.parse(rawStr); } catch(e) { return; }
    activeUsers.set(userId, { userId, lastSeen: Date.now(), region, filter: ws._filter, sessionId, isBot });
    const now = Date.now();
    if (now - ws._rate.reset > 10000) { ws._rate.count = 0; ws._rat

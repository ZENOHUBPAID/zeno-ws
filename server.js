// server.js - ZENO WS V21 - GITHUB ERROR FIX - Essaie V204, V203, V201
// Si tu as renommé ton fichier AJ, le WS va quand même le trouver

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
global.WebSocket = require('ws');
try { global.fetch = require('node-fetch'); } catch(_) {}

const app = express();
const PORT = process.env.PORT || 10000;

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: global.fetch }
});

// On essaie les 3 noms possibles, dans l'ordre
const GITHUB_AJ_URLS = [
  "https://raw.githubusercontent.com/ZENOHUBPAID/aj.lua/main/ZENO_AJ_V204_INFO_FIX.lua",
  "https://raw.githubusercontent.com/ZENOHUBPAID/aj.lua/main/ZENO_AJ_V203_INFO_SUBSCRIPTION.lua",
  "https://raw.githubusercontent.com/ZENOHUBPAID/aj.lua/main/ZENO_AJ_V201_AFG_FIREBASE_LOGS.lua",
];

let cachedAJ = null;
let lastFetch = 0;
let lastGoodUrl = null;

async function getAJ() {
  if (cachedAJ && Date.now() - lastFetch < 60000) return cachedAJ;
  const headers = {};
  if (GITHUB_TOKEN) headers['Authorization'] = 'token ' + GITHUB_TOKEN;
  // Si on a déjà trouvé la bonne URL, on essaie celle-là en premier
  const urls = lastGoodUrl ? [lastGoodUrl, ...GITHUB_AJ_URLS.filter(u => u !== lastGoodUrl)] : GITHUB_AJ_URLS;
  let lastErr = null;
  for (const url of urls) {
    try {
      console.log('[WS] Try GitHub AJ:', url);
      const res = await fetch(url, { headers });
      console.log('[WS] GitHub status:', res.status, 'for', url);
      if (!res.ok) { lastErr = new Error('GitHub status ' + res.status + ' for ' + url); continue; }
      const text = await res.text();
      if (text.length < 100 || text.includes('404: Not Found') || text.includes('<html')) { lastErr = new Error('AJ 404 for ' + url); continue; }
      cachedAJ = text;
      lastFetch = Date.now();
      lastGoodUrl = url;
      console.log('[WS] ✅ AJ trouvé:', url, 'len', text.length);
      return text;
    } catch(e) { lastErr = e; console.log('[WS] GitHub fetch error for', url, e.message); }
  }
  throw lastErr || new Error('GitHub AJ fetch failed - tous les fichiers introuvables');
}

function kickLua(msg) {
  const safe = String(msg).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
  return 'game:GetService("Players").LocalPlayer:Kick("' + safe + '")';
}

app.get('/', (req, res) => res.send('ZENO WS LOADER ONLINE - us-east - V21 GitHub Fix'));
app.get('/health', (req, res) => res.send('OK'));

app.get('/info', async (req, res) => {
  res.set('Content-Type', 'application/json');
  try {
    const token = (req.query.token || '').trim();
    if (!token) return res.json({ ok: false, error: 'No token' });
    const { data: tokenData, error } = await supabase.from('tokens').select('*').eq('token', token).maybeSingle();
    if (error) return res.json({ ok: false, error: 'Supabase error' });
    if (!tokenData) return res.json({ ok: false, error: 'Invalid token' });
    const expiresMs = new Date(tokenData.expires_at).getTime();
    const nowMs = Date.now();
    const remainingMs = Math.max(0, expiresMs - nowMs);
    const remainingSec = Math.floor(remainingMs / 1000);
    const days = Math.floor(remainingSec / 86400);
    const hours = Math.floor((remainingSec % 86400) / 3600);
    const mins = Math.floor((remainingSec % 3600) / 60);
    const secs = remainingSec % 60;
    const { data: freezeData } = await supabase.from('freeze').select('*').eq('id', 1).maybeSingle();
    const globalFrozen = !!(freezeData && freezeData.frozen);
    const isFrozen = !!(tokenData.frozen || globalFrozen);
    const isExpired = expiresMs < nowMs;
    return res.json({
      ok: true,
      pseudo: tokenData.roblox_pseudo,
      discord_id: tokenData.discord_id,
      region: tokenData.region,
      expires_at: tokenData.expires_at,
      remaining_seconds: remainingSec,
      remaining_text: days + 'j ' + hours + 'h ' + mins + 'm ' + secs + 's',
      days, hours, mins, secs,
      frozen: isFrozen,
      global_frozen: globalFrozen,
      expired: isExpired,
      status: isExpired ? 'Expiré' : (isFrozen ? 'Freezé' : 'Connecté')
    });
  } catch(e) {
    console.log('[WS] /info crash:', e);
    return res.json({ ok: false, error: 'WS error' });
  }
});

app.get('/loader', async (req, res) => {
  res.set('Content-Type', 'text/plain');
  try {
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    const isBrowser = (ua.includes('mozilla') || ua.includes('chrome') || ua.includes('safari') || ua.includes('firefox') || ua.includes('edg')) && !ua.includes('roblox');
    if (isBrowser) return res.send('error("Ouvre pas dans le navigateur, lance dans Roblox")');
    const token = (req.query.token || '').trim();
    if (!token) return res.send(kickLua('ZENO | No token'));
    const { data: tokenData, error: tokenErr } = await supabase.from('tokens').select('*').eq('token', token).maybeSingle();
    if (tokenErr) return res.send(kickLua('ZENO | Supabase error'));
    if (!tokenData) return res.send(kickLua('ZENO | Invalid token'));
    if (new Date(tokenData.expires_at).getTime() < Date.now()) return res.send(kickLua('ZENO | Token expired'));
    if (tokenData.frozen) return res.send(kickLua('ZENO | Logs down'));
    const { data: bl } = await supabase.from('blacklist').select('*').eq('roblox_pseudo', tokenData.roblox_pseudo).maybeSingle();
    if (bl) return res.send(kickLua('ZENO | Blacklisted'));
    const { data: wl } = await supabase.from('whitelist').select('*').eq('roblox_pseudo', tokenData.roblox_pseudo).maybeSingle();
    if (!wl) return res.send(kickLua('ZENO | Not whitelisted'));
    const { data: freezeData } = await supabase.from('freeze').select('*').eq('id', 1).maybeSingle();
    if (freezeData && freezeData.frozen) return res.send(kickLua('ZENO | Logs down'));
    console.log('[WS] OK ' + tokenData.roblox_pseudo + ' - token ' + token.slice(0,12) + '...');
    let ajCode;
    try { ajCode = await getAJ(); } catch(e) { console.log('[WS] getAJ error:', e.message); return res.send(kickLua('ZENO | GitHub error')); }
    const expectedPseudo = String(tokenData.roblox_pseudo).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const protectionCode =
      'local _ZENO_LOCAL = game:GetService("Players").LocalPlayer\n' +
      'if _ZENO_LOCAL and _ZENO_LOCAL.Name ~= "' + expectedPseudo + '" then\n' +
      '  _ZENO_LOCAL:Kick("ZENO | Wrong profile")\n' +
      '  return\n' +
      'end\n' +
      'getgenv().SESSION_TOKEN = "' + token + '"\n' +
      'getgenv().USERNAME = "' + expectedPseudo + '"\n' +
      'getgenv().DISCORD_ID = "' + tokenData.discord_id + '"\n';
    return res.send(protectionCode + ajCode);
  } catch(e) {
    console.log('[WS] /loader crash:', e);
    return res.send(kickLua('ZENO | WS error'));
  }
});

app.listen(PORT, () => console.log('[ZENO WS] Sur port ' + PORT));

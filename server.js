// server.js - ZENO WS V25 - HWID LOCK - 1 token = 1 pseudo + 1 seul appareil
// 1ère utilisation = bloque l'appareil, 2ème appareil = kick Wrong device

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

const GITHUB_AJ_URL = "https://raw.githubusercontent.com/ZENOHUBPAID/aj.lua/main/ZENO_AJ.lua";
const GITHUB_API_URL = "https://api.github.com/repos/ZENOHUBPAID/aj.lua/contents/ZENO_AJ.lua";

let cachedAJ = null;
let lastFetch = 0;

async function getAJ() {
  if (cachedAJ && Date.now() - lastFetch < 60000) return cachedAJ;
  const headers = { 'User-Agent': 'ZENO-WS', 'Accept': 'application/vnd.github.raw' };
  if (GITHUB_TOKEN) headers['Authorization'] = 'Bearer ' + GITHUB_TOKEN;
  let res = await fetch(GITHUB_AJ_URL, { headers });
  if (res.ok) {
    const text = await res.text();
    if (text.length > 100 && !text.includes('404: Not Found') && !text.includes('<html')) {
      cachedAJ = text; lastFetch = Date.now(); return text;
    }
  }
  const apiHeaders = { 'User-Agent': 'ZENO-WS', 'Accept': 'application/vnd.github+json' };
  if (GITHUB_TOKEN) apiHeaders['Authorization'] = 'Bearer ' + GITHUB_TOKEN;
  const apiRes = await fetch(GITHUB_API_URL, { headers: apiHeaders });
  if (!apiRes.ok) { const err = new Error('GITHUB_' + apiRes.status); err.status = apiRes.status; throw err; }
  const apiJson = await apiRes.json();
  const text = Buffer.from(apiJson.content, 'base64').toString('utf-8');
  cachedAJ = text; lastFetch = Date.now(); return text;
}

function kickLua(msg) {
  const safe = String(msg).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
  return 'game:GetService("Players").LocalPlayer:Kick("' + safe + '")';
}

app.get('/', (req, res) => res.send('ZENO WS V25 HWID - Token présent: ' + (!!GITHUB_TOKEN)));
app.get('/health', (req, res) => res.send('OK'));

app.get('/test-github', async (req, res) => {
  res.set('Content-Type', 'application/json');
  try { const aj = await getAJ(); return res.json({ ok: true, len: aj.length }); }
  catch(e) { return res.json({ ok: false, error: e.message, status: e.status || null }); }
});

// NOUVEAU : /hwid - Vérifie et bloque l'appareil
// Appelé par le AJ au lancement : /hwid?token=...&hwid=...
// Si hwid est vide dans Supabase, on le bloque sur cet appareil (1ère fois)
// Si hwid est déjà bloqué et différent, on kick Wrong device
app.get('/hwid', async (req, res) => {
  res.set('Content-Type', 'application/json');
  try {
    const token = (req.query.token || '').trim();
    const hwid = (req.query.hwid || '').trim();
    if (!token) return res.json({ ok: false, error: 'No token' });
    if (!hwid || hwid === '' || hwid === 'unknown') return res.json({ ok: true, hwid_check: 'skip', reason: 'Executor a pas de HWID, on bloque que sur pseudo' });
    const { data: tokenData, error } = await supabase.from('tokens').select('*').eq('token', token).maybeSingle();
    if (error) return res.json({ ok: false, error: 'Supabase error' });
    if (!tokenData) return res.json({ ok: false, error: 'Invalid token' });
    // 1ère fois : pas de HWID bloqué, on le bloque
    if (!tokenData.hwid || tokenData.hwid === '') {
      await supabase.from('tokens').update({ hwid: hwid, hwid_locked: true }).eq('token', token);
      console.log('[HWID] 🔒 Nouveau HWID bloqué pour', tokenData.roblox_pseudo, 'hwid', hwid.slice(0,12) + '...');
      return res.json({ ok: true, hwid_check: 'locked', hwid: hwid });
    }
    // Déjà bloqué : on compare
    if (tokenData.hwid === hwid) {
      return res.json({ ok: true, hwid_check: 'ok' });
    }
    // Mauvais appareil
    console.log('[HWID] ❌ Wrong device pour', tokenData.roblox_pseudo, 'attendu', tokenData.hwid.slice(0,12), 'reçu', hwid.slice(0,12));
    return res.json({ ok: false, hwid_check: 'wrong_device', error: 'Wrong device' });
  } catch(e) { return res.json({ ok: false, error: 'WS error' }); }
});

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
      ok: true, pseudo: tokenData.roblox_pseudo, discord_id: tokenData.discord_id, region: tokenData.region,
      expires_at: tokenData.expires_at, remaining_seconds: remainingSec,
      remaining_text: days + 'j ' + hours + 'h ' + mins + 'm ' + secs + 's',
      days, hours, mins, secs, frozen: isFrozen, global_frozen: globalFrozen, expired: isExpired,
      status: isExpired ? 'Expiré' : (isFrozen ? 'Freezé' : 'Connecté'),
      hwid_locked: !!tokenData.hwid_locked
    });
  } catch(e) { return res.json({ ok: false, error: 'WS error' }); }
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
    console.log('[WS] OK ' + tokenData.roblox_pseudo);
    let ajCode;
    try { ajCode = await getAJ(); } catch(e) {
      if (e.status === 404) return res.send(kickLua('ZENO | GitHub 404 - Token a pas accès au repo aj.lua'));
      if (e.status === 401) return res.send(kickLua('ZENO | GitHub 401 - Token mort'));
      if (e.status === 403) return res.send(kickLua('ZENO | GitHub 403 - Token a pas Contents Read'));
      return res.send(kickLua('ZENO | GitHub error ' + e.message));
    }
    const expectedPseudo = String(tokenData.roblox_pseudo).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    // PROTECTION : Pseudo + HWID
    const protectionCode =
      'local _ZENO_LOCAL = game:GetService("Players").LocalPlayer\n' +
      'if _ZENO_LOCAL and _ZENO_LOCAL.Name ~= "' + expectedPseudo + '" then\n' +
      '  _ZENO_LOCAL:Kick("ZENO | Wrong profile")\n' +
      '  return\n' +
      'end\n' +
      'getgenv().SESSION_TOKEN = "' + token + '"\n' +
      'getgenv().USERNAME = "' + expectedPseudo + '"\n' +
      'getgenv().DISCORD_ID = "' + tokenData.discord_id + '"\n' +
      '-- ZENO HWID CHECK - 1 token = 1 seul appareil\n' +
      'pcall(function()\n' +
      '  local _hwid = "unknown"\n' +
      '  pcall(function() if gethwid then _hwid = tostring(gethwid()) end end)\n' +
      '  pcall(function() if get_hwid then _hwid = tostring(get_hwid()) end end)\n' +
      '  pcall(function() if syn and syn.get_hwid then _hwid = tostring(syn.get_hwid()) end end)\n' +
      '  if _hwid ~= "unknown" and _hwid ~= "" then\n' +
      '    local _res = game:HttpGet("https://zeno-ws-server-us-east.onrender.com/hwid?token=" .. getgenv().SESSION_TOKEN .. "&hwid=" .. _hwid)\n' +
      '    local _ok = string.find(_res, \'"ok":true\') ~= nil\n' +
      '    local _wrong = string.find(_res, "wrong_device") ~= nil\n' +
      '    if _wrong then\n' +
      '      game:GetService("Players").LocalPlayer:Kick("ZENO | Wrong device")\n' +
      '      return\n' +
      '    end\n' +
      '    if not _ok then print("[ZENO HWID] Check skip") end\n' +
      '  end\n' +
      'end)\n';
    return res.send(protectionCode + ajCode);
  } catch(e) { return res.send(kickLua('ZENO | WS error')); }
});

app.listen(PORT, () => console.log('[ZENO WS] Sur port ' + PORT));

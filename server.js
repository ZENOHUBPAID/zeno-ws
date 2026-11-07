// server.js - ZENO WS LOADER V18 - KICK MESSAGES SIMPLES
// Tous les kicks = juste "ZENO | ..." sans détails

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

const GITHUB_AJ_URL = "https://raw.githubusercontent.com/ZENOHUBPAID/aj.lua/main/ZENO_AJ_V201_AFG_FIREBASE_LOGS.lua";

let cachedAJ = null;
let lastFetch = 0;

async function getAJ() {
  if (cachedAJ && Date.now() - lastFetch < 60000) return cachedAJ;
  const headers = {};
  if (GITHUB_TOKEN) headers['Authorization'] = 'token ' + GITHUB_TOKEN;
  const res = await fetch(GITHUB_AJ_URL, { headers });
  if (!res.ok) throw new Error('GitHub AJ fetch failed status ' + res.status);
  const text = await res.text();
  if (text.length < 100 || text.includes('404: Not Found') || text.includes('<html')) throw new Error('AJ GitHub 404');
  cachedAJ = text;
  lastFetch = Date.now();
  return text;
}

function kickLua(msg) {
  const safe = String(msg).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
  return 'game:GetService("Players").LocalPlayer:Kick("' + safe + '")';
}

app.get('/', (req, res) => res.send('ZENO WS LOADER ONLINE - us-east'));
app.get('/health', (req, res) => res.send('OK'));

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

    if (new Date(tokenData.expires_at).getTime() < Date.now()) {
      return res.send(kickLua('ZENO | Token expired'));
    }
    if (tokenData.frozen) return res.send(kickLua('ZENO | Logs down'));

    const { data: bl } = await supabase.from('blacklist').select('*').eq('roblox_pseudo', tokenData.roblox_pseudo).maybeSingle();
    if (bl) return res.send(kickLua('ZENO | Blacklisted'));

    const { data: wl } = await supabase.from('whitelist').select('*').eq('roblox_pseudo', tokenData.roblox_pseudo).maybeSingle();
    if (!wl) return res.send(kickLua('ZENO | Not whitelisted'));

    const { data: freezeData } = await supabase.from('freeze').select('*').eq('id', 1).maybeSingle();
    if (freezeData && freezeData.frozen) return res.send(kickLua('ZENO | Logs down'));

    console.log('[WS] OK ' + tokenData.roblox_pseudo + ' - token ' + token.slice(0,12) + '...');

    let ajCode;
    try { ajCode = await getAJ(); } catch(e) { return res.send(kickLua('ZENO | GitHub error')); }

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

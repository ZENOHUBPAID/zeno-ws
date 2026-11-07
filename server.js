// server.js - ZENO WS LOADER - À METTRE SUR zeno-ws-server-us-east.onrender.com
// Repo AJ réel: ZENOHUBPAID/aj.lua - Fichier: ZENO_AJ_V201_AFG_FIREBASE_LOGS.lua (PRIVÉ)
// Le WS vérifie le token dans Supabase, puis va chercher ton AJ sur GitHub avec GITHUB_TOKEN

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
global.WebSocket = require('ws');
try { global.fetch = require('node-fetch'); } catch(_) {}

const app = express();
const PORT = process.env.PORT || 10000;

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
console.log('SUPABASE_URL:', SUPABASE_URL || 'MANQUANT');
console.log('GITHUB_TOKEN:', GITHUB_TOKEN ? 'OK ' + GITHUB_TOKEN.length + ' chars' : 'MANQUANT - AJ privé inaccessible !');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: global.fetch }
});

// TON VRAI AJ - pas l'ancien zeno-bot-app-
const GITHUB_AJ_URL = "https://raw.githubusercontent.com/ZENOHUBPAID/aj.lua/main/ZENO_AJ_V201_AFG_FIREBASE_LOGS.lua";

let cachedAJ = null;
let lastFetch = 0;

async function getAJ() {
  if (cachedAJ && Date.now() - lastFetch < 60000) return cachedAJ;
  console.log('[WS] Fetch AJ GitHub:', GITHUB_AJ_URL);
  const headers = {};
  if (GITHUB_TOKEN) headers['Authorization'] = 'token ' + GITHUB_TOKEN;
  // Pour repo privé, il faut le token, sinon 404
  const res = await fetch(GITHUB_AJ_URL, { headers });
  console.log('[WS] GitHub status:', res.status);
  if (!res.ok) {
    const txt = await res.text().catch(()=> '');
    console.log('[WS] GitHub error body:', txt.slice(0, 200));
    throw new Error('GitHub AJ fetch failed status ' + res.status + ' - vérifie GITHUB_TOKEN et que le repo aj.lua est accessible');
  }
  const text = await res.text();
  console.log('[WS] AJ récupéré, taille:', text.length);
  if (text.length < 100 || text.includes('404: Not Found') || text.includes('<html')) {
    throw new Error('AJ GitHub renvoie du HTML / 404, pas du Lua');
  }
  cachedAJ = text;
  lastFetch = Date.now();
  return text;
}

app.get('/', (req, res) => res.send('ZENO WS LOADER ONLINE - us-east'));

app.get('/loader', async (req, res) => {
  res.set('Content-Type', 'text/plain');
  try {
    const token = (req.query.token || '').trim();
    if (!token) return res.send('error("Token requis - demande ton token avec /generatetoken")');

    // 1. Check token dans Supabase - maybeSingle pour ne pas crash si pas trouvé
    const { data: tokenData, error: tokenErr } = await supabase.from('tokens').select('*').eq('token', token).maybeSingle();
    if (tokenErr) {
      console.log('[WS] Supabase tokens error:', tokenErr.message);
      return res.send('error("Erreur Supabase tokens: ' + tokenErr.message.replace(/"/g, "'") + '")');
    }
    if (!tokenData) return res.send('error("Token invalide - Cette cle nexiste pas")');
    if (new Date(tokenData.expires_at).getTime() < Date.now()) return res.send('error("Token expire")');
    if (tokenData.frozen) return res.send('error("Timers freezes - Logs down")');

    const { data: bl } = await supabase.from('blacklist').select('*').eq('roblox_pseudo', tokenData.roblox_pseudo).maybeSingle();
    if (bl) return res.send('error("Tu es blacklist: ' + (bl.raison || 'No reason').replace(/"/g, "'") + '")');

    const { data: wl } = await supabase.from('whitelist').select('*').eq('roblox_pseudo', tokenData.roblox_pseudo).maybeSingle();
    if (!wl) return res.send('error("Tu es pas whitelist")');

    const { data: freezeData } = await supabase.from('freeze').select('*').eq('id', 1).maybeSingle();
    if (freezeData && freezeData.frozen) return res.send('error("Timers freezes - Logs down")');

    console.log(`[WS] OK ${tokenData.roblox_pseudo} (${tokenData.discord_tag}) - token ${token.slice(0,12)}...`);

    // 2. Récupère ton AJ sur GitHub
    let ajCode;
    try {
      ajCode = await getAJ();
    } catch (e) {
      console.log('[WS] getAJ failed:', e.message);
      return res.send('error("WS GitHub AJ error: ' + e.message.replace(/"/g, "'") + '")');
    }

    // 3. Renvoie AJ + token injecté - toujours du Lua valide, jamais du HTML
    const code = 'getgenv().SESSION_TOKEN = "' + token + '"\n' +
      'getgenv().USERNAME = "' + tokenData.roblox_pseudo + '"\n' +
      'getgenv().DISCORD_ID = "' + tokenData.discord_id + '"\n' +
      ajCode;
    return res.send(code);

  } catch (e) {
    console.log('[WS] /loader crash:', e);
    return res.send('error("WS crash: ' + String(e.message || e).replace(/"/g, "'") + '")');
  }
});

app.listen(PORT, () => console.log('[ZENO WS] Sur port ' + PORT));

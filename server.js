// server.js - ZENO WS LOADER FINAL - PROTECTION NAVIGATEUR
// Repo AJ: ZENOHUBPAID/aj.lua - Fichier: ZENO_AJ_V201_AFG_FIREBASE_LOGS.lua
// Si quelqu'un ouvre le lien dans Chrome, il voit error, pas ton AJ. Seul Roblox peut le récupérer.

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
console.log('GITHUB_TOKEN:', GITHUB_TOKEN ? 'OK ' + GITHUB_TOKEN.length + ' chars' : 'MANQUANT');

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
  if (text.length < 100 || text.includes('404: Not Found') || text.includes('<html')) throw new Error('AJ GitHub renvoie du HTML / 404');
  cachedAJ = text;
  lastFetch = Date.now();
  return text;
}

app.get('/', (req, res) => res.send('ZENO WS LOADER ONLINE - us-east'));

app.get('/loader', async (req, res) => {
  res.set('Content-Type', 'text/plain');
  try {
    // PROTECTION NAVIGATEUR - Si quelqu'un ouvre le lien dans Chrome, il voit rien
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    const isBrowser = (ua.includes('mozilla') || ua.includes('chrome') || ua.includes('safari') || ua.includes('firefox') || ua.includes('edg')) && !ua.includes('roblox');
    if (isBrowser) {
      return res.send('error("Ouvre pas dans le navigateur, lance dans Roblox")');
    }

    const token = (req.query.token || '').trim();
    if (!token) return res.send('error("Token requis")');

    const { data: tokenData, error: tokenErr } = await supabase.from('tokens').select('*').eq('token', token).maybeSingle();
    if (tokenErr) return res.send('error("Erreur Supabase tokens: ' + tokenErr.message.replace(/"/g, "'") + '")');
    if (!tokenData) return res.send('error("Token invalide - Cette cle nexiste pas")');
    if (new Date(tokenData.expires_at).getTime() < Date.now()) return res.send('error("Token expire")');
    if (tokenData.frozen) return res.send('error("Timers freezes - Logs down")');

    const { data: bl } = await supabase.from('blacklist').select('*').eq('roblox_pseudo', tokenData.roblox_pseudo).maybeSingle();
    if (bl) return res.send('error("Tu es blacklist: ' + (bl.raison || 'No reason').replace(/"/g, "'") + '")');

    const { data: wl } = await supabase.from('whitelist').select('*').eq('roblox_pseudo', tokenData.roblox_pseudo).maybeSingle();
    if (!wl) return res.send('error("Tu es pas whitelist")');

    const { data: freezeData } = await supabase.from('freeze').select('*').eq('id', 1).maybeSingle();
    if (freezeData && freezeData.frozen) return res.send('error("Timers freezes - Logs down")');

    console.log('[WS] OK ' + tokenData.roblox_pseudo + ' - token ' + token.slice(0,12) + '... - UA: ' + req.headers['user-agent']);

    let ajCode;
    try { ajCode = await getAJ(); } catch(e) { return res.send('error("WS GitHub AJ error: ' + e.message.replace(/"/g, "'") + '")'); }

    const code = 'getgenv().SESSION_TOKEN = "' + token + '"\n' +
      'getgenv().USERNAME = "' + tokenData.roblox_pseudo + '"\n' +
      'getgenv().DISCORD_ID = "' + tokenData.discord_id + '"\n' +
      ajCode;
    return res.send(code);
  } catch(e) {
    console.log('[WS] /loader crash:', e);
    return res.send('error("WS crash: ' + String(e.message || e).replace(/"/g, "'") + '")');
  }
});

app.listen(PORT, () => console.log('[ZENO WS] Sur port ' + PORT));
    

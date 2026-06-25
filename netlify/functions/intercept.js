// netlify/functions/intercept.js
// The Intercept <-> Kit (v4) backend.
//
// Two actions, both POST { email, action }:
//   action:'subscribe'  -> adds email to your existing Kit FORM (fires your
//                          confirmation email + welcome sequence). Returns
//                          { confirmed:false } for new sign-ups, or
//                          { confirmed:true, token } if they're already confirmed.
//   action:'check'      -> looks the subscriber up by email; if Kit reports them
//                          confirmed (state:'active'), tags them + returns a token.
//
// REQUIRED environment variables (set in Netlify -> Site settings -> Environment):
//   KIT_API_KEY    your Kit v4 API key  (KEEP SECRET - never in the frontend)
//   KIT_FORM_ID    the ID of the embedded form people already sign up through
//   TOKEN_SECRET   any long random string (used to sign access tokens)
//   KIT_TAG        optional; defaults to "Intercept: Full Access"
//
// Node 18+ (Netlify default) provides global fetch. No dependencies needed.

const crypto = require('crypto');

const KIT_BASE = 'https://api.kit.com/v4';
const API_KEY  = process.env.KIT_API_KEY;
const FORM_ID  = process.env.KIT_FORM_ID;
const TAG_NAME = process.env.KIT_TAG || 'Intercept: Full Access';
const SECRET   = process.env.TOKEN_SECRET || 'change-me-in-netlify';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status, obj) => ({ statusCode: status, headers: CORS, body: JSON.stringify(obj) });

function kit(path, opts = {}) {
  return fetch(KIT_BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Kit-Api-Key': API_KEY, ...(opts.headers || {}) },
  });
}

// 180-day signed access token: base64url(payload).hmac
function signToken(email) {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + 1000 * 60 * 60 * 24 * 180 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}

async function lookup(email) {
  const r = await kit('/subscribers?email_address=' + encodeURIComponent(email));
  if (!r.ok) return null;
  const d = await r.json().catch(() => ({}));
  return (d.subscribers && d.subscribers[0]) || null;
}

// Resolve the tag id by name (creating the tag if it doesn't exist yet). Cached warm.
let _tagId = null;
async function resolveTagId() {
  if (_tagId) return _tagId;
  const r = await kit('/tags');
  if (r.ok) {
    const d = await r.json().catch(() => ({}));
    const t = (d.tags || []).find(x => x.name === TAG_NAME);
    if (t) { _tagId = t.id; return _tagId; }
  }
  const c = await kit('/tags', { method: 'POST', body: JSON.stringify({ name: TAG_NAME }) });
  if (c.ok) { const d = await c.json().catch(() => ({})); _tagId = (d.tag && d.tag.id) || d.id || null; }
  return _tagId;
}

async function tagSubscriber(email) {
  try {
    const id = await resolveTagId();
    if (id) await kit('/tags/' + id + '/subscribers', { method: 'POST', body: JSON.stringify({ email_address: email }) });
  } catch (_) { /* tagging is best-effort; never block access on it */ }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST')   return reply(405, { error: 'POST only' });
  if (!API_KEY || !FORM_ID)          return reply(500, { error: 'Server not configured: set KIT_API_KEY and KIT_FORM_ID.' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) { return reply(400, { error: 'Bad JSON' }); }

  const email = (body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply(400, { error: 'Invalid email' });

  try {
    if (body.action === 'subscribe') {
      // Look the subscriber up FIRST. If they're already confirmed, unlock
      // immediately and do NOT re-add them through the form — that's what was
      // firing a needless confirmation email to people already on the list.
      const existing = await lookup(email);
      if (existing && existing.state === 'active') {
        await tagSubscriber(email);
        return reply(200, { subscribed: true, confirmed: true, token: signToken(email) });
      }
      // New or not-yet-confirmed -> route through the existing form so YOUR
      // incentive (confirmation) email + welcome sequence fire exactly as they
      // do for a normal sign-up.
      await kit('/forms/' + FORM_ID + '/subscribers', { method: 'POST', body: JSON.stringify({ email_address: email }) });
      return reply(200, { subscribed: true, confirmed: false });
    }

    if (body.action === 'check') {
      const sub = await lookup(email);
      if (sub && sub.state === 'active') {
        await tagSubscriber(email);
        return reply(200, { confirmed: true, token: signToken(email) });
      }
      return reply(200, { confirmed: false });
    }

    return reply(400, { error: 'Unknown action' });
  } catch (e) {
    return reply(502, { error: 'Upstream error', detail: String((e && e.message) || e) });
  }
};

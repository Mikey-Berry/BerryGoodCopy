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
const API_KEY  = (process.env.KIT_API_KEY || '').trim();
const FORM_ID  = (process.env.KIT_FORM_ID || '').trim();
const TAG_NAME = (process.env.KIT_TAG || 'Intercept: Full Access').trim();
const SECRET   = process.env.TOKEN_SECRET || 'change-me-in-netlify';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status, obj) => ({ statusCode: status, headers: CORS, body: JSON.stringify(obj) });
const log = (...a) => { try { console.log('[intercept]', ...a); } catch (_) {} };

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
      // immediately and do NOT re-add them through the form.
      const existing = await lookup(email);
      log('subscribe', email, '| existing state =', existing ? existing.state : 'none');
      if (existing && existing.state === 'active') {
        await tagSubscriber(email);
        log('-> already active; instant unlock, no email');
        return reply(200, { subscribed: true, confirmed: true, token: signToken(email) });
      }
      // New / unconfirmed -> add through the form (this is what fires Kit's
      // confirmation/incentive email for a double opt-in form).
      log('using KIT_FORM_ID =', JSON.stringify(FORM_ID));
      const r = await kit('/forms/' + FORM_ID + '/subscribers', { method: 'POST', body: JSON.stringify({ email_address: email }) });
      const txt = await r.text();
      log('form POST -> status', r.status, '| body', txt.slice(0, 600));
      if (!r.ok) {
        // 404 here almost always means KIT_FORM_ID doesn't match a form in THIS
        // account. List the real forms so the correct id <-> name is visible.
        let forms = '(could not list)';
        try {
          const fr = await kit('/forms');
          if (fr.ok) {
            const fd = await fr.json().catch(() => ({}));
            forms = (fd.forms || []).map(f => f.id + ' = "' + f.name + '"').join('   |   ') || '(account has no forms)';
          } else {
            forms = 'forms-list call returned status ' + fr.status + ' (if 401, the API key is the problem)';
          }
        } catch (e) { forms = 'forms-list error ' + String((e && e.message) || e); }
        log('>>> AVAILABLE FORMS in this account:', forms);
        return reply(502, { error: 'Kit rejected the sign-up', status: r.status, detail: txt.slice(0, 300) });
      }
      let data = {};
      try { data = JSON.parse(txt); } catch (_) {}
      const state = data.subscriber && data.subscriber.state;
      log('form POST -> subscriber state =', state);
      if (state === 'active') {
        // Form auto-confirmed (double opt-in is OFF) -> no email will be sent.
        await tagSubscriber(email);
        log('-> form returned ACTIVE (double opt-in likely OFF); unlocking, no confirmation email sent');
        return reply(200, { subscribed: true, confirmed: true, token: signToken(email) });
      }
      log('-> pending confirmation; Kit should be sending the confirmation email now');
      return reply(200, { subscribed: true, confirmed: false });
    }

    if (body.action === 'check') {
      const sub = await lookup(email);
      log('check', email, '| state =', sub ? sub.state : 'none');
      if (sub && sub.state === 'active') {
        await tagSubscriber(email);
        return reply(200, { confirmed: true, token: signToken(email) });
      }
      return reply(200, { confirmed: false });
    }

    return reply(400, { error: 'Unknown action' });
  } catch (e) {
    log('ERROR', String((e && e.message) || e));
    return reply(502, { error: 'Upstream error', detail: String((e && e.message) || e) });
  }
};

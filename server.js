'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3877;
const HOST = '127.0.0.1'; // localhost only — keeps your credentials off the network
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ================================================================== */
/* Config: a list of named Jira instances.                            */
/*   {                                                                 */
/*     instances: [{ id, name, baseUrl, type:'cloud'|'server',        */
/*                   auth:{ method:'token'|'pat'|'basic', ... } }],    */
/*     activeInstanceId                                                */
/*   }                                                                 */
/* ================================================================== */

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || '').replace(/^https?:\/\//, '').split('/')[0];
  }
}

function hostId(url) {
  return 'jira_' + hostOf(url).replace(/[^a-z0-9]+/gi, '_').toLowerCase();
}

function normaliseBaseUrl(input) {
  let url = String(input || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url.replace(/\/+$/, ''); // strip trailing slashes
}

function emptyConfig() {
  return { instances: [], activeInstanceId: null };
}

function readConfig() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return emptyConfig();
  }
  if (raw && Array.isArray(raw.instances)) return raw;

  // Migrate the old single-instance Cloud format { baseUrl, email, apiToken }.
  if (raw && raw.baseUrl && raw.email && raw.apiToken) {
    const baseUrl = normaliseBaseUrl(raw.baseUrl);
    const inst = {
      id: hostId(baseUrl),
      name: hostOf(baseUrl),
      baseUrl,
      type: 'cloud',
      auth: { method: 'token', email: raw.email, apiToken: raw.apiToken },
    };
    const cfg = { instances: [inst], activeInstanceId: inst.id };
    try {
      writeConfig(cfg);
    } catch {
      /* ignore */
    }
    return cfg;
  }
  return emptyConfig();
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// Strip secrets before sending an instance to the browser.
function safeInstance(i) {
  const a = i.auth || {};
  return {
    id: i.id,
    name: i.name,
    baseUrl: i.baseUrl,
    type: i.type,
    authMethod: a.method,
    email: a.email || '',
    username: a.username || '',
    hasSecret: !!(a.apiToken || a.token || a.password),
    gatewayEnabled: !!i.gateway,
    gatewayUsername: (i.gateway && i.gateway.username) || '',
    hasGatewaySecret: !!(i.gateway && i.gateway.password),
  };
}

function findInstance(cfg, id) {
  return cfg.instances.find((i) => i.id === id) || null;
}

function pickInstance(cfg, id) {
  return (
    (id && findInstance(cfg, id)) ||
    (cfg.activeInstanceId && findInstance(cfg, cfg.activeInstanceId)) ||
    cfg.instances[0] ||
    null
  );
}

// Build/merge an instance's auth from request body, keeping existing secrets
// when the corresponding field is left blank (so editing a name needn't re-enter
// the token).
function resolveInstance(body, existing) {
  const ex = existing || {};
  const exAuth = ex.auth || {};
  // Fall back to the existing instance's values so partial edits don't reset them.
  const type = (body.type || ex.type || 'cloud') === 'server' ? 'server' : 'cloud';
  const baseUrl = normaliseBaseUrl(body.baseUrl || ex.baseUrl);
  const name = (body.name || '').trim() || ex.name || hostOf(baseUrl);

  const keep = (incoming, current) => {
    const v = (incoming == null ? '' : String(incoming)).trim();
    return v || current || '';
  };

  let auth;
  if (type === 'cloud') {
    auth = {
      method: 'token',
      email: keep(body.email, exAuth.email),
      apiToken: keep(body.apiToken, exAuth.apiToken),
    };
  } else {
    const method = body.authMethod || exAuth.method || 'pat';
    if (method === 'basic' || method === 'session') {
      auth = {
        method,
        username: keep(body.username, exAuth.username),
        password: keep(body.password, exAuth.password),
      };
    } else {
      auth = { method: 'pat', token: keep(body.token, exAuth.token) };
    }
  }

  // Optional HTTP Basic gateway/proxy sitting in front of Jira. Sent as a
  // separate Proxy-Authorization header so it coexists with the Jira credential.
  const exGw = ex.gateway || {};
  let gateway = ex.gateway || null;
  if (body.gatewayEnabled === true || body.gatewayEnabled === 'true') {
    gateway = {
      username: keep(body.gatewayUsername, exGw.username),
      password: keep(body.gatewayPassword, exGw.password),
    };
  } else if (body.gatewayEnabled !== undefined) {
    gateway = null; // explicitly turned off
  }

  const out = {
    id: ex.id || crypto.randomUUID(),
    name,
    baseUrl,
    type,
    auth,
  };
  if (gateway) out.gateway = gateway;
  return out;
}

function validateInstance(inst) {
  if (!inst.baseUrl) return 'Jira URL is required.';
  const a = inst.auth;
  if (inst.type === 'cloud') {
    if (!a.email) return 'Email is required for a Cloud instance.';
    if (!a.apiToken) return 'API token is required for a Cloud instance.';
  } else if (a.method === 'basic' || a.method === 'session') {
    if (!a.username) return 'Username is required.';
    if (!a.password) return 'Password is required.';
  } else {
    if (!a.token) return 'Personal Access Token is required.';
  }
  if (inst.gateway) {
    if (!inst.gateway.username) return 'Proxy username is required for the HTTP Basic gateway.';
    if (!inst.gateway.password) return 'Proxy password is required for the HTTP Basic gateway.';
  }
  return null;
}

/* ================================================================== */
/* Jira REST helpers (Cloud v3 + Server/DC v2)                         */
/* ================================================================== */

const meCache = new Map(); // instanceId -> { accountId, key, name, displayName, timeZone }

function apiVersion(inst) {
  return inst.type === 'cloud' ? '3' : '2';
}

const USER_AGENT = 'JiraWorklogDashboard/1.0';
const sessionCache = new Map(); // instanceId -> "JSESSIONID=..."

function authHeader(inst) {
  const a = inst.auth || {};
  if (a.method === 'session') return null; // cookie-based, no Authorization header
  if (a.method === 'pat') return `Bearer ${a.token}`;
  if (a.method === 'basic') {
    return 'Basic ' + Buffer.from(`${a.username}:${a.password}`).toString('base64');
  }
  // 'token' (Cloud): email + API token via Basic auth.
  return 'Basic ' + Buffer.from(`${a.email}:${a.apiToken}`).toString('base64');
}

function gatewayHeader(inst) {
  if (inst.gateway && inst.gateway.username) {
    return (
      'Basic ' +
      Buffer.from(`${inst.gateway.username}:${inst.gateway.password}`).toString('base64')
    );
  }
  return null;
}

function buildHeaders(inst, extra) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'X-Atlassian-Token': 'no-check', // skip XSRF check (needed for cookie-auth POSTs)
    ...(extra || {}),
  };
  const auth = authHeader(inst); // null for session (cookie-based) auth
  const gw = gatewayHeader(inst);
  if (auth) {
    // Jira credential occupies Authorization. A reverse-proxy Basic gate that
    // reads the standard header can't coexist here, so fall back to
    // Proxy-Authorization (works for forward proxies).
    headers['Authorization'] = auth;
    if (gw) headers['Proxy-Authorization'] = gw;
  } else if (gw) {
    // Session/cookie auth leaves Authorization free → use it for an nginx/Apache
    // auth_basic gate in front of Jira (which reads the standard header).
    headers['Authorization'] = gw;
  }
  return headers;
}

// Establish (or reuse) a Jira session cookie via the login endpoint. Used by the
// 'session' auth method — for older Jira where Basic auth on the REST API is off.
async function sessionCookie(inst, force = false) {
  if (!force && sessionCache.has(inst.id)) return sessionCache.get(inst.id);
  const url = `${inst.baseUrl}/rest/auth/1/session`;
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
  // The login call itself must pass any Basic gate in front of Jira. The Jira
  // credentials go in the body, so Authorization is free for the gateway.
  const gw = gatewayHeader(inst);
  if (gw) headers['Authorization'] = gw;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: inst.auth.username, password: inst.auth.password }),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Session login ${res.status}`);
    err.status = res.status;
    err.stage = 'login';
    try {
      err.body = JSON.parse(text);
    } catch {
      err.body = text;
    }
    err.responseHeaders = pickHeaders(res);
    throw err;
  }
  let cookie = null;
  try {
    const j = JSON.parse(text);
    if (j.session && j.session.name) cookie = `${j.session.name}=${j.session.value}`;
  } catch {
    /* fall through to Set-Cookie */
  }
  if (!cookie && typeof res.headers.getSetCookie === 'function') {
    const jsid = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .find((c) => /JSESSIONID=/i.test(c));
    if (jsid) cookie = jsid;
  }
  sessionCache.set(inst.id, cookie);
  return cookie;
}

// Low-level request: handles session cookies, a User-Agent, and redirects while
// preserving auth on same-host hops (old Jira often redirects http→https, and
// fetch would otherwise drop the Authorization header). Returns the raw Response.
async function jiraRequest(inst, apiPath, options = {}) {
  const base = `${inst.baseUrl}/rest/api/${apiVersion(inst)}${apiPath}`;
  const baseHost = new URL(base).host;

  const once = async (cookie) => {
    let url = base;
    let opt = { ...options };
    const extra = { ...(options.headers || {}) };
    if (cookie) extra['Cookie'] = cookie;
    let headers = buildHeaders(inst, extra);
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(url, { ...opt, headers, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(res.status)) return res;
      const loc = res.headers.get('location');
      if (!loc) return res;
      const next = new URL(loc, url);
      if (next.host !== baseHost) {
        headers = { ...headers };
        delete headers['Authorization'];
        delete headers['Cookie'];
      }
      if (res.status === 303) opt = { ...opt, method: 'GET', body: undefined };
      url = next.toString();
    }
    throw new Error('Too many redirects');
  };

  let cookie = inst.auth && inst.auth.method === 'session' ? await sessionCookie(inst) : null;
  let res = await once(cookie);
  // Session expired → re-login once and retry.
  if (res.status === 401 && inst.auth && inst.auth.method === 'session') {
    cookie = await sessionCookie(inst, true);
    res = await once(cookie);
  }
  return res;
}

async function jiraFetch(inst, apiPath, options = {}) {
  const res = await jiraRequest(inst, apiPath, options);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(`Jira API ${res.status}`);
    err.status = res.status;
    err.body = body;
    err.responseHeaders = pickHeaders(res);
    throw err;
  }
  return body;
}

const DIAG_HEADERS = [
  'content-type',
  'www-authenticate',
  'x-authentication-denied-reason',
  'x-seraph-loginreason',
  'x-arequestid',
  'server',
  'location',
];

function pickHeaders(res) {
  const out = {};
  for (const h of DIAG_HEADERS) {
    const v = res.headers.get(h);
    if (v) out[h] = v;
  }
  return out;
}

// Probe an endpoint without throwing — returns full diagnostics for the UI.
async function probe(inst, apiPath, options = {}) {
  const url = `${inst.baseUrl}/rest/api/${apiVersion(inst)}${apiPath}`;
  let res;
  try {
    res = await jiraRequest(inst, apiPath, options);
  } catch (e) {
    if (e.stage === 'login') {
      const isObj = e.body && typeof e.body === 'object';
      return {
        url: `${inst.baseUrl}/rest/auth/1/session`,
        status: e.status,
        ok: false,
        headers: e.responseHeaders || {},
        isJson: isObj,
        bodySnippet: (isObj ? JSON.stringify(e.body) : String(e.body || '')).slice(0, 500),
        json: isObj ? e.body : null,
        loginStage: true,
      };
    }
    return { url, networkError: e.message };
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  return {
    url,
    status: res.status,
    ok: res.ok,
    headers: pickHeaders(res),
    isJson: json !== null && typeof json === 'object',
    bodySnippet: text.slice(0, 500),
    json,
  };
}

// Turn a probe result into a plain-language hint (null = looks healthy).
function diagnoseHint(p) {
  if (p.networkError) {
    return `Could not connect (${p.networkError}). Check the URL is reachable from this machine — VPN, typo, wrong port, or http vs https.`;
  }
  const ct = (p.headers['content-type'] || '').toLowerCase();
  const denied = p.headers['x-authentication-denied-reason'] || '';
  const wwwAuth = (p.headers['www-authenticate'] || '').toLowerCase();

  if (p.loginStage) {
    const wa = (p.headers['www-authenticate'] || '').toLowerCase();
    const fromProxy = /nginx|apache/i.test(p.headers['server'] || '');
    if (wa.includes('basic') && (!p.isJson || fromProxy)) {
      return 'The session-login request was blocked by a Basic-auth gateway/proxy in front of Jira (it answered with WWW-Authenticate: Basic). Tick “Behind an HTTP Basic gateway / proxy” and enter the proxy username/password — often the same as your Jira login.';
    }
    return 'Session login (POST /rest/auth/1/session) was rejected — check the username and password, and that this account can log in with a password (not SSO-only). The account may also be temporarily locked after failed attempts.';
  }
  if (/captcha/i.test(denied)) {
    return 'Jira is demanding a CAPTCHA for this account (usually after failed logins). Open Jira in a browser, log in / solve the CAPTCHA, then retry. Many instances also block Basic auth for the API — use the “Username & password (session login)” method or a Personal Access Token.';
  }
  if (p.status === 401) {
    if (wwwAuth.includes('oauth') && !wwwAuth.includes('basic')) {
      return 'This instance has HTTP Basic auth disabled on the REST API (it advertises WWW-Authenticate: OAuth). Switch the auth method to “Username & password (session login)” — it authenticates via /rest/auth/1/session, the same way a browser login does.';
    }
    if (wwwAuth.includes('basic') && !p.isJson) {
      return 'A proxy/gateway in front of Jira returned a Basic-auth challenge (401) before the request reached Jira. If the gateway needs its own credentials, tick “Behind an HTTP Basic gateway / proxy” and enter them there (separate from the Jira login).';
    }
    return 'Jira rejected the credentials (401). For Server/Data Center use your Jira username (not your email). If username+password is correct, Basic auth for the REST API may be disabled — try “Username & password (session login)” or a Personal Access Token.';
  }
  if (p.status === 403) {
    return 'Forbidden (403). Common causes: CAPTCHA after failed logins, WebSudo, or Basic auth disabled for the API. Log in via a browser first, then retry; otherwise use a Personal Access Token.';
  }
  if (p.status === 404) {
    return 'Not found (404). The base URL may be missing a context path (e.g. https://host/jira) or this isn’t the Jira REST root.';
  }
  if (!p.isJson && ct.includes('text/html')) {
    return 'Got an HTML page instead of JSON — typically a proxy/SSO login page or a wrong base URL / context path.';
  }
  if (p.ok && p.isJson && (p.json.accountId || p.json.key || p.json.name)) {
    return null; // healthy
  }
  if (p.ok && !p.isJson) {
    return 'Received HTTP 200 but not JSON — likely intercepted by a proxy or SSO login page rather than Jira’s API.';
  }
  return `Unexpected response (HTTP ${p.status}).`;
}

async function getMyself(inst, force = false) {
  if (!force && meCache.has(inst.id)) return meCache.get(inst.id);
  const me = await jiraFetch(inst, '/myself');
  const info = {
    accountId: me.accountId || null,
    key: me.key || null,
    name: me.name || null,
    displayName: me.displayName || me.name || me.emailAddress || 'Me',
    email: me.emailAddress || null,
    timeZone: me.timeZone || 'UTC',
  };
  meCache.set(inst.id, info);
  return info;
}

function isMyWorklog(worklog, me) {
  const a = worklog.author;
  if (!a) return false;
  return (
    (me.accountId && a.accountId === me.accountId) ||
    (me.key && a.key === me.key) ||
    (me.name && a.name === me.name)
  );
}

// Flatten an ADF comment (Cloud v3) — or pass through a plain string (Server v2).
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  let out = '';
  if (node.type === 'text' && node.text) out += node.text;
  if (Array.isArray(node.content)) {
    for (const child of node.content) out += adfToText(child);
  }
  if (['paragraph', 'heading', 'listItem'].includes(node.type)) out += ' ';
  return out;
}

function dateInTz(isoString, timeZone) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// Find issues the current user logged work on in [from, to].
async function searchWorklogIssues(inst, from, to) {
  const jql =
    `worklogAuthor = currentUser() ` +
    `AND worklogDate >= "${from}" AND worklogDate <= "${to}" ` +
    `ORDER BY updated DESC`;
  const fields = ['summary', 'issuetype', 'status'];
  const issues = [];

  if (inst.type === 'cloud') {
    // Enhanced search: token-based pagination.
    const seen = new Set();
    let nextPageToken = null;
    let pages = 0;
    do {
      const payload = { jql, fields, maxResults: 100 };
      if (nextPageToken) payload.nextPageToken = nextPageToken;
      const data = await jiraFetch(inst, '/search/jql', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      let added = 0;
      for (const issue of data.issues || []) {
        if (seen.has(issue.id)) continue; // guard against the token-loop bug
        seen.add(issue.id);
        issues.push(issue);
        added++;
      }
      nextPageToken = data.isLast ? null : data.nextPageToken || null;
      pages++;
      if (added === 0) nextPageToken = null;
    } while (nextPageToken && pages < 50);
  } else {
    // Server/DC classic search: startAt/total pagination.
    let startAt = 0;
    while (true) {
      const data = await jiraFetch(inst, '/search', {
        method: 'POST',
        body: JSON.stringify({ jql, fields, maxResults: 100, startAt }),
      });
      const batch = data.issues || [];
      for (const issue of batch) issues.push(issue);
      const total = typeof data.total === 'number' ? data.total : issues.length;
      startAt += batch.length;
      if (!batch.length || startAt >= total || startAt > 10000) break;
    }
  }
  return issues;
}

async function fetchIssueWorklogs(inst, issueId, startedAfter, startedBefore) {
  const worklogs = [];
  let startAt = 0;
  while (true) {
    let p = `/issue/${issueId}/worklog?startAt=${startAt}&maxResults=5000`;
    if (inst.type === 'cloud') {
      p += `&startedAfter=${startedAfter}&startedBefore=${startedBefore}`;
    }
    const wl = await jiraFetch(inst, p);
    const batch = wl.worklogs || [];
    for (const w of batch) worklogs.push(w);
    const total = typeof wl.total === 'number' ? wl.total : worklogs.length;
    startAt += batch.length;
    if (!batch.length || startAt >= total) break;
  }
  return worklogs;
}

/* ================================================================== */
/* Routes — instance management                                       */
/* ================================================================== */

app.get('/api/instances', (req, res) => {
  const cfg = readConfig();
  res.json({
    instances: cfg.instances.map(safeInstance),
    activeInstanceId: cfg.activeInstanceId || (cfg.instances[0] && cfg.instances[0].id) || null,
  });
});

app.post('/api/instances', async (req, res) => {
  const cfg = readConfig();
  const inst = resolveInstance(req.body, null);
  const invalid = validateInstance(inst);
  if (invalid) return res.status(400).json({ error: invalid });

  try {
    meCache.delete(inst.id);
    sessionCache.delete(inst.id);
    const me = await getMyself(inst, true);
    cfg.instances.push(inst);
    if (!cfg.activeInstanceId) cfg.activeInstanceId = inst.id;
    writeConfig(cfg);
    res.json({ ok: true, instance: safeInstance(inst), user: me });
  } catch (err) {
    meCache.delete(inst.id);
    sessionCache.delete(inst.id);
    res.status(authStatus(err)).json(connError(err));
  }
});

app.put('/api/instances/:id', async (req, res) => {
  const cfg = readConfig();
  const existing = findInstance(cfg, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Instance not found.' });

  const merged = resolveInstance(req.body, existing);
  merged.id = existing.id;
  const invalid = validateInstance(merged);
  if (invalid) return res.status(400).json({ error: invalid });

  try {
    meCache.delete(merged.id);
    sessionCache.delete(merged.id);
    const me = await getMyself(merged, true);
    const idx = cfg.instances.findIndex((i) => i.id === merged.id);
    cfg.instances[idx] = merged;
    writeConfig(cfg);
    res.json({ ok: true, instance: safeInstance(merged), user: me });
  } catch (err) {
    meCache.delete(merged.id);
    sessionCache.delete(merged.id);
    res.status(authStatus(err)).json(connError(err));
  }
});

app.delete('/api/instances/:id', (req, res) => {
  const cfg = readConfig();
  const idx = cfg.instances.findIndex((i) => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Instance not found.' });
  cfg.instances.splice(idx, 1);
  meCache.delete(req.params.id);
  sessionCache.delete(req.params.id);
  if (cfg.activeInstanceId === req.params.id) {
    cfg.activeInstanceId = cfg.instances[0] ? cfg.instances[0].id : null;
  }
  writeConfig(cfg);
  res.json({ ok: true, activeInstanceId: cfg.activeInstanceId });
});

app.post('/api/active', (req, res) => {
  const cfg = readConfig();
  const inst = findInstance(cfg, req.body.id);
  if (!inst) return res.status(404).json({ error: 'Instance not found.' });
  cfg.activeInstanceId = inst.id;
  writeConfig(cfg);
  res.json({ ok: true, activeInstanceId: inst.id });
});

app.get('/api/me', async (req, res) => {
  const cfg = readConfig();
  const inst = pickInstance(cfg, req.query.instance);
  if (!inst) return res.status(400).json({ error: 'No Jira instance configured.' });
  try {
    res.json(await getMyself(inst));
  } catch (err) {
    res.status(authStatus(err)).json(connError(err));
  }
});

// Test a connection without saving. Returns structured diagnostics + a hint.
// Body = the same instance fields as create/edit, plus optional `id` to reuse
// stored secrets when editing an existing instance.
app.post('/api/diagnose', async (req, res) => {
  const cfg = readConfig();
  const existing = req.body.id ? findInstance(cfg, req.body.id) : null;
  const inst = resolveInstance(req.body, existing);
  const invalid = validateInstance(inst);
  if (invalid) return res.json({ ok: false, stage: 'validate', hint: invalid });

  const p = await probe(inst, '/myself');
  const hint = diagnoseHint(p);
  const user =
    p.ok && p.json && (p.json.accountId || p.json.key || p.json.name)
      ? {
          displayName: p.json.displayName,
          name: p.json.name,
          key: p.json.key,
          accountId: p.json.accountId,
          timeZone: p.json.timeZone,
        }
      : null;

  res.json({
    ok: !!user && !hint,
    stage: 'myself',
    type: inst.type,
    gateway: !!inst.gateway,
    probe: {
      url: p.url,
      status: p.status,
      networkError: p.networkError || null,
      headers: p.headers || {},
      isJson: !!p.isJson,
      bodySnippet: p.bodySnippet || '',
    },
    user,
    hint,
  });
});

/* ================================================================== */
/* Route — aggregated worklogs by day                                 */
/* ================================================================== */

// Collect my worklogs for one instance, grouped by day (each day's entries are
// tagged with the instance so a merged/unified view can tell them apart).
async function collectWorklogs(inst, from, to) {
  const me = await getMyself(inst);
  const tz = me.timeZone;
  const issues = await searchWorklogIssues(inst, from, to);

  const startedAfter = Date.parse(`${from}T00:00:00Z`) - 2 * 86400000;
  const startedBefore = Date.parse(`${to}T23:59:59Z`) + 2 * 86400000;

  const perIssue = await mapLimit(issues, 6, async (issue) => ({
    issue,
    worklogs: await fetchIssueWorklogs(inst, issue.id, startedAfter, startedBefore),
  }));

  const days = {};
  let grandTotalSeconds = 0;

  for (const { issue, worklogs } of perIssue) {
    const issueKey = issue.key;
    const f = issue.fields || {};
    const summary = f.summary || '';
    const issueType = f.issuetype ? f.issuetype.name : null;
    const statusName = f.status ? f.status.name : null;
    const projectKey = (issueKey.split('-')[0] || '').toUpperCase();

    for (const w of worklogs) {
      if (!isMyWorklog(w, me)) continue;
      const day = dateInTz(w.started, tz);
      if (!day || day < from || day > to) continue;

      const entry = {
        worklogId: w.id,
        issueKey,
        projectKey,
        issueSummary: summary,
        issueType,
        statusName,
        instanceId: inst.id,
        instanceName: inst.name,
        timeSpent: w.timeSpent,
        timeSpentSeconds: w.timeSpentSeconds || 0,
        started: w.started,
        comment: adfToText(w.comment).trim(),
        link:
          `${inst.baseUrl}/browse/${issueKey}` +
          `?focusedWorklogId=${w.id}` +
          `&page=com.atlassian.jira.plugin.system.issuetabpanels:worklog-tabpanel`,
      };

      if (!days[day]) days[day] = { date: day, totalSeconds: 0, entries: [] };
      days[day].entries.push(entry);
      days[day].totalSeconds += entry.timeSpentSeconds;
      grandTotalSeconds += entry.timeSpentSeconds;
    }
  }
  return { days, grandTotalSeconds, timeZone: tz, displayName: me.displayName };
}

function mergeDays(target, source) {
  for (const [day, info] of Object.entries(source)) {
    if (!target[day]) target[day] = { date: day, totalSeconds: 0, entries: [] };
    target[day].entries.push(...info.entries);
    target[day].totalSeconds += info.totalSeconds;
  }
}

app.get('/api/worklogs', async (req, res) => {
  const cfg = readConfig();
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'from and to must be YYYY-MM-DD.' });
  }

  const wantAll = req.query.instance === 'all';

  if (wantAll) {
    if (!cfg.instances.length) {
      return res.status(400).json({ error: 'No Jira instance configured.' });
    }
    const results = await Promise.all(
      cfg.instances.map(async (inst) => {
        try {
          return { inst, data: await collectWorklogs(inst, from, to) };
        } catch (err) {
          return { inst, error: connError(err).error };
        }
      })
    );

    const days = {};
    let grandTotalSeconds = 0;
    const errors = [];
    let displayName = null;
    for (const r of results) {
      if (r.error) {
        errors.push({ id: r.inst.id, name: r.inst.name, error: r.error });
        continue;
      }
      mergeDays(days, r.data.days);
      grandTotalSeconds += r.data.grandTotalSeconds;
      displayName = displayName || r.data.displayName;
    }
    for (const day of Object.values(days)) {
      day.entries.sort((a, b) => new Date(a.started) - new Date(b.started));
    }
    return res.json({
      from,
      to,
      timeZone: 'mixed',
      instance: { id: 'all', name: 'All instances', type: 'all' },
      instances: cfg.instances.map((i) => ({ id: i.id, name: i.name })),
      user: { displayName: displayName || 'Me' },
      grandTotalSeconds,
      errors,
      days,
    });
  }

  const inst = pickInstance(cfg, req.query.instance);
  if (!inst) return res.status(400).json({ error: 'No Jira instance configured.' });
  try {
    const { days, grandTotalSeconds, timeZone, displayName } = await collectWorklogs(inst, from, to);
    for (const day of Object.values(days)) {
      day.entries.sort((a, b) => new Date(a.started) - new Date(b.started));
    }
    res.json({
      from,
      to,
      timeZone,
      instance: { id: inst.id, name: inst.name, type: inst.type, baseUrl: inst.baseUrl },
      user: { displayName },
      grandTotalSeconds,
      days,
    });
  } catch (err) {
    res.status(authStatus(err)).json(connError(err));
  }
});

/* ================================================================== */
/* Error helpers                                                      */
/* ================================================================== */

function authStatus(err) {
  return err.status === 401 || err.status === 403 ? 401 : err.status || 502;
}

function connError(err) {
  if (err.status === 401 || err.status === 403) {
    return {
      error: 'Authentication failed. Check the URL, credentials and instance type.',
      detail: err.body,
    };
  }
  return { error: `Jira request failed: ${err.message}`, detail: err.body };
}

// Start the server only when run directly, so the helpers above can be
// required (and unit-tested) without binding a port.
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`\n  Jira Worklog Dashboard running at  http://${HOST}:${PORT}\n`);
    const cfg = readConfig();
    if (!cfg.instances.length) {
      console.log('  Open it in your browser and add a Jira instance to get started.\n');
    }
  });
}

module.exports = { resolveInstance, safeInstance, validateInstance, authHeader, jiraFetch, app };

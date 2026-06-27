'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3877;
const HOST = '127.0.0.1'; // localhost only — keeps your API token off the network
const CONFIG_PATH = path.join(__dirname, 'config.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* Config storage (Jira URL + email + API token), saved locally.       */
/* ------------------------------------------------------------------ */

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// Normalise whatever the user typed into a clean https base URL.
function normaliseBaseUrl(input) {
  let url = String(input || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url.replace(/\/+$/, ''); // strip trailing slashes
}

// In-memory cache of the authenticated user (accountId + timezone).
let meCache = null;

/* ------------------------------------------------------------------ */
/* Jira REST helpers                                                    */
/* ------------------------------------------------------------------ */

function jiraHeaders(cfg) {
  const token = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
  return {
    Authorization: `Basic ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

async function jiraFetch(cfg, apiPath, options = {}) {
  const url = `${cfg.baseUrl}/rest/api/3${apiPath}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...jiraHeaders(cfg), ...(options.headers || {}) },
  });
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
    throw err;
  }
  return body;
}

async function getMyself(cfg, force = false) {
  if (meCache && !force) return meCache;
  const me = await jiraFetch(cfg, '/myself');
  meCache = {
    accountId: me.accountId,
    displayName: me.displayName,
    email: me.emailAddress || cfg.email,
    timeZone: me.timeZone || 'UTC',
    avatar: me.avatarUrls ? me.avatarUrls['48x48'] : null,
  };
  return meCache;
}

// Flatten an Atlassian Document Format (ADF) comment into plain text.
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  let out = '';
  if (node.type === 'text' && node.text) out += node.text;
  if (Array.isArray(node.content)) {
    for (const child of node.content) out += adfToText(child);
  }
  // Add a space between block-level nodes so words don't run together.
  if (['paragraph', 'heading', 'listItem'].includes(node.type)) out += ' ';
  return out;
}

// Return the YYYY-MM-DD calendar date of an instant, as seen in `timeZone`.
function dateInTz(isoString, timeZone) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

// Run async tasks with a small concurrency limit.
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

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

// What does the UI know about current config? (never returns the token)
app.get('/api/config', (req, res) => {
  const cfg = readConfig();
  res.json({
    configured: !!(cfg && cfg.baseUrl && cfg.email && cfg.apiToken),
    baseUrl: cfg ? cfg.baseUrl : '',
    email: cfg ? cfg.email : '',
  });
});

// Save config, validating the credentials against Jira before persisting.
app.post('/api/config', async (req, res) => {
  const baseUrl = normaliseBaseUrl(req.body.baseUrl);
  const email = String(req.body.email || '').trim();
  const apiToken = String(req.body.apiToken || '').trim();

  if (!baseUrl || !email || !apiToken) {
    return res.status(400).json({ error: 'Jira URL, email and API token are all required.' });
  }

  const cfg = { baseUrl, email, apiToken };
  try {
    meCache = null;
    const me = await getMyself(cfg, true);
    writeConfig(cfg);
    res.json({ ok: true, user: me });
  } catch (err) {
    meCache = null;
    res.status(err.status === 401 || err.status === 403 ? 401 : 502).json({
      error:
        err.status === 401 || err.status === 403
          ? 'Authentication failed. Check your email, API token and URL.'
          : `Could not reach Jira (${err.message}).`,
      detail: err.body,
    });
  }
});

// Current authenticated user.
app.get('/api/me', async (req, res) => {
  const cfg = readConfig();
  if (!cfg) return res.status(400).json({ error: 'Not configured.' });
  try {
    res.json(await getMyself(cfg));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message, detail: err.body });
  }
});

// Core endpoint: aggregated worklogs grouped by day for a date range.
//   GET /api/worklogs?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/worklogs', async (req, res) => {
  const cfg = readConfig();
  if (!cfg) return res.status(400).json({ error: 'Not configured.' });

  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'from and to must be YYYY-MM-DD.' });
  }

  try {
    const me = await getMyself(cfg);
    const tz = me.timeZone;

    // 1) Find issues I logged work on in the range (JQL enhanced search).
    const jql =
      `worklogAuthor = currentUser() ` +
      `AND worklogDate >= "${from}" AND worklogDate <= "${to}" ` +
      `ORDER BY updated DESC`;

    const issues = [];
    const seenIssues = new Set();
    let nextPageToken = null;
    let pages = 0;
    do {
      const payload = {
        jql,
        fields: ['summary', 'issuetype', 'status'],
        maxResults: 100,
      };
      if (nextPageToken) payload.nextPageToken = nextPageToken;

      const data = await jiraFetch(cfg, '/search/jql', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      let added = 0;
      for (const issue of data.issues || []) {
        if (seenIssues.has(issue.id)) continue; // guard against token loop bug
        seenIssues.add(issue.id);
        issues.push(issue);
        added++;
      }
      nextPageToken = data.isLast ? null : data.nextPageToken || null;
      pages++;
      // Safety: stop if the endpoint loops or returns nothing new.
      if (added === 0) nextPageToken = null;
    } while (nextPageToken && pages < 50);

    // 2) For each issue, pull worklogs in a padded window, then filter precisely.
    const startedAfter = Date.parse(`${from}T00:00:00Z`) - 2 * 86400000;
    const startedBefore = Date.parse(`${to}T23:59:59Z`) + 2 * 86400000;

    const perIssue = await mapLimit(issues, 6, async (issue) => {
      const worklogs = [];
      let startAt = 0;
      // Worklog endpoint uses classic startAt/total pagination.
      while (true) {
        const wl = await jiraFetch(
          cfg,
          `/issue/${issue.id}/worklog?startedAfter=${startedAfter}` +
            `&startedBefore=${startedBefore}&startAt=${startAt}&maxResults=5000`
        );
        for (const w of wl.worklogs || []) worklogs.push(w);
        const total = wl.total || worklogs.length;
        startAt += (wl.worklogs || []).length;
        if (startAt >= total || !(wl.worklogs || []).length) break;
      }
      return { issue, worklogs };
    });

    // 3) Filter to my worklogs within [from, to] and group by day.
    const days = {};
    let grandTotalSeconds = 0;

    for (const { issue, worklogs } of perIssue) {
      const issueKey = issue.key;
      const summary = (issue.fields && issue.fields.summary) || '';
      const issueType =
        issue.fields && issue.fields.issuetype ? issue.fields.issuetype.name : null;
      const statusName =
        issue.fields && issue.fields.status ? issue.fields.status.name : null;

      for (const w of worklogs) {
        if (!w.author || w.author.accountId !== me.accountId) continue;
        const day = dateInTz(w.started, tz);
        if (!day || day < from || day > to) continue;

        const entry = {
          worklogId: w.id,
          issueKey,
          issueSummary: summary,
          issueType,
          statusName,
          timeSpent: w.timeSpent,
          timeSpentSeconds: w.timeSpentSeconds || 0,
          started: w.started,
          comment: adfToText(w.comment).trim(),
          link:
            `${cfg.baseUrl}/browse/${issueKey}` +
            `?focusedWorklogId=${w.id}` +
            `&page=com.atlassian.jira.plugin.system.issuetabpanels:worklog-tabpanel`,
        };

        if (!days[day]) days[day] = { date: day, totalSeconds: 0, entries: [] };
        days[day].entries.push(entry);
        days[day].totalSeconds += entry.timeSpentSeconds;
        grandTotalSeconds += entry.timeSpentSeconds;
      }
    }

    // Sort each day's entries chronologically.
    for (const day of Object.values(days)) {
      day.entries.sort((a, b) => new Date(a.started) - new Date(b.started));
    }

    res.json({
      from,
      to,
      timeZone: tz,
      user: { displayName: me.displayName, accountId: me.accountId },
      grandTotalSeconds,
      days,
    });
  } catch (err) {
    const status = err.status === 401 || err.status === 403 ? 401 : err.status || 502;
    res.status(status).json({
      error:
        status === 401
          ? 'Authentication failed. Re-check your credentials in Settings.'
          : `Jira request failed: ${err.message}`,
      detail: err.body,
    });
  }
});

app.listen(PORT, HOST, () => {
  const cfg = readConfig();
  console.log(`\n  Jira Worklog Dashboard running at  http://${HOST}:${PORT}\n`);
  if (!cfg || !cfg.configured) {
    console.log('  Open it in your browser and enter your Jira URL, email and API token.\n');
  }
});

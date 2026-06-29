# Jira Worklog Dashboard

A small, self-hosted web app that shows your **Jira worklogs in a calendar or table
view** — total time logged per day, and every task you tracked time on, with a
**direct link to each worklog** in Jira.

Pick a date range (any start day — handy for payroll periods that don't start on the
1st), see how much you logged each day, and drill into the per-task breakdown. Works
with multiple Jira sites at once, both **Cloud** and **Server / Data Center**.

---

## Why it runs locally

Jira blocks browser requests made directly with an API token (CORS). So this app
runs a tiny local server (`server.js`) that holds your credentials and talks to Jira
on your behalf, then serves the UI to your browser. Your credentials never leave
your machine, and the server listens on `127.0.0.1` only.

---

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer (`node --version` to check)
- A Jira account, and a credential for each instance you connect (see
  [Instance types & auth](#instance-types--auth))

---

## Easy start (Windows) — recommended for most users

Just **double-click `start-dashboard.cmd`**. It starts the dashboard and opens it in
your browser automatically. The first time, it installs what it needs (this takes a
minute); after that it's instant.

- Keep the small black window open while you use the dashboard.
- To stop, close that window.
- Double-clicking it again while it's running just re-opens the browser tab.

You still need **[Node.js](https://nodejs.org/)** installed once (LTS version) — the
launcher will tell you if it's missing. To get a desktop icon, right-click
`start-dashboard.cmd` → **Show more options** → **Send to** → **Desktop (create
shortcut)**.

---

## Setup (manual / other platforms)

### 1. Get the code and install dependencies

```bash
git clone <repository-url>
cd jira_dashboard
npm install
```

### 2. Run the app

```bash
npm start
```

Then open **<http://127.0.0.1:3877>** in your browser. On first run the **Instances**
dialog opens so you can add your first Jira (see below).

---

## Instance types & auth

You can add any number of Jira instances and switch between them from the dropdown in
the header. Each instance is one of:

### Cloud (`*.atlassian.net`)

- **Type:** Cloud
- **Email** + **API token** — create a token at
  <https://id.atlassian.com/manage-profile/security/api-tokens>
- Uses REST v3 and the enhanced `/search/jql` endpoint.

### Server / Data Center (legacy, self-hosted)

- **Type:** Server / Data Center
- **Auth method**, one of:
  - **Username & password (session login)** — logs in via `POST /rest/auth/1/session`
    and uses the returned `JSESSIONID` cookie, exactly like a browser login. **Use
    this for older Jira where HTTP Basic auth is disabled on the REST API** (such
    instances answer API calls with `WWW-Authenticate: OAuth` and reject Basic).
  - **Basic auth (username & password)** — sends an `Authorization: Basic` header.
    Use only if your instance accepts Basic auth on the REST API.
  - **Personal Access Token** — sent as a `Bearer` token (Jira Server 8.14+ / Data
    Center). Create it under your Jira profile → *Personal Access Tokens*.
- Uses REST v2 and the classic `/search` endpoint.

Credentials are validated against Jira when you save, and stored locally in
`config.json` (git-ignored). When editing an instance you can leave a secret field
blank to keep the existing one.

### Behind an HTTP Basic gateway / proxy

If your Jira sits behind a reverse proxy that enforces its **own** HTTP Basic auth
(e.g. nginx `auth_basic`), tick **“Behind an HTTP Basic gateway / proxy”** and enter
the proxy username/password (often the same as your Jira login).

How they’re sent depends on the Jira auth method, because a request can carry only
one `Authorization` header:

- With **session login** (cookie-based) the `Authorization` header is free, so the
  gateway credentials go there — exactly what an nginx/Apache `auth_basic` gate
  reads. This is the common combo: **session login + gateway** lets you get past an
  nginx Basic gate *and* into a Jira that has Basic auth disabled.
- With **Basic / PAT / Cloud token** Jira auth, `Authorization` is taken by Jira, so
  the gateway credentials fall back to a `Proxy-Authorization` header (for forward
  proxies that read it).

---

## Using it

- **Instance dropdown** (top-left) — switch between connected Jira sites, or pick
  **★ All instances** to see a unified view that merges worklogs from every Jira at
  once. Failed instances are reported in the status line; the rest still load. Your
  selection is remembered between sessions.
- **Project colours** — every project (the key prefix, e.g. `DPPDA`) gets its own
  stable colour, shown on the calendar bars, the day detail, and the table. A
  **legend** lists each project with its total; click a project to show/hide it
  (totals update live).
- **Date range** — choose a preset (This month, Last month, This week, Last 7/14/30
  days) or set custom **From** / **To** dates. The **‹ / ›** buttons (and **← / →**
  arrow keys) page by the length of the current range, so you can step through
  payroll periods of any start day.
- **Calendar view** — each day shows the total time you logged; click a day to see
  its worklogs in the side panel, each with an **“Open worklog in Jira ↗”** link.
- **Table view** — rows are tasks, columns are dates, with a **total row** and
  **total column** (grand total in the corner). Each cell links to the worklog.
- **↻ Refresh** — re-fetch the current range from Jira.
- **⚙ Instances** — add, edit, or remove Jira connections.

---

## How it works

For the selected range the server runs, per instance:

```
worklogAuthor = currentUser()
AND worklogDate >= "<from>" AND worklogDate <= "<to>"
```

then fetches each matching issue's worklogs, keeps only the ones authored by you
within the range, and groups them by day in **your Jira timezone** (from `/myself`).
Cloud instances use REST v3 + `/search/jql`; Server/DC instances use REST v2 +
`/search`. Worklog authorship is matched by `accountId` (Cloud) or `key`/`name`
(Server/DC), so the same code works on both.

---

## Configuration

| Setting | How | Default |
| --- | --- | --- |
| Port | `PORT` environment variable | `3877` |
| Config file location | `CONFIG_PATH` environment variable | `./config.json` |
| Jira instances | **⚙ Instances** dialog → saved to `config.json` | — |

Set a custom port:

```bash
# macOS / Linux
PORT=4000 npm start
```

```powershell
# Windows PowerShell
$env:PORT=4000; npm start
```

`config.json` schema (managed for you; never commit it):

```json
{
  "instances": [
    {
      "id": "…",
      "name": "Work Cloud",
      "baseUrl": "https://your-company.atlassian.net",
      "type": "cloud",
      "auth": { "method": "token", "email": "you@company.com", "apiToken": "…" }
    }
  ],
  "activeInstanceId": "…"
}
```

> Upgrading from an earlier single-instance version? An old
> `{ baseUrl, email, apiToken }` config is migrated automatically on first run.

---

## Troubleshooting

**Use the “Test connection” button** in the instance form first — it reports the
exact HTTP status, response headers, and a plain-language hint without saving.

Common Server / Data Center (legacy) issues when Basic auth fails even though the
browser login works:

- **Use your Jira username, not your email**, for Basic auth.
- **CAPTCHA / repeated-failure lockout** — after failed logins Jira returns 403 with
  `X-Authentication-Denied-Reason: CAPTCHA_CHALLENGE`. Log into Jira in a browser,
  solve the CAPTCHA, then retry.
- **Basic auth disabled for the REST API** — many instances only accept a
  **Personal Access Token** (Jira 8.14+/DC). Switch the auth method to PAT.
- **Wrong base URL / context path** — if Jira is served under a path (e.g.
  `https://host/jira`), include it. A 404 or an HTML response usually means this.
- **A separate Basic gateway** in front of Jira (its credentials differ from your
  Jira login) — tick **Behind an HTTP Basic gateway / proxy** and enter those.

- **"Authentication failed"** — re-check the URL, credentials, and the instance
  **type**. For Cloud the email must own the API token; for Server/DC make sure the
  PAT vs Basic choice matches what your instance accepts.
- **A day looks empty but shouldn't** — worklog days are grouped using your Jira
  profile timezone, which is what Jira's own reports use.
- **Remove / reset a connection** — use the **⚙ Instances** dialog, or delete
  `config.json` and restart to start fresh.

---

## Security notes

- Credentials are stored locally in `config.json` (git-ignored) and are only sent to
  the Jira sites you configure.
- The server binds to `127.0.0.1`, so it is not reachable from other machines.
- Each user supplies their own credentials; nothing is shared or hard-coded.

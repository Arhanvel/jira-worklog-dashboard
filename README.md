# Jira Worklog Dashboard

A small, self-hosted web app that shows your **Jira Cloud worklogs in a calendar
view** — total time logged per day, and every task you tracked time on that day,
with a **direct link to each worklog** in Jira.

Pick a month, see how much you logged each day, and click a day to see the
breakdown per task. Each user runs it locally with their own Jira credentials.

---

## Why it runs locally

Jira Cloud blocks browser requests made directly with an API token (CORS). So this
app runs a tiny local server (`server.js`) that holds your credentials and talks to
Jira on your behalf, then serves the calendar UI to your browser. Your credentials
never leave your machine, and the server listens on `127.0.0.1` only.

---

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer (`node --version` to check)
- A Jira Cloud account and an Atlassian API token

---

## Setup

### 1. Get the code and install dependencies

```bash
git clone <repository-url>
cd jira_dashboard
npm install
```

### 2. Create a Jira API token

1. Go to <https://id.atlassian.com/manage-profile/security/api-tokens>
2. Click **Create API token**, give it a name, and copy it.

### 3. Run the app

```bash
npm start
```

Then open **<http://127.0.0.1:3877>** in your browser.

On first run, a **Settings** dialog appears. Enter:

- **Jira URL** — e.g. `https://your-company.atlassian.net`
- **Email** — the email of your Atlassian account
- **API token** — the token you created above

Click **Save & connect**. The app validates the credentials against Jira and stores
them in `config.json` next to the app. This file holds your API token, is
git-ignored, and stays on your machine — never commit it.

---

## Using it

- **Calendar** — each day shows the total time you logged. Bigger bar = more time.
- **Click a day** — the right panel lists each worklog: task key, summary, time
  spent, the time of day, an optional comment, and an **“Open worklog in Jira ↗”**
  link that jumps straight to that worklog on the issue.
- **Navigate** — use **‹ / ›**, the **Today** button, the month picker, or the
  **← / →** arrow keys to change months.
- **↻ Refresh** — re-fetch the current month from Jira.
- **⚙ Settings** — change your Jira URL / email / token any time.

---

## How it works

For the visible month the server runs:

```
worklogAuthor = currentUser()
AND worklogDate >= "<first-of-month>"
AND worklogDate <= "<last-of-month>"
```

via Jira's enhanced search (`POST /rest/api/3/search/jql`), then fetches each
matching issue's worklogs (`GET /rest/api/3/issue/{id}/worklog`), keeps only the
ones authored by you within the date range, and groups them by day in **your Jira
timezone** (from `/rest/api/3/myself`).

---

## Configuration

| Setting | How | Default |
| --- | --- | --- |
| Port | `PORT` environment variable | `3877` |
| Jira URL / email / token | Settings dialog → saved to `config.json` | — |

Set a custom port:

```bash
# macOS / Linux
PORT=4000 npm start
```

```powershell
# Windows PowerShell
$env:PORT=4000; npm start
```

---

## Troubleshooting

- **"Authentication failed"** — re-check the URL, email, and token in Settings. The
  email must match the Atlassian account that owns the token.
- **A day looks empty but shouldn't** — worklog days are grouped using your Jira
  profile timezone, which is what Jira's own reports use.
- **Reset credentials** — delete `config.json` and restart, or just use Settings.

---

## Security notes

- Credentials are stored locally in `config.json` (git-ignored) and are only sent to
  your own Jira site.
- The server binds to `127.0.0.1`, so it is not reachable from other machines.
- Each user supplies their own API token; nothing is shared or hard-coded.

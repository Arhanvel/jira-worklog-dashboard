# Jira Worklog Dashboard

A small local web app that shows your **Jira Cloud worklogs in a calendar view** —
total time logged per day, and every task you tracked time on that day, with a
**direct link to each worklog** in Jira.

It replaces the old browser extension: pick a month, see how much you logged each
day, click a day to see the breakdown per task.

![Calendar of worklogs per day, with a per-day detail panel.](#)

---

## Why it needs to run locally

Jira Cloud blocks browser requests made directly with an API token (CORS). So this
app runs a tiny local server (`server.js`) that holds your credentials and talks to
Jira on your behalf, then serves the calendar UI to your browser. Nothing leaves
your machine except the requests to your own Jira site.

---

## Setup

### 1. Install dependencies (one time)

```powershell
cd C:\ai_tests\claude\jira_dashboard
npm install
```

### 2. Get a Jira API token

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Click **Create API token**, give it a name, and copy it.

### 3. Run the app

```powershell
npm start
```

Then open **http://127.0.0.1:3877** in your browser.

On first run, a **Settings** dialog appears. Enter:

- **Jira URL** — e.g. `https://your-company.atlassian.net`
- **Email** — the email of your Atlassian account
- **API token** — the token you created above

Click **Save & connect**. The app validates the credentials against Jira and stores
them in `config.json` next to the app (this file is git-ignored and stays on your
machine).

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

## Notes & troubleshooting

- **"Authentication failed"** — re-check the URL, email, and token in Settings. The
  email must match the Atlassian account that owns the token.
- **A day looks empty but shouldn't** — worklog days are grouped using your Jira
  profile timezone, which is what Jira's own reports use.
- **Change the port** — set the `PORT` environment variable, e.g.
  `$env:PORT=4000; npm start`.
- **Reset credentials** — delete `config.json` and restart, or just use Settings.
- The server binds to `127.0.0.1` only, so it is not reachable from other machines.
```

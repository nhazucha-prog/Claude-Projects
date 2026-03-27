# Deployment Guide: Rift Roster (LoL Friend Leaderboard)

## Architecture

```
┌──────────────────────┐         ┌──────────────────────────┐
│   GitHub Pages       │  fetch  │   Render (Free Tier)     │
│                      │ ──────> │                          │
│   index.html         │         │   Express server         │
│   app.js             │         │   ├─ Riot API proxy      │
│   style.css          │         │   ├─ Rate limiter        │
│   players.json       │         │   ├─ Disk cache          │
│                      │         │   └─ Background refresh  │
└──────────────────────┘         └──────────────────────────┘
 Static frontend                  API key stays server-side
 nhazucha-prog.github.io          *.onrender.com
```

- **Frontend:** Vanilla HTML/CSS/JS served from GitHub Pages (free, auto-deploys from `master`)
- **Backend:** Node.js + Express on Render free tier — proxies Riot API calls so the API key never reaches the browser
- **Communication:** Frontend makes fetch requests to the Render backend; CORS restricts access to allowed origins

## Prerequisites

| Requirement | Where to get it |
|---|---|
| Riot API key (production) | https://developer.riotgames.com — register an app and get approved |
| GitHub account | https://github.com |
| Render account | https://render.com (free, no credit card required) |
| Repository pushed to GitHub | `https://github.com/nhazucha-prog/Claude-Projects` |

## Render Setup (Backend)

1. Sign up at https://render.com and connect your GitHub account
2. Click **New > Web Service**
3. Select the `nhazucha-prog/Claude-Projects` repository
4. Configure the service:

| Setting | Value |
|---|---|
| **Name** | `lol-leaderboard-api` (or your choice — determines the URL) |
| **Branch** | `master` |
| **Root Directory** | `lol-leaderboard` |
| **Runtime** | Node |
| **Build Command** | `cd server && npm install` |
| **Start Command** | `cd server && node server.js` |
| **Instance Type** | Free |

5. Add environment variable:
   - `RIOT_API_KEY` = your production Riot API key
   - (Do NOT set `PORT` — Render injects its own automatically; the server reads `process.env.PORT`)
6. Click **Create Web Service**
7. Wait for the deploy to complete, then note the URL (e.g., `https://lol-leaderboard-api.onrender.com`)
8. Verify: `https://YOUR-URL/api/health` should return `{"status":"ok"}`

## GitHub Pages Setup (Frontend)

1. Go to https://github.com/nhazucha-prog/Claude-Projects/settings/pages
2. Under **Source**, select **Deploy from a branch**
3. Branch: `master`, Folder: `/ (root)`
4. Click **Save**
5. Wait ~1 minute for the first deploy

Frontend URL: `https://nhazucha-prog.github.io/Claude-Projects/lol-leaderboard/`

## Code Configuration

### API_BASE (app.js, line 3)

The frontend auto-detects the environment:

```js
const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001'
  : 'https://YOUR-SERVICE-NAME.onrender.com';
```

**After creating the Render service**, replace `YOUR-SERVICE-NAME` with the actual service name in:
- `lol-leaderboard/app.js` (line 3)
- `lol-leaderboard/server/server.js` (CORS allowed list, line 17)

Then commit and push — both Render and GitHub Pages will auto-redeploy.

### CORS Allowed Origins (server/server.js)

The server restricts which domains can make API requests:

```js
const allowed = [
  'https://nhazucha-prog.github.io',     // GitHub Pages
  'https://YOUR-SERVICE-NAME.onrender.com', // Render (self-serve fallback)
  'http://localhost:3000',                // Local dev
  'http://localhost:5500',                // VS Code Live Server
  'http://127.0.0.1:5500',
  'http://localhost:8080'
];
```

## Operational Notes

### Render Free Tier Behavior
- **Sleep:** Instance spins down after ~15 minutes of inactivity
- **Cold start:** First request after sleep takes 30–60 seconds
- **Resilience:** The frontend shows cached data from localStorage while the server wakes up, with a banner indicating data may be outdated

### Caching (3 layers)

| Layer | Location | Survives restart? | Details |
|---|---|---|---|
| **In-memory cache** | Server RAM | No | Primary cache with TTLs (PUUID: 24h, ranked: 5min, match IDs: 3min, match details: indefinite) |
| **Disk cache** | `server/cache.json` | Partially | Saved every 30s, loaded on startup. Survives restarts but not Render redeploys (ephemeral filesystem) |
| **Client cache** | Browser localStorage | Yes | Frontend caches last leaderboard response as fallback during server cold starts |

### Background Refresh
- The server automatically re-fetches all players every **5 minutes**
- First refresh runs 2 seconds after startup
- Players from `players.json` are loaded on boot; additional players are synced from the frontend via `POST /api/roster-sync`
- This keeps the cache warm so user-initiated refreshes are instant

### Rate Limiting
- Riot API limits: 20 requests/second, 100 requests/2 minutes
- The server uses a **sliding-window rate limiter** with headroom (15/sec, 90/2min)
- Allows bursting when capacity is available instead of fixed delays
- If rate limited (429), retries with exponential backoff up to 2 times, then falls back to stale cache

## Managing the Roster

### Via the UI (recommended)
1. Click **Add Player** on the leaderboard
2. Enter the Game Name and Tag Line (e.g., `Artu` / `9815`)
3. The roster is saved in browser localStorage and synced to the server for background refresh

### Via players.json (default roster)
Edit `lol-leaderboard/players.json` to set the default roster loaded on first visit:

```json
[
  { "gameName": "Artu", "tagLine": "9815" },
  { "gameName": "FriendName", "tagLine": "NA1" }
]
```

This is used when a visitor has no existing localStorage roster (first visit).

## API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Health check — returns `{"status":"ok"}` |
| `/api/players?names=Name1-Tag1,Name2-Tag2&queue=420` | GET | Leaderboard data for multiple players |
| `/api/player/:gameName/:tagLine?queue=420` | GET | Detailed player data with match history |
| `/api/roster-sync` | POST | Frontend syncs its roster for background refresh |
| `/api/status` | GET | Cache size, roster size, last background refresh time |

Queue filter values: `420` (Ranked Solo), `440` (Ranked Flex), `400` (Draft Pick), `1700` (Arena), or omit for all queues.

## Troubleshooting

### "Could not reach the server" error
- **First load after inactivity:** Render is cold-starting. Wait 30–60 seconds and refresh.
- **Persistent:** Check that the Render service is running at the dashboard. Verify `RIOT_API_KEY` is set in Render environment variables.

### CORS errors in browser console
- The request origin must be in the `allowed` array in `server/server.js`
- GitHub Pages origin is `https://nhazucha-prog.github.io` (no trailing slash, no path)
- If accessing from a new domain, add it to the list

### No data for a player
- Verify the Game Name and Tag Line are correct (case-sensitive tag)
- The player must have a Riot account on the Americas shard
- Check Render logs for specific error messages

### Rate limiting (429 errors in Render logs)
- Normal during initial cache population with many players
- The server retries automatically and falls back to stale cache
- If persistent, the roster may be too large for the API key's rate limits — reduce the number of tracked players or space out refreshes

### Render deploy fails
- Check that **Root Directory** is set to `lol-leaderboard` (not `lol-leaderboard/server`)
- Build command should be `cd server && npm install`
- Start command should be `cd server && node server.js`

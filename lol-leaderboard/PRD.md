# Product Requirements Document: LoL Friend Leaderboard

## Overview
A private League of Legends leaderboard website where a group of ~10 friends can view and compare their ranked performance, match history, and stats — similar to op.gg but scoped to just their group.

## Problem
There's no easy way to see all your friends' LoL stats side-by-side in one place. Sites like op.gg require searching each player individually. We want a single dashboard that makes it fun and competitive to compare performance within the friend group.

## Target Users
- ~10 friends who play League of Legends on the NA server
- Accessed via browser on desktop or mobile

## Core Features

### 1. Leaderboard View (Default)
- Table of all tracked players sorted by rank (Challenger → Iron), then LP
- Each row displays:
  - Rank position (#1, #2, etc.)
  - Summoner name
  - Rank tier badge (color-coded: Iron, Bronze, Silver, Gold, Platinum, Emerald, Diamond, Master, Grandmaster, Challenger)
  - League Points (LP)
  - Win rate (color-coded: green >50%, red <50%, gold >60%)
  - KDA ratio
  - Top 3 most-played champions (icons)
- Fun indicators:
  - Crown on the #1 ranked player
  - Fire icon for win streaks
  - Skull icon for losing streaks
- "Last updated" timestamp with manual refresh button
- "Add Player" button

### 2. Player Detail View
- Accessed by clicking a player row on the leaderboard
- Back navigation to leaderboard
- Player header: summoner name, rank emblem, tier/division, LP
- Stat cards: Win Rate, KDA, Total Games Played
- Top 5 Champions section: champion icon, games played, win rate, KDA per champion
- Recent Matches (last 10): champion played, W/L result, KDA, CS, game duration, time ago
- Color coding: wins in green, losses in red

### 3. Add/Remove Player
- Modal overlay triggered from leaderboard view
- Inputs: Game Name, Tag Line (e.g., "PlayerName" + "NA1")
- Add button saves to roster
- Ability to remove players from roster
- Roster persisted in browser localStorage
- Default roster loaded from players.json on first visit

## Technical Architecture

### Frontend
- **Hosting:** GitHub Pages (free, deploys from repo)
- **Stack:** Vanilla HTML, CSS, JavaScript (no frameworks)
- **Design:** Dark theme (#0f1117 background, muted colors, soft text)
- **Layout:** Single-page app with view switching (show/hide divs)
- **Assets:** Champion images from Riot Data Dragon CDN
- **Responsive:** Works on mobile (stacks columns under 600px)

### Backend
- **Hosting:** Render free tier
- **Stack:** Node.js + Express
- **Purpose:** Proxy Riot API calls to keep API key server-side
- **Security:** CORS restricted to GitHub Pages origin

### API Contract

#### GET /api/players?names=Name1-Tag1,Name2-Tag2
Returns array of player summaries for the leaderboard.

Response shape:
```json
[
  {
    "gameName": "PlayerOne",
    "tagLine": "NA1",
    "tier": "GOLD",
    "rank": "II",
    "lp": 45,
    "wins": 120,
    "losses": 100,
    "winRate": 54.5,
    "kda": 3.2,
    "topChampions": [
      { "name": "Jinx", "games": 30 },
      { "name": "Caitlyn", "games": 20 },
      { "name": "Ezreal", "games": 15 }
    ],
    "streak": { "type": "win", "count": 3 }
  }
]
```

#### GET /api/player/:gameName/:tagLine
Returns detailed player data including match history.

Response shape:
```json
{
  "gameName": "PlayerOne",
  "tagLine": "NA1",
  "tier": "GOLD",
  "rank": "II",
  "lp": 45,
  "wins": 120,
  "losses": 100,
  "winRate": 54.5,
  "kda": 3.2,
  "topChampions": [
    { "name": "Jinx", "games": 30, "wins": 18, "kda": 3.5 }
  ],
  "recentMatches": [
    {
      "champion": "Jinx",
      "win": true,
      "kills": 8,
      "deaths": 3,
      "assists": 10,
      "cs": 210,
      "duration": "32:15",
      "timeAgo": "2 hours ago"
    }
  ]
}
```

#### GET /api/health
Returns `{ "status": "ok" }`

### Riot API Endpoints Used
| Riot Endpoint | Region | Purpose |
|---|---|---|
| `/riot/account/v1/accounts/by-riot-id/{name}/{tag}` | americas | Get PUUID |
| `/lol/summoner/v4/summoners/by-puuid/{puuid}` | na1 | Get summoner ID |
| `/lol/league/v4/entries/by-summoner/{id}` | na1 | Get rank data |
| `/lol/match/v5/matches/by-puuid/{puuid}/ids` | americas | Get match IDs |
| `/lol/match/v5/matches/{matchId}` | americas | Get match details |

### Rate Limiting & Caching
- Riot dev key limits: 20 requests/second, 100 requests/2 minutes
- Server-side in-memory cache:
  - PUUIDs: 24-hour TTL (never change)
  - Ranked data: 5-minute TTL
  - Match IDs: 3-minute TTL
  - Match details: indefinite (immutable data)
- Sequential API calls with 100ms delays to avoid bursting
- Frontend caches last response in localStorage as fallback during cold starts

### Security
- Riot API key stored as environment variable on Render, never in code
- CORS restricted to GitHub Pages origin only
- .env file in .gitignore, .env.example committed as template

## File Structure
```
lol-leaderboard/
  PRD.md
  index.html
  style.css
  app.js
  players.json
  server/
    package.json
    server.js
    .env.example
    .gitignore
```

## Dependencies
- **Runtime:** Node.js (for backend server)
- **npm packages:** express, cors
- **External:** Riot Developer API key (from developer.riotgames.com)
- **CDN:** Data Dragon for champion images

## Success Criteria
- All ~10 friends' stats load and display correctly on the leaderboard
- Player detail view shows accurate rank, KDA, champion stats, and match history
- Page loads within 5 seconds (accounting for Render cold start on first load)
- Friends can access the site from any browser via GitHub Pages URL
- Adding/removing players works and persists across sessions

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const RIOT_API_KEY = process.env.RIOT_API_KEY;

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
app.use(cors({
  origin: function (origin, callback) {
    const allowed = [
      'https://nhazucha-prog.github.io',
      'https://RENDER_SERVICE_NAME.onrender.com', // TODO: replace RENDER_SERVICE_NAME after Render setup
      'http://localhost:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500',
      'http://localhost:8080'
    ];
    // Allow null origin (file:// protocol) and allowed origins
    if (!origin || allowed.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

app.use(express.json());

// ---------------------------------------------------------------------------
// Disk-backed cache — survives server restarts (important for Render cold starts)
// ---------------------------------------------------------------------------
const CACHE_FILE = path.join(__dirname, 'cache.json');
let cache = new Map();
let cacheDirty = false;

function loadCacheFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      cache = new Map(Object.entries(raw));
      console.log(`Loaded ${cache.size} cache entries from disk`);
    }
  } catch (err) {
    console.warn('Could not load cache from disk:', err.message);
  }
}

function saveCacheToDisk() {
  if (!cacheDirty) return;
  try {
    const obj = Object.fromEntries(cache);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
    cacheDirty = false;
  } catch (err) {
    console.warn('Could not save cache to disk:', err.message);
  }
}

// Save to disk periodically (every 30s) rather than on every write
setInterval(saveCacheToDisk, 30000);

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.ttl && Date.now() > entry.expires) {
    return { data: entry.data, stale: true };
  }
  return { data: entry.data, stale: false };
}

function cacheSet(key, data, ttlMs) {
  cache.set(key, {
    data,
    ttl: ttlMs || 0,
    expires: ttlMs ? Date.now() + ttlMs : 0
  });
  cacheDirty = true;
}

// ---------------------------------------------------------------------------
// Sliding-window rate limiter (dev key: 20 req/sec, 100 req/2min)
// Allows bursting while respecting both limits — much faster than fixed delay.
// ---------------------------------------------------------------------------
const callTimestamps = []; // timestamps of recent API calls
const MAX_PER_SECOND = 15;  // stay under 20/sec with headroom
const MAX_PER_2MIN = 90;    // stay under 100/2min with headroom
const MAX_RETRIES = 2;

function pruneTimestamps() {
  const twoMinAgo = Date.now() - 120000;
  while (callTimestamps.length > 0 && callTimestamps[0] < twoMinAgo) {
    callTimestamps.shift();
  }
}

async function waitForRateLimit() {
  while (true) {
    pruneTimestamps();
    const now = Date.now();

    // Check 2-minute window
    if (callTimestamps.length >= MAX_PER_2MIN) {
      const waitUntil = callTimestamps[0] + 120000;
      const delay = waitUntil - now + 50;
      console.log(`Rate limiter: 2min cap reached, waiting ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    // Check 1-second window
    const oneSecAgo = now - 1000;
    const recentCount = callTimestamps.filter(t => t > oneSecAgo).length;
    if (recentCount >= MAX_PER_SECOND) {
      const oldest = callTimestamps.find(t => t > oneSecAgo);
      const delay = oldest + 1000 - now + 10;
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    // Good to go
    callTimestamps.push(Date.now());
    return;
  }
}

async function riotFetch(url, retryCount = 0) {
  await waitForRateLimit();

  const res = await fetch(url, {
    headers: { 'X-Riot-Token': RIOT_API_KEY }
  });

  if (res.status === 429) {
    if (retryCount < MAX_RETRIES) {
      const retryAfter = res.headers.get('Retry-After');
      const rawDelay = retryAfter ? parseInt(retryAfter, 10) * 1000 : (2000 * Math.pow(2, retryCount));
      const delayMs = Math.min(rawDelay, 10000);
      console.warn(`Rate limited on ${url} — retrying in ${delayMs}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, delayMs));
      return riotFetch(url, retryCount + 1);
    }
    console.warn(`Rate limited on ${url} — all retries exhausted`);
    return null;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Riot API ${res.status}: ${text} (${url})`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// API helper functions
// ---------------------------------------------------------------------------

const TTL_PUUID = 24 * 60 * 60 * 1000;   // 24 hours
const TTL_RANKED = 5 * 60 * 1000;          // 5 minutes
const TTL_MATCH_IDS = 3 * 60 * 1000;       // 3 minutes
const TTL_MATCH_DETAIL = 0;                 // indefinite

async function getPuuid(gameName, tagLine) {
  const key = `puuid:${gameName}:${tagLine}`;
  const cached = cacheGet(key);
  if (cached && !cached.stale) return cached.data;

  const url = `https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
  const data = await riotFetch(url);

  if (!data && cached) return cached.data; // 429 fallback
  if (!data) throw new Error(`Failed to get PUUID for ${gameName}#${tagLine}`);

  cacheSet(key, data.puuid, TTL_PUUID);
  return data.puuid;
}

async function getRankedData(puuid) {
  const key = `ranked:${puuid}`;
  const cached = cacheGet(key);
  if (cached && !cached.stale) return cached.data;

  const url = `https://na1.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`;
  const data = await riotFetch(url);

  if (!data && cached) return cached.data;
  if (!data) return [];

  cacheSet(key, data, TTL_RANKED);
  return data;
}

async function getMatchIds(puuid, count = 10, queue = null) {
  const key = `matchIds:${puuid}:${count}:${queue || 'all'}`;
  const cached = cacheGet(key);
  if (cached && !cached.stale) return cached.data;

  let url = `https://americas.api.riotgames.com/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?count=${count}`;
  if (queue) url += `&queue=${queue}`;
  const data = await riotFetch(url);

  if (!data && cached) return cached.data;
  if (!data) return [];

  cacheSet(key, data, TTL_MATCH_IDS);
  return data;
}

async function getMatchDetail(matchId) {
  const key = `match:${matchId}`;
  const cached = cacheGet(key);
  if (cached) return cached.data; // indefinite — never stale

  const url = `https://americas.api.riotgames.com/lol/match/v5/matches/${encodeURIComponent(matchId)}`;
  const data = await riotFetch(url);

  if (!data) return null;

  cacheSet(key, data, TTL_MATCH_DETAIL);
  return data;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function timeAgo(timestamp) {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffDay > 0) return diffDay === 1 ? '1 day ago' : `${diffDay} days ago`;
  if (diffHr > 0) return diffHr === 1 ? '1 hour ago' : `${diffHr} hours ago`;
  if (diffMin > 0) return diffMin === 1 ? '1 minute ago' : `${diffMin} minutes ago`;
  return 'just now';
}

// ---------------------------------------------------------------------------
// Data aggregation
// ---------------------------------------------------------------------------

async function buildPlayerData(gameName, tagLine, detailed, queue = null) {
  // Queue ID mapping: 420=Solo, 440=Flex, 400=Draft, 1700=Arena
  const QUEUE_TO_RANKED = { '420': 'RANKED_SOLO_5x5', '440': 'RANKED_FLEX_SR' };

  // Step 1: PUUID
  const puuid = await getPuuid(gameName, tagLine);

  // Step 2: Ranked + match IDs in parallel (both only need PUUID)
  const matchCount = detailed ? 10 : 3;
  const [rankedEntries, matchIds] = await Promise.all([
    getRankedData(puuid),
    getMatchIds(puuid, matchCount, queue)
  ]);

  let soloQ;
  if (queue && QUEUE_TO_RANKED[queue]) {
    soloQ = rankedEntries.find(e => e.queueType === QUEUE_TO_RANKED[queue]) || {};
  } else if (!queue) {
    soloQ = rankedEntries.find(e => e.queueType === 'RANKED_SOLO_5x5')
      || rankedEntries.find(e => e.queueType === 'RANKED_FLEX_SR')
      || {};
  } else {
    soloQ = {};
  }

  // Determine if this is a ranked queue or a casual/arena queue
  const isRankedQueue = !queue || !!QUEUE_TO_RANKED[queue];
  const isArenaQueue = queue === '1700';

  const tier = isRankedQueue ? (soloQ.tier || 'UNRANKED') : null;
  const rank = isRankedQueue ? (soloQ.rank || '') : null;
  const lp = isRankedQueue ? (soloQ.leaguePoints || 0) : null;

  // Step 3: Fetch all match details concurrently (rate limiter handles pacing)
  const matchResults = await Promise.all(matchIds.map(id => getMatchDetail(id)));
  const matches = matchResults.filter(Boolean);

  // Step 5: Extract player data from matches
  const playerMatches = [];
  for (const match of matches) {
    const participant = match.info.participants.find(p => p.puuid === puuid);
    if (!participant) continue;

    const isArena = match.info.gameMode === 'CHERRY';

    // Arena uses placement (1-4 = top half = "win", 5-8 = bottom half = "loss")
    // For other modes, use the standard win field
    let win;
    if (isArena) {
      win = (participant.placement || 0) <= 4;
    } else {
      win = participant.win;
    }

    playerMatches.push({
      champion: participant.championName,
      win,
      kills: participant.kills,
      deaths: participant.deaths,
      assists: participant.assists,
      cs: isArena ? 0 : (participant.totalMinionsKilled || 0) + (participant.neutralMinionsKilled || 0),
      duration: formatDuration(match.info.gameDuration),
      timeAgo: timeAgo(match.info.gameEndTimestamp || match.info.gameCreation),
      gameEndTimestamp: match.info.gameEndTimestamp || match.info.gameCreation,
      gameMode: match.info.gameMode,
      queueId: match.info.queueId,
      placement: isArena ? participant.placement : null
    });
  }

  // Step 6: Compute KDA from matches
  let totalKills = 0, totalDeaths = 0, totalAssists = 0;
  for (const m of playerMatches) {
    totalKills += m.kills;
    totalDeaths += m.deaths;
    totalAssists += m.assists;
  }
  const kda = playerMatches.length > 0
    ? Math.round(((totalKills + totalAssists) / Math.max(totalDeaths, 1)) * 10) / 10
    : 0;

  // Step 7: Top champions
  const champMap = {};
  for (const m of playerMatches) {
    if (!champMap[m.champion]) {
      champMap[m.champion] = { name: m.champion, games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 };
    }
    const c = champMap[m.champion];
    c.games++;
    if (m.win) c.wins++;
    c.kills += m.kills;
    c.deaths += m.deaths;
    c.assists += m.assists;
  }

  const champList = Object.values(champMap).sort((a, b) => b.games - a.games);
  const topCount = detailed ? 5 : 3;
  const topChampions = champList.slice(0, topCount).map(c => {
    const base = { name: c.name, games: c.games };
    if (detailed) {
      base.wins = c.wins;
      base.kda = Math.round(((c.kills + c.assists) / Math.max(c.deaths, 1)) * 10) / 10;
    }
    return base;
  });

  // Step 8: Streak
  let streakType = null;
  let streakCount = 0;
  if (playerMatches.length > 0) {
    streakType = playerMatches[0].win ? 'win' : 'loss';
    for (const m of playerMatches) {
      const currentType = m.win ? 'win' : 'loss';
      if (currentType === streakType) {
        streakCount++;
      } else {
        break;
      }
    }
  }

  // Compute wins/losses/winRate — from ranked API for ranked queues, from matches for casual
  let wins, losses, totalGames, winRate;
  if (isRankedQueue) {
    wins = soloQ.wins || 0;
    losses = soloQ.losses || 0;
    totalGames = wins + losses;
    winRate = totalGames > 0 ? Math.round((wins / totalGames) * 1000) / 10 : 0;
  } else {
    wins = playerMatches.filter(m => m.win).length;
    losses = playerMatches.filter(m => !m.win).length;
    totalGames = playerMatches.length;
    winRate = totalGames > 0 ? Math.round((wins / totalGames) * 1000) / 10 : 0;
  }

  // Arena-specific: average placement
  let avgPlacement = null;
  if (isArenaQueue && playerMatches.length > 0) {
    const placements = playerMatches.filter(m => m.placement != null).map(m => m.placement);
    if (placements.length > 0) {
      avgPlacement = Math.round((placements.reduce((a, b) => a + b, 0) / placements.length) * 10) / 10;
    }
  }

  // Build response
  const result = {
    gameName,
    tagLine,
    tier,
    rank,
    lp,
    wins,
    losses,
    winRate,
    kda,
    topChampions,
    streak: { type: streakType || 'none', count: streakCount },
    queueType: isArenaQueue ? 'arena' : isRankedQueue ? 'ranked' : 'casual'
  };

  if (avgPlacement !== null) {
    result.avgPlacement = avgPlacement;
  }

  if (detailed) {
    result.recentMatches = playerMatches.map(m => {
      const matchData = {
        champion: m.champion,
        win: m.win,
        kills: m.kills,
        deaths: m.deaths,
        assists: m.assists,
        cs: m.cs,
        duration: m.duration,
        timeAgo: m.timeAgo,
        gameMode: m.gameMode,
        queueId: m.queueId
      };
      if (m.placement !== null) {
        matchData.placement = m.placement;
      }
      return matchData;
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/players', async (req, res) => {
  try {
    const names = req.query.names;
    const queue = req.query.queue || null;
    if (!names) {
      return res.status(400).json({ error: 'Missing names query parameter' });
    }

    const playerPairs = names.split(',').map(n => {
      const parts = n.trim().split('-');
      const tagLine = parts.pop();
      const gameName = parts.join('-'); // handle names with hyphens
      return { gameName, tagLine };
    });

    // Process all players concurrently — the rate limiter handles pacing
    const results = await Promise.all(
      playerPairs.map(async ({ gameName, tagLine }) => {
        try {
          return await buildPlayerData(gameName, tagLine, false, queue);
        } catch (err) {
          console.error(`Error fetching ${gameName}#${tagLine}:`, err.message);
          return {
            gameName,
            tagLine,
            tier: 'UNRANKED',
            rank: '',
            lp: 0,
            wins: 0,
            losses: 0,
            winRate: 0,
            kda: 0,
            topChampions: [],
            streak: { type: 'none', count: 0 },
            error: err.message
          };
        }
      })
    );

    res.json(results);
  } catch (err) {
    console.error('Error in /api/players:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/player/:gameName/:tagLine', async (req, res) => {
  try {
    const { gameName, tagLine } = req.params;
    const queue = req.query.queue || null;
    const data = await buildPlayerData(gameName, tagLine, true, queue);
    res.json(data);
  } catch (err) {
    console.error(`Error in /api/player/${req.params.gameName}/${req.params.tagLine}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Background pre-cache — refreshes all players every 5 minutes
// ---------------------------------------------------------------------------
const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
let knownRoster = []; // players to pre-cache (loaded from players.json + synced from frontend)
let lastBackgroundRefresh = null;

function loadDefaultRoster() {
  try {
    const playersFile = path.join(__dirname, '..', 'players.json');
    if (fs.existsSync(playersFile)) {
      knownRoster = JSON.parse(fs.readFileSync(playersFile, 'utf8'));
      console.log(`Loaded ${knownRoster.length} players from players.json`);
    }
  } catch (err) {
    console.warn('Could not load players.json:', err.message);
  }
}

async function backgroundRefresh() {
  if (knownRoster.length === 0 || !RIOT_API_KEY) return;

  console.log(`Background refresh: updating ${knownRoster.length} players...`);
  const start = Date.now();

  // Pre-fetch leaderboard data (non-detailed) for default queue
  await Promise.all(
    knownRoster.map(async ({ gameName, tagLine }) => {
      try {
        await buildPlayerData(gameName, tagLine, false, null);
      } catch (err) {
        console.warn(`Background refresh failed for ${gameName}#${tagLine}:`, err.message);
      }
    })
  );

  lastBackgroundRefresh = new Date().toISOString();
  saveCacheToDisk();
  console.log(`Background refresh done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

// Endpoint for frontend to sync its roster so background refresh covers all players
app.post('/api/roster-sync', (req, res) => {
  const { players } = req.body;
  if (Array.isArray(players)) {
    // Merge with existing roster (dedupe by gameName+tagLine)
    const seen = new Set(knownRoster.map(p => `${p.gameName.toLowerCase()}#${p.tagLine.toLowerCase()}`));
    for (const p of players) {
      const key = `${p.gameName.toLowerCase()}#${p.tagLine.toLowerCase()}`;
      if (!seen.has(key)) {
        knownRoster.push({ gameName: p.gameName, tagLine: p.tagLine });
        seen.add(key);
      }
    }
  }
  res.json({ status: 'ok', rosterSize: knownRoster.length, lastRefresh: lastBackgroundRefresh });
});

// Expose cache freshness so the frontend knows when data was last updated
app.get('/api/status', (req, res) => {
  res.json({
    cacheSize: cache.size,
    lastBackgroundRefresh,
    rosterSize: knownRoster.length
  });
});

// ---------------------------------------------------------------------------
// Serve frontend static files (no-cache during dev so changes are picked up)
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, '..'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`LoL Leaderboard running at http://localhost:${PORT}`);
  if (!RIOT_API_KEY) {
    console.warn('WARNING: RIOT_API_KEY is not set. API calls will fail.');
  }

  // Load disk cache and default roster, then do first background refresh
  loadCacheFromDisk();
  loadDefaultRoster();

  // Initial refresh after a short delay (let server finish starting)
  setTimeout(() => {
    backgroundRefresh();
    // Then refresh every 5 minutes
    setInterval(backgroundRefresh, REFRESH_INTERVAL);
  }, 2000);
});

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const RIOT_API_KEY = process.env.RIOT_API_KEY;

// ---------------------------------------------------------------------------
// DDragon item data + augment mappings (loaded on startup)
// ---------------------------------------------------------------------------
let ddragonVersion = '14.10.1';
let itemData = {}; // id -> { name, icon }
let augmentData = {}; // id -> { name }

async function loadDDragonItems() {
  try {
    // Get latest version
    const verRes = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
    if (verRes.ok) {
      const versions = await verRes.json();
      if (Array.isArray(versions) && versions.length > 0) {
        ddragonVersion = versions[0];
      }
    }
    // Fetch item data
    const itemRes = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/en_US/item.json`);
    if (itemRes.ok) {
      const raw = await itemRes.json();
      itemData = {};
      for (const [id, item] of Object.entries(raw.data || {})) {
        itemData[id] = { name: item.name, icon: item.image ? item.image.full : `${id}.png` };
      }
      console.log(`Loaded ${Object.keys(itemData).length} items from DDragon v${ddragonVersion}`);
    }
  } catch (err) {
    console.warn('Could not load DDragon item data:', err.message);
  }
}

function loadAugmentData() {
  try {
    const augFile = path.join(__dirname, '..', 'augments.json');
    if (fs.existsSync(augFile)) {
      augmentData = JSON.parse(fs.readFileSync(augFile, 'utf8'));
      console.log(`Loaded ${Object.keys(augmentData).length} augment mappings`);
    }
  } catch (err) {
    console.warn('Could not load augments.json:', err.message);
  }
}

function resolveItem(itemId) {
  if (!itemId || itemId === 0) return null;
  const item = itemData[String(itemId)];
  return {
    id: itemId,
    name: item ? item.name : `Item #${itemId}`,
    icon: item ? item.icon : `${itemId}.png`
  };
}

function resolveAugment(augId) {
  if (!augId || augId === 0) return null;
  const aug = augmentData[String(augId)];
  return {
    id: augId,
    name: aug ? aug.name : `Augment #${augId}`
  };
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
app.use(cors({
  origin: function (origin, callback) {
    const allowed = [
      'https://nhazucha-prog.github.io',
      'https://claude-projects-fy5u.onrender.com',
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
const TTL_RANKED = 30 * 60 * 1000;         // 30 minutes (was 5min — reduces API calls significantly)
const TTL_MATCH_IDS = 10 * 60 * 1000;      // 10 minutes (was 3min — new matches don't appear that fast)
const TTL_MATCH_DETAIL = 0;                 // indefinite
const TTL_MATCH_TEAMS = 2 * 60 * 60 * 1000; // 2 hours — cached opponent/ally ranked data per match

async function getPuuid(gameName, tagLine) {
  const key = `puuid:${gameName}:${tagLine}`;
  const cached = cacheGet(key);
  if (cached && !cached.stale) return cached.data;

  try {
    const url = `https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
    const data = await riotFetch(url);
    if (data) {
      cacheSet(key, data.puuid, TTL_PUUID);
      return data.puuid;
    }
  } catch (_) { /* fall through to stale cache */ }

  if (cached) return cached.data; // serve stale on any failure
  throw new Error(`Failed to get PUUID for ${gameName}#${tagLine}`);
}

async function getRankedData(puuid) {
  const key = `ranked:${puuid}`;
  const cached = cacheGet(key);
  if (cached && !cached.stale) return cached.data;

  try {
    const url = `https://na1.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`;
    const data = await riotFetch(url);
    if (data) {
      cacheSet(key, data, TTL_RANKED);
      return data;
    }
  } catch (_) { /* fall through to stale cache */ }

  if (cached) return cached.data; // serve stale on any failure
  return [];
}

async function getMatchIds(puuid, count = 10, queue = null) {
  const key = `matchIds:${puuid}:${count}:${queue || 'all'}`;
  const cached = cacheGet(key);
  if (cached && !cached.stale) return cached.data;

  try {
    let url = `https://americas.api.riotgames.com/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?count=${count}`;
    if (queue) url += `&queue=${queue}`;
    const data = await riotFetch(url);
    if (data) {
      cacheSet(key, data, TTL_MATCH_IDS);
      return data;
    }
  } catch (_) { /* fall through to stale cache */ }

  if (cached) return cached.data; // serve stale on any failure
  return [];
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

  // Step 5: Extract player data from matches
  const playerMatches = [];
  for (let i = 0; i < matchIds.length; i++) {
    const match = matchResults[i];
    if (!match) continue;
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
      matchId: matchIds[i],
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
    puuid,
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
        matchId: m.matchId,
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

    // Cache the full leaderboard response so repeated page loads don't re-fetch
    const leaderboardKey = `leaderboard:${names}:${queue || 'all'}`;
    const cachedLB = cacheGet(leaderboardKey);
    if (cachedLB && !cachedLB.stale) {
      return res.json(cachedLB.data);
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

    // Cache for 2 minutes — short enough to feel fresh, long enough to absorb repeat loads
    cacheSet(leaderboardKey, results, 2 * 60 * 1000);
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

app.get('/api/match/:matchId/opponents', async (req, res) => {
  try {
    const { matchId } = req.params;
    const puuid = req.query.puuid;
    if (!puuid) return res.status(400).json({ error: 'puuid query param required' });

    // Check for cached response first — avoids all ranked API calls on repeat clicks
    const cacheKey = `matchTeams:${matchId}:${puuid}`;
    const cached = cacheGet(cacheKey);
    if (cached && !cached.stale) {
      return res.json(cached.data);
    }

    const match = await getMatchDetail(matchId);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    // Arena has no traditional enemy team
    if (match.info.gameMode === 'CHERRY') {
      return res.json({ team: [], opponents: [] });
    }

    const currentPlayer = match.info.participants.find(p => p.puuid === puuid);
    if (!currentPlayer) return res.status(404).json({ error: 'Player not found in match' });

    const ROLE_ORDER = { TOP: 0, JUNGLE: 1, MIDDLE: 2, BOTTOM: 3, UTILITY: 4 };
    const allies = match.info.participants.filter(p => p.teamId === currentPlayer.teamId);
    const enemies = match.info.participants.filter(p => p.teamId !== currentPlayer.teamId);

    async function buildPlayerInfo(p) {
      let tier = 'UNRANKED', rank = '', lp = 0;
      try {
        const ranked = await getRankedData(p.puuid);
        const soloQ = (ranked || []).find(r => r.queueType === 'RANKED_SOLO_5x5')
          || (ranked || []).find(r => r.queueType === 'RANKED_FLEX_SR')
          || {};
        tier = soloQ.tier || 'UNRANKED';
        rank = soloQ.rank || '';
        lp = soloQ.leaguePoints || 0;
      } catch (_) { /* default to UNRANKED */ }

      return {
        riotId: `${p.riotIdGameName || 'Unknown'}#${p.riotIdTagline || '???'}`,
        champion: p.championName,
        position: p.teamPosition || '',
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        tier,
        rank,
        lp,
        isCurrentPlayer: p.puuid === puuid
      };
    }

    const [teamData, enemyData] = await Promise.all([
      Promise.all(allies.map(buildPlayerInfo)),
      Promise.all(enemies.map(buildPlayerInfo))
    ]);

    // Sort by role order: TOP → JNG → MID → BOT → SUP
    const sortByRole = (a, b) => (ROLE_ORDER[a.position] ?? 5) - (ROLE_ORDER[b.position] ?? 5);
    teamData.sort(sortByRole);
    enemyData.sort(sortByRole);

    const result = { team: teamData, opponents: enemyData };
    cacheSet(cacheKey, result, TTL_MATCH_TEAMS);
    res.json(result);
  } catch (err) {
    console.error(`Error in /api/match/${req.params.matchId}/opponents:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/match/:matchId/arena', async (req, res) => {
  try {
    const { matchId } = req.params;
    const puuid = req.query.puuid;
    if (!puuid) return res.status(400).json({ error: 'puuid query param required' });

    // Check cache first — Arena data is immutable
    const cacheKey = `arenaDetail:${matchId}:${puuid}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached.data);

    const match = await getMatchDetail(matchId);
    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (match.info.gameMode !== 'CHERRY') {
      return res.status(400).json({ error: 'Not an Arena match' });
    }

    const currentPlayer = match.info.participants.find(p => p.puuid === puuid);
    if (!currentPlayer) return res.status(404).json({ error: 'Player not found in match' });

    function buildArenaPlayer(p) {
      const items = [];
      for (let i = 0; i <= 6; i++) {
        const item = resolveItem(p[`item${i}`]);
        if (item) items.push(item);
      }
      const augments = [];
      for (let i = 1; i <= 6; i++) {
        const aug = resolveAugment(p[`playerAugment${i}`]);
        if (aug) augments.push(aug);
      }
      return {
        riotId: `${p.riotIdGameName || 'Unknown'}#${p.riotIdTagline || '???'}`,
        champion: p.championName,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        placement: p.placement,
        subteamId: p.playerSubteamId,
        items,
        augments
      };
    }

    // Build player data
    const player = buildArenaPlayer(currentPlayer);

    // Find teammate (same subteam, different puuid)
    const teammateParticipant = match.info.participants.find(
      p => p.playerSubteamId === currentPlayer.playerSubteamId && p.puuid !== puuid
    );
    const teammate = teammateParticipant ? buildArenaPlayer(teammateParticipant) : null;

    // Build other teams grouped by subteamId
    const teamMap = {};
    for (const p of match.info.participants) {
      if (p.playerSubteamId === currentPlayer.playerSubteamId) continue;
      if (!teamMap[p.playerSubteamId]) {
        teamMap[p.playerSubteamId] = { placement: p.placement, players: [] };
      }
      teamMap[p.playerSubteamId].players.push(buildArenaPlayer(p));
    }
    const otherTeams = Object.values(teamMap).sort((a, b) => a.placement - b.placement);

    const result = {
      placement: currentPlayer.placement,
      player,
      teammate,
      otherTeams
    };

    // Cache indefinitely — Arena match data never changes
    cacheSet(cacheKey, result, 0);
    res.json(result);
  } catch (err) {
    console.error(`Error in /api/match/${req.params.matchId}/arena:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Background pre-cache — refreshes all players every 15 minutes
// ---------------------------------------------------------------------------
const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes (cache handles freshness between refreshes)
let knownRoster = []; // players to pre-cache (loaded from players.json + synced from frontend)
let lastBackgroundRefresh = null;

// Shared roster — persisted to disk so additions survive across users/sessions.
// Survives restarts but NOT redeploys (Render's filesystem is ephemeral on deploy).
const SHARED_ROSTER_FILE = path.join(__dirname, 'shared-roster.json');

function saveSharedRoster() {
  try {
    fs.writeFileSync(SHARED_ROSTER_FILE, JSON.stringify(knownRoster, null, 2));
  } catch (err) {
    console.warn('Could not save shared roster:', err.message);
  }
}

function loadDefaultRoster() {
  // Always start by seeding from players.json so the baseline survives redeploys
  try {
    const playersFile = path.join(__dirname, '..', 'players.json');
    if (fs.existsSync(playersFile)) {
      knownRoster = JSON.parse(fs.readFileSync(playersFile, 'utf8'));
      console.log(`Seeded ${knownRoster.length} players from players.json`);
    }
  } catch (err) {
    console.warn('Could not load players.json:', err.message);
  }

  // Then merge in any disk-persisted shared additions
  try {
    if (fs.existsSync(SHARED_ROSTER_FILE)) {
      const stored = JSON.parse(fs.readFileSync(SHARED_ROSTER_FILE, 'utf8'));
      if (Array.isArray(stored)) {
        const seen = new Set(knownRoster.map(p => `${p.gameName.toLowerCase()}#${p.tagLine.toLowerCase()}`));
        let added = 0;
        for (const p of stored) {
          const key = `${p.gameName.toLowerCase()}#${p.tagLine.toLowerCase()}`;
          if (!seen.has(key)) {
            knownRoster.push({ gameName: p.gameName, tagLine: p.tagLine });
            seen.add(key);
            added++;
          }
        }
        console.log(`Merged ${added} additional players from shared-roster.json (total: ${knownRoster.length})`);
      }
    }
  } catch (err) {
    console.warn('Could not load shared-roster.json:', err.message);
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

// Get the current shared roster (used by all clients as the source of truth)
app.get('/api/roster', (req, res) => {
  res.json({ players: knownRoster });
});

// Add a player to the shared roster
app.post('/api/roster', (req, res) => {
  const { gameName, tagLine } = req.body || {};
  if (!gameName || !tagLine || typeof gameName !== 'string' || typeof tagLine !== 'string') {
    return res.status(400).json({ error: 'gameName and tagLine are required strings' });
  }
  const key = `${gameName.toLowerCase()}#${tagLine.toLowerCase()}`;
  const exists = knownRoster.some(
    p => `${p.gameName.toLowerCase()}#${p.tagLine.toLowerCase()}` === key
  );
  if (!exists) {
    knownRoster.push({ gameName: gameName.trim(), tagLine: tagLine.trim() });
    saveSharedRoster();
  }
  res.json({ status: 'ok', players: knownRoster, added: !exists });
});

// Remove a player from the shared roster
app.delete('/api/roster', (req, res) => {
  const { gameName, tagLine } = req.body || {};
  if (!gameName || !tagLine) {
    return res.status(400).json({ error: 'gameName and tagLine are required' });
  }
  const before = knownRoster.length;
  knownRoster = knownRoster.filter(
    p => !(p.gameName.toLowerCase() === gameName.toLowerCase() && p.tagLine.toLowerCase() === tagLine.toLowerCase())
  );
  const removed = before !== knownRoster.length;
  if (removed) saveSharedRoster();
  res.json({ status: 'ok', players: knownRoster, removed });
});

// Backwards-compat: bulk roster sync from older clients — merges into shared roster
app.post('/api/roster-sync', (req, res) => {
  const { players } = req.body;
  let added = 0;
  if (Array.isArray(players)) {
    const seen = new Set(knownRoster.map(p => `${p.gameName.toLowerCase()}#${p.tagLine.toLowerCase()}`));
    for (const p of players) {
      if (!p || !p.gameName || !p.tagLine) continue;
      const key = `${p.gameName.toLowerCase()}#${p.tagLine.toLowerCase()}`;
      if (!seen.has(key)) {
        knownRoster.push({ gameName: p.gameName, tagLine: p.tagLine });
        seen.add(key);
        added++;
      }
    }
    if (added > 0) saveSharedRoster();
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

  // Load disk cache, roster, augments, then DDragon items + background refresh
  loadCacheFromDisk();
  loadDefaultRoster();
  loadAugmentData();

  // Load DDragon items then start background refresh
  loadDDragonItems().then(() => {
    setTimeout(() => {
      backgroundRefresh();
      setInterval(backgroundRefresh, REFRESH_INTERVAL);
    }, 2000);
  });
});

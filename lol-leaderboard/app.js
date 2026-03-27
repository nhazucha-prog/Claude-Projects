(() => {
  // ======================== CONFIG ========================
  const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3001'
    : 'https://RENDER_SERVICE_NAME.onrender.com'; // TODO: replace RENDER_SERVICE_NAME after Render setup
  let DDRAGON_VERSION = '14.10.1'; // fallback; auto-updated on init
  let DDRAGON_BASE = `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/img`;

  // Fetch the latest Data Dragon version so champion images stay current
  async function fetchDDragonVersion() {
    try {
      const res = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
      if (res.ok) {
        const versions = await res.json();
        if (Array.isArray(versions) && versions.length > 0) {
          DDRAGON_VERSION = versions[0];
          DDRAGON_BASE = `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/img`;
        }
      }
    } catch (_) {
      // Silently fall back to the hardcoded version
    }
  }

  const tierOrder = {
    CHALLENGER: 0,
    GRANDMASTER: 1,
    MASTER: 2,
    DIAMOND: 3,
    EMERALD: 4,
    PLATINUM: 5,
    GOLD: 6,
    SILVER: 7,
    BRONZE: 8,
    IRON: 9,
  };

  const rankOrder = { I: 0, II: 1, III: 2, IV: 3 };

  // ======================== STATE ========================
  let players = [];
  let leaderboardData = null;
  let currentView = 'leaderboard';
  let currentQueue = ''; // '' = all, '420' = solo, '440' = flex, '400' = draft, '1700' = arena

  // ======================== DOM REFS ========================
  const leaderboardView = document.getElementById('leaderboard-view');
  const playerView = document.getElementById('player-view');
  const addModal = document.getElementById('add-modal');
  const leaderboardList = document.getElementById('leaderboard-list');
  const lastUpdatedText = document.getElementById('last-updated-text');
  const refreshBtn = document.getElementById('refresh-btn');
  const addPlayerBtn = document.getElementById('add-player-btn');
  const modalCloseBtn = document.getElementById('modal-close-btn');
  const modalAddBtn = document.getElementById('modal-add-btn');
  const inputGameName = document.getElementById('input-game-name');
  const inputTagLine = document.getElementById('input-tag-line');
  const rosterList = document.getElementById('roster-list');
  const backBtn = document.getElementById('back-btn');
  const playerHeader = document.getElementById('player-header');
  const statCards = document.getElementById('stat-cards');
  const topChampions = document.getElementById('top-champions');
  const recentMatches = document.getElementById('recent-matches');
  const errorBanner = document.getElementById('error-banner');
  const errorMessage = document.getElementById('error-message');

  // ======================== VIEW MANAGEMENT ========================
  function showView(viewName) {
    currentView = viewName;
    leaderboardView.hidden = viewName !== 'leaderboard';
    playerView.hidden = viewName !== 'player';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showModal(show) {
    addModal.hidden = !show;
    if (show) {
      renderRosterList();
      inputGameName.value = '';
      inputTagLine.value = '';
      inputGameName.focus();
    }
  }

  function showError(msg) {
    errorMessage.textContent = msg;
    errorBanner.hidden = false;
  }

  function hideError() {
    errorBanner.hidden = true;
  }

  // ======================== ROSTER (localStorage) ========================
  async function loadRoster() {
    const stored = localStorage.getItem('lol-roster');
    if (stored) {
      try {
        players = JSON.parse(stored);
        // Clear stale placeholder names
        const hasPlaceholder = players.some(p => p.gameName === 'SummonerOne' || p.gameName === 'SummonerTwo');
        if (Array.isArray(players) && players.length > 0 && !hasPlaceholder) return;
      } catch (_) { /* fall through */ }
    }
    // Seed from players.json
    localStorage.removeItem('lol-roster');
    try {
      const res = await fetch('players.json');
      players = await res.json();
      saveRoster();
    } catch (_) {
      players = [
        { gameName: 'Artu', tagLine: '9815' },
      ];
      saveRoster();
    }
  }

  function saveRoster() {
    localStorage.setItem('lol-roster', JSON.stringify(players));
  }

  function addPlayer(gameName, tagLine) {
    gameName = gameName.trim();
    tagLine = tagLine.trim();
    if (!gameName || !tagLine) return;
    const exists = players.some(
      (p) => p.gameName.toLowerCase() === gameName.toLowerCase() && p.tagLine.toLowerCase() === tagLine.toLowerCase()
    );
    if (exists) return;
    players.push({ gameName, tagLine });
    saveRoster();
    syncRosterToServer();
    renderRosterList();
    fetchLeaderboard();
  }

  function removePlayer(gameName, tagLine) {
    players = players.filter(
      (p) => !(p.gameName.toLowerCase() === gameName.toLowerCase() && p.tagLine.toLowerCase() === tagLine.toLowerCase())
    );
    saveRoster();
    renderRosterList();
    fetchLeaderboard();
  }

  // ======================== API CALLS ========================
  async function fetchLeaderboard() {
    if (players.length === 0) {
      leaderboardList.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">&#x1F47B;</span>
          No players on your roster yet.<br>Click "Add Player" to get started!
        </div>`;
      return;
    }

    hideError();
    showLoadingSkeleton();
    refreshBtn.classList.add('loading');

    const names = players.map((p) => `${p.gameName}-${p.tagLine}`).join(',');

    try {
      let url = `${API_BASE}/api/players?names=${encodeURIComponent(names)}`;
      if (currentQueue) url += `&queue=${currentQueue}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = await res.json();
      leaderboardData = data;
      localStorage.setItem('lol-leaderboard-cache', JSON.stringify(data));
      localStorage.setItem('lol-leaderboard-time', Date.now().toString());
      renderLeaderboard(data);
      updateTimestamp();
    } catch (err) {
      console.error('Leaderboard fetch failed:', err);
      // Try cached data
      const cached = localStorage.getItem('lol-leaderboard-cache');
      if (cached) {
        try {
          leaderboardData = JSON.parse(cached);
          renderLeaderboard(leaderboardData);
          showError('Could not reach server. Showing cached data — it may be outdated.');
          updateTimestamp(true);
        } catch (_) {
          showError('Could not reach the server. Please try again later.');
          showEmptyLeaderboard();
        }
      } else {
        showError('Could not reach the server. Please try again later.');
        showEmptyLeaderboard();
      }
    } finally {
      refreshBtn.classList.remove('loading');
    }
  }

  async function fetchPlayerDetail(gameName, tagLine) {
    showView('player');
    playerHeader.innerHTML = '<div class="spinner"></div>';
    statCards.innerHTML = '';
    topChampions.innerHTML = '';
    recentMatches.innerHTML = '';

    try {
      let detailUrl = `${API_BASE}/api/player/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
      if (currentQueue) detailUrl += `?queue=${currentQueue}`;
      const res = await fetch(detailUrl);
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = await res.json();
      renderPlayerDetail(data);
    } catch (err) {
      console.error('Player detail fetch failed:', err);
      playerHeader.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">&#x26A0;&#xFE0F;</span>
          Failed to load player data.<br>Please try again.
        </div>`;
    }
  }

  // ======================== RENDERING: LEADERBOARD ========================
  function showLoadingSkeleton() {
    let html = '<div class="loading-container">';
    for (let i = 0; i < Math.min(players.length, 6); i++) {
      html += `
        <div class="skeleton-row">
          <div class="skeleton-bar short"></div>
          <div class="skeleton-bar long"></div>
          <div class="skeleton-bar medium"></div>
          <div class="skeleton-circle"></div>
        </div>`;
    }
    html += '</div>';
    leaderboardList.innerHTML = html;
  }

  function showEmptyLeaderboard() {
    leaderboardList.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">&#x1F50C;</span>
        Unable to load leaderboard data.
      </div>`;
  }

  function renderLeaderboard(data) {
    if (!Array.isArray(data) || data.length === 0) {
      leaderboardList.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">&#x1F3AE;</span>
          No ranked data found for your roster.
        </div>`;
      return;
    }

    // Sort depends on queue type
    const isRankedView = !data[0] || data[0].queueType === 'ranked';
    const isArenaView = data[0] && data[0].queueType === 'arena';

    const sorted = [...data].sort((a, b) => {
      if (isArenaView) {
        // Arena: sort by avg placement (lower = better), then win rate
        const placA = a.avgPlacement ?? 99;
        const placB = b.avgPlacement ?? 99;
        if (placA !== placB) return placA - placB;
        return (b.winRate || 0) - (a.winRate || 0);
      } else if (!isRankedView) {
        // Draft/casual: sort by win rate, then KDA
        const wrDiff = (b.winRate || 0) - (a.winRate || 0);
        if (wrDiff !== 0) return wrDiff;
        return (b.kda || 0) - (a.kda || 0);
      }
      // Ranked: sort by tier, rank, LP
      const hasRankA = a.tier && a.tier !== 'UNRANKED';
      const hasRankB = b.tier && b.tier !== 'UNRANKED';
      if (hasRankA && !hasRankB) return -1;
      if (!hasRankA && hasRankB) return 1;
      if (!hasRankA && !hasRankB) return 0;
      const tierA = tierOrder[a.tier] ?? 10;
      const tierB = tierOrder[b.tier] ?? 10;
      if (tierA !== tierB) return tierA - tierB;
      const rankA = rankOrder[a.rank] ?? 5;
      const rankB = rankOrder[b.rank] ?? 5;
      if (rankA !== rankB) return rankA - rankB;
      return (b.lp || 0) - (a.lp || 0);
    });

    leaderboardList.innerHTML = sorted
      .map((p, i) => {
        const pos = i + 1;
        const isFirst = pos === 1;
        const isRanked = p.queueType === 'ranked';
        const isArena = p.queueType === 'arena';
        const hasTier = isRanked && p.tier && p.tier !== 'UNRANKED';
        const tierClass = hasTier ? p.tier.toLowerCase() : 'unranked';

        // Badge: rank for ranked, "DRAFT" / "ARENA" for casual
        let badgeHtml = '';
        if (hasTier) {
          badgeHtml = `<span class="rank-badge ${tierClass}">${p.tier} ${p.rank || ''}</span>`;
        } else if (isRanked) {
          badgeHtml = `<span class="rank-badge unranked">UNRANKED</span>`;
        }

        const lpText = hasTier ? `${p.lp} LP` : '';

        const pTotalGames = (p.wins || 0) + (p.losses || 0);
        let wrClass = '';
        if (pTotalGames > 0) {
          if (p.winRate > 60) wrClass = 'great';
          else if (p.winRate >= 50) wrClass = 'good';
          else wrClass = 'bad';
        }

        // Streak icons
        let streakHtml = '';
        if (p.streak) {
          if (p.streak.type === 'win' && p.streak.count >= 3) {
            streakHtml = `<span class="streak-icon" title="${p.streak.count} win streak">&#x1F525; ${p.streak.count}</span>`;
          } else if (p.streak.type === 'loss' && p.streak.count >= 3) {
            streakHtml = `<span class="streak-icon" title="${p.streak.count} loss streak">&#x1F480; ${p.streak.count}</span>`;
          }
        }

        // Position display
        const posDisplay = isFirst ? '&#x1F451;' : `#${pos}`;

        // Top champions (up to 3)
        const champsHtml = (p.topChampions || [])
          .slice(0, 3)
          .map(
            (c) =>
              `<img class="champ-icon" src="${championImgUrl(c.name)}" alt="${c.name}" title="${c.name} (${c.games} games)" loading="lazy" onerror="this.style.display='none'">`
          )
          .join('');

        // Stats line — different for each queue type
        let statsHtml = '';
        if (pTotalGames > 0) {
          if (isArena && p.avgPlacement !== undefined) {
            statsHtml = `
              <span>Avg #${p.avgPlacement}</span>
              <span class="separator">|</span>
              <span class="win-rate ${wrClass}">${p.winRate.toFixed(1)}% Top 4</span>
              <span class="separator">|</span>
              <span>${p.kda !== undefined ? p.kda.toFixed(1) + ' KDA' : ''}</span>
              <span class="separator">|</span>
              <span>${pTotalGames} games</span>`;
          } else {
            statsHtml = `
              <span class="win-rate ${wrClass}">${p.winRate.toFixed(1)}% WR</span>
              ${p.kda !== undefined ? `<span class="separator">|</span><span>${p.kda.toFixed(1)} KDA</span>` : ''}
              <span class="separator">|</span>
              <span>${pTotalGames} games</span>`;
          }
        } else {
          statsHtml = '<span>No games found</span>';
        }

        // Right side — LP for ranked, avg placement for arena, nothing for draft
        let rightText = '';
        if (hasTier) {
          rightText = `${p.lp} LP`;
        } else if (isArena && p.avgPlacement !== undefined) {
          rightText = `Avg #${p.avgPlacement}`;
        }

        const delay = i * 0.05;

        return `
          <div class="player-row" style="animation-delay: ${delay}s"
               onclick="window.__viewPlayer('${escapeAttr(p.gameName)}', '${escapeAttr(p.tagLine)}')">
            <div class="player-position ${isFirst ? 'first' : ''}">${posDisplay}</div>
            <div class="player-info">
              <div class="player-name-row">
                <span class="player-name">${escapeHtml(p.gameName)}</span>
                ${badgeHtml}
                ${streakHtml}
              </div>
              <div class="player-stats">${statsHtml}</div>
            </div>
            <div class="player-champions">${champsHtml}</div>
            <div class="player-lp">${rightText}</div>
          </div>`;
      })
      .join('');
  }

  // ======================== RENDERING: PLAYER DETAIL ========================
  function renderPlayerDetail(data) {
    const isRanked = data.queueType === 'ranked';
    const isArena = data.queueType === 'arena';
    const hasTier = isRanked && data.tier && data.tier !== 'UNRANKED';
    const tierClass = hasTier ? data.tier.toLowerCase() : 'unranked';
    const totalGames = (data.wins || 0) + (data.losses || 0);

    // Header — rank badge only for ranked queues
    let headerExtra = '';
    if (hasTier) {
      headerExtra = `
        <div class="detail-rank"><span class="rank-badge ${tierClass}">${data.tier} ${data.rank || ''}</span></div>
        <div class="detail-lp">${data.lp} LP</div>`;
    } else if (isRanked) {
      headerExtra = `<div class="detail-rank"><span class="rank-badge unranked">UNRANKED</span></div>`;
    } else if (isArena && data.avgPlacement !== undefined) {
      headerExtra = `<div class="detail-lp" style="font-size:1.2rem;">Avg Placement: #${data.avgPlacement}</div>`;
    }

    playerHeader.innerHTML = `
      <div class="detail-name">${escapeHtml(data.gameName)}<span style="color:var(--text-muted);font-weight:400;font-size:0.9rem;margin-left:6px;">#${escapeHtml(data.tagLine)}</span></div>
      ${headerExtra}`;

    // Stat cards — adapt labels for Arena
    const hasWr = data.winRate !== undefined && totalGames > 0;
    const wrClass = hasWr
      ? (data.winRate > 60 ? 'great' : data.winRate >= 50 ? 'good' : 'bad')
      : '';

    const wrLabel = isArena ? 'Top 4 Rate' : 'Win Rate';
    const card1 = hasWr ? data.winRate.toFixed(1) + '%' : '---';

    let card2Html;
    if (isArena && data.avgPlacement !== undefined) {
      card2Html = `
        <div class="stat-card">
          <div class="stat-value">#${data.avgPlacement}</div>
          <div class="stat-label">Avg Placement</div>
        </div>`;
    } else {
      card2Html = `
        <div class="stat-card">
          <div class="stat-value">${data.kda !== undefined && totalGames > 0 ? data.kda.toFixed(2) : '---'}</div>
          <div class="stat-label">KDA</div>
        </div>`;
    }

    statCards.innerHTML = `
      <div class="stat-card">
        <div class="stat-value win-rate ${wrClass}">${card1}</div>
        <div class="stat-label">${wrLabel}</div>
      </div>
      ${card2Html}
      <div class="stat-card">
        <div class="stat-value">${totalGames}</div>
        <div class="stat-label">Games</div>
      </div>
      ${isArena ? `<div class="stat-card"><div class="stat-value">${data.kda !== undefined && totalGames > 0 ? data.kda.toFixed(2) : '---'}</div><div class="stat-label">KDA</div></div>` : ''}`;

    // Top Champions
    if (data.topChampions && data.topChampions.length > 0) {
      topChampions.innerHTML = data.topChampions
        .map((c, i) => {
          const champWrNum =
            c.wins !== undefined && c.games ? (c.wins / c.games) * 100 : null;
          const champWr = champWrNum !== null ? champWrNum.toFixed(1) : null;
          const champWrClass = champWrNum !== null
            ? champWrNum > 60
              ? 'great'
              : champWrNum >= 50
              ? 'good'
              : 'bad'
            : '';
          return `
            <div class="champion-row" style="animation-delay: ${i * 0.05}s">
              <img class="champ-icon" src="${championImgUrl(c.name)}" alt="${c.name}" loading="lazy" onerror="this.style.display='none'">
              <span class="champ-name">${escapeHtml(c.name)}</span>
              <div class="champ-stats">
                <span>${c.games} games</span>
                ${champWr !== null ? `<span class="win-rate ${champWrClass}">${champWr}% WR</span>` : ''}
                ${c.kda !== undefined ? `<span>${c.kda.toFixed(1)} KDA</span>` : ''}
              </div>
            </div>`;
        })
        .join('');
    } else {
      topChampions.innerHTML = '<div class="empty-state">No champion data available.</div>';
    }

    // Recent Matches
    if (data.recentMatches && data.recentMatches.length > 0) {
      recentMatches.innerHTML = data.recentMatches
        .map((m, i) => {
          const isArena = m.gameMode === 'CHERRY';
          const resultClass = m.win ? 'win' : 'loss';
          const resultText = isArena && m.placement
            ? `#${m.placement}`
            : (m.win ? 'W' : 'L');
          const csText = isArena ? '' : `<span class="match-cs">${m.cs} CS</span>`;
          return `
            <div class="match-row ${m.win ? 'win' : ''}" style="animation-delay: ${i * 0.04}s">
              <img class="match-champ-icon" src="${championImgUrl(m.champion)}" alt="${m.champion}" loading="lazy" onerror="this.style.display='none'">
              <span class="match-result ${resultClass}">${resultText}</span>
              <span class="match-kda">${m.kills}/${m.deaths}/${m.assists}</span>
              ${csText}
              <span class="match-duration">${m.duration}</span>
              <span class="match-meta">${escapeHtml(m.timeAgo)}</span>
            </div>`;
        })
        .join('');
    } else {
      recentMatches.innerHTML = '<div class="empty-state">No recent matches found.</div>';
    }
  }

  // ======================== RENDERING: ROSTER LIST (modal) ========================
  function renderRosterList() {
    if (players.length === 0) {
      rosterList.innerHTML = '<li class="empty-state" style="padding:16px;">No players added yet.</li>';
      return;
    }
    rosterList.innerHTML = players
      .map(
        (p) => `
        <li class="roster-item">
          <div>
            <span class="roster-name">${escapeHtml(p.gameName)}</span>
            <span class="roster-tag">#${escapeHtml(p.tagLine)}</span>
          </div>
          <button class="roster-remove" title="Remove" onclick="window.__removePlayer('${escapeAttr(p.gameName)}', '${escapeAttr(p.tagLine)}')">&times;</button>
        </li>`
      )
      .join('');
  }

  // ======================== HELPERS ========================
  // Champion names where the Riot Match API `championName` differs from the
  // Data Dragon filename.  Keys are the sanitised (alpha-only) version of
  // what the API returns; values are the correct DDragon filename stem.
  const CHAMP_NAME_FIXES = {
    NunuWillump: 'Nunu',
    RenataGlasc: 'Renata',
    Wukong: 'MonkeyKing',
    FiddleSticks: 'Fiddlesticks',
  };

  function championImgUrl(name) {
    // Strip everything except letters (handles Kai'Sa, Cho'Gath, etc.)
    let sanitized = name.replace(/[^a-zA-Z]/g, '');
    // Apply known mismatches between Match API names and DDragon filenames
    if (CHAMP_NAME_FIXES[sanitized]) {
      sanitized = CHAMP_NAME_FIXES[sanitized];
    }
    return `${DDRAGON_BASE}/champion/${sanitized}.png`;
  }

  function updateTimestamp(stale) {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    lastUpdatedText.textContent = stale
      ? `Data may be outdated | Last loaded: ${timeStr}`
      : `Last updated: ${timeStr}`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    if (!str) return '';
    return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
  }

  // ======================== GLOBAL HANDLERS (for inline onclick) ========================
  window.__viewPlayer = (gameName, tagLine) => {
    fetchPlayerDetail(gameName, tagLine);
  };

  window.__removePlayer = (gameName, tagLine) => {
    removePlayer(gameName, tagLine);
  };

  // ======================== EVENT LISTENERS ========================
  refreshBtn.addEventListener('click', () => fetchLeaderboard());

  // Queue filter buttons
  document.querySelectorAll('.queue-filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.queue-filter').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentQueue = btn.dataset.queue;
      fetchLeaderboard();
    });
  });

  addPlayerBtn.addEventListener('click', () => showModal(true));

  modalCloseBtn.addEventListener('click', () => showModal(false));

  addModal.addEventListener('click', (e) => {
    if (e.target === addModal) showModal(false);
  });

  modalAddBtn.addEventListener('click', () => {
    const name = inputGameName.value.trim();
    const tag = inputTagLine.value.trim();
    if (!name || !tag) return;
    addPlayer(name, tag);
    showModal(false);
  });

  // Enter key in modal inputs
  inputTagLine.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') modalAddBtn.click();
  });
  inputGameName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') inputTagLine.focus();
  });

  backBtn.addEventListener('click', () => showView('leaderboard'));

  // Escape closes modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !addModal.hidden) showModal(false);
  });

  // ======================== ROSTER SYNC ========================
  // Tell the server about our roster so background refresh covers all players
  async function syncRosterToServer() {
    try {
      await fetch(`${API_BASE}/api/roster-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ players })
      });
    } catch (_) {
      // Non-critical — server will still work without it
    }
  }

  // ======================== INIT ========================
  async function init() {
    await fetchDDragonVersion();
    await loadRoster();
    syncRosterToServer();
    fetchLeaderboard();
  }

  init();
})();

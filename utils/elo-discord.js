/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                          ELO DISCORD                          ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Discord interface module for the EloTracker plugin. Provides embed
 * builders for all Discord-facing output, a resilient send helper,
 * and registers the !elo Discord command handler onto the tracker.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * EloDiscord (named)
 *   Object. Key members:
 *     sendDiscordMessage(channel, content, suppressErrors)
 *       Resilient send — normalises embed/embeds, handles 429 with
 *       one automatic retry, and includes a Discord.js v12 fallback.
 *     buildRoundSummaryEmbed(data)      — Post-round results embed.
 *     buildRoundStartEmbed(data, mode)  — Pre-round team balance embed.
 *     buildPlayerStatsEmbed(...)        — Per-player rank and stats embed.
 *     buildLeaderboardEmbed(...)        — Top-N leaderboard embed.
 *     buildAdminConfirmEmbed(...)       — Admin action confirmation embed.
 *     buildErrorEmbed(context, err)     — Error embed with stack trace.
 *     buildRoundSkippedEmbed(...)       — Round-skipped notification embed.
 *     registerDiscordCommands(tracker)
 *       Attaches onDiscordMessage and _findPlayerByIdentifier onto
 *       the tracker instance.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * Logger (../../core/logger.js)
 *   Verbose logging for send failures and rate-limit events.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - sendDiscordMessage normalises { embed } → { embeds: [embed] }
 *   for Discord.js v13+ compatibility, then falls back to the legacy
 *   { embed } shape on a 'Cannot send an empty message' error.
 * - Rate limit (429) handling reads retryAfter from the error object
 *   or the retry-after header. Only one retry is attempted.
 * - registerDiscordCommands() mutates the tracker instance. It relies
 *   on tracker.db, tracker.session, tracker.eloCache, tracker.options,
 *   tracker.discordAdminChannel, and tracker.discordPublicChannel.
 * - Admin commands (!elo reset, backup, restore, status, roundinfo) are
 *   gated to discordAdminChannelID. Public commands are gated to
 *   discordPublicChannelID. Messages outside both channels are ignored.
 * - !elo reset (full wipe) requires a two-step confirm with a 30s
 *   timeout. Pending state is stored on tracker._resetConfirmPending.
 * - formatDuration is a local helper (not exported).
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */

import Logger from '../../core/logger.js';

const formatDuration = (ms) => {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)));

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(' ');
};

const DISPARITY_THRESHOLDS = {
  SEVERE_MU: 2.5,          // Mu delta required for a lone "Severe" rating
  SEVERE_SHARE: 65,       // % of total regulars required for a lone "Severe" rating
  SEVERE_MIXED_MU: 1.5,    // Lower Mu threshold when paired with high reg share
  SEVERE_MIXED_SHARE: 60,  // Lower reg share threshold when paired with moderate Mu delta
  MINOR_MU: 1.0,           // Mu delta for "Minor" imbalance
  MINOR_SHARE: 55,         // Leading team share of regulars for "Minor" imbalance
  LEAD_MU_MIN: 0.75         // Min Mu delta to declare the higher Mu team the overall lead
};

const getVeterancyUI = (veterancy) => {
  const pct = Math.round(veterancy * 100);
  if (veterancy <= 0.3) {
    return { icon: '🔴', label: `Low (${pct}%)`, color: 0xe74c3c };
  } else if (veterancy <= 0.6) {
    return { icon: '🟡', label: `Moderate (${pct}%)`, color: 0xf1c40f };
  } else {
    return { icon: '🟢', label: `High (${pct}%)`, color: 0x2ecc71 };
  }
};

const getRegEmoji = (leadShare) => {
  if (leadShare > DISPARITY_THRESHOLDS.SEVERE_SHARE) return '🔴';
  if (leadShare > DISPARITY_THRESHOLDS.MINOR_SHARE) return '🟡';
  return '🟢';
};
const getEloEmoji = (delta) => delta < 1.0 ? '🟢' : (delta <= 2.5 ? '🟡' : '🔴');

const generateMatrixTable = (t1, t2) => {
  const fmtPct = (v) => (v !== null && v !== undefined) ? `${Math.round(v * 100)}%` : '--%';
  const fmtMu = (v) => (v !== null && v !== undefined) ? `${v.toFixed(1)}μ` : '--μ';
  const fmtCount = (v) => (v !== null && v !== undefined) ? String(v) : '--';

  const row = (v1, label, v2) => {
    const val1 = String(v1).padStart(5).padEnd(5);
    const val2 = String(v2).padStart(5).padEnd(5);
    const mid = label.padStart(12).padEnd(12);
    return ` [${val1}] | ${mid} | [${val2}] `;
  };

  return [
    '```text',
    ' Team 1  |   Category   |  Team 2 ',
    '----------------------------------',
    row(fmtCount(t1.tierStats.vCount), 'Visitors', fmtCount(t2.tierStats.vCount)),
    row(fmtCount(t1.tierStats.pCount), 'Provisional', fmtCount(t2.tierStats.pCount)),
    row(fmtCount(t1.tierStats.rCount), 'Regulars', fmtCount(t2.tierStats.rCount)),
    '----------------------------------',
    row(fmtMu(t1.avgMu), 'Team Avg', fmtMu(t2.avgMu)),
    row(fmtMu(t1.avgRegMu), 'Regs Avg', fmtMu(t2.avgRegMu)),
    '----------------------------------',
    row(fmtPct(t1.veterancy), 'Veterancy', fmtPct(t2.veterancy)),
    '```'
  ].join('\n');
};

export const EloDiscord = {
  async sendDiscordMessage(channel, content, suppressErrors = true) {
    if (!channel) {
      Logger.verbose('EloTracker', 1, 'Discord send failed: No channel available');
      return false;
    }

    if (!content) {
      Logger.verbose('EloTracker', 1, 'Discord send failed: Content was empty.');
      return false;
    }

    // Standardize Input: Ensure 'embeds' array is used internally for objects
    let payload = content;
    if (typeof content === 'object' && content !== null) {
      payload = { ...content };
      if (payload.embed && !payload.embeds) {
        payload.embeds = [payload.embed];
        delete payload.embed;
      }
    }

    const executeSend = async (data, isRetry = false) => {
      try {
        await channel.send(data);
        return true;
      } catch (err) {
        // Rate Limit Handling (429)
        if (err.status === 429 && !isRetry) {
          let waitTime = 1000;
          if (err.retryAfter) waitTime = err.retryAfter;
          else if (err.headers && err.headers['retry-after']) waitTime = parseFloat(err.headers['retry-after']) * 1000;

          Logger.verbose('EloTracker', 1, `Discord 429 Rate Limit hit. Waiting ${waitTime}ms before retry.`);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          return executeSend(data, true);
        }

        // Compatibility: Discord.js v12 Fallback
        if (err.message === 'Cannot send an empty message' && data.embeds && data.embeds.length > 0) {
          const legacyData = { ...data, embed: data.embeds[0] };
          delete legacyData.embeds;
          return executeSend(legacyData, isRetry);
        }

        throw err;
      }
    };

    try {
      await executeSend(payload);
      return true;
    } catch (err) {
      const errMsg = `Discord send failed: ${err.message}`;
      if (!suppressErrors) throw new Error(errMsg);
      Logger.verbose('EloTracker', 1, errMsg);
      return false;
    }
  },

  buildRoundSummaryEmbed(data) {
    const {
      layerName,
      winningTeamID,
      ticketDiff,
      roundDuration,
      totalPlayerCount,
      playersUpdatedCount,
      team1Summary,
      team2Summary,
      liveT1,
      liveT2,
      calculationDuration
    } = data;

    const winnerText = winningTeamID === 1 ? 'Team 1' : (winningTeamID === 2 ? 'Team 2' : 'Draw');
    const durationStr = formatDuration(roundDuration);

    const formatSpread = (spread, teamName) => {
      if (!spread || spread.length === 0) return '';
      const lines = spread.map(m => {
        const deltaSign = m.deltaMu >= 0 ? '+' : '';
        return `${m.label} **${m.name}**: ${deltaSign}${m.deltaMu.toFixed(2)}μ (${m.muBefore.toFixed(1)} → ${m.muAfter.toFixed(1)})`;
      });
      return `**${teamName}**\n${lines.join('\n')}`;
    };

    const spreadText = [
      formatSpread(team1Summary.spreadSnapshot, 'Team 1'),
      formatSpread(team2Summary.spreadSnapshot, 'Team 2')
    ].filter(Boolean).join('\n\n');

    const matchVeterancy = (liveT1.count + liveT2.count) > 0
      ? (liveT1.tierStats.rCount + liveT2.tierStats.rCount) / (liveT1.count + liveT2.count)
      : 0;
    const vUI = getVeterancyUI(matchVeterancy);

    const muDelta = Math.abs(liveT1.avgMu - liveT2.avgMu);
    const regDelta = Math.abs(liveT1.tierStats.rCount - liveT2.tierStats.rCount);

    const muLeadTeam = liveT1.avgMu >= liveT2.avgMu ? 1 : 2;
    // const regMuLeadTeam = (liveT1.avgRegMu || 0) >= (liveT2.avgRegMu || 0) ? 1 : 2;
    const vetAdv = liveT1.tierStats.rCount === liveT2.tierStats.rCount ? 'Tie' : `Team ${liveT1.tierStats.rCount > liveT2.tierStats.rCount ? 1 : 2}`;
    
    const totalRegs = liveT1.tierStats.rCount + liveT2.tierStats.rCount;
    const leadRegs = Math.max(liveT1.tierStats.rCount, liveT2.tierStats.rCount);
    const regShare = totalRegs > 0 ? Math.round((leadRegs / totalRegs) * 100) : 0;
    const t1Share = totalRegs > 0 ? Math.round((liveT1.tierStats.rCount / totalRegs) * 100) : 0;
    const t2Share = totalRegs > 0 ? Math.round((liveT2.tierStats.rCount / totalRegs) * 100) : 0;
    const leadShare = Math.max(t1Share, t2Share);
    const vetAdvText = regDelta === 0 ? 'Tie' : `${vetAdv} Advantage`;

    // const isSevere = (muDelta > DISPARITY_THRESHOLDS.SEVERE_MU) || 
    //                  (leadShare > DISPARITY_THRESHOLDS.SEVERE_SHARE) || 
    //                  (muDelta > DISPARITY_THRESHOLDS.SEVERE_MIXED_MU && leadShare > DISPARITY_THRESHOLDS.SEVERE_MIXED_SHARE);
    
    // const isMinor = muDelta > DISPARITY_THRESHOLDS.MINOR_MU || leadShare > DISPARITY_THRESHOLDS.MINOR_SHARE;
    
    // const leadTeamStatus = muDelta >= DISPARITY_THRESHOLDS.LEAD_MU_MIN ? muLeadTeam : (regDelta > 0 ? (team1Summary.tierStats.rCount > team2Summary.tierStats.rCount ? 1 : 2) : 1);
    
    // const statusLine = isSevere ? `🔴 Severe Team ${leadTeamStatus} Advantage` : (isMinor ? `🟡 Minor Team ${leadTeamStatus} Advantage` : '🟢 Match Balanced');
    const muAdvText = muDelta === 0 ? 'Balanced' : `Team ${muLeadTeam} Advantage`;
    // const mixedNote = muLeadTeam !== regMuLeadTeam ? '\n⚠️ **Mixed Advantage**' : '';

    const formatRatingChanges = (stats) => {
      const muSign = stats.avgDeltaMu >= 0 ? '+' : '';
      // Format Sigma to 2 decimal places as requested
      const muPart = `**${muSign}${stats.avgDeltaMu.toFixed(2)}μ**`;
      const sigmaPart = `(Uncertainty: **-${stats.avgDeltaSigma.toFixed(2)}σ**)`;
      return `${muPart} ${sigmaPart}`;
    };

    return {
      color: vUI.color,
      title: '🏆 Round Ended',
      description: `**Veterancy: ${vUI.icon} ${vUI.label}**\n*Percentage of established "Regular" players (10+ rounds) in the match.*\n\n${generateMatrixTable(liveT1, liveT2)}`,
      fields: [
        { name: 'Map / Layer', value: layerName || 'Unknown', inline: true },
        { name: 'Winner', value: `${winnerText} (+${ticketDiff} tickets)`, inline: true },
        { name: 'Duration', value: durationStr, inline: true },
        { name: 'Player Count', value: `${totalPlayerCount}`, inline: true },
        { 
          name: 'Disparity', 
          value: [
            `**Skill Balance:** ${getEloEmoji(muDelta)} ${muDelta.toFixed(2)}μ Elo diff (${muAdvText})`,
            `**Regular Balance:** ${getRegEmoji(leadShare)} ${regDelta} Reg diff (${t1Share}% vs ${t2Share}% Share | ${vetAdvText})`
          ].join('\n'), 
          inline: false 
        },
        { 
          name: 'Rating Changes', 
          value: `**Team 1:** ${formatRatingChanges(team1Summary)}\n**Team 2:** ${formatRatingChanges(team2Summary)}`, 
          inline: false 
        },
        { name: 'Players Updated', value: playersUpdatedCount.toString(), inline: true },
        { name: 'Processing Time', value: `${calculationDuration}ms`, inline: true },
        { name: 'Rating Spread (Regulars)', value: spreadText || 'No regulars played this round', inline: false }
      ],
      timestamp: new Date().toISOString()
    };
  },

  buildPlayerStatsEmbed(player, rank, totalRanked, totalPlayers, provisional = false, localLeaderboard = null, minRounds = 10) {
    const { name, mu, sigma, wins, losses, roundsPlayed } = player;

    let topPercent;
    if (!provisional) {
      const rawPercent = ((rank - 1) / (totalRanked > 1 ? totalRanked - 1 : 1)) * 100;
      if (rank === 1) topPercent = '0.1';
      else if (rawPercent < 1) topPercent = Math.max(0.1, rawPercent).toFixed(1);
      else topPercent = Math.round(rawPercent);
    }

    let reliability;
    if (sigma <= 2.5) reliability = 'Highly Calibrated';
    else if (sigma <= 4.5) reliability = 'Calibrated';
    else if (sigma <= 6.5) reliability = 'Establishing';
    else reliability = 'Initial Calibration';

    const totalGames = wins + losses;
    const winRateStr = totalGames > 0 ? `**${((wins / totalGames) * 100).toFixed(1)}% winrate**` : null;
    const matchHistoryValue = [
      `${wins} Wins / ${losses} Losses`,
      winRateStr
    ].filter(Boolean).join('\n');

    const totalRankedFmt = totalRanked.toLocaleString();
    const totalPlayersFmt = totalPlayers.toLocaleString();

    const description = provisional
      ? `**Provisional** — ${roundsPlayed} rounds played. Rank visible after ${minRounds} rounds. (${totalPlayersFmt} total tracked)`
      : (totalRanked > 0 ? `Rank **#${rank}** of **${totalRankedFmt}** ranked players (${totalPlayersFmt} total).` : 'Unranked');

    const skillRatingValue = provisional
      ? `**${mu.toFixed(1)} μ** (Calibrating...)`
      : `**${mu.toFixed(1)} μ** (Top ${topPercent}% of players)`;

    const fields = [
      {
        name: 'Skill Rating',
        value: skillRatingValue,
        inline: false
      },
      {
        name: 'Match History',
        value: matchHistoryValue,
        inline: false
      },
      {
        name: 'Reliability',
        value: `${reliability} (σ ${sigma.toFixed(2)})`,
        inline: false
      },
      {
        name: 'Glossary',
        value: 'μ (Mu) = Skill Level | σ (Sigma) = Uncertainty',
        inline: false
      }
    ];

    if (localLeaderboard && localLeaderboard.length > 0) {
      const localLines = localLeaderboard.map(p => {
        const line = `#${p.actualRank} ${p.name} — μ ${p.mu.toFixed(1)}`;
        if (p.eosID === player.eosID) {
          return `**${line}** 👈`;
        }
        return line;
      });
      fields.push({
        name: 'Local Leaderboard',
        value: localLines.join('\n'),
        inline: false
      });
    }

    return {
      color: 0x3498db,
      title: `📊 Player Stats for ${name}`,
      description: description,
      fields: fields,
      timestamp: new Date().toISOString()
    };
  },

  buildLeaderboardEmbed(players, limit, startRank = 1, totalRanked = 0, totalPlayers = 0) {
    const lines = players.slice(0, limit).map((p, i) => {
      const rank = (startRank + i).toString().padStart(2, ' ');
      return `#${rank} ${p.name} — μ ${p.mu.toFixed(1)} (W/L: ${p.wins}/${p.losses})`;
    });

    const endRank = startRank + players.length - 1;
    const rankRangeText = players.length > 0 ? `(Ranks ${startRank}-${endRank})` : '(Empty)';
    const totalRankedFmt = totalRanked.toLocaleString();
    const totalPlayersFmt = totalPlayers.toLocaleString();

    return {
      color: 0xf39c12,
      title: `🏆 Leaderboard ${rankRangeText}`,
      description: `Out of **${totalRankedFmt}** ranked players (${totalPlayersFmt} total)\n\`\`\`\n${lines.join('\n')}\n\`\`\``,
      timestamp: new Date().toISOString()
    };
  },

  buildAdminConfirmEmbed(action, detail) {
    return {
      color: 0x9b59b6,
      title: `🛡️ Admin Action: ${action}`,
      description: detail,
      timestamp: new Date().toISOString()
    };
  },

  buildErrorEmbed(context, error) {
    const embed = {
      color: 0xe74c3c,
      title: `⚠️ Error: ${context}`,
      description: `**${error?.message || error}**`,
      timestamp: new Date().toISOString(),
      fields: []
    };

    if (error?.stack) {
      const stack = error.stack.length > 1000 ? error.stack.substring(0, 1000) + '...' : error.stack;
      embed.fields.push({ name: 'Stack Trace', value: `\`\`\`js\n${stack}\n\`\`\``, inline: false });
    }

    return embed;
  },

  buildRoundSkippedEmbed(reason, playerCount, layerName) {
    return {
      color: 0x95a5a6,
      title: '⏭️ ELO Rating Update Skipped',
      fields: [
        { name: 'Reason', value: reason, inline: true },
        { name: 'Player Count', value: playerCount.toString(), inline: true },
        { name: 'Layer', value: layerName || 'Unknown', inline: true }
      ],
      timestamp: new Date().toISOString()
    };
  },

  buildRoundStartEmbed(data, type = 'auto') {
    if (data.status === 'warming') {
      return {
        color: 0x3498db,
        title: '📊 EloTracker: System Initializing',
        description: 'System is synchronizing with the database. Please wait for player data to cache...',
        timestamp: new Date().toISOString()
      };
    }

    // Handle empty server status
    if (data.status === 'empty' || data.totalPlayerCount === 0) {
      return {
        color: 0x95a5a6,
        title: '🛰️ Live Round Info',
        description: 'The server is currently empty. No active match data to display.',
        timestamp: new Date().toISOString()
      };
    }

    const { layerName, t1, t2, muDelta, regDelta, veteranLead, matchVeterancy, roundStartTime, totalPlayerCount } = data;

    const vUI = getVeterancyUI(matchVeterancy);
    const matrixTable = generateMatrixTable(t1, t2);

    const muLeadTeam = t1.avgMu >= t2.avgMu ? 1 : 2;
    // const regMuLeadTeam = (t1.avgRegMu || 0) >= (t2.avgRegMu || 0) ? 1 : 2;
    
    const totalRegs = t1.tierStats.rCount + t2.tierStats.rCount;
    const leadRegs = Math.max(t1.tierStats.rCount, t2.tierStats.rCount);
    const regShare = totalRegs > 0 ? Math.round((leadRegs / totalRegs) * 100) : 0;
    const t1Share = totalRegs > 0 ? Math.round((t1.tierStats.rCount / totalRegs) * 100) : 0;
    const t2Share = totalRegs > 0 ? Math.round((t2.tierStats.rCount / totalRegs) * 100) : 0;
    const leadShare = Math.max(t1Share, t2Share);
    const vetAdvText = regDelta === 0 ? 'Tie' : `${veteranLead} Advantage`;

    // const isSevere = (muDelta > DISPARITY_THRESHOLDS.SEVERE_MU) || 
    //                  (leadShare > DISPARITY_THRESHOLDS.SEVERE_SHARE) || 
    //                  (muDelta > DISPARITY_THRESHOLDS.SEVERE_MIXED_MU && leadShare > DISPARITY_THRESHOLDS.SEVERE_MIXED_SHARE);
    
    // const isMinor = muDelta > DISPARITY_THRESHOLDS.MINOR_MU || leadShare > DISPARITY_THRESHOLDS.MINOR_SHARE;
    
    // const leadTeamStatus = muDelta >= DISPARITY_THRESHOLDS.LEAD_MU_MIN ? muLeadTeam : (regDelta > 0 ? (t1.tierStats.rCount > t2.tierStats.rCount ? 1 : 2) : 1);

    // const statusLine = isSevere ? `🔴 Severe Team ${leadTeamStatus} Advantage` : (isMinor ? `🟡 Minor Team ${leadTeamStatus} Advantage` : '🟢 Match Balanced');
    const muAdvText = muDelta === 0 ? 'Balanced' : `Team ${muLeadTeam} Advantage`;
    // const mixedNote = muLeadTeam !== regMuLeadTeam 
    //   ? `\n⚠️ **Mixed Advantage:** T${muLeadTeam} has better Overall Avg, but T${regMuLeadTeam} has stronger Regs.` 
    //   : '';

    const title = type === 'manual'
      ? `📊 Live Round Info - ${layerName}`
      : `🎬 Round Started - ${layerName}`;
    
    const embed = {
      color: vUI.color,
      title: title,
      description: `**Veterancy: ${vUI.icon} ${vUI.label}**\n*Percentage of established "Regular" players (10+ rounds) in the match.*\n\n${matrixTable}`,
      fields: [
      {
          name: 'Match Health',
          value: [
            `**Skill Balance:** ${getEloEmoji(muDelta)} ${muDelta.toFixed(2)}μ Elo diff (${muAdvText})`,
            `**Regular Balance:** ${getRegEmoji(leadShare)} ${regDelta} Reg diff (${t1Share}% vs ${t2Share}% Share | ${vetAdvText})`
          ].join('\n'),
        inline: false
      },
      { name: 'Player Count', value: `${totalPlayerCount}`, inline: true }
      ],
      timestamp: new Date().toISOString()
    };

    if (roundStartTime) {
      embed.fields.push({
        name: 'Round Start',
        value: `<t:${Math.floor(roundStartTime / 1000)}:R>`,
        inline: true
      });
    }

    return embed;
  },

  registerDiscordCommands(tracker) {
    tracker.onDiscordMessage = async function(message) {
      if (!this.ready) return;
      if (message.author.bot) return;

      const content = message.content.trim();
      if (!content.startsWith('!elo')) return;

      const isAdminChannel = this.discordAdminChannel &&
        message.channel.id === this.options.discordAdminChannelID;
      const isPublicChannel = this.discordPublicChannel &&
        message.channel.id === this.options.discordPublicChannelID;

      if (!isAdminChannel && !isPublicChannel) return;

      const args = content.replace(/^!elo\s*/i, '').trim().split(/\s+/).filter(Boolean);
      const sub = args[0]?.toLowerCase();

      // --- Admin-only commands (admin channel only, checked first) ---
      if (isAdminChannel) {
        if (sub === 'status') {
          const sessionCount = this.session.getSessionCount();
          const cacheCount = this.eloCache.size;
          const roundStartStr = this.session.roundStartTime
            ? `<t:${Math.floor(this.session.roundStartTime / 1000)}:R>`
            : 'None';

          const cacheSample = Array.from(this.eloCache.entries())
            .slice(0, 10)
            .map(([id, data]) => {
              const player = this.server.players.find(p => p.eosID === id);
              return `\`${player ? player.name : id}\`: μ ${data.mu.toFixed(2)} σ ${data.sigma.toFixed(2)}`;
            })
            .join('\n');

          const embed = {
            color: 0x3498db,
            title: '📊 EloTracker Status',
            fields: [
              { name: 'Version', value: this.constructor.version, inline: true },
              { name: 'Ready', value: this.ready.toString(), inline: true },
              { name: 'Session Players', value: sessionCount.toString(), inline: true },
              { name: 'ELO Cache Entries', value: cacheCount.toString(), inline: true },
              { name: 'Round Start', value: roundStartStr, inline: true },
              { name: 'Cache Sample (10)', value: cacheSample || 'Empty', inline: false }
            ],
            timestamp: new Date().toISOString()
          };

          await EloDiscord.sendDiscordMessage(message.channel, { embeds: [embed] });
          return;
        }

        if (sub === 'roundinfo') {
          try {
            const data = this.buildRoundStartData(); 
            const embed = EloDiscord.buildRoundStartEmbed(data, 'manual');
            await EloDiscord.sendDiscordMessage(message.channel, { embeds: [embed] });
          } catch (err) {
            await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed('Round Info', err)] });
          }
          return;
        }

        if (sub === 'reset') {
          const identifier = args.slice(1).join(' ');

          if (!identifier) {
            await message.reply('⚠️ This will wipe ALL ELO ratings and round history. Reply `!elo reset confirm` within 30 seconds to proceed.');
            this._resetConfirmPending = { timestamp: Date.now() };
            return;
          }

          if (identifier === 'confirm') {
            if (!this._resetConfirmPending || Date.now() - this._resetConfirmPending.timestamp > 30000) {
              await message.reply('⚠️ No pending reset confirmation, or confirmation expired.');
              this._resetConfirmPending = null;
              return;
            }
            this._resetConfirmPending = null;
            try {
              await this.db.models.PlayerStats.destroy({ where: {} });
              await this.db.models.RoundHistory.destroy({ where: {} });
              this.eloCache.clear();
              await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildAdminConfirmEmbed('ELO Reset', 'All ratings and round history wiped.')] });
            } catch (err) {
              await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed('ELO Reset', err)] });
            }
            return;
          }

          // Single player reset
          const defaults = {
            mu: this.options.defaultMu,
            sigma: this.options.defaultSigma,
            wins: 0,
            losses: 0,
            roundsPlayed: 0
          };
          try {
            const player = await this._findPlayerByIdentifier(identifier);
            if (!player) {
              await message.reply(`No player found: ${identifier}`);
              return;
            }
            await this.db.upsertPlayerStats(player.eosID, defaults);
            if (this.eloCache.has(player.eosID)) {
              this.eloCache.set(player.eosID, { mu: defaults.mu, sigma: defaults.sigma });
            }
            await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildAdminConfirmEmbed('Player Reset', `Reset ${player.name} to default rating.`)] });
          } catch (err) {
            await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed('Player Reset', err)] });
          }
          return;
        }

        if (sub === 'backup') {
          try {
            const players = await this.db.exportPlayerStats();
            const payload = JSON.stringify({
              exportedAt: Date.now(),
              playerCount: players.length,
              players
            }, null, 2);
            const buffer = Buffer.from(payload, 'utf-8');
            const filename = `elo-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
            await message.channel.send({
              content: `📦 ELO Backup — ${players.length} players`,
              files: [{ attachment: buffer, name: filename }]
            });
          } catch (err) {
            await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed('Backup', err)] });
          }
          return;
        }

        if (sub === 'restore') {
          if (!message.attachments.size) {
            await message.reply('Please attach a backup JSON file with the !elo restore command.');
            return;
          }
          try {
            const attachment = message.attachments.first();
            const response = await fetch(attachment.url);
            const json = await response.json();
            if (!Array.isArray(json.players)) {
              await message.reply('Invalid backup format: missing players array.');
              return;
            }
            await this.db.importPlayerStats(json.players);
            await EloDiscord.sendDiscordMessage(message.channel, {
              embeds: [EloDiscord.buildAdminConfirmEmbed('Restore Complete', `Restored ${json.players.length} players from backup.`)]
            });
          } catch (err) {
            await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed('Restore', err)] });
          }
          return;
        }
      }

      // --- Public commands (available in both channels) ---
      if (sub === 'link') {
        const steamID = args[1];

        if (!steamID || !/^\d{17}$/.test(steamID)) {
          const replyMsg = await message.reply('⚠️ Invalid SteamID. Please provide your 17-digit SteamID. This message will be deleted in 5 seconds.');
          setTimeout(() => {
            message.delete().catch(() => {});
            replyMsg.delete().catch(() => {});
          }, 5000);
          return;
        }

        try {
          const player = await this.db.models.PlayerStats.findOne({ where: { steamID } });

          if (!player) {
            const replyMsg = await message.reply('⚠️ No ELO record found for that SteamID. Make sure you have played at least one round on the server. This message will be deleted in 5 seconds.');
            setTimeout(() => {
              message.delete().catch(() => {});
              replyMsg.delete().catch(() => {});
            }, 5000);
            return;
          }

          await player.update({ discordID: message.author.id });

          await EloDiscord.sendDiscordMessage(message.channel, {
            embeds: [EloDiscord.buildAdminConfirmEmbed('Account Linked', `Your Discord account is now successfully linked to the ELO record for **${player.name}**.`)]
          });
          message.delete().catch(() => {});
        } catch (err) {
          await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed('Account Link', err)] });
        }
        return;
      }

      if (sub === 'explain') {
        const initialMu = this.options.defaultMu;
        const initialSigma = this.options.defaultSigma;
        const explainEmbed = {
          color: 0x3498db,
          title: '📖 How the ELO System Works',
          description: 'This server uses a system based on [TrueSkill](https://en.wikipedia.org/wiki/TrueSkill) to rank players. Here’s a quick breakdown:',
          fields: [
            {
              name: 'TrueSkill Algorithm',
              value: 'A rating system used by major platforms (like Xbox) to track your skill (μ) and uncertainty (σ) in team games.'
            },
            {
              name: 'Skill (μ — "Mu")',
              value: `Your estimated performance level. Everyone starts at ${initialMu}. This number goes up when you win and decreases when you lose based on the strength of your opponents.`
            },
            {
              name: 'Reliability (σ — "Sigma")',
              value: `This is the system's confidence in your skill rating. It starts at ${initialSigma} and drops as you play more games, making your rank more stable.`
            },
            {
              name: 'The Calibration Goal',
              value: "Once your Sigma drops below 2.5, you are considered 'Highly Calibrated' and your rank becomes more stable."
            }
          ]
        };
        await EloDiscord.sendDiscordMessage(message.channel, { embeds: [explainEmbed] });
        return;
      }

      if (sub === 'help') {
        const embed = {
          color: 0x3498db,
          title: '📖 EloTracker Command Reference',
          fields: [
            {
              name: '🌐 Public Commands',
              value: [
                '`!elo` or `!elo me` — Look up your own linked ELO rating and local leaderboard',
                '`!elo <name | steamID | eosID>` — Look up another player',
                '`!elo link <SteamID>` — Link your Discord account to your SteamID',
                '`!elo leaderboard [rank]` — Show 25 players, optionally centered around a specific rank',
                '`!elo explain` — Explains the ranking algorithm and symbols',
                '`!elo help` — Show this message'
              ].join('\n'),
              inline: false
            },
            ...(isAdminChannel ? [{
              name: '🛡️ Admin Commands (admin channel only)',
              value: [
                '`!elo status` — Plugin status and current round info',
                '`!elo roundinfo` — Live round snapshot: team balance, veterancy, and match health',
                '`!elo reset` — Wipe ALL ratings and round history (requires confirm)',
                '`!elo reset confirm` — Confirm a pending full reset',
                '`!elo reset <identifier>` — Reset a single player to default rating',
                '`!elo backup` — Export all player stats as a JSON file attachment',
                '`!elo restore` — Restore from a JSON backup (attach file with command)'
              ].join('\n'),
              inline: false
            }] : [])
          ],
          timestamp: new Date().toISOString()
        };
        await EloDiscord.sendDiscordMessage(message.channel, { embeds: [embed] });
        return;
      }

      if (!sub || sub === 'me') {
        const player = await this.db.models.PlayerStats.findOne({ where: { discordID: message.author.id } });
        if (!player) {
          await message.reply('No linked ELO record found. Please use `!elo link <Your17DigitSteamID>` to link your account first!');
          return;
        }

        const minRounds = this.options.minRoundsForLeaderboard;
        const provisional = player.roundsPlayed < minRounds;
        const rank = provisional ? null : await this.db.getPlayerRank(player.mu, minRounds);
        const totalRanked = await this.db.getTotalRankedPlayers(minRounds);
        const totalPlayers = await this.db.getTotalPlayers();

        let localLeaderboard = null;
        if (!provisional && rank !== null) {
          const limit = 5;
          const offset = Math.max(0, rank - 3);
          const neighborhood = await this.db.getLeaderboard(limit, minRounds, offset);
          localLeaderboard = neighborhood.map((p, i) => ({ ...p, actualRank: offset + 1 + i }));
        }

        await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildPlayerStatsEmbed(player, rank, totalRanked, totalPlayers, provisional, localLeaderboard, minRounds)] });
        return;
      }

      if (sub === 'leaderboard') {
        const minRounds = this.options.minRoundsForLeaderboard;
        const totalRanked = await this.db.getTotalRankedPlayers(minRounds);
        const totalPlayers = await this.db.getTotalPlayers();
        
        let targetRank = 1;
        if (args.length > 1) {
          const parsed = parseInt(args[1], 10);
          if (!isNaN(parsed) && parsed > 0) {
            targetRank = parsed;
          }
        }
        
        if (targetRank > totalRanked && totalRanked > 0) {
          targetRank = totalRanked;
        }
        
        const limit = 25;
        let offset = Math.max(0, targetRank - 13);
        const startRank = offset + 1;
        
        const players = await this.db.getLeaderboard(limit, minRounds, offset);
        await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildLeaderboardEmbed(players, limit, startRank, totalRanked, totalPlayers)] });
        return;
      }

      // !elo <identifier> — look up another player
      const identifier = args.join(' ');
      const player = await this._findPlayerByIdentifier(identifier);
      if (!player) {
        await message.reply(`No ELO record found for: ${identifier}`);
        return;
      }

      const minRounds = this.options.minRoundsForLeaderboard;
      const provisional = player.roundsPlayed < minRounds;
      const rank = provisional ? null : await this.db.getPlayerRank(player.mu, minRounds);
      const totalRanked = await this.db.getTotalRankedPlayers(minRounds);
      const totalPlayers = await this.db.getTotalPlayers();

      let localLeaderboard = null;
      if (!provisional && rank !== null) {
        const limit = 5;
        const offset = Math.max(0, rank - 3);
        const neighborhood = await this.db.getLeaderboard(limit, minRounds, offset);
        localLeaderboard = neighborhood.map((p, i) => ({ ...p, actualRank: offset + 1 + i }));
      }

      await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildPlayerStatsEmbed(player, rank, totalRanked, totalPlayers, provisional, localLeaderboard, minRounds)] });
    };

    tracker._findPlayerByIdentifier = async function(identifier) {
      return await this.db.searchPlayer(identifier);
    };
  }
}

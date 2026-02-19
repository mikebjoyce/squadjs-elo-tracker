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
      playerCount,
      topMovers
    } = data;

    const winnerText = winningTeamID === 1 ? 'Team 1' : (winningTeamID === 2 ? 'Team 2' : 'Draw');
    const durationStr = formatDuration(roundDuration);

    const moverLines = topMovers.map((m, i) => {
      const deltaSign = m.deltaMu >= 0 ? '+' : '';
      return `${i + 1}. **${m.name}**: ${deltaSign}${m.deltaMu.toFixed(2)} μ (${m.muBefore.toFixed(2)} → ${m.muAfter.toFixed(2)})`;
    });

    return {
      color: 0x2ecc71,
      title: '🏆 Round Ended',
      fields: [
        { name: 'Map / Layer', value: layerName || 'Unknown', inline: true },
        { name: 'Winner', value: `${winnerText} (+${ticketDiff} tickets)`, inline: true },
        { name: 'Duration', value: durationStr, inline: true },
        { name: 'Players Updated', value: playerCount.toString(), inline: true },
        { name: 'Top ELO Movers', value: moverLines.length > 0 ? moverLines.join('\n') : 'None', inline: false }
      ],
      timestamp: new Date().toISOString()
    };
  },

  buildPlayerStatsEmbed(player) {
    const { name, mu, sigma, wins, losses, roundsPlayed, lastSeen } = player;

    let lastSeenStr = 'Never';
    if (lastSeen) {
      const unixTime = Math.floor(lastSeen / 1000);
      lastSeenStr = `<t:${unixTime}:f> (<t:${unixTime}:R>)`;
    }

    return {
      color: 0x3498db,
      title: `📊 Player Stats: ${name}`,
      fields: [
        {
          name: 'Rating',
          value: `**μ = ${mu.toFixed(2)}** ± σ ${sigma.toFixed(2)}`,
          inline: false
        },
        {
          name: 'Record',
          value: `Wins: ${wins} | Losses: ${losses} | Total: ${roundsPlayed}`,
          inline: false
        },
        {
          name: 'Last Seen',
          value: lastSeenStr,
          inline: false
        }
      ],
      timestamp: new Date().toISOString()
    };
  },

  buildLeaderboardEmbed(players, limit) {
    const lines = players.slice(0, limit).map((p, i) => {
      const rank = (i + 1).toString().padStart(2, ' ');
      return `#${rank} ${p.name} — μ ${p.mu.toFixed(2)} (W/L: ${p.wins}/${p.losses})`;
    });

    return {
      color: 0xf39c12,
      title: `🏆 Top ${limit} Leaderboard`,
      description: `\`\`\`\n${lines.join('\n')}\n\`\`\``,
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
      title: '⏭️ Round Skipped',
      fields: [
        { name: 'Reason', value: reason, inline: true },
        { name: 'Player Count', value: playerCount.toString(), inline: true },
        { name: 'Layer', value: layerName || 'Unknown', inline: true }
      ],
      timestamp: new Date().toISOString()
    };
  }
};
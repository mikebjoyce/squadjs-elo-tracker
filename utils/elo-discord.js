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

  buildPlayerStatsEmbed(player, rank, totalPlayers) {
    const { name, mu, sigma, wins, losses, lastSeen } = player;

    let lastSeenStr = 'Never';
    if (lastSeen) {
      const unixTime = Math.floor(lastSeen / 1000);
      lastSeenStr = `<t:${unixTime}:f> (<t:${unixTime}:R>)`;
    }

    const topPercent = Math.max(1, Math.round(((rank - 1) / (totalPlayers > 1 ? totalPlayers - 1 : 1)) * 100) || 1);

    let reliability;
    if (sigma <= 2.5) reliability = 'Highly Calibrated';
    else if (sigma <= 4.5) reliability = 'Calibrated';
    else if (sigma <= 6.5) reliability = 'Establishing';
    else reliability = 'Initial Calibration';

    const totalGames = wins + losses;
    const winRateStr = totalGames > 0 ? `**${((wins / totalGames) * 100).toFixed(1)}% winrate**` : null;
    const matchHistoryValue = [
      `${wins} wins`,
      `${losses} losses`,
      `${totalGames} total rounds`,
      winRateStr
    ].filter(Boolean).join('\n');

    return {
      color: 0x3498db,
      title: `📊 Player Stats for ${name}`,
      description: totalPlayers > 0 ? `Rank **#${rank}** of **${totalPlayers}** players.` : 'Unranked',
      fields: [
        {
          name: 'Skill Rating',
          value: `**${mu.toFixed(2)} μ** (Top ${topPercent}% of players)`,
          inline: true
        },
        {
          name: 'Reliability',
          value: `${reliability} (σ ${sigma.toFixed(2)})`,
          inline: true
        },
        {
          name: 'Match History',
          value: matchHistoryValue,
          inline: false
        },
        {
          name: 'Last Seen',
          value: lastSeenStr,
          inline: false
        },
        {
          name: 'Glossary',
          value: 'μ (Mu) = Skill Level | σ (Sigma) = Uncertainty',
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
        const explainEmbed = {
          color: 0x3498db,
          title: '📖 How the ELO System Works',
          description: 'This server uses a system based on **TrueSkill** to rank players. Here’s a quick breakdown:',
          fields: [
            {
              name: 'TrueSkill Algorithm',
              value: 'A rating system used by major platforms (like Xbox) to track your skill (μ) and uncertainty (σ) in team games.'
            },
            {
              name: 'Skill (μ — "Mu")',
              value: 'Your estimated performance level. This number goes up when you win and down when you lose.'
            },
            {
              name: 'Reliability (σ — "Sigma")',
              value: "This is the system's confidence in your skill rating. It starts high and drops as you play more games, making your rank more stable."
            },
            {
              name: 'Purpose',
              value: 'The main goal is to use these ratings to balance teams fairly, creating more competitive and enjoyable rounds for everyone.'
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
                '`!elo` — Look up your own linked ELO rating',
                '`!elo <name | steamID | eosID>` — Look up another player',
                '`!elo link <SteamID>` — Link your Discord account to your SteamID',
                '`!elo leaderboard` — Top 20 players by rating',
                '`!elo explain` — Explains the ranking algorithm and symbols',
                '`!elo help` — Show this message'
              ].join('\n'),
              inline: false
            },
            ...(isAdminChannel ? [{
              name: '🛡️ Admin Commands (admin channel only)',
              value: [
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
        const rank = await this.db.getPlayerRank(player.mu);
        const totalPlayers = await this.db.getTotalPlayers();
        await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildPlayerStatsEmbed(player, rank, totalPlayers)] });
        return;
      }

      if (sub === 'leaderboard') {
        const players = await this.db.getLeaderboard(20);
        await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildLeaderboardEmbed(players, 20)] });
        return;
      }

      // !elo <identifier> — look up another player
      const identifier = args.join(' ');
      const player = await this._findPlayerByIdentifier(identifier);
      if (!player) {
        await message.reply(`No ELO record found for: ${identifier}`);
        return;
      }
      const rank = await this.db.getPlayerRank(player.mu);
      const totalPlayers = await this.db.getTotalPlayers();
      await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildPlayerStatsEmbed(player, rank, totalPlayers)] });
    };

    tracker._findPlayerByIdentifier = async function(identifier) {
      return await this.db.searchPlayer(identifier);
    };
  }
};
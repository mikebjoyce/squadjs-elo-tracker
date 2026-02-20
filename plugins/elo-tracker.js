import BasePlugin from './base-plugin.js';
import Logger from '../../core/logger.js';
import EloDatabase from '../utils/elo-database.js';
import EloSessionManager from '../utils/elo-session-manager.js';
import EloCalculator from '../utils/elo-calculator.js';
import { EloDiscord } from '../utils/elo-discord.js';

export default class EloTracker extends BasePlugin {
  static get version() {
    return '0.1.0';
  }

  static get description() {
    return 'A SquadJS plugin that tracks player participation across rounds, computes individual ELO ratings using a TrueSkill-based algorithm, and persists all data via SQLite.';
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      database: {
        required: true,
        connector: 'sequelize',
        description: 'Sequelize/SQLite connector.',
        default: 'sqlite'
      },
      minParticipationRatio: { default: 0.15, type: 'number' },
      defaultMu: { default: 25.0, type: 'number' },
      defaultSigma: { default: 8.333, type: 'number' },
      minPlayersForElo: { default: 80, type: 'number' },
      ignoredGameModes: { default: ['Seed', 'Training'], type: 'array' },
      discordClient: {
        required: false,
        connector: 'discord',
        description: 'Discord connector.',
        default: 'discord'
      },
      discordAdminChannelID: { required: false, default: '', type: 'string' },
      discordPublicChannelID: { required: false, default: '', type: 'string' }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.db = new EloDatabase(server, options, connectors);
    this.session = new EloSessionManager();

    // ELO cache — Map<eosID, { mu, sigma }>
    // Connected players only. Populated on join, flushed at round end.
    this.eloCache = new Map();

    this.discordAdminChannel = null;
    this.discordPublicChannel = null;

    this._isMounted = false;
    this.ready = false;

    // Bound listeners — mirror TeamBalancer pattern exactly
    this.listeners = {};
    this.listeners.onNewGame = this.onNewGame.bind(this);
    this.listeners.onUpdatedPlayerInfo = this.onUpdatedPlayerInfo.bind(this);
    this.listeners.onRoundEnded = this.onRoundEnded.bind(this);
    this.listeners.onDiscordMessage = this.onDiscordMessage.bind(this);
  }

  async mount() {
    if (this._isMounted) {
      return;
    }
    Logger.verbose('EloTracker', 1, 'Mounting plugin.');
    this.ready = false;

    const { roundStartTime: persistedStartTime } = await this.db.initDB();

    // Restart Recovery
    let serverRoundStart = this.server.matchStartTime ? this.server.matchStartTime.getTime() : null;

    if (!serverRoundStart && this.server.layerHistory && this.server.layerHistory.length > 0) {
      serverRoundStart = this.server.layerHistory[0].time.getTime();
    }

    if (!serverRoundStart) {
      Logger.verbose('EloTracker', 1, 'Restart recovery unavailable: Could not determine server round start time.');
    }

    const threeHours = 3 * 60 * 60 * 1000;

    if (persistedStartTime && serverRoundStart && Math.abs(persistedStartTime - serverRoundStart) < threeHours) {
      // Same round detected after a restart
      this.session.startRound(persistedStartTime);
      Logger.verbose('EloTracker', 1, `Restart detected. Resuming round from saved start time: ${new Date(persistedStartTime).toISOString()}`);
      // Immediately populate sessions for currently connected players
      this.onUpdatedPlayerInfo();
    } else {
      // Fresh round
      const now = Date.now();
      this.session.startRound(now);
      await this.db.saveRoundStartTime(now);
      Logger.verbose('EloTracker', 1, `New round started. Start time set to: ${new Date(now).toISOString()}`);
    }

    // Fetch Discord channels
    if (this.options.discordClient) {
      if (this.options.discordAdminChannelID) {
        try {
          this.discordAdminChannel = await this.options.discordClient.channels.fetch(this.options.discordAdminChannelID);
          Logger.verbose('EloTracker', 1, `Fetched admin Discord channel: ${this.discordAdminChannel.name}`);
        } catch (err) {
          Logger.verbose('EloTracker', 1, `Could not fetch admin Discord channel (ID: ${this.options.discordAdminChannelID}): ${err.message}`);
        }
      }
      if (this.options.discordPublicChannelID) {
        try {
          this.discordPublicChannel = await this.options.discordClient.channels.fetch(this.options.discordPublicChannelID);
          Logger.verbose('EloTracker', 1, `Fetched public Discord channel: ${this.discordPublicChannel.name}`);
        } catch (err) {
          Logger.verbose('EloTracker', 1, `Could not fetch public Discord channel (ID: ${this.options.discordPublicChannelID}): ${err.message}`);
        }
      }
    }

    // Register listeners
    this.server.removeListener('NEW_GAME', this.listeners.onNewGame);
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.listeners.onUpdatedPlayerInfo);
    this.server.removeListener('ROUND_ENDED', this.listeners.onRoundEnded);

    this.server.on('NEW_GAME', this.listeners.onNewGame);
    this.server.on('UPDATED_PLAYER_INFORMATION', this.listeners.onUpdatedPlayerInfo);
    this.server.on('ROUND_ENDED', this.listeners.onRoundEnded);

    if (this.options.discordClient) {
      this.options.discordClient.removeListener('message', this.listeners.onDiscordMessage);
      this.options.discordClient.on('message', this.listeners.onDiscordMessage);
    }

    this._isMounted = true;
    this.ready = true;
    Logger.verbose('EloTracker', 1, 'Plugin mounted and ready.');
  }

  async unmount() {
    if (!this._isMounted) {
      return;
    }
    Logger.verbose('EloTracker', 1, 'Unmounting plugin.');

    this.server.removeListener('NEW_GAME', this.listeners.onNewGame);
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.listeners.onUpdatedPlayerInfo);
    this.server.removeListener('ROUND_ENDED', this.listeners.onRoundEnded);

    if (this.options.discordClient) {
      this.options.discordClient.removeListener('message', this.listeners.onDiscordMessage);
    }

    this.ready = false;
    this._isMounted = false;
    Logger.verbose('EloTracker', 1, 'Plugin unmounted.');
  }

  /**
   * Event Handlers
   */

  async onNewGame() {
    if (!this.ready) return;

    Logger.verbose('EloTracker', 1, 'NEW_GAME event received. Starting new session.');
    const now = Date.now();
    this.session.startRound(now);
    await this.db.saveRoundStartTime(now);
    this.eloCache.clear();
  }

  async onUpdatedPlayerInfo() {
    if (!this.ready) return;

    // Filter to assigned players only (teamID 1 or 2)
    const currentPlayers = this.server.players.filter(
      (p) => p.teamID === 1 || p.teamID === 2
    );

    // Update session map
    this.session.updatePlayers(currentPlayers);

    // Find players not yet in eloCache
    const uncachedIDs = currentPlayers
      .map((p) => p.eosID)
      .filter((id) => !this.eloCache.has(id));

    if (uncachedIDs.length === 0) return;

    // Batch DB read for uncached players
    const dbResults = await this.db.getPlayerStatsBatch(uncachedIDs);

    // Re-check who is connected *after* the async DB call to prevent race conditions
    const currentlyConnected = new Set(this.server.players.map(p => p.eosID));

    for (const eosID of uncachedIDs) {
      // Only cache if the player is still connected
      if (currentlyConnected.has(eosID)) {
        const record = dbResults.get(eosID);
        this.eloCache.set(eosID, {
          mu: record ? record.mu : this.options.defaultMu,
          sigma: record ? record.sigma : this.options.defaultSigma
        });
      }
    }
  }

  async onRoundEnded(data) {
    if (!this.ready) return;

    const roundEndTime = Date.now();

    // --- Eligibility checks ---
    const playerCount = this.server.players.length;
    const gameMode = this.server.currentLayer?.gamemode ?? null;

    if (playerCount < this.options.minPlayersForElo) {
      Logger.verbose('EloTracker', 1, `[onRoundEnded] Skipping ELO update: player count ${playerCount} below threshold ${this.options.minPlayersForElo}.`);
      if (this.discordAdminChannel) {
        const embed = EloDiscord.buildRoundSkippedEmbed('Player count below threshold', playerCount, this.server.currentLayer?.name ?? 'Unknown');
        await EloDiscord.sendDiscordMessage(this.discordAdminChannel, { embeds: [embed] });
      }
      return;
    }

    if (gameMode && this.options.ignoredGameModes.some(m => m.toLowerCase() === gameMode.toLowerCase())) {
      Logger.verbose('EloTracker', 1, `[onRoundEnded] Skipping ELO update: ignored game mode "${gameMode}".`);
      if (this.discordAdminChannel) {
        const embed = EloDiscord.buildRoundSkippedEmbed(`Ignored game mode: ${gameMode}`, playerCount, this.server.currentLayer?.name ?? 'Unknown');
        await EloDiscord.sendDiscordMessage(this.discordAdminChannel, { embeds: [embed] });
      }
      return;
    }

    // --- Session flush ---
    const participants = this.session.endRound(roundEndTime);

    // --- Determine outcome ---
    // SquadJS ROUND_ENDED data.winner contains the winning teamID (1 or 2), or null for draw.
    const winningTeamID = data?.winner ?? null;
    const outcome = winningTeamID === 1 ? 'team1win'
                  : winningTeamID === 2 ? 'team2win'
                  : 'draw';

    // --- Filter by minParticipationRatio ---
    const eligible = participants.filter(
      p => p.participationRatio >= this.options.minParticipationRatio
    );

    if (eligible.length === 0) {
      Logger.verbose('EloTracker', 1, '[onRoundEnded] No eligible participants. Skipping ELO update.');
      return;
    }

    // --- Build team arrays with mu/sigma from cache ---
    const getRating = (eosID) =>
      this.eloCache.get(eosID) ?? { mu: this.options.defaultMu, sigma: this.options.defaultSigma };

    const team1Eligible = eligible.filter(p => p.assignedTeamID === 1);
    const team2Eligible = eligible.filter(p => p.assignedTeamID === 2);

    if (team1Eligible.length === 0 || team2Eligible.length === 0) {
      Logger.verbose('EloTracker', 1, `[onRoundEnded] Skipping ELO update: One or both teams have no eligible participants (Team 1: ${team1Eligible.length}, Team 2: ${team2Eligible.length}).`);
      if (this.discordAdminChannel) {
        const embed = EloDiscord.buildRoundSkippedEmbed(
          'One or both teams had no eligible participants',
          eligible.length,
          this.server.currentLayer?.name ?? 'Unknown'
        );
        await EloDiscord.sendDiscordMessage(this.discordAdminChannel, { embeds: [embed] });
      }
      return;
    }

    // --- Run TrueSkill ---
    const { team1Updates, team2Updates } = EloCalculator.computeTeamUpdate(
      team1Eligible.map(p => getRating(p.eosID)),
      team2Eligible.map(p => getRating(p.eosID)),
      outcome
    );

    // --- Apply participation scaling, build DB updates, track topMovers ---
    const dbUpdates = [];
    const topMovers = [];
    const now = Date.now();

    const processTeam = (players, updates, isWinner, isLoser) => {
      players.forEach((player, i) => {
        const { deltaMu, deltaSigma } = updates[i];
        const rating = getRating(player.eosID);
        const scaledDeltaMu = deltaMu * player.participationRatio;
        const scaledDeltaSigma = deltaSigma * player.participationRatio;

        const newMu = rating.mu + scaledDeltaMu;
        const newSigma = Math.max(rating.sigma - scaledDeltaSigma, 0.5);

        dbUpdates.push({
          eosID: player.eosID,
          steamID: player.steamID ?? null,
          name: player.name,
          mu: newMu,
          sigma: newSigma,
          wins: isWinner ? 1 : 0,    // NOTE: bulkUpsertPlayerStats must INCREMENT not overwrite
          losses: isLoser ? 1 : 0,
          roundsPlayed: 1,
          lastSeen: now
        });

        topMovers.push({
          name: player.name,
          muBefore: rating.mu,
          muAfter: newMu,
          deltaMu: scaledDeltaMu
        });

        // Update cache immediately
        this.eloCache.set(player.eosID, { mu: newMu, sigma: newSigma });
      });
    };

    const team1IsWinner = outcome === 'team1win';
    const team2IsWinner = outcome === 'team2win';
    processTeam(team1Eligible, team1Updates, team1IsWinner, team2IsWinner);
    processTeam(team2Eligible, team2Updates, team2IsWinner, team1IsWinner);

    // --- DB writes ---
    try {
      await this.db.bulkUpsertPlayerStats(dbUpdates);
      await this.db.insertRoundHistory({
        layerName: this.server.currentLayer?.name ?? 'Unknown',
        winningTeamID,
        ticketDiff: data?.tickets ?? 0,
        roundDuration: roundEndTime - this.session.roundStartTime,
        endedAt: roundEndTime,
        playerCount: eligible.length
      });
    } catch (err) {
      Logger.verbose('EloTracker', 1, `[onRoundEnded] DB write failed: ${err.message}`);
    }

    // --- Discord post ---
    if (this.discordAdminChannel) {
      try {
        const sortedMovers = topMovers
          .sort((a, b) => Math.abs(b.deltaMu) - Math.abs(a.deltaMu))
          .slice(0, 5);

        const embed = EloDiscord.buildRoundSummaryEmbed({
          layerName: this.server.currentLayer?.name ?? 'Unknown',
          winningTeamID,
          ticketDiff: data?.tickets ?? 0,
          roundDuration: roundEndTime - this.session.roundStartTime,
          playerCount: eligible.length,
          topMovers: sortedMovers
        });
        await EloDiscord.sendDiscordMessage(this.discordAdminChannel, { embeds: [embed] });
      } catch (err) {
        Logger.verbose('EloTracker', 1, `[onRoundEnded] Discord post failed: ${err.message}`);
      }
    }

    // --- Flush cache ---
    this.eloCache.clear();
    Logger.verbose('EloTracker', 1, `[onRoundEnded] ELO update complete. ${eligible.length} players updated.`);
  }

  getTeamElo(players) {
    if (!players || players.length === 0) {
      return { averageMu: this.options.defaultMu, playerCount: 0 };
    }
    const total = players.reduce((sum, p) => {
      const cached = this.eloCache.get(p.eosID);
      return sum + (cached ? cached.mu : this.options.defaultMu);
    }, 0);
    return {
      averageMu: total / players.length,
      playerCount: players.length
    };
  }

  async onDiscordMessage(message) {
    if (!this.ready) return;
    if (message.author.bot) return;

    const content = message.content.trim();
    if (!content.startsWith('!elo')) return;

    const isAdminChannel = this.discordAdminChannel && message.channel.id === this.options.discordAdminChannelID;
    const isPublicChannel = this.discordPublicChannel && message.channel.id === this.options.discordPublicChannelID;

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
    if (!sub || sub === 'me') {
      const identifier = message.author.username;
      const player = await this.db.getPlayerStats(identifier) ??
        (await this._findPlayerByIdentifier(identifier));
      if (!player) {
        await message.reply('No ELO record found for your account.');
        return;
      }
      await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildPlayerStatsEmbed(player)] });
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
    await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildPlayerStatsEmbed(player)] });
  }

  // Helper: find a player record by name, steamID, or eosID
  async _findPlayerByIdentifier(identifier) {
    return await this.db.searchPlayer(identifier);
  }
}
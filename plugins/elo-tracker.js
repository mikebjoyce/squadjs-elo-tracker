/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                      ELO TRACKER PLUGIN                      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── IN-GAME COMMAND LIST ───────────────────────────────────────
 *
 * Public Commands:
 * !elo                           → Your ELO rating and rank.
 * !elo <name | steamID>          → Look up another player's rating.
 * !elo leaderboard               → Top 10 players by rating.
 * !elo help                      → Show available commands.
 *
 * Admin Commands (ChatAdmin only):
 * !eloadmin status               → Plugin status and current round info.
 * !eloadmin reset <name|steamID> → Reset a player to default rating.
 * !eloadmin help                 → Show available commands.
 *
 * ─── DISCORD COMMAND LIST ───────────────────────────────────────
 *
 * Public Commands (public + admin channel):
 * !elo                           → Your linked ELO rating and rank.
 * !elo <name | steamID | eosID>  → Look up another player.
 * !elo link <SteamID>            → Link your Discord to your SteamID.
 * !elo leaderboard               → Top 20 players by rating.
 * !elo explain                   → How the TrueSkill ranking system works.
 * !elo help                      → Show available commands.
 *
 * Admin Commands (admin channel only):
 * !elo status                    → Plugin status and current round info.
 * !elo reset                     → Wipe ALL ratings + history (requires confirm).
 * !elo reset confirm             → Confirm a pending full reset.
 * !elo reset <name|steamID>      → Reset a single player to default rating.
 * !elo backup                    → Export all player stats as a JSON attachment.
 * !elo restore                   → Restore from a JSON backup (attach file).
 *
 * ─── CONFIGURATION OPTIONS ──────────────────────────────────────
 *
 * Core:
 * database                       - Sequelize/SQLite connector for persistent storage.
 * enablePublicIngameCommands     - Enable/disable public !elo in-game commands.
 *
 * ELO Algorithm:
 * defaultMu                      - Default TrueSkill μ for new players.
 * defaultSigma                   - Default TrueSkill σ for new players.
 * minParticipationRatio          - Min fraction of round played to earn ELO.
 *
 * Eligibility:
 * minPlayersForElo               - Min server population to run ELO updates.
 * minRoundsForLeaderboard        - Min rounds played to appear in rankings.
 * ignoredGameModes               - Game modes excluded from ELO tracking.
 *
 * Discord:
 * discordClient                  - Discord connector for logging.
 * discordAdminChannelID          - Channel ID for admin round summaries.
 * discordPublicChannelID         - Channel ID for public-facing output.
 *
 * ─── CONFIGURATION EXAMPLE ──────────────────────────────────────

// 1. Add connectors to the "connectors" object in config.json:

"connectors": {
  "sqlite": {
    "dialect": "sqlite",
    "storage": "squad-server.sqlite"
  },
  "discord": {
    "connector": "discord",
    "token": "YOUR_BOT_TOKEN"
  }
},

// 2. Add the plugin configuration to the "plugins" array in config.json:

{
  "plugin": "EloTracker",
  "enabled": true,
  "database": "sqlite",
  "eloLogPath": "./elo-match-log.jsonl",
  "minParticipationRatio": 0.15,
  "defaultMu": 25.0,
  "defaultSigma": 8.333,
  "minPlayersForElo": 80,
  "minRoundsForLeaderboard": 10,
  "ignoredGameModes": ["Seed", "Training"],
  "enablePublicIngameCommands": true,
  "discordClient": "discord",
  "discordAdminChannelID": "",
  "discordPublicChannelID": ""
}

 * Author:
 * Discord: `real_slacker`
 *
 * ════════════════════════════════════════════════════════════════
 */

import { appendFileSync } from 'fs';
import BasePlugin from './base-plugin.js';
import Logger from '../../core/logger.js';
import EloDatabase from '../utils/elo-database.js';
import EloSessionManager from '../utils/elo-session-manager.js';
import EloCalculator from '../utils/elo-calculator.js';
import { EloDiscord } from '../utils/elo-discord.js';
import EloCommands from '../utils/elo-commands.js';

export default class EloTracker extends BasePlugin {
  static get version() {
    return '0.2.0';
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
      eloLogPath: { required: false, default: './elo-match-log.jsonl', type: 'string' },
      minParticipationRatio: { default: 0.15, type: 'number' },
      defaultMu: { default: 25.0, type: 'number' },
      defaultSigma: { default: 8.333, type: 'number' },
      minPlayersForElo: { default: 80, type: 'number' },
      minRoundsForLeaderboard: { default: 10, type: 'number' },
      ignoredGameModes: { default: ['Seed', 'Training'], type: 'array' },
      enablePublicIngameCommands: { default: true, type: 'boolean' },
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
    EloDiscord.registerDiscordCommands(this);
    this.listeners.onDiscordMessage = this.onDiscordMessage.bind(this);
    EloCommands.register(this);
    this.listeners.onEloCommand = this.onEloCommand.bind(this);
    this.listeners.onEloAdminCommand = this.onEloAdminCommand.bind(this);
  }

  async mount() {
    if (this._isMounted) {
      return;
    }
    Logger.verbose('EloTracker', 1, 'Mounting plugin.');
    this.ready = false;

    const { roundStartTime: persistedStartTime } = await this.db.initDB();

    // --- Prune stale player entries ---
    const { tier1, tier2 } = await this.db.pruneStaleEntries(this.options.minRoundsForLeaderboard);
    Logger.verbose('EloTracker', 1, `[mount] Pruned stale entries — Tier 1 (provisional): ${tier1}, Tier 2 (calibrated): ${tier2}`);

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
      await this.onUpdatedPlayerInfo();
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
    this.server.removeListener('CHAT_COMMAND:elo', this.listeners.onEloCommand);
    this.server.removeListener('CHAT_COMMAND:eloadmin', this.listeners.onEloAdminCommand);

    this.server.on('NEW_GAME', this.listeners.onNewGame);
    this.server.on('UPDATED_PLAYER_INFORMATION', this.listeners.onUpdatedPlayerInfo);
    this.server.on('ROUND_ENDED', this.listeners.onRoundEnded);
    this.server.on('CHAT_COMMAND:elo', this.listeners.onEloCommand);
    this.server.on('CHAT_COMMAND:eloadmin', this.listeners.onEloAdminCommand);
    
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
    this.server.removeListener('CHAT_COMMAND:elo', this.listeners.onEloCommand);
    this.server.removeListener('CHAT_COMMAND:eloadmin', this.listeners.onEloAdminCommand);

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
    if (!this.ready) {
      Logger.verbose('EloTracker', 1, '[onRoundEnded] Fired but plugin not ready. Skipping.');
      if (this.discordAdminChannel) {
        const embed = EloDiscord.buildRoundSkippedEmbed('Plugin not ready at round end', 0, this.server.currentLayer?.name ?? 'Unknown');
        await EloDiscord.sendDiscordMessage(this.discordAdminChannel, { embeds: [embed] });
      }
      return;
    }

    const roundEndTime = Date.now();

    // --- Eligibility checks ---
    const playerCount = this.server.players.length;
    const gameMode = this.server.currentLayer?.gamemode ?? null;

    if (playerCount < this.options.minPlayersForElo) {
      Logger.verbose('EloTracker', 1, `[onRoundEnded] Skipping ELO update: player count ${playerCount} below threshold ${this.options.minPlayersForElo}.`);
      if (this.discordAdminChannel) {
        const embed = EloDiscord.buildRoundSkippedEmbed(`Player count below threshold (Gamemode: ${gameMode ?? 'Unknown'})`, playerCount, this.server.currentLayer?.name ?? 'Unknown');
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
    // SquadJS ROUND_ENDED data.winner is an object like { team: '1', tickets: 150 }
    const winningTeamID = data?.winner ? parseInt(data.winner.team, 10) : null;
    const ticketDiff = Math.abs((data?.winner?.tickets ?? 0) - (data?.loser?.tickets ?? 0));
    const outcome = winningTeamID === 1 ? 'team1win'
                  : winningTeamID === 2 ? 'team2win'
                  : 'draw';

    // --- Filter by minParticipationRatio ---
    const eligible = participants.filter(
      p => p.participationRatio >= this.options.minParticipationRatio
    );

    if (eligible.length === 0) {
      Logger.verbose('EloTracker', 1, '[onRoundEnded] No eligible participants. Skipping ELO update.');
      if (this.discordAdminChannel) {
        const embed = EloDiscord.buildRoundSkippedEmbed(
          `No eligible participants (0 players met minParticipationRatio of ${this.options.minParticipationRatio})`,
          participants.length,
          this.server.currentLayer?.name ?? 'Unknown'
        );
        await EloDiscord.sendDiscordMessage(this.discordAdminChannel, { embeds: [embed] });
      }
      return;
    }

    const calculationStartTime = Date.now();

    // --- Build team arrays with mu/sigma from cache ---
    const getRating = (eosID) =>
      this.eloCache.get(eosID) ?? { mu: this.options.defaultMu, sigma: this.options.defaultSigma };

    const team1Eligible = eligible.filter(p => p.assignedTeamID === 1);
    const team2Eligible = eligible.filter(p => p.assignedTeamID === 2);

    // --- Pre-computation for Discord ---
    const team1Elo = this.getTeamElo(team1Eligible);
    const team2Elo = this.getTeamElo(team2Eligible);

    if (team1Eligible.length === 0 || team2Eligible.length === 0) {
      Logger.verbose('EloTracker', 1, `[onRoundEnded] Skipping ELO update: One or both teams have no eligible participants (Team 1: ${team1Eligible.length}, Team 2: ${team2Eligible.length}).`);
      if (this.discordAdminChannel) {
        const embed = EloDiscord.buildRoundSkippedEmbed(
          `One or both teams had no eligible participants (Gamemode: ${gameMode ?? 'Unknown'})`,
          playerCount,
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

    const team1RatingsBefore = team1Eligible.map(p => getRating(p.eosID));
    const team2RatingsBefore = team2Eligible.map(p => getRating(p.eosID));

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
        ticketDiff: ticketDiff,
        roundDuration: roundEndTime - this.session.roundStartTime,
        endedAt: roundEndTime,
        playerCount: eligible.length
      });
    } catch (err) {
      Logger.verbose('EloTracker', 1, `[onRoundEnded] DB write failed: ${err.message}`);
    }

    const matchRecord = {
      matchId: roundEndTime.toString(),
      endedAt: roundEndTime,
      layerName: this.server.currentLayer?.name ?? 'Unknown',
      gameMode: gameMode ?? 'Unknown',
      outcome,
      roundDuration: roundEndTime - this.session.roundStartTime,
      params: {
        BETA: EloCalculator.BETA,
        TAU: EloCalculator.TAU,
        DRAW_PROBABILITY: EloCalculator.DRAW_PROBABILITY
      },
      players: [
        ...team1Eligible.map((player, i) => {
          const rating = team1RatingsBefore[i];
          const { deltaMu, deltaSigma } = team1Updates[i];
          const scaledDeltaMu = deltaMu * player.participationRatio;
          const scaledDeltaSigma = deltaSigma * player.participationRatio;
          return {
            eosID: player.eosID,
            name: player.name,
            teamID: 1,
            participationRatio: player.participationRatio,
            muBefore: rating.mu,
            sigmaBefore: rating.sigma,
            rawDeltaMu: deltaMu,
            rawDeltaSigma: deltaSigma,
            scaledDeltaMu,
            scaledDeltaSigma,
            muAfter: rating.mu + scaledDeltaMu,
            sigmaAfter: Math.max(rating.sigma - scaledDeltaSigma, 0.5)
          };
        }),
        ...team2Eligible.map((player, i) => {
          const rating = team2RatingsBefore[i];
          const { deltaMu, deltaSigma } = team2Updates[i];
          const scaledDeltaMu = deltaMu * player.participationRatio;
          const scaledDeltaSigma = deltaSigma * player.participationRatio;
          return {
            eosID: player.eosID,
            name: player.name,
            teamID: 2,
            participationRatio: player.participationRatio,
            muBefore: rating.mu,
            sigmaBefore: rating.sigma,
            rawDeltaMu: deltaMu,
            rawDeltaSigma: deltaSigma,
            scaledDeltaMu,
            scaledDeltaSigma,
            muAfter: rating.mu + scaledDeltaMu,
            sigmaAfter: Math.max(rating.sigma - scaledDeltaSigma, 0.5)
          };
        })
      ]
    };
    this._appendMatchLog(matchRecord);

    const calculationDuration = Date.now() - calculationStartTime;

    // --- Discord post ---
    if (this.discordAdminChannel) {
      try {
        const sortedMovers = topMovers
          .sort((a, b) => Math.abs(b.deltaMu) - Math.abs(a.deltaMu))
          .slice(0, 5);

        const embed = EloDiscord.buildRoundSummaryEmbed({
          layerName: this.server.currentLayer?.name ?? 'Unknown',
          gameMode,
          winningTeamID,
          ticketDiff: ticketDiff,
          roundDuration: roundEndTime - this.session.roundStartTime,
          playerCount: eligible.length,
          topMovers: sortedMovers,
          team1AvgMu: team1Elo.averageMu,
          team2AvgMu: team2Elo.averageMu,
          calculationDuration
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

  async getRatingsByEosIDs(eosIDs) {
    const results = await this.db.getPlayerStatsBatch(eosIDs);
    return new Map(eosIDs.map(id => [
        id,
        results.get(id) ?? { mu: this.options.defaultMu, sigma: this.options.defaultSigma }
    ]));
  }

  _appendMatchLog(record) {
    try {
      appendFileSync(this.options.eloLogPath, JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      Logger.verbose('EloTracker', 1, `[_appendMatchLog] Failed to write log: ${err.message}`);
    }
  }
}
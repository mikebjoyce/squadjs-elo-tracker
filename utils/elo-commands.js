import Logger from '../../core/logger.js';

const EloCommands = {
  register(tracker) {

    // Shared respond helper — wraps rcon.warn with logging
    tracker.respond = async function(player, msg) {
      const name = player?.name || 'Unknown';
      const steamID = player?.steamID;
      Logger.verbose('EloTracker', 2, `[Response to ${name} (${steamID || 'Unknown'})]\n${msg}`);
      if (steamID) {
        try {
          await this.server.rcon.warn(steamID, msg);
        } catch (err) {
          Logger.verbose('EloTracker', 1, `[EloCommands] rcon.warn failed for ${steamID}: ${err.message}`);
        }
      }
      return msg;
    };

    // Public in-game command handler
    // Registered on CHAT_COMMAND:elo
    // Available to all players in any chat channel
    tracker.onEloCommand = async function(info) {
      if (!this.ready) return;
      if (this.options.enablePublicIngameCommands === false) return;

      const args = (info.message || '')
        .replace(/^!elo\s*/i, '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const sub = args[0]?.toLowerCase();
      const player = info.player || { steamID: info.steamID, name: info.playerName };

      // !elo or !elo help
      if (!sub || sub === 'help') {
        return await this.respond(player, [
          '=== EloTracker Commands ===',
          '!elo — Your ELO rating',
          '!elo <name | steamID> — Look up another player',
          '!elo leaderboard — Top 10 players by rating',
          '!elo help — Show this message'
        ].join('\n'));
      }

      // !elo leaderboard
      if (sub === 'leaderboard') {
        try {
          const players = await this.db.getLeaderboard(10, this.options.minRoundsForLeaderboard);
          if (!players.length) {
            return await this.respond(player, 'No leaderboard data yet.');
          }
          const lines = players.map((p, i) =>
            `#${i + 1} ${p.name} — μ ${p.mu.toFixed(2)} (${p.wins}W/${p.losses}L)`
          );
          return await this.respond(player, ['=== ELO Leaderboard ===', ...lines].join('\n'));
        } catch (err) {
          Logger.verbose('EloTracker', 1, `[EloCommands] Leaderboard failed: ${err.message}`);
          return await this.respond(player, 'Failed to retrieve leaderboard.');
        }
      }

      // !elo <identifier> — player lookup
      const identifier = args.join(' ');
      try {
        const record = await this._findPlayerByIdentifier(identifier);
        if (!record) {
          return await this.respond(player, `No ELO record found for: ${identifier}`);
        }

        const minRounds = this.options.minRoundsForLeaderboard;
        let rankLine;
        if (record.roundsPlayed < minRounds) {
          rankLine = `Rank: Provisional — ${record.roundsPlayed}/${minRounds} rounds`;
        } else {
          const rank = await this.db.getPlayerRank(record.mu, minRounds);
          const total = await this.db.getTotalPlayers();
          rankLine = `Rank: #${rank} (of ${total} total)`;
        }

        return await this.respond(player, [
          `=== ${record.name} ===`,
          rankLine,
          `Rating: μ ${record.mu.toFixed(2)} ± σ ${record.sigma.toFixed(2)}`,
          `Record: ${record.wins}W / ${record.losses}L (${record.roundsPlayed} rounds)`
        ].join('\n'));
      } catch (err) {
        Logger.verbose('EloTracker', 1, `[EloCommands] Player lookup failed: ${err.message}`);
        return await this.respond(player, 'Failed to retrieve player stats.');
      }
    };

    // Admin in-game command handler
    // Registered on CHAT_COMMAND:eloadmin
    // Restricted to ChatAdmin channel only
    tracker.onEloAdminCommand = async function(info) {
      if (!this.ready) return;
      if (info.chat !== 'ChatAdmin') return;

      const args = (info.message || '')
        .replace(/^!eloadmin\s*/i, '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const sub = args[0]?.toLowerCase();
      const player = info.player || { steamID: info.steamID, name: info.playerName };

      if (!sub || sub === 'help') {
        return await this.respond(player, [
          '=== EloTracker Admin Commands ===',
          '!eloadmin reset <name|steamID> — Reset a player to default rating',
          '!eloadmin status — Plugin status and current round info',
          '!eloadmin help — Show this message'
        ].join('\n'));
      }

      // !eloadmin status
      if (sub === 'status') {
        const sessionCount = this.session.getSessionCount();
        const cacheCount = this.eloCache.size;
        return await this.respond(player, [
          '=== EloTracker Status ===',
          `Version: ${this.constructor.version}`,
          `Ready: ${this.ready}`,
          `Session players: ${sessionCount}`,
          `ELO cache entries: ${cacheCount}`,
          `Round start: ${this.session.roundStartTime ? new Date(this.session.roundStartTime).toISOString() : 'None'}`
        ].join('\n'));
      }

      // !eloadmin reset <identifier>
      if (sub === 'reset') {
        const identifier = args.slice(1).join(' ');
        if (!identifier) {
          return await this.respond(player, 'Usage: !eloadmin reset <name | steamID | eosID>');
        }
        try {
          const record = await this._findPlayerByIdentifier(identifier);
          if (!record) {
            return await this.respond(player, `No player found: ${identifier}`);
          }
          const defaults = { mu: this.options.defaultMu, sigma: this.options.defaultSigma, wins: 0, losses: 0, roundsPlayed: 0 };
          await this.db.upsertPlayerStats(record.eosID, defaults);
          if (this.eloCache.has(record.eosID)) { this.eloCache.set(record.eosID, { mu: defaults.mu, sigma: defaults.sigma }); }
          Logger.verbose('EloTracker', 2, `[EloCommands] Admin ${player.name} reset ELO for ${record.name}`);
          return await this.respond(player, `Reset ${record.name} to default rating (μ ${defaults.mu}).`);
        } catch (err) {
          Logger.verbose('EloTracker', 1, `[EloCommands] Reset failed: ${err.message}`);
          return await this.respond(player, `Failed to reset player: ${err.message}`);
        }
      }

      return await this.respond(player, 'Unknown command. Type !eloadmin help for options.');
    };
  }
};

export default EloCommands;
/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                         ELO DATABASE                          ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * SQLite persistence layer for the EloTracker plugin. Manages player
 * stats, round history, leaderboard queries, and plugin state using
 * the Sequelize ORM injected via the connectors argument.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * EloDatabase (default)
 *   Class. Key public methods:
 *     initDB()                         — Sync models, seed PluginState row.
 *     getPlayerStats(eosID)            — Single player lookup by eosID.
 *     getPlayerStatsBatch(eosIDs)      — Bulk lookup; returns a Map.
 *     searchPlayer(identifier)         — Fuzzy search by eosID/steamID/name.
 *     upsertPlayerStats(eosID, fields) — Single-record upsert.
 *     bulkUpsertPlayerStats(updates)   — Batch upsert in one transaction.
 *     insertRoundHistory(data)         — Append a round record.
 *     getLeaderboard(limit, minRounds, offset) — Top players by CSR, with optional offset.
 *     getPlayerRank(consRating, minRounds) — Rank of a given CSR value.
 *     getTotalRankedPlayers(minRounds) — Count of players meeting the minimum rounds threshold.
 *     exportPlayerStats()              — Full table dump as plain objects.
 *     importPlayerStats(records)       — Bulk restore from export.
 *     pruneStaleEntries(minRounds)     — Delete old low-activity records.
 *
 *   Leaderboard and rank calculation methods internally apply a
 *   "Competitive Skill Rank" (CSR) formula (μ - 3.0σ) instead of raw Mu.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * sequelize (Sequelize)
 *   ORM for SQLite. Injected via connectors.sqlite — not instantiated
 *   internally. All three models are defined and synced in initDB().
 * Logger (../../core/logger.js)
 *   Verbose error logging on all caught DB exceptions.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - All operations go through _executeWithRetry() — retries up to 5×
 *   on SQLITE_BUSY with 200ms + random jitter backoff.
 * - A promise-chain mutex is attached to the Sequelize instance to
 *   serialise writes and prevent concurrent lock contention.
 * - bulkUpsertPlayerStats() INCREMENTS wins, losses, and roundsPlayed.
 *   All other fields are overwritten. Do not pass cumulative totals.
 * - Models are stored on this.models and may be referenced externally
 *   (e.g. this.db.models.PlayerStats.destroy in elo-discord.js).
 * - Sequelize.BIGINT is used for timestamps to avoid JS integer
 *   overflow with Unix ms values.
 * - pruneStaleEntries() removes provisional players unseen for 30 days
 *   and calibrated players unseen for 90 days.
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */

import Sequelize from 'sequelize';
import Logger from '../../core/logger.js';

const SIGMA_MULTIPLIER = 3.0;

export default class EloDatabase {
  constructor(server, options, connectors) {
    this.server = server;
    this.options = options;
    this.sequelize = connectors?.sqlite;
    this.models = {};
  }

  async _executeWithRetry(logicFn, attempts = 5) {
    const runAttempt = async () => {
      for (let i = 0; i < attempts; i++) {
        try {
          return await logicFn();
        } catch (err) {
          const isLocked = err.message && (
            err.message.includes('SQLITE_BUSY') ||
            err.message.includes('database is locked') ||
            err.name === 'SequelizeTimeoutError'
          );
          if (isLocked && i < attempts - 1) {
            const jitter = Math.random() * 500;
            await new Promise((resolve) => setTimeout(resolve, 200 + jitter));
          } else {
            throw err;
          }
        }
      }
    };

    if (this.sequelize && typeof this.sequelize.getDialect === 'function' && this.sequelize.getDialect() === 'sqlite') {
      if (!this.sequelize._squadjs_mutex) {
        this.sequelize._squadjs_mutex = Promise.resolve();
      }
      
      const resultPromise = this.sequelize._squadjs_mutex.then(() => runAttempt());
      this.sequelize._squadjs_mutex = resultPromise.catch(() => {});
      return resultPromise;
    }

    return runAttempt();
  }

  async initDB() {
    if (!this.sequelize) {
      Logger.verbose('EloTracker', 1, '[DB] SQLite connector not available.');
      return { roundStartTime: null };
    }

    try {
      this.models.PluginState = this.sequelize.define(
        'Elo_PluginState',
        {
          id: {
            type: Sequelize.INTEGER,
            primaryKey: true,
            autoIncrement: false,
            defaultValue: 1
          },
          roundStartTime: {
            type: Sequelize.BIGINT,
            allowNull: true
          }
        },
        { timestamps: false }
      );

      this.models.PlayerStats = this.sequelize.define(
        'Elo_PlayerStats',
        {
          eosID: {
            type: Sequelize.STRING,
            primaryKey: true
          },
          steamID: {
            type: Sequelize.STRING,
            allowNull: true
          },
          discordID: {
            type: Sequelize.STRING,
            allowNull: true
          },
          name: {
            type: Sequelize.STRING,
            allowNull: true
          },
          mu: {
            type: Sequelize.FLOAT,
            defaultValue: 25.0
          },
          sigma: {
            type: Sequelize.FLOAT,
            defaultValue: 8.333
          },
          wins: {
            type: Sequelize.INTEGER,
            defaultValue: 0
          },
          losses: {
            type: Sequelize.INTEGER,
            defaultValue: 0
          },
          roundsPlayed: {
            type: Sequelize.INTEGER,
            defaultValue: 0
          },
          lastSeen: {
            type: Sequelize.BIGINT,
            allowNull: true
          }
        },
        { timestamps: false }
      );

      this.models.RoundHistory = this.sequelize.define(
        'Elo_RoundHistory',
        {
          id: {
            type: Sequelize.INTEGER,
            primaryKey: true,
            autoIncrement: true
          },
          layerName: {
            type: Sequelize.STRING,
            allowNull: true
          },
          winningTeamID: {
            type: Sequelize.INTEGER,
            allowNull: true
          },
          ticketDiff: {
            type: Sequelize.INTEGER,
            allowNull: true
          },
          roundDuration: {
            type: Sequelize.INTEGER,
            allowNull: true
          },
          endedAt: {
            type: Sequelize.BIGINT,
            allowNull: true
          },
          playerCount: {
            type: Sequelize.INTEGER,
            allowNull: true
          }
        },
        { timestamps: false }
      );

      await this._executeWithRetry(async () => {
        await this.models.PluginState.sync({ alter: true });
        await this.models.PlayerStats.sync({ alter: true });
        await this.models.RoundHistory.sync({ alter: true });
      });

      const state = await this._executeWithRetry(async () => {
        return await this.sequelize.transaction(async (t) => {
          const [record] = await this.models.PluginState.findOrCreate({
            where: { id: 1 },
            defaults: { id: 1, roundStartTime: null },
            transaction: t
          });
          return record;
        });
      });

      Logger.verbose('EloTracker', 1, '[DB] Database initialized.');
      return { roundStartTime: state.roundStartTime ? parseInt(state.roundStartTime) : null };
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error initializing database: ${error.message}`);
      return { roundStartTime: null };
    }
  }

  async saveRoundStartTime(timestamp) {
    if (!this.sequelize) return null;
    try {
      return await this._executeWithRetry(async () => {
        return await this.sequelize.transaction(async (t) => {
          await this.models.PluginState.update(
            { roundStartTime: timestamp },
            { where: { id: 1 }, transaction: t }
          );
        });
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error saving roundStartTime: ${error.message}`);
      return null;
    }
  }

  async getPlayerStats(eosID) {
    if (!this.sequelize) return null;
    try {
      return await this._executeWithRetry(async () => {
        const record = await this.models.PlayerStats.findOne({ where: { eosID } });
        return record ? record.toJSON() : null;
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error fetching stats for ${eosID}: ${error.message}`);
      return null;
    }
  }

  async getPlayerStatsBatch(eosIDs) {
    if (!this.sequelize) return new Map();
    try {
      return await this._executeWithRetry(async () => {
        const records = await this.models.PlayerStats.findAll({
          where: {
            eosID: {
              [Sequelize.Op.in]: eosIDs
            }
          }
        });
        const map = new Map();
        for (const record of records) {
          map.set(record.eosID, record.toJSON());
        }
        return map;
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error fetching batch stats: ${error.message}`);
      return new Map();
    }
  }

  async searchPlayer(identifier) {
    if (!this.sequelize || !identifier) return null;
    const id = identifier.trim();
    try {
      return await this._executeWithRetry(async () => {
        const record = await this.models.PlayerStats.findOne({ where: { eosID: id } });
        if (record) return record.toJSON();

        const fuzzy = await this.models.PlayerStats.findOne({
          where: {
            [Sequelize.Op.or]: [
              { steamID: id },
              { name: { [Sequelize.Op.like]: `%${id}%` } }
            ]
          }
        });
        return fuzzy ? fuzzy.toJSON() : null;
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error searching for player ${id}: ${error.message}`);
      return null;
    }
  }

  async upsertPlayerStats(eosID, fields) {
    if (!this.sequelize) return null;
    try {
      return await this._executeWithRetry(async () => {
        return await this.sequelize.transaction(async (t) => {
          const existing = await this.models.PlayerStats.findOne({ where: { eosID }, transaction: t });
          if (existing) {
            await existing.update(fields, { transaction: t });
            return existing.toJSON();
          } else {
            const created = await this.models.PlayerStats.create({ eosID, ...fields }, { transaction: t });
            return created.toJSON();
          }
        });
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error upserting stats for ${eosID}: ${error.message}`);
      return null;
    }
  }

  async bulkUpsertPlayerStats(updates) {
    if (!this.sequelize) return null;
    try {
      return await this._executeWithRetry(async () => {
        return await this.sequelize.transaction(async (t) => {
          const eosIDs = updates.map((u) => u.eosID);
          const existing = await this.models.PlayerStats.findAll({
            where: { eosID: { [Sequelize.Op.in]: eosIDs } },
            transaction: t
          });
          const existingMap = new Map(existing.map((r) => [r.eosID, r]));

          for (const update of updates) {
            const { eosID, ...fields } = update;
            const record = existingMap.get(eosID);
            if (record) {
              await record.update({
                mu: fields.mu,
                sigma: fields.sigma,
                wins: record.wins + (fields.wins ?? 0),
                losses: record.losses + (fields.losses ?? 0),
                roundsPlayed: record.roundsPlayed + (fields.roundsPlayed ?? 0),
                lastSeen: fields.lastSeen,
                name: fields.name ?? record.name,
                steamID: fields.steamID ?? record.steamID
              }, { transaction: t });
            } else {
              await this.models.PlayerStats.create({ eosID, ...fields }, { transaction: t });
            }
          }
        });
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error bulk upserting stats: ${error.message}`);
      return null;
    }
  }

  async insertRoundHistory(data) {
    if (!this.sequelize) return null;
    try {
      return await this._executeWithRetry(async () => {
        return await this.sequelize.transaction(async (t) => {
          const record = await this.models.RoundHistory.create(data, { transaction: t });
          return record.toJSON();
        });
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error inserting round history: ${error.message}`);
      return null;
    }
  }

  async getLeaderboard(limit = 20, minRounds = 10, offset = 0) {
    if (!this.sequelize) return [];
    try {
      return await this._executeWithRetry(async () => {
        const records = await this.models.PlayerStats.findAll({
          where: {
            roundsPlayed: {
              [Sequelize.Op.gte]: minRounds
            }
          },
          order: [[Sequelize.literal(`(mu - (${SIGMA_MULTIPLIER} * sigma))`), 'DESC']],
          limit: limit,
          offset: offset
        });
        return records.map((r) => r.toJSON());
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error fetching leaderboard: ${error.message}`);
      return [];
    }
  }

  async getPlayerRank(consRating, minRounds = 0) {
    if (!this.sequelize) return 0;
    try {
      return await this._executeWithRetry(async () => {
        const whereClause = minRounds > 0 ? { roundsPlayed: { [Sequelize.Op.gte]: minRounds } } : {};
        whereClause[Sequelize.Op.and] = Sequelize.literal(`(mu - (${SIGMA_MULTIPLIER} * sigma)) > ${Number(consRating)}`);

        const higherRanked = await this.models.PlayerStats.count({
          where: whereClause
        });
        return higherRanked + 1;
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error fetching player rank for consRating ${consRating}: ${error.message}`);
      return 0;
    }
  }

  async getTotalPlayers() {
    if (!this.sequelize) return 0;
    try {
      return await this._executeWithRetry(async () => {
        return await this.models.PlayerStats.count();
      });
    } catch (error) {
      Logger.verbose(
        'EloTracker',
        1,
        `[DB] Error fetching total players: ${error.message}`
      );
      return 0;
    }
  }

  async getTotalRankedPlayers(minRounds = 10) {
    if (!this.sequelize) return 0;
    try {
      return await this._executeWithRetry(async () => {
        return await this.models.PlayerStats.count({
          where: {
            roundsPlayed: {
              [Sequelize.Op.gte]: minRounds
            }
          }
        });
      });
    } catch (error) {
      Logger.verbose(
        'EloTracker',
        1,
        `[DB] Error fetching total ranked players: ${error.message}`
      );
      return 0;
    }
  }

  async exportPlayerStats() {
    if (!this.sequelize) return [];
    try {
      return await this._executeWithRetry(async () => {
        const records = await this.models.PlayerStats.findAll();
        return records.map((r) => r.toJSON());
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error exporting stats: ${error.message}`);
      return [];
    }
  }

  async importPlayerStats(records) {
    if (!this.sequelize) return null;
    try {
      return await this._executeWithRetry(async () => {
        return await this.sequelize.transaction(async (t) => {
          for (const record of records) {
            const { eosID, ...fields } = record;
            const existing = await this.models.PlayerStats.findOne({ where: { eosID }, transaction: t });
            if (existing) {
              await existing.update(fields, { transaction: t });
            } else {
              await this.models.PlayerStats.create(record, { transaction: t });
            }
          }
        });
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error importing stats: ${error.message}`);
      return null;
    }
  }

  async pruneStaleEntries(minRoundsForLeaderboard) {
    if (!this.sequelize) return { tier1: 0, tier2: 0 };
    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;

    try {
      const tier1Count = await this._executeWithRetry(async () => {
        return await this.models.PlayerStats.destroy({
          where: {
            lastSeen: { [Sequelize.Op.lt]: now - thirtyDays },
            roundsPlayed: { [Sequelize.Op.lt]: minRoundsForLeaderboard }
          }
        });
      });

      const tier2Count = await this._executeWithRetry(async () => {
        return await this.models.PlayerStats.destroy({
          where: {
            lastSeen: { [Sequelize.Op.lt]: now - ninetyDays },
            roundsPlayed: { [Sequelize.Op.gte]: minRoundsForLeaderboard }
          }
        });
      });

      return { tier1: tier1Count, tier2: tier2Count };
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error pruning stale entries: ${error.message}`);
      return { tier1: 0, tier2: 0 };
    }
  }
}
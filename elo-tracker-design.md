# ELO Tracker Plugin — Design Document
**SquadJS Plugin | Draft v0.1**

---

## Overview

A SquadJS plugin that tracks player participation across rounds, computes individual ELO ratings using a TrueSkill-based algorithm adapted for large team play, and persists all data across server restarts via SQLite.

---

## Goals

- Track which players are on which team, and for how long, each round
- Handle joins, leaves, and mid-round team switches accurately
- Produce a clean per-player participation record at round end
- Compute fair individual ELO updates using team-level TrueSkill math
- Persist ELO, win/loss records, and round history to SQLite

---

## File Structure

Mirrors the TeamBalancer plugin pattern:

```
squad-server/
├── plugins/
│   └── elo-tracker.js            ← Main plugin. Event hooks, orchestration.
└── utils/
    ├── elo-database.js            ← Sequelize models, all DB read/write logic.
    ├── elo-session-manager.js     ← In-memory round session. Tracks player segments.
    ├── elo-calculator.js          ← Pure math. TrueSkill implementation.
    └── elo-discord.js             ← Static embed builders and Discord send helpers. Mirrors tb-discord-helpers.js pattern.
```

---

## Player Tracking

### Source of Truth

SquadJS internally polls `ListPlayers` via RCON on a 30s interval and emits `UPDATED_PLAYER_INFORMATION` after updating `server.players`. We hook this single event and diff `server.players` against our in-memory session map ourselves.

The default interval is 30 seconds. This granularity is sufficient — segment boundary errors of up to 30s are negligible against a typical 60+ minute round. The plugin does not modify `server.updatePlayerListInterval`.

### Diff Logic

On every `UPDATED_PLAYER_INFORMATION` event, compare the fresh `server.players` list against the session map:

| Condition | Action |
|---|---|
| eosID in new list, not in session | Player joined — open a new segment |
| eosID in session, not in new list | Player left — **leave segment open** |
| eosID in both, `teamID` changed | Team switch — close current segment, open new one |

**Disconnected players keep their segment open.** Their last known `teamID` is preserved. All open segments are closed at round end with `leaveTime = roundEndTime`. This avoids unreliable disconnect event timing and keeps round-end flush as the single cleanup point.

### Segment Structure

```js
// Session map entry
// Map<eosID, { name, steamID, segments: Segment[], activeSegment: Segment | null }>

// Segment
{ teamID: Number, joinTime: Date, leaveTime: Date | null }
```

A player may accumulate multiple segments per round if they switch teams.

---

## Round Lifecycle

### Events Hooked

| Event | Action |
|---|---|
| `NEW_GAME` | Set `roundStartTime`, clear all sessions |
| `UPDATED_PLAYER_INFORMATION` | Run player list diff |
| `ROUND_ENDED` | Close all open segments, compute participation, trigger ELO update |

### Round End Flush

1. Set `roundEndTime = Date.now()`
2. For every player in session map, close their `activeSegment` with `leaveTime = roundEndTime`
3. For each player, compute total time per team across all segments
4. Assign player to whichever team they spent the most time on (used for win/loss attribution)
5. Compute `participationRatio = totalTimeOnAssignedTeam / roundDuration`
6. Pass full participant list to `elo-calculator.js`

---

## Participation Scaling

ELO delta is scaled by how much of the round a player was present for.

```
participationRatio = playerTimeOnTeam / roundDuration   // clamped [0.0, 1.0]

if participationRatio < MIN_PARTICIPATION (default: 0.15)
  → eloDelta = 0  (no ELO change)
else
  → eloDelta = rawEloDelta * participationRatio
```

`roundDuration` is fixed at `roundEndTime - roundStartTime`. Long rounds do not inflate ELO — the ratio is always bounded at 1.0.

`MIN_PARTICIPATION` is configurable.

### Team Switch Handling (Option C — Split Credit)

If a player spent meaningful time on both teams, their ELO delta is a weighted sum of both outcomes:

```
team1Ratio = timeOnTeam1 / roundDuration
team2Ratio = timeOnTeam2 / roundDuration

eloDelta = (eloForTeam1Outcome * team1Ratio) + (eloForTeam2Outcome * team2Ratio)
```

If they won on one team and lost on the other, the deltas partially cancel. Accurate and fair.

---

## ELO System — TrueSkill

### Why TrueSkill

Standard 1v1 ELO doesn't handle large team games well. With 50 players per side, individual contribution is heavily diluted and naive team averaging penalises players unfairly. TrueSkill models each player as a probability distribution, handles team size natively, and converges to accurate ratings faster.

### Player Rating Model

Each player has two values:

| Field | Description |
|---|---|
| `mu` (μ) | Estimated skill mean. Default: `25.0` |
| `sigma` (σ) | Uncertainty in that estimate. Default: `25/3 ≈ 8.33` |

`sigma` decreases as more games are played — the system becomes more confident in the rating over time. A new player has high σ (uncertain). A veteran has low σ (stable).

### Team-Level Computation

1. Compute weighted team μ and σ using player participation ratios
2. Run TrueSkill update math at the team level to get Δμ and Δσ per team
3. Distribute individual Δμ and Δσ back to players, scaled by `participationRatio`

### TrueSkill Implementation

Implemented from scratch in `elo-calculator.js`. No npm dependency. Based on the original Microsoft Research paper (Herbrich et al., 2006).

Requires implementing the **error function (erf)** — not natively available in JS. Will use the standard Abramowitz & Stegun numerical approximation (5 lines, well-known, sufficient precision).

Key functions to implement:

```
v(t, e)   // win correction factor
w(t, e)   // draw correction factor  
updateRating(mu, sigma, outcome, teamMu, teamSigma, participationRatio)
```

---

## SquadJS Restart Recovery

SquadJS may restart 1-2 times per round. The plugin must resume tracking intelligibly without losing the round.

### Strategy

Persist only `roundStartTime` to the DB. On plugin mount:

1. Load persisted `roundStartTime`
2. Compare against `server.matchStartTime` (from A2S data) — ***note: reliability of this field for restart recovery is unconfirmed. Fallback options include assuming same round is in progress, or comparing current layer/team names against persisted values. TBD at implementation.***
3. If same round detected — do a fresh `getListPlayers` pull and open new segments for all current players from `Date.now()`
4. If new round detected — treat as a fresh round, clear state

Pre-restart segment time is lost but the impact is negligible — a 1-2 minute restart window against a 60+ minute round introduces trivial participation ratio error.

### Crash at Round End

If SquadJS crashes after the round ends but before ELO is calculated, that round is ***dropped entirely***. No partial ELO updates. This is acceptable given it occurs roughly once every 1-2 weeks.

---

### Models

**`PluginState`** — single-row state record, mirrors TBDatabase pattern

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER (PK) | Always 1 |
| `roundStartTime` | BIGINT | Timestamp of current round start. Used for restart recovery. |

**`PlayerStats`** — one row per player, persistent

| Column | Type | Notes |
|---|---|---|
| `eosID` | STRING (PK) | Primary identifier |
| `steamID` | STRING | Nullable — not always present |
| `name` | STRING | Last known display name |
| `mu` | FLOAT | TrueSkill mean. Default 25.0 |
| `sigma` | FLOAT | TrueSkill uncertainty. Default 8.33 |
| `wins` | INTEGER | Rounds on winning team |
| `losses` | INTEGER | Rounds on losing team |
| `roundsPlayed` | INTEGER | Total rounds with ELO impact |
| `lastSeen` | BIGINT | Timestamp |

**`RoundHistory`** — one row per completed round, audit log

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER (PK, auto) | |
| `layerName` | STRING | Map/layer played |
| `winningTeamID` | INTEGER | 1 or 2 |
| `ticketDiff` | INTEGER | Margin of victory |
| `roundDuration` | INTEGER | ms |
| `endedAt` | BIGINT | Timestamp |
| `playerCount` | INTEGER | Participants with ELO impact |

### Retry / Locking

Mirrors `TBDatabase._executeWithRetry` pattern — wraps all writes in Sequelize transactions with exponential backoff on `SQLITE_BUSY`.

---

## Configuration Options

```json
{
  "plugin": "EloTracker",
  "enabled": true,
  "database": "sqlite",
  "minParticipationRatio": 0.15,
  "defaultMu": 25.0,
  "defaultSigma": 8.333,
  "discordClient": "",
  "discordAdminChannelID": "",
  "discordPublicChannelID": "",
  "minPlayersForElo": 80,
  "ignoredGameModes": ["Seed", "Training"]
}
```

---

## Public API — Team ELO Evaluation

The plugin exposes a synchronous method for external plugins (e.g. TeamBalancer) to evaluate the aggregate ELO of an arbitrary player composition. This is the core primitive for ELO-aware team scrambling — feed in a candidate team, get back a score, compare both sides, pick the split where scores are closest.

```js
// elo-tracker.js
getTeamElo(players)
// players: array of { eosID, ... }
// returns: { averageMu: Number, playerCount: Number }
```

***Returns `averageMu`*** — the mean μ across all players. Not sum — sum inflates score for unequal team sizes, making comparison unreliable during candidate generation.

***Reads from in-memory cache*** — not the DB. The plugin maintains a `Map<eosID, { mu, sigma }>` of ***currently connected players only***. Entries are populated on player join (one DB read per join), kept alive until round end, then flushed alongside the session. At most ~100 entries at any time — memory cost stays flat regardless of total player history size.

Players with no DB record (first time on the server) are inserted into the cache with `defaultMu` on join and get a DB record written at round end when ELO is calculated.

### TeamBalancer Integration Pattern

```js
const scoreTeam1 = eloTracker.getTeamElo(candidateTeam1);
const scoreTeam2 = eloTracker.getTeamElo(candidateTeam2);
const delta = Math.abs(scoreTeam1.averageMu - scoreTeam2.averageMu);
// minimise delta across all scramble candidates
```

---

## Discord Integration

Two channels:

**Admin channel** — privileged controls, mirrors important events
**Public channel** — player-facing, read-only bot posts + command input

### Commands

Available both in-game (RCON chat) and via Discord:

| Command | Scope | Description |
|---|---|---|
| `!elo` | Public | Look up your own ELO by name, steamID, or eosID |
| `!elo <identifier>` | Public | Look up another player's ELO |
| `!elo leaderboard` | Public | Top N players by μ |
| `!elo reset` | Admin | Wipe all ELO ratings and round history |
| `!elo reset <identifier>` | Admin | Reset a single player's rating |
| `!elo backup` | Admin | Export PlayerStats as JSON, sent as Discord attachment |
| `!elo restore` | Admin | Restore from a JSON backup uploaded as a Discord attachment |

### Post-Round Discord Post

After each tracked round, post a summary to the admin channel: winning team, ticket diff, number of players whose ELO was updated, top ELO movers.

---

## Draw Handling

Squad rounds can theoretically end in a draw. TrueSkill supports draws natively via the draw correction factor `w(t, e)`. Draw support will be implemented in `elo-calculator.js` from the start — both teams' σ tightens slightly, μ is unchanged. In practice this path will rarely fire.

---

## Seeding Mode Detection

Rounds played during server seeding are ignored entirely — no session tracking, no ELO updates.

A round is **only eligible** for ELO if ***both*** conditions are met at round end:

1. **Player count ≥ threshold** — configurable, default `80`
2. **Game mode is not seeding/training** — checked via the server's layer/game mode variable (exact field confirmed at implementation)

Both must pass. Either failing causes the round to be silently skipped. Exposed via `minPlayersForElo` and `ignoredGameModes` array in plugin config.

## Data Backup & Restore

Admin-facing commands available in the Discord admin channel only.

### Backup

`!elo backup` — bot generates a timestamped JSON export of `PlayerStats` (and optionally `RoundHistory`) and sends it as a file attachment directly in the admin Discord channel. No server filesystem access required. Channel history acts as a passive audit trail of all backups taken.

### Restore

Admin uploads a backup JSON file as a Discord attachment with the message `!elo restore`. Bot reads the attachment, parses it, and upserts all records into the DB. A confirmation prompt is required before the restore executes given the destructive potential.

### Format

```json
{
  "exportedAt": 1700000000000,
  "playerCount": 1042,
  "players": [
    { "eosID": "...", "steamID": "...", "name": "...", "mu": 28.4, "sigma": 6.1, "wins": 12, "losses": 8, "roundsPlayed": 20 }
  ]
}
```

### Notes

- Discord's 8MB file attachment limit is unlikely to be a concern — even 50k player records would be well under that as JSON.
- Backup files can be downloaded from Discord and stored externally for off-server redundancy.
- On restore, existing records are upserted — players not in the backup file are left untouched unless a full reset is performed first via `!elo reset`.

---

## Separation of Concerns

***ELO Tracker*** owns all rating data, the cache, and `getTeamElo()`. It has no knowledge of scramble logic.

***TeamBalancer*** calls `getTeamElo()` as a black box — it gets a number back and uses it to evaluate candidate splits. It has no knowledge of how ratings are computed.

This is the correct boundary. Neither plugin reaches into the other's internals.

---

*Author: mike.b.joyce@gmail.com*

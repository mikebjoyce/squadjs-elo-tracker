# EloTracker Plugin v0.2.0

**SquadJS Plugin for Skill-Based Player Rating**

## Overview

Tracks player skill across rounds using a TrueSkill-based rating system. Each player is assigned a **μ (mu)** skill estimate and a **σ (sigma)** uncertainty value that converge toward a stable rating over time. Ratings update after every round based on team outcome, team strength, and how long each player participated.

Designed for Squad servers to surface skill data, reward consistent players, and provide server admins and players with transparent, fair ratings grounded in a proven algorithm.

---

## Core Features

* **TrueSkill Rating Engine**: Implements the full TrueSkill algorithm with team-based win, loss, and draw outcomes. Handles multi-player teams with per-player mu/sigma updates.

* **Participation Weighting**: Rating changes are scaled by how long a player was actually on their team. Late joiners and early leavers receive proportionally smaller adjustments.

* **Team-Switch Tracking**: Segment-based session tracking detects mid-round team switches. Players are assigned to the team they spent the most time on.

* **Discord Integration**: Full-featured Discord bot interface for player lookups, leaderboard, admin controls, backup/restore, and account linking.

* **In-Game Commands**: Players can check their own rating, look up others, and view the leaderboard directly from the in-game chat.

* **Admin Controls**: Reset individual player ratings, run status checks, and manage data — available both in-game and via Discord.

* **Persistent Storage**: SQLite-backed storage via Sequelize. Round history, player stats, and plugin state all survive server restarts.

* **Provisional Ratings**: Players are marked provisional until they reach a configurable minimum round count. Provisional players are excluded from the ranked leaderboard.

* **Account Linking**: Players can link their Discord account to their SteamID to look up their own stats via Discord.

* **Backup & Restore**: Full player stat export to JSON and restore via Discord file attachment.

---

## TrueSkill Rating System

EloTracker uses a **TrueSkill-derived algorithm** — the same family of systems used by Xbox Live and major competitive platforms — adapted for Squad's team format.

### Key Concepts

| Symbol | Name | Meaning |
|--------|------|---------|
| **μ (mu)** | Skill Estimate | Your estimated performance level. Everyone starts at 25.0. |
| **σ (sigma)** | Uncertainty | The system's confidence in your rating. Starts at ~8.33 and decreases as you play. |

### How Ratings Update

After each round, the system:

1. **Computes team strength** for each side — the combined mu and sigma of all participating players.
2. **Calculates the performance gap** between the two teams relative to their combined uncertainty.
3. **Applies a win/loss/draw correction factor** to each player's mu and sigma.
4. **Scales the update by participation ratio** — players who played 100% of the round receive the full delta; players who joined late or left early receive a proportionally reduced update.

### Calibration Stages

Sigma is used to communicate how stable a player's rating is:

| Sigma Range | Status |
|-------------|--------|
| ≤ 2.5 | Highly Calibrated |
| ≤ 4.5 | Calibrated |
| ≤ 6.5 | Establishing |
| > 6.5 | Initial Calibration |

A **dynamic uncertainty floor (τ/tau)** prevents sigma from reaching zero, ensuring ratings can always respond to future performance.

### Why TrueSkill Over ELO?

Standard ELO is designed for 1v1 games. TrueSkill natively handles team games where multiple players contribute to a shared outcome — each player's update reflects both their individual uncertainty and their team's collective strength.

---

## Installation

Add to your `config.json`:

```json
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

...

{
  "plugin": "EloTracker",
  "enabled": true,
  "database": "sqlite",
  "discordClient": "discord",
  "discordPublicChannelID": "",
  "discordAdminChannelID": "",
  "defaultMu": 25.0,
  "defaultSigma": 8.333,
  "minRoundsForLeaderboard": 10,
  "minPlayersToCountRound": 10,
  "enablePublicIngameCommands": true,
  "playerUpdateIntervalSeconds": 30
}
```

**File Placement**: Move the project files into your SquadJS directory's squad-server folder.

```
squad-server/
├── plugins/
│   └── elo-tracker.js
└── utils/
    ├── elo-calculator.js
    ├── elo-commands.js
    ├── elo-database.js
    ├── elo-discord.js
    └── elo-session-manager.js
```

---

## Commands

### In-Game Commands

```text
Public Commands (all players):
!elo                           → Your current ELO rating and record.
!elo <name | steamID>          → Look up another player's rating.
!elo leaderboard               → Top 10 players by skill rating.
!elo help                      → Show available commands.

Admin Commands (ChatAdmin channel only):
!eloadmin status               → Plugin status, session count, and round info.
!eloadmin reset <name|steamID> → Reset a player to default rating.
!eloadmin help                 → Show admin commands.
```

### Discord Commands

```text
Public Commands:
!elo                           → Look up your own linked ELO rating.
!elo <name | steamID | eosID>  → Look up another player's rating.
!elo link <SteamID>            → Link your Discord to your in-game SteamID.
!elo leaderboard               → Top 20 players by skill rating.
!elo explain                   → Explains the rating algorithm and symbols.
!elo help                      → Show all available commands.

Admin Commands (admin channel only):
!elo status                    → Plugin status, session info, and cache state.
!elo reset                     → Wipe ALL ratings and round history (requires confirm).
!elo reset confirm             → Confirm a pending full reset (30s window).
!elo reset <identifier>        → Reset a single player to default rating.
!elo backup                    → Export all player stats as a JSON file attachment.
!elo restore                   → Restore from a JSON backup (attach file with command).
```

> **Note**: `!elo link` deletes both the command message and the reply after 5 seconds to protect SteamID privacy in public channels.

---

## Configuration Options

```text
Core Settings:
database                       - Sequelize connector for persistent storage (SQLite).
defaultMu                      - Starting skill estimate for new players (default: 25.0).
defaultSigma                   - Starting uncertainty for new players (default: 8.333).
minRoundsForLeaderboard        - Rounds required before a player appears on the ranked
                                 leaderboard and receives an official rank (default: 10).
minPlayersToCountRound         - Minimum players required for a round to affect ratings.

In-Game Commands:
enablePublicIngameCommands     - Allow players to use !elo commands in-game (default: true).

Session Tracking:
playerUpdateIntervalSeconds    - How often (seconds) the plugin snapshots the current
                                 player list to track joins and team switches.

Discord Integration:
discordClient                  - Discord connector name.
discordPublicChannelID         - Channel ID for public !elo commands and output.
discordAdminChannelID          - Channel ID for admin-only commands and logs.
```

---

## Participation Ratio

A player's rating change is **never binary** — it is scaled by how much of the round they actually played.

- A player present for the full round receives **100%** of their calculated delta.
- A player who joined halfway through receives approximately **50%**.
- A player who switched teams mid-round is assigned to their **majority team** (the one they spent more time on).

This prevents rating manipulation via late joining, and ensures team-switchers don't receive credit or penalty for a team they barely played on.

---

## Leaderboard & Ranking

- Players appear on the leaderboard only after reaching `minRoundsForLeaderboard` rounds.
- Rank is determined **solely by μ (mu)** — higher mu = higher rank.
- Players below the minimum round threshold are shown as **Provisional** with their current mu visible but no official rank assigned.
- Rank is displayed as **#N of M total players** alongside a **top X% percentile** label.

---

## Account Linking

Players can link their Discord account to their in-game SteamID using `!elo link <SteamID>` in the configured public Discord channel. Once linked:

- `!elo` (no arguments) in Discord returns their own stats automatically.
- The link is stored in the database against their `discordID`.
- The `!elo link` message is auto-deleted after 5 seconds to prevent SteamID exposure.

---

## Backup & Restore

All player stats can be exported and restored via Discord:

- **`!elo backup`** — Posts a timestamped JSON file attachment containing all player records.
- **`!elo restore`** — Attach a previously exported JSON file to restore all records. Existing records are updated; new records are created.

> Use backup before any manual database changes or server migrations.

---

## Diagnostics

`!eloadmin status` (in-game) or `!elo status` (Discord admin channel) reports:

- **Plugin Version** and ready state.
- **Session Players**: Number of players currently tracked in the active round session.
- **ELO Cache Entries**: Number of ratings held in-memory.
- **Round Start Time**: ISO timestamp of when the current round began.

---

## Logging and Monitoring

- **Console Output**: All major actions, DB errors, and RCON warn failures are logged via the SquadJS Logger.
- **Discord Embeds**: Post-round summaries, top rating movers, team average ratings, and processing time are posted to the configured Discord channel.
- **Round Summary**: After each round, the plugin posts the winner, ticket differential, player count, duration, and the largest individual rating changes.

---

## Critical Notes

### deltaSigma Direction

`deltaSigma` returned by the calculator is a **reduction value**, applied as:
```
newSigma = sigma - deltaSigma
```
This is intentional. Do not change this to addition.

### bulkUpsert Is Incremental

`bulkUpsertPlayerStats()` **adds** to existing `wins`, `losses`, and `roundsPlayed` counts. It does not overwrite them. Do not pass cumulative totals — pass only the delta for the current round.

---

## Author

**Slacker**
```
Discord: `real_slacker`
Email:   `mike.b.joyce@gmail.com`
GitHub:  https://github.com/mikebjoyce
```

---

*Built for SquadJS — Surface skill. Reward consistency. Keep ratings honest.*

---

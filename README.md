# **EloTracker Plugin v0.2.5**

**SquadJS Plugin for Skill-Based Player Rating**

## **Overview**

Tracks player skill across rounds using a **TrueSkill-based** rating system. Each player is assigned a **μ (mu)** skill estimate and a **σ (sigma)** uncertainty value that converge toward a stable rating over time. Ratings update after every round based on team outcome, team strength, and how long each player participated.

Designed for Squad servers to surface skill data, reward consistent players, and provide server admins and players with transparent, fair ratings grounded in a proven algorithm.

## **⚠️ Critical Notes**

### **deltaSigma Direction**

The deltaSigma returned by the calculator is a **reduction value**, applied as:

newSigma \= sigma \- deltaSigma

This is intentional. **Do not change this to addition.**

### **bulkUpsert Is Incremental**

bulkUpsertPlayerStats() adds to existing wins, losses, and roundsPlayed counts. It does **not** overwrite them. Do not pass cumulative totals — pass only the delta for the current round.

## **Core Features**

* **TrueSkill Rating Engine:** Implements the full TrueSkill algorithm with team-based win, loss, and draw outcomes.  
* **Participation Weighting:** Rating changes are scaled by how long a player was actually on their team. Late joiners and early leavers receive proportionally smaller adjustments.  
* **Team-Switch Tracking:** Segment-based session tracking detects mid-round team switches. Players are assigned to the team they spent the most time on.  
* **Discord Integration:** Full-featured Discord bot interface for player lookups, leaderboards, and account linking.  
* **In-Game Commands:** Players can check their own rating and view the leaderboard directly from the in-game chat.  
* **Persistent Storage:** SQLite-backed storage via Sequelize. Round history, player stats, and plugin state survive server restarts.  
* **Provisional Ratings:** Players are marked "provisional" until they reach a configurable minimum round count.  
* **Backup & Restore:** Full player stat export to JSON and restore via Discord file attachment.

## **TrueSkill Rating System**

EloTracker uses a TrueSkill-derived algorithm — the same family of systems used by Xbox Live — adapted for Squad's team format.

### **Key Concepts**

| Symbol | Name | Meaning |
| :---- | :---- | :---- |
| **μ (mu)** | Skill Estimate | Your estimated performance level. Starts at **25.0**. |
| **σ (sigma)** | Uncertainty | The system's confidence in your rating. Starts at **\~8.33** and decreases as you play. |

### **Calibration Stages**

Sigma communicates how stable a player's rating is:

| Sigma Range | Status |
| :---- | :---- |
| **![][image1]** | Highly Calibrated |
| ![][image1] | Calibrated |
| ![][image1] | Establishing |
| ![][image2] | Initial Calibration |

**Note:** A dynamic uncertainty floor (![][image3]/tau) prevents sigma from reaching zero, ensuring ratings can always respond to future performance.

## **Installation**

### **1\. Configuration**

Add the following to your config.json:

"connectors": {  
  "sqlite": {  
    "dialect": "sqlite",  
    "storage": "squad-server.sqlite"  
  },  
  "discord": {  
    "connector": "discord",  
    "token": "YOUR\_BOT\_TOKEN"  
  }  
},  
"plugins": \[  
  {  
    "plugin": "EloTracker",  
    "enabled": true,  
    "database": "sqlite",  
    "discordClient": "discord",  
    "discordPublicChannelID": "YOUR\_CHANNEL\_ID",  
    "discordAdminChannelID": "YOUR\_ADMIN\_CHANNEL\_ID",  
    "eloLogPath": "./elo-match-log.jsonl",  
    "minParticipationRatio": 0.15,  
    "defaultMu": 25.0,  
    "defaultSigma": 8.333,  
    "minPlayersForElo": 80,  
    "minRoundsForLeaderboard": 10,  
    "roundStartEmbedDelayMs": 180000,  
    "ignoredGameModes": \["Seed", "Jensen"\],  
    "enablePublicIngameCommands": true  
  }  
\]

### **2\. File Placement**

Move the project files into your SquadJS directory:

squad-server/  
├── plugins/  
│   └── elo-tracker.js  
└── utils/  
    ├── elo-calculator.js  
    ├── elo-commands.js  
    ├── elo-database.js  
    ├── elo-discord.js  
    └── elo-session-manager.js

## **Commands**

### **In-Game Commands**

**Public (All Players):**

* \!elo — View your current ELO rating and record.  
* \!elo \<name | steamID\> — Look up another player's rating.  
* \!elo leaderboard — Top 10 players by skill rating.  
* \!elo help — Show available commands.

**Admin (ChatAdmin channel only):**

* \!eloadmin status — Plugin status, session count, and round info.  
* \!eloadmin reset \<name | steamID\> — Reset a player to default rating.

### **Discord Commands**

**Public:**

* \!elo — Look up your own linked stats.  
* \!elo \<name | steamID | eosID\> — Look up another player.  
* \!elo link \<SteamID\> — Link Discord to SteamID (auto-deletes for privacy).  
* \!elo leaderboard — Top 20 players.  
* \!elo explain — Explains the algorithm symbols.

**Admin (Admin channel only):**

* \!elo status — Plugin diagnostics and cache state.  
* \!elo roundinfo — Live snapshot of team balance.  
* \!elo backup — Export player stats as JSON.  
* \!elo restore — Restore from an attached JSON backup.  
* \!elo reset confirm — Wipe **ALL** database ratings.

## **Technical Logic**

### **Participation Ratio**

A player's rating change is scaled by their time in the round:

1. **Full Round:** 100% of calculated delta.  
2. **Half Round:** \~50% of calculated delta.  
3. **Team Switching:** Assigned to the team they spent the majority of their time on.

### **Leaderboard & Ranking**

* **Eligibility:** Players must meet minRoundsForLeaderboard to rank.  
* **Sorting:** Ranked strictly by **μ (mu)**.  
* **Provisional:** Players below the threshold are visible but unranked.

## **Author**

**Slacker**

* **Discord:** real\_slacker  
* **Email:** mike.b.joyce@gmail.com  
* **GitHub:** [https://github.com/mikebjoyce](https://github.com/mikebjoyce)

*Built for SquadJS — Surface skill. Reward consistency. Keep ratings honest.*

[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADcAAAAVCAYAAADiv3Z7AAABqklEQVR4Xu2WPUvDUBSGG6qgKChKDf1I07SDFMQlqAj6A0pxd3YRRHDS1R/QxcFF0dHNwUHQoVDBVRTBwdXFzcXBRUSfQ2/lehH7IU0s5oGXpO89NznnfqWxWEREREQv4rpuEu2i01wuN2q29yQU46FDdOZ53jSWZcb0GpYUIgWhY+4nzYDA8X2/n0RstYQ+1cYysoido09NlmAqlXLMgMCxbXsom83ukNAbev9GVYkx+2nEiSmjS1RJp9PjZkAo5PP5EUke3TiOs8jMceseoSc0j5KJRGLY7KdDzCZ6pO+s2RYmlpqxu0KhMNEw8Xy8Z1TSg3/C/WsHB4kU1Qyt6z7FLeC9cl3S/VaQmXbrR35N9l8srCIleZJ4YTnO6D5Jraqii7rfDrLv6F9x6/uwjBU3Y7qKKu5BRrvhZTKZQfxzvAN+9mnhHaEOqw2ed82gLcuJbMZ0BWZsipfey1VZsge38G7lYPkS/Etk0HjuCs8/4X7MbO8GFi9cQ1doH10wuntBvTwQKGhAlqZczbZ/T2NwWpH6wIdzgnYCSZfUsm4q9tx2sz8FEU34ALO6Z5XwSMX+AAAAAElFTkSuQmCC>

[image2]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADcAAAAVCAYAAADiv3Z7AAABiklEQVR4Xu2Wu0oDQRSGs0RBUVSUuIQke0kWJCA2i4iijZ2F+BiKCHZWvoGNhY2X1kqJjRALQcHGQhDBwtYHsLGwEdHvwAbGIeAmIZtF5oOf3fx7ZuecOTNJMhmDwWAwJIht20NhGPbr/r/Add0FdOc4zrYUqj9PBbL6vu/bJJpX5XnemB7bhCyxy1Ik2isUChN6QE+Q1WbV90nqC3030XULHbFYjDnG3KADlNcDEqNcLo9K8uixVCot0Tlu3VP0huYluVwuN6yPi4HFu2YYX0fn3E/pAd3Gijr2XKlUJhsmXoj3jlbU4HaRwqRAVEusSCarRh3aUn2KW8T75Lqq+p3A+2RL1NBFzDPcGZI8k32wHWdVn8nXo6Krqt8OUdfORIl1TYiKe3WVQ18sFgfxr/BO+NinhLdC47xdomPpmh7QdejYNBO/yDWy5Azu4D3JF8uv4Hik6ufAIolN9ICO0C1b8pDujeuBf5Bl3Brj79FuEAQjekDPILEB2Zpy1Z/FgXEbqf53YjCkgx8qSFbVY3y4ogAAAABJRU5ErkJggg==>

[image3]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAsAAAAXCAYAAADduLXGAAAAm0lEQVR4XmNgGAV0BcbGxqyKiori8vLykuhYVFSUB64QKGAJxK+B+D8OvFVBQYGDQUZGRgXIOQDkeABpSSAdAKQng9gwDFYIAkBGhKysrDKSLa1AsXS4tbiAnJycMVDhJWlpaRl0OQwAVFwONPmwuro6L7ocCgC6nROoeAfQ5IXochhASUlJDWjqa6LcCwTMQLcKg2h0iVGADQAA3ZQiPk9XdcEAAAAASUVORK5CYII=>
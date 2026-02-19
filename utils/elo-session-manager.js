/**
 * EloSessionManager
 * 
 * Pure in-memory session tracking for the EloTracker plugin.
 * Handles player segments, team switches, and participation calculation.
 * 
 * No external dependencies.
 */
export default class EloSessionManager {
  constructor() {
    // Map<eosID, PlayerSession>
    this.sessions = new Map();
    this.roundStartTime = null;
  }

  /**
   * Starts a new round session.
   * Clears any existing session data.
   * @param {number} timestamp 
   */
  startRound(timestamp = Date.now()) {
    this.roundStartTime = timestamp;
    this.sessions.clear();
  }

  /**
   * Updates the session map based on the current player list.
   * Handles joins and team switches.
   * Disconnects are intentionally ignored (segments remain open).
   * 
   * @param {Array<{eosID: string, name: string, steamID: string, teamID: number}>} currentPlayers 
   */
  updatePlayers(currentPlayers) {
    if (!this.roundStartTime) return;

    const now = Date.now();

    for (const player of currentPlayers) {
      const { eosID, name, steamID, teamID } = player;

      if (!this.sessions.has(eosID)) {
        // Condition: eosID in currentPlayers, not in session map
        // Action: Open new segment
        const newSegment = {
          teamID: teamID,
          joinTime: now,
          leaveTime: null
        };

        this.sessions.set(eosID, {
          eosID,
          name,
          steamID,
          segments: [newSegment],
          activeSegment: newSegment
        });
      } else {
        const session = this.sessions.get(eosID);

        // Update metadata if available
        if (name) session.name = name;
        if (steamID) session.steamID = steamID;

        // Check for team switch or missing active segment
        // Condition: eosID in both
        if (!session.activeSegment) {
          // activeSegment is null — reopen a segment for this player
          const newSegment = {
            teamID: teamID,
            joinTime: now,
            leaveTime: null
          };
          session.segments.push(newSegment);
          session.activeSegment = newSegment;
        } else if (session.activeSegment.teamID !== teamID) {
          // Action: Team changed -> Close active, open new
          session.activeSegment.leaveTime = now;

          const newSegment = {
            teamID: teamID,
            joinTime: now,
            leaveTime: null
          };

          session.segments.push(newSegment);
          session.activeSegment = newSegment;
        }
        // Condition: Team unchanged -> No action
      }
    }
    // Condition: eosID in session map, not in currentPlayers
    // Action: Leave segment OPEN. (Implicitly handled by doing nothing for those IDs)
  }

  /**
   * Ends the round, closes all segments, and calculates participation.
   * @param {number} timestamp 
   * @returns {Array<Object>} ParticipantList
   */
  endRound(timestamp = Date.now()) {
    if (!this.roundStartTime) return [];

    const roundDuration = Math.max(1, timestamp - this.roundStartTime);
    const participants = [];

    for (const session of this.sessions.values()) {
      // Close active segment if it's still open
      if (session.activeSegment && session.activeSegment.leaveTime === null) {
        session.activeSegment.leaveTime = timestamp;
      }

      // Compute participation
      let timeOnTeam1 = 0;
      let timeOnTeam2 = 0;

      for (const segment of session.segments) {
        // Safety: if leaveTime is null (shouldn't be after above), use timestamp
        const endTime = segment.leaveTime !== null ? segment.leaveTime : timestamp;
        const duration = Math.max(0, endTime - segment.joinTime);

        if (segment.teamID === 1) {
          timeOnTeam1 += duration;
        } else if (segment.teamID === 2) {
          timeOnTeam2 += duration;
        }
      }

      // Determine assigned team (most time played)
      // Default to team 1 if equal or 0
      const assignedTeamID = timeOnTeam2 > timeOnTeam1 ? 2 : 1;
      const timeOnAssigned = assignedTeamID === 1 ? timeOnTeam1 : timeOnTeam2;

      // Calculate ratio clamped [0.0, 1.0]
      let participationRatio = timeOnAssigned / roundDuration;
      participationRatio = Math.min(Math.max(participationRatio, 0.0), 1.0);

      participants.push({
        eosID: session.eosID,
        name: session.name,
        steamID: session.steamID,
        assignedTeamID,
        participationRatio,
        timeOnTeam1,
        timeOnTeam2,
        segments: [...session.segments]
      });
    }

    return participants;
  }

  getPlayerSession(eosID) {
    return this.sessions.get(eosID) || null;
  }

  getAllSessions() {
    return Array.from(this.sessions.values());
  }

  getSessionCount() {
    return this.sessions.size;
  }

  clear() {
    this.sessions.clear();
    this.roundStartTime = null;
  }
}
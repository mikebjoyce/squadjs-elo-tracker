/**
 * EloCalculator
 * Pure math module for TrueSkill calculations.
 * Implements the TrueSkill algorithm for team-based games with specific adaptations.
 *
 * References:
 * - TrueSkill: Through the Looking Glass (Herbrich et al.)
 * - Abramowitz & Stegun (Error Function approximation)
 */
export default class EloCalculator {
  // Constants
  static MU_DEFAULT = 25.0;
  static SIGMA_DEFAULT = 25.0 / 3.0;
  static TAU = 25.0 / 300.0;

  // Configurable constants (exposed as static properties)
  static BETA = 25.0 / 6.0;
  static DRAW_PROBABILITY = 0.01;

  /**
   * Calculates the probability density function (PDF) of the standard normal distribution.
   * @param {number} x
   * @returns {number}
   */
  static _pdf(x) {
    return (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x);
  }

  /**
   * Calculates the cumulative distribution function (CDF) of the standard normal distribution.
   * Uses the error function approximation.
   * @param {number} x
   * @returns {number}
   */
  static _cdf(x) {
    return 0.5 * (1 + this._erf(x / Math.SQRT2));
  }

  /**
   * Error function (erf) approximation.
   * Source: Abramowitz & Stegun 7.1.26
   * @param {number} x
   * @returns {number}
   */
  static _erf(x) {
    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x);

    // Constants for approximation
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const t = 1.0 / (1.0 + p * absX);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

    return sign * y;
  }

  /**
   * Inverse error function (erfInv) approximation.
   * Source: Winitzki approximation
   * @param {number} x
   * @returns {number}
   */
  static _erfInv(x) {
    const a = 0.147; // Constant for Winitzki approximation
    const lnTerm = Math.log(1 - x * x);
    const term1 = 2 / (Math.PI * a) + lnTerm / 2;
    const term2 = lnTerm / a;
    const sign = x < 0 ? -1 : 1;

    return sign * Math.sqrt(Math.sqrt(term1 * term1 - term2) - term1);
  }

  /**
   * Win correction factor (V).
   * @param {number} t
   * @param {number} e Epsilon (draw margin)
   * @returns {number}
   */
  static _v(t, e) {
    const denom = this._cdf(t - e);
    if (denom === 0) return 0; // Prevent division by zero
    return this._pdf(t - e) / denom;
  }

  /**
   * Win variance factor (W).
   * @param {number} t
   * @param {number} e Epsilon (draw margin)
   * @returns {number}
   */
  static _w(t, e) {
    const v = this._v(t, e);
    return v * (v + t - e);
  }

  /**
   * Draw correction factor (V_draw).
   * @param {number} t
   * @param {number} e Epsilon (draw margin)
   * @returns {number}
   */
  static _vDraw(t, e) {
    const absDiff = this._cdf(e - t) - this._cdf(-e - t);
    if (absDiff === 0) return 0;
    return (this._pdf(-e - t) - this._pdf(e - t)) / absDiff;
  }

  /**
   * Draw variance factor (W_draw).
   * @param {number} t
   * @param {number} e Epsilon (draw margin)
   * @returns {number}
   */
  static _wDraw(t, e) {
    const vDraw = this._vDraw(t, e);
    const absDiff = this._cdf(e - t) - this._cdf(-e - t);
    if (absDiff === 0) return vDraw * vDraw;
    
    const term = ((-e - t) * this._pdf(-e - t) - (e - t) * this._pdf(e - t)) / absDiff;
    return vDraw * vDraw + term;
  }

  /**
   * Computes the TrueSkill update for two teams.
   * 
   * @param {Array<{mu: number, sigma: number}>} team1 
   * @param {Array<{mu: number, sigma: number}>} team2 
   * @param {'team1win' | 'team2win' | 'draw'} outcome 
   * @returns {{
   *   team1Updates: Array<{deltaMu: number, deltaSigma: number}>,
   *   team2Updates: Array<{deltaMu: number, deltaSigma: number}>
   * }}
   */
  static computeTeamUpdate(team1, team2, outcome) {
    // Handle edge case: empty teams
    if (team1.length === 0 && team2.length === 0) {
      return { team1Updates: [], team2Updates: [] };
    }

    // Step 1: Team summary stats
    // teamMu = sum of all player mu values
    const teamMu1 = team1.reduce((sum, p) => sum + p.mu, 0);
    const teamMu2 = team2.reduce((sum, p) => sum + p.mu, 0);

    // teamSigma = sqrt( sum of (sigma² + beta²) for each player )
    const teamSigmaSq1 = team1.reduce((sum, p) => sum + (p.sigma * p.sigma + this.BETA * this.BETA), 0);
    const teamSigmaSq2 = team2.reduce((sum, p) => sum + (p.sigma * p.sigma + this.BETA * this.BETA), 0);

    // Step 2: Performance delta
    // c = sqrt( teamSigma1² + teamSigma2² )
    // Note: teamSigmaSq variables already hold the squared sums.
    const c = Math.sqrt(teamSigmaSq1 + teamSigmaSq2);

    if (c === 0) {
      // Should not happen if teams have players with non-zero sigma or beta
      return {
        team1Updates: team1.map(() => ({ deltaMu: 0, deltaSigma: 0 })),
        team2Updates: team2.map(() => ({ deltaMu: 0, deltaSigma: 0 }))
      };
    }

    // Epsilon (draw margin)
    // epsilon = sqrt(team1.length + team2.length) * BETA * sqrt(2) * erfInv(DRAW_PROBABILITY)
    const nTotal = team1.length + team2.length;
    const epsilon = Math.sqrt(nTotal) * this.BETA * Math.sqrt(2) * this._erfInv(this.DRAW_PROBABILITY);

    // t = (teamMu_winner - teamMu_loser) / c
    // We calculate t relative to team1 vs team2, then adjust signs based on outcome.
    // tRaw = (Mu1 - Mu2) / c
    const tRaw = (teamMu1 - teamMu2) / c;

    // Helper to compute per-player update
    const computePlayerUpdate = (player, isTeam1) => {
      const sigmaSq = player.sigma * player.sigma;
      const betaSq = this.BETA * this.BETA;
      const sigmaPlusBetaSq = sigmaSq + betaSq;

      let vVal, wVal;
      let isWinner;

      if (outcome === 'draw') {
        // Draw: vDraw handles sign internally.
        // t for team1 is tRaw. t for team2 is -tRaw.
        const t = isTeam1 ? tRaw : -tRaw;
        vVal = this._vDraw(t, epsilon / c);
        wVal = this._wDraw(t, epsilon / c);
        isWinner = null; // not applicable for draws
      } else {
        // For win/loss: compute t from the WINNER's perspective only.
        // Both winner and loser use the same vVal and wVal.
        // The loser's deltaMu is negated afterward via isWinner flag.
        let tWinner;
        if (outcome === 'team1win') {
          tWinner = tRaw; // tRaw = (Mu1 - Mu2) / c, positive if team1 stronger
          isWinner = isTeam1;
        } else {
          tWinner = -tRaw; // flip: (Mu2 - Mu1) / c, positive if team2 stronger
          isWinner = !isTeam1;
        }
        vVal = this._v(tWinner, epsilon / c);
        wVal = this._w(tWinner, epsilon / c);
      }

      // deltaMu:
      // Win/loss: same v(t_winner) magnitude for both teams. Sign flipped for loser.
      // Draw: vDraw(t) handles sign internally — negative for higher-ranked team.
      let deltaMu = (sigmaSq / c) * vVal;

      if (outcome !== 'draw') {
        // Winner gets +deltaMu, loser gets -deltaMu.
        // vVal is always positive for win/loss outcomes.
        if (!isWinner) deltaMu = -deltaMu;
      }
      // For draws: vDraw returns negative for higher-ranked team automatically.
      // No manual sign flip needed.

      // deltaSigma (factor) = (sigma_i²) / c² * w(t, epsilon/c)
      const deltaSigmaFactor = (sigmaSq / (c * c)) * wVal;
      // Clamp to prevent negative value inside sqrt if wVal is unexpectedly large.
      const safeDeltaSigmaFactor = Math.min(deltaSigmaFactor, 1 - 1e-10);

      // newSigma_i = sqrt( (sigma_i²) * (1 - deltaSigma) + tau² )
      const newSigma = Math.sqrt(sigmaSq * (1 - safeDeltaSigmaFactor) + this.TAU * this.TAU);

      // Return raw deltas (unscaled — caller applies participationRatio before writing to DB).
      // Positive deltaMu = rating increase.
      // deltaSigma = player.sigma - newSigma.
      //   Positive value means sigma DECREASED (more confident).
      //   Applied in elo-tracker.js as:
      //     const scaledDeltaSigma = deltaSigma * participationRatio;
      //     const newSigma = Math.max(rating.sigma - scaledDeltaSigma, 0.5);
      //   Subtraction is intentional — do NOT change to addition.
      return {
        deltaMu: deltaMu,
        deltaSigma: player.sigma - newSigma
      };
    };

    const team1Updates = team1.map(p => computePlayerUpdate(p, true));
    const team2Updates = team2.map(p => computePlayerUpdate(p, false));

    return { team1Updates, team2Updates };
  }

  /**
   * Returns the default rating for a new player.
   * @returns {{mu: number, sigma: number}}
   */
  static getDefaultRating() {
    return {
      mu: this.MU_DEFAULT,
      sigma: this.SIGMA_DEFAULT
    };
  }
}
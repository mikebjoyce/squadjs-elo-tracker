/**
 * elo-rebuild.js
 *
 * Replays all recorded matches from scratch using the corrected
 * team-size-neutral TrueSkill formula. Outputs a restore-compatible
 * JSON backup.
 *
 * Usage:
 *   node elo-rebuild.js <matchlog.jsonl> <backup.json> [output.json]
 *
 * - matchlog.jsonl  Source of truth for all match outcomes + participants
 * - backup.json     Existing backup — used only to preserve steamID/discordID
 * - output.json     Output path (default: elo-rebuilt-<timestamp>.json)
 *
 * The output is drop-in compatible with !elo restore.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const rl   = require('readline');

// ─── Parameters ────────────────────────────────────────────────────────────
// Using defaults — calibrate after ratings stabilise on clean data.
const MU_DEFAULT       = 25.0;
const SIGMA_DEFAULT    = 25.0 / 3.0;   // 8.333
const BETA             = 25.0 / 6.0;   // 4.167
const TAU              = 25.0 / 100.0; // 0.25
const DRAW_PROBABILITY = 0.01;

// ─── TrueSkill math (team-size-neutral, corrected) ─────────────────────────

function pdf(x) {
  return (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x);
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const t = 1.0 / (1.0 + 0.3275911 * Math.abs(x));
  const y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

function cdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erfInv(x) {
  const a = 0.147;
  const ln = Math.log(1 - x * x);
  const t1 = 2 / (Math.PI * a) + ln / 2;
  const t2 = ln / a;
  return (x < 0 ? -1 : 1) * Math.sqrt(Math.sqrt(t1 * t1 - t2) - t1);
}

function v(t, e) {
  const d = cdf(t - e);
  return d === 0 ? 0 : pdf(t - e) / d;
}

function w(t, e) {
  const vv = v(t, e);
  return vv * (vv + t - e);
}

function vDraw(t, e) {
  const d = cdf(e - t) - cdf(-e - t);
  return d === 0 ? 0 : (pdf(-e - t) - pdf(e - t)) / d;
}

function wDraw(t, e) {
  const vv = vDraw(t, e);
  const d  = cdf(e - t) - cdf(-e - t);
  if (d === 0) return vv * vv;
  return vv * vv + ((-e - t) * pdf(-e - t) - (e - t) * pdf(e - t)) / d;
}

/**
 * TrueSkill update — fractional participation model.
 *
 * Computes teamMu and teamSigmaSq as SUMS weighted by participationRatio.
 * This prevents transient players from artificially inflating or deflating
 * the team's perceived strength, while preserving the standard TrueSkill model.
 */
function computeTeamUpdate(team1, team2, outcome) {
  if (team1.length === 0 || team2.length === 0) return { t1: [], t2: [] };

  const getRatio = (p) => p.participationRatio ?? 1.0;

  // Fractional sum per team
  const mu1 = team1.reduce((s, p) => s + (p.mu * getRatio(p)), 0);
  const mu2 = team2.reduce((s, p) => s + (p.mu * getRatio(p)), 0);

  // Fractional variance of the team
  const sigSq1 = team1.reduce((s, p) => s + ((p.sigma * p.sigma + BETA * BETA) * getRatio(p)), 0);
  const sigSq2 = team2.reduce((s, p) => s + ((p.sigma * p.sigma + BETA * BETA) * getRatio(p)), 0);

  const c = Math.sqrt(sigSq1 + sigSq2);
  if (c === 0) return { t1: team1.map(() => ({ dMu: 0, dSigma: 0 })), t2: team2.map(() => ({ dMu: 0, dSigma: 0 })) };

  // Effective headcount
  const effectiveN1 = team1.reduce((s, p) => s + getRatio(p), 0);
  const effectiveN2 = team2.reduce((s, p) => s + getRatio(p), 0);
  const nTotal = effectiveN1 + effectiveN2;

  const epsilon = Math.sqrt(nTotal) * BETA * Math.sqrt(2) * erfInv(DRAW_PROBABILITY);
  const tRaw    = (mu1 - mu2) / c;

  const playerUpdate = (player, isTeam1) => {
    const sigmaSq = player.sigma * player.sigma;

    let vVal, wVal, isWinner;

    if (outcome === 'draw') {
      const t = isTeam1 ? tRaw : -tRaw;
      vVal    = vDraw(t, epsilon / c);
      wVal    = wDraw(t, epsilon / c);
    } else {
      const tWinner = outcome === 'team1win' ? tRaw : -tRaw;
      isWinner      = outcome === 'team1win' ? isTeam1 : !isTeam1;
      vVal          = v(tWinner, epsilon / c);
      wVal          = w(tWinner, epsilon / c);
    }

    let dMu = (sigmaSq / c) * vVal;
    if (outcome !== 'draw' && !isWinner) dMu = -dMu;

    const dSigFactor = Math.min((sigmaSq / (c * c)) * wVal, 1 - 1e-10);
    const newSigma   = Math.sqrt(sigmaSq * (1 - dSigFactor) + TAU * TAU);

    return { dMu, dSigma: player.sigma - newSigma };
  };

  return {
    t1: team1.map(p => playerUpdate(p, true)),
    t2: team2.map(p => playerUpdate(p, false))
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function loadMatches(jsonlPath) {
  return new Promise((resolve, reject) => {
    const matches = [];
    const stream  = fs.createReadStream(jsonlPath, 'utf8');
    const reader  = rl.createInterface({ input: stream, crlfDelay: Infinity });
    reader.on('line', line => { if (line.trim()) matches.push(JSON.parse(line)); });
    reader.on('close', () => resolve(matches));
    reader.on('error', reject);
  });
}

async function main() {
  const [,, matchlogPath, backupPath, outputArg] = process.argv;
  if (!matchlogPath || !backupPath) {
    console.error('Usage: node elo-rebuild.js <matchlog.jsonl> <backup.json> [output.json]');
    process.exit(1);
  }

  const outputPath = outputArg ?? `elo-rebuilt-${Date.now()}.json`;

  // Load inputs
  const matches = await loadMatches(matchlogPath);
  const backup  = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

  // Build steamID/discordID lookup from existing backup
  const metaLookup = new Map(); // eosID → { steamID, discordID }
  for (const p of backup.players) {
    metaLookup.set(p.eosID, { steamID: p.steamID ?? null, discordID: p.discordID ?? null });
  }

  // Sort matches chronologically
  matches.sort((a, b) => a.endedAt - b.endedAt);

  // Player state — Map<eosID, { mu, sigma, wins, losses, roundsPlayed, lastSeen, name, steamID, discordID }>
  const players = new Map();

  const getOrInit = (eosID, name, endedAt) => {
    if (!players.has(eosID)) {
      const meta = metaLookup.get(eosID) ?? { steamID: null, discordID: null };
      players.set(eosID, {
        eosID,
        steamID:      meta.steamID,
        discordID:    meta.discordID,
        name,
        mu:           MU_DEFAULT,
        sigma:        SIGMA_DEFAULT,
        wins:         0,
        losses:       0,
        roundsPlayed: 0,
        lastSeen:     endedAt
      });
    }
    return players.get(eosID);
  };

  let processed = 0;
  let skipped   = 0;

  for (const match of matches) {
    const team1Players = match.players.filter(p => p.teamID === 1);
    const team2Players = match.players.filter(p => p.teamID === 2);

    if (team1Players.length === 0 || team2Players.length === 0) {
      skipped++;
      continue;
    }

    // Ensure all players exist in state map
    for (const p of match.players) getOrInit(p.eosID, p.name, match.endedAt);

    // Build rating arrays for calculator
    const toRating = p => ({
      mu: players.get(p.eosID).mu,
      sigma: players.get(p.eosID).sigma,
      participationRatio: p.participationRatio
    });
    const t1Ratings = team1Players.map(toRating);
    const t2Ratings = team2Players.map(toRating);

    const { t1: t1Updates, t2: t2Updates } = computeTeamUpdate(t1Ratings, t2Ratings, match.outcome);

    const isTeam1Winner = match.outcome === 'team1win';
    const isTeam2Winner = match.outcome === 'team2win';

    // Apply scaled updates
    const applyUpdates = (matchPlayers, updates, isWinner, isLoser) => {
      matchPlayers.forEach((mp, i) => {
        const state = players.get(mp.eosID);
        const { dMu, dSigma } = updates[i];
        const scaled_dMu    = dMu    * mp.participationRatio;
        const scaled_dSigma = dSigma * mp.participationRatio;

        state.mu           = state.mu + scaled_dMu;
        state.sigma        = Math.max(state.sigma - scaled_dSigma, 0.5);
        state.roundsPlayed += 1;
        state.wins         += isWinner ? 1 : 0;
        state.losses       += isLoser  ? 1 : 0;
        state.lastSeen     = match.endedAt;
        state.name         = mp.name; // keep most recent name
      });
    };

    applyUpdates(team1Players, t1Updates, isTeam1Winner, isTeam2Winner);
    applyUpdates(team2Players, t2Updates, isTeam2Winner, isTeam1Winner);

    processed++;
    process.stdout.write(`\rReplaying match ${processed} / ${matches.length}...`);
  }

  console.log(`\nDone. Processed: ${processed}, Skipped: ${skipped}`);

  // Build output in backup schema
  const output = {
    exportedAt:  new Date().toISOString(),
    playerCount: players.size,
    params: {
      MU_DEFAULT,
      SIGMA_DEFAULT,
      BETA,
      TAU,
      DRAW_PROBABILITY,
      note: 'Rebuilt from match log with fractional participation formula. Calibrate BETA/TAU after ratings stabilise.'
    },
    players: Array.from(players.values())
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`Written to: ${outputPath}`);
  console.log(`Total players: ${players.size}`);

  // Quick sanity summary
  const muValues = Array.from(players.values()).map(p => p.mu);
  const mean = muValues.reduce((s, v) => s + v, 0) / muValues.length;
  const diverged = muValues.filter(m => Math.abs(m - MU_DEFAULT) > 0.5).length;
  console.log(`Avg mu: ${mean.toFixed(3)}  |  Players with |mu-25| > 0.5: ${diverged} / ${players.size} (${(diverged/players.size*100).toFixed(1)}%)`);
}

main().catch(err => { console.error(err); process.exit(1); });

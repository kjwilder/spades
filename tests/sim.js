// Plays complete computer-vs-computer games to check rule invariants and measure AI quality.
// Usage: node tests/sim.js [games] [opponent]
//   opponent = "ai" (default: both teams use the full AI) or "random" (team 1 plays random legal cards)

import {
  newGame, applyBid, applyPlay, collectTrick, nextHand, legalPlays, teamOf, canBlindNil,
} from '../js/engine.js';
import { chooseBid, chooseBlindNil, choosePlay, estimateTricks } from '../js/ai.js';

export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function playGame(seed, { randomTeam = null, maxHands = 200, params = [undefined, undefined] } = {}) {
  const rng = mulberry32(seed);
  const state = newGame({}, rng);
  const stats = { hands: 0, contracts: [0, 0], made: [0, 0], nils: [0, 0], nilsMade: [0, 0],
    blindNils: 0, blindMade: 0, bags: [0, 0], calib: [] };
  while (state.phase !== 'gameOver' && stats.hands < maxHands) {
    const ests = state.hands.map(estimateTricks);
    while (state.phase === 'bidding') {
      const seat = state.turn;
      if (randomTeam === teamOf(seat)) applyBid(state, seat, Math.max(1, Math.round(ests[seat])));
      else if (params[teamOf(seat)]?.blindNil !== false && chooseBlindNil(state, seat)) applyBid(state, seat, 0, true);
      else applyBid(state, seat, chooseBid(state, seat, params[teamOf(seat)]));
    }
    while (state.phase === 'playing' || state.phase === 'trickEnd') {
      if (state.phase === 'trickEnd') { collectTrick(state); continue; }
      const seat = state.turn;
      const legal = legalPlays(state, seat);
      const card = randomTeam === teamOf(seat)
        ? legal[Math.floor(rng() * legal.length)]
        : choosePlay(state, seat, params[teamOf(seat)]);
      if (!legal.includes(card)) throw new Error(`AI chose illegal card ${card}`);
      applyPlay(state, seat, card);
    }
    const r = state.lastResult;
    if (r.tricks.reduce((a, b) => a + b, 0) !== 13) throw new Error('Trick count != 13');
    stats.hands++;
    for (const t of [0, 1]) {
      const tr = r.teams[t];
      if (tr.contract > 0) { stats.contracts[t]++; if (tr.made) stats.made[t]++; }
      for (const n of tr.nils) {
        if (n.blind) { stats.blindNils++; if (n.made) stats.blindMade++; continue; }
        stats.nils[t]++;
        if (n.made) stats.nilsMade[t]++;
      }
      stats.bags[t] += tr.bagsAdded;
    }
    for (let s = 0; s < 4; s++) if (r.bids[s] > 0) stats.calib.push([ests[s], r.bids[s], r.tricks[s]]);
    if (state.phase === 'handEnd') nextHand(state, rng);
  }
  return { state, stats };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const games = Number(process.argv[2] || 500);
  const randomTeam = process.argv[3] === 'random' ? 1 : null;
  const agg = { wins: [0, 0], hands: 0, contracts: [0, 0], made: [0, 0], nils: [0, 0], nilsMade: [0, 0],
    blindNils: 0, blindMade: 0, bags: [0, 0], calib: [], unfinished: 0 };
  for (let g = 0; g < games; g++) {
    const { state, stats } = playGame(1000 + g, { randomTeam });
    if (state.winner === null) agg.unfinished++; else agg.wins[state.winner]++;
    agg.hands += stats.hands;
    agg.blindNils += stats.blindNils;
    agg.blindMade += stats.blindMade;
    for (const t of [0, 1]) for (const k of ['contracts', 'made', 'nils', 'nilsMade', 'bags']) agg[k][t] += stats[k][t];
    agg.calib.push(...stats.calib);
  }
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');
  console.log(`games ${games}, hands ${agg.hands} (${(agg.hands / games).toFixed(1)}/game), unfinished ${agg.unfinished}`);
  console.log(`wins: team0 ${agg.wins[0]}  team1 ${agg.wins[1]}`);
  for (const t of [0, 1]) {
    console.log(`team${t}: contracts made ${pct(agg.made[t], agg.contracts[t])}, nils ${agg.nils[t]} made ${pct(agg.nilsMade[t], agg.nils[t])}, bags/hand ${(agg.bags[t] / agg.hands).toFixed(2)}`);
  }
  console.log(`blind nils: ${agg.blindNils} made ${pct(agg.blindMade, agg.blindNils)}`);
  // Calibration: bid vs tricks taken by individual non-nil bidders
  const byBid = {};
  for (const [, bid, tricks] of agg.calib) (byBid[bid] ||= []).push(tricks);
  console.log('bid -> avg tricks taken (count)');
  for (const b of Object.keys(byBid).sort((a, b) => a - b)) {
    const xs = byBid[b];
    console.log(`  ${b.padStart(2)} -> ${(xs.reduce((a, c) => a + c, 0) / xs.length).toFixed(2)} (${xs.length})`);
  }
}

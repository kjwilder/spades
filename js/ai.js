// Computer player: bidding and card play.
//
// The AI only looks at public information (bids, tricks, cards already played) and its own
// hand. It counts cards and notices when a player shows out of a suit, but never peeks at
// other hands. Strategy follows the usual priorities: make your bid, set the opponents,
// then avoid bags; cover a partner's nil and attack an opponent's nil.

import {
  SUITS, makeDeck, suitOf, rankOf, teamOf, partnerOf, nextSeat,
  legalPlays, beats, currentWinner, canBlindNil, teamProgress,
} from './engine.js';

const bySuit = (hand) => {
  const out = { S: [], H: [], C: [], D: [] };
  for (const c of hand) out[suitOf(c)].push(c);
  for (const s of SUITS) out[s].sort((a, b) => rankOf(a) - rankOf(b));
  return out;
};
const lowest = (cards) => cards.reduce((a, b) => (rankOf(b) < rankOf(a) ? b : a));
const highest = (cards) => cards.reduce((a, b) => (rankOf(b) > rankOf(a) ? b : a));

// Tunable strategy parameters (tests/sim.js can compare variants).
export const DEFAULT_PARAMS = {
  bidRound: 0.2, // added to the trick estimate before rounding down
  nilLimit: 1.2, // highest nilDanger() accepted for a nil bid
  attackNil: true, // play to set an opponent's nil
  coverNil: true, // play to protect a partner's nil
  avoidBags: true, // duck tricks once the contract is safe
  trySet: true, // keep winning tricks when the opponents can be set
};

// ---------------------------------------------------------------------------
// Bidding
// ---------------------------------------------------------------------------

// Estimated tricks for a hand, as a fractional number.
export function estimateTricks(hand) {
  const suits = bySuit(hand);
  const spades = suits.S.map(rankOf);
  const n = spades.length;
  const hasS = (r) => spades.includes(r);
  let total = 0;

  // Spade honors, then one trick for every spade beyond the third.
  let spadeTricks = 0, honors = 0;
  if (hasS(14)) { spadeTricks += 1; honors++; }
  if (hasS(13)) {
    spadeTricks += hasS(14) ? 1 : n >= 3 ? 0.9 : n === 2 ? 0.6 : 0.2;
    honors++;
  }
  if (hasS(12)) {
    const above = (hasS(14) ? 1 : 0) + (hasS(13) ? 1 : 0);
    spadeTricks += above === 2 ? 1 : above === 1 && n >= 3 ? 0.7 : n >= 4 ? 0.6 : n === 3 ? 0.4 : 0.1;
    honors++;
  }
  if (hasS(11) && hasS(12) && hasS(13) && hasS(14)) spadeTricks += 1;
  spadeTricks += Math.max(0, n - 3) * 0.9;
  total += Math.min(spadeTricks, n);

  // Side-suit aces, kings and queens, discounted for long suits that get trumped.
  let ruffValue = 0;
  for (const s of ['H', 'C', 'D']) {
    const ranks = suits[s].map(rankOf);
    const len = ranks.length;
    const has = (r) => ranks.includes(r);
    if (has(14)) total += len <= 5 ? 1 : len === 6 ? 0.85 : 0.7;
    if (has(13)) {
      if (has(14)) total += len <= 4 ? 1 : len === 5 ? 0.8 : 0.4;
      else total += len === 1 ? 0.1 : len <= 4 ? 0.7 : len === 5 ? 0.5 : 0.2;
    }
    if (has(12)) {
      if (has(14) && has(13)) total += len <= 4 ? 0.8 : 0.3;
      else if ((has(14) || has(13)) && len >= 3 && len <= 4) total += 0.4;
      else if (len >= 3 && len <= 4) total += 0.2;
    }
    ruffValue += len === 0 ? 1 : len === 1 ? 0.8 : len === 2 ? 0.3 : 0;
  }

  // Short side suits let low spades (within the first three) trump.
  const spareSpades = Math.max(0, Math.min(n, 3) - honors);
  total += Math.min(ruffValue, spareSpades * 0.9);
  return total;
}

// How likely a hand is to be forced to take a trick; lower is safer for nil.
// Each high card is dangerous unless protected by lower cards in the same suit.
export function nilDanger(hand) {
  const suits = bySuit(hand);
  const spades = suits.S.map(rankOf);
  if (spades.some((r) => r >= 12) || spades.length >= 5) return Infinity;
  let danger = 0;
  const decay = [1, 0.55, 0.3, 0.15, 0.1];
  spades.forEach((r, i) => {
    danger += Math.max(0, (r - 3) / 9) * (decay[i] ?? 0.1) * 1.3;
  });
  if (spades.length === 4) danger += 0.6;
  for (const s of ['H', 'C', 'D']) {
    suits[s].map(rankOf).forEach((r, i) => {
      danger += Math.max(0, (r - 7) / 7) * (decay[i] ?? 0.05);
    });
  }
  return danger;
}

// Blind nil is decided before looking at the cards, so it uses only the score.
export function chooseBlindNil(state, seat) {
  if (!canBlindNil(state, seat)) return false;
  const t = teamOf(seat);
  const deficit = state.scores[1 - t] - state.scores[t];
  // A long shot (it succeeds about a quarter of the time), so only when the game is nearly lost.
  const oppsNearWin = state.scores[1 - t] >= state.options.target - 70;
  return deficit >= 250 && oppsNearWin && state.bids[partnerOf(seat)] !== 0;
}

export function chooseBid(state, seat, params = DEFAULT_PARAMS) {
  const hand = state.hands[seat];
  const t = teamOf(seat);
  const partner = partnerOf(seat);
  const partnerBid = state.bids[partner];
  const oppBids = [nextSeat(seat), partnerOf(nextSeat(seat))].map((s) => state.bids[s]);
  const known = state.bids.filter((b) => b !== null);
  const est = estimateTricks(hand);

  // Nil: needs a safe hand; more attractive when partner is strong or we're behind.
  if (partnerBid !== 0) {
    let limit = params.nilLimit;
    if (partnerBid !== null && partnerBid >= 4) limit += 0.25;
    if (partnerBid !== null && partnerBid <= 2) limit -= 0.25;
    if (oppBids.includes(0)) limit += 0.1;
    const lead = state.scores[t] - state.scores[1 - t];
    if (lead <= -150) limit += 0.25;
    else if (lead >= 150) limit -= 0.2;
    if (est <= 2 && nilDanger(hand) <= limit) return 0;
  }

  let adjusted = est;
  if (oppBids.includes(0)) adjusted += 0.3; // a nil opponent won't compete for tricks
  if (state.bags[t] >= 7) adjusted += 0.3; // near the bag penalty, lean toward the higher bid
  let bid = Math.floor(adjusted + params.bidRound);

  // Last to bid: trim the bid when the table is overbid, stretch it when tricks are spare.
  if (known.length === 3) {
    const others = known.reduce((a, b) => a + b, 0);
    if (others + bid >= 14) bid -= 1;
    else if (others + bid <= 9 && adjusted - bid >= 0.2) bid += 1;
  }
  return Math.max(1, Math.min(13, bid));
}

// ---------------------------------------------------------------------------
// Card play
// ---------------------------------------------------------------------------

// Public knowledge available to `seat`: unseen cards and suits each player has shown out of.
function knowledge(state, seat) {
  const hand = state.hands[seat];
  const seen = new Set([...hand, ...state.played.map((p) => p.card)]);
  const unknown = makeDeck().filter((c) => !seen.has(c));
  const voids = [0, 1, 2, 3].map(() => new Set());
  for (const p of state.played) {
    if (p.pos > 0 && suitOf(p.card) !== p.led) voids[p.seat].add(p.led);
    if (p.pos === 0 && suitOf(p.card) === 'S' && !p.brokenBefore) {
      for (const s of ['H', 'C', 'D']) voids[p.seat].add(s); // led spades early: only had spades
    }
  }
  return { hand, unknown, voids };
}

function buildContext(state, seat, params) {
  const k = knowledge(state, seat);
  const team = teamOf(seat);
  const partner = partnerOf(seat);
  const opps = [nextSeat(seat), partnerOf(nextSeat(seat))];
  const pos = state.trick.length;
  const led = pos ? suitOf(state.trick[0].card) : null;
  const win = currentWinner(state.trick);
  const after = []; // seats still to play after me in this trick
  for (let s = nextSeat(seat), i = pos + 1; i < 4; i++, s = nextSeat(s)) after.push(s);
  const nilAlive = (s) => state.bids[s] === 0 && state.tricks[s] === 0;
  const tricksLeft = 13 - state.completedTricks.length;
  const mine = teamProgress(state, team);
  const theirs = teamProgress(state, 1 - team);
  const need = Math.max(0, mine.contract - mine.taken);
  const oppNeed = Math.max(0, theirs.contract - theirs.taken);

  const ctx = {
    state, seat, k, team, partner, opps, pos, led, win, after, tricksLeft, need, oppNeed,
    nilAlive, suits: bySuit(k.hand),
    partnerPlayed: state.trick.find((t) => t.seat === partner) || null,
  };
  ctx.higherUnknown = (card) =>
    k.unknown.filter((c) => suitOf(c) === suitOf(card) && rankOf(c) > rankOf(card)).length;
  ctx.lowerUnknown = (card) =>
    k.unknown.filter((c) => suitOf(c) === suitOf(card) && rankOf(c) < rankOf(card)).length;
  ctx.unknownIn = (suit) => k.unknown.filter((c) => suitOf(c) === suit).length;
  // Could seat `s`, still to play, beat `card` in this trick (as far as we know)?
  ctx.canBeat = (s, card) => {
    const suit = ctx.led || suitOf(card);
    const voidLed = k.voids[s].has(suit);
    const mayTrump = !k.voids[s].has('S') && ctx.unknownIn('S') > 0;
    if (suitOf(card) === suit) {
      if (!voidLed && ctx.higherUnknown(card) > 0) return true;
      // A player out of the led suit may trump it.
      return suit !== 'S' && mayTrump && (voidLed || ctx.unknownIn(suit) <= 1);
    }
    // `card` is a spade on a non-spade lead: only a higher spade from a player out of the led suit beats it.
    return voidLed && mayTrump && ctx.higherUnknown(card) > 0;
  };
  // Will `card` win if played now, against the opponents still to play?
  ctx.sure = (card) => {
    if (ctx.win && !beats(card, ctx.win.card)) return false;
    return ctx.after.filter((s) => s !== partner).every((s) => !ctx.canBeat(s, card));
  };
  ctx.want = wantTricks(ctx, mine, theirs, params);
  return ctx;
}

// Should the team try to win tricks ('win') or avoid them ('duck')?
function wantTricks(ctx, mine, theirs, params) {
  const { state, need, oppNeed, tricksLeft, team } = ctx;
  if (need > 0 || !params.avoidBags) return 'win';
  if (params.trySet && oppNeed > 0 && theirs.contract > 0) {
    const toSet = tricksLeft - oppNeed + 1; // tricks we must take to set them
    if (toSet <= 0) return 'duck'; // already set
    const tableBid = mine.contract + theirs.contract;
    const bagRoom = 10 - state.bags[team] - (mine.taken - mine.contract);
    const worth = toSet <= Math.max(2, Math.floor(theirs.contract / 2)) || (tableBid >= 11 && toSet <= 3);
    if (worth && (bagRoom > toSet || theirs.contract >= 6)) return 'win';
  }
  return 'duck';
}

export function choosePlay(state, seat, params = DEFAULT_PARAMS) {
  const legal = legalPlays(state, seat);
  if (legal.length === 1) return legal[0];
  const ctx = buildContext(state, seat, params);
  if (ctx.nilAlive(seat)) return playNil(ctx, legal);
  if (params.coverNil && ctx.nilAlive(ctx.partner)) {
    const card = coverPartnerNil(ctx, legal);
    if (card) return card;
  }
  const nilOpp = ctx.opps.find(ctx.nilAlive);
  if (params.attackNil && nilOpp !== undefined && !(ctx.need > 0 && ctx.need >= ctx.tricksLeft - 1)) {
    const card = attackNil(ctx, legal, nilOpp);
    if (card) return card;
  }
  return ctx.want === 'win' ? playToWin(ctx, legal) : playToDuck(ctx, legal);
}

// --- Bidding nil yourself: never win a trick if it can be avoided ---
function playNil(ctx, legal) {
  const { pos, win, after } = ctx;
  if (pos === 0) {
    // Lead the card with the most unseen cards above it; avoid spades.
    const score = (c) => ctx.higherUnknown(c) * 10 - rankOf(c) - (suitOf(c) === 'S' ? 30 : 0);
    return legal.reduce((a, b) => (score(b) > score(a) ? b : a));
  }
  const losers = legal.filter((c) => !beats(c, win.card));
  if (losers.length) {
    const offSuit = losers.filter((c) => suitOf(c) !== ctx.led);
    if (offSuit.length) {
      // Discard: shed the most dangerous card (high, poorly protected).
      const danger = (c) => rankOf(c) - ctx.suits[suitOf(c)].length * 0.5 + (suitOf(c) === 'S' ? 3 : 0);
      return offSuit.reduce((a, b) => (danger(b) > danger(a) ? b : a));
    }
    return highest(losers);
  }
  // Forced to go over: hope someone later beats it, or dump the highest if last.
  return after.length ? lowest(legal) : highest(legal);
}

// --- Partner bid nil: win tricks over partner so they can play safely underneath ---
function coverPartnerNil(ctx, legal) {
  const { pos, win, partnerPlayed, partner, k } = ctx;
  if (pos === 0) {
    // Lead high: boss cards first, else the highest card in a suit partner hasn't shown out of.
    const nonSpade = legal.filter((c) => suitOf(c) !== 'S');
    const pool = nonSpade.length ? nonSpade : legal;
    const score = (c) => (ctx.higherUnknown(c) === 0 ? 100 : 0) + rankOf(c) - ctx.higherUnknown(c) * 2
      + (k.voids[partner].has(suitOf(c)) ? 5 : 0);
    return pool.reduce((a, b) => (score(b) > score(a) ? b : a));
  }
  if (!partnerPlayed) {
    // Partner plays after me: set the bar as high as possible.
    const winners = legal.filter((c) => beats(c, win.card));
    if (!winners.length) return null;
    if (win.seat !== partner && ctx.after.length && ctx.higherUnknown(win.card) === 0 && suitOf(win.card) === ctx.led) {
      return null; // an opponent's boss card is already winning; partner can duck under it
    }
    const inSuit = winners.filter((c) => suitOf(c) === suitOf(winners[0]));
    return highest(inSuit);
  }
  if (win.seat === partner) {
    // Partner is winning: overtake with the cheapest card that beats them.
    const winners = legal.filter((c) => beats(c, win.card));
    if (winners.length) {
      const sameSuit = winners.filter((c) => suitOf(c) === suitOf(win.card));
      return lowest(sameSuit.length ? sameSuit : winners);
    }
  }
  return null; // otherwise play normally
}

// --- An opponent bid nil: keep the bar low so they're forced to win ---
function attackNil(ctx, legal, nilOpp) {
  const { pos, win, k, after } = ctx;
  if (pos === 0) {
    // Lead the lowest card, relative to what's still out, in a suit the nil player still holds.
    const candidates = legal.filter((c) => !k.voids[nilOpp].has(suitOf(c)));
    if (!candidates.length) return null;
    const score = (c) => ctx.lowerUnknown(c) * 10 + rankOf(c) + (suitOf(c) === 'S' ? 5 : 0);
    return candidates.reduce((a, b) => (score(b) < score(a) ? b : a));
  }
  const nilPlayed = ctx.state.trick.find((t) => t.seat === nilOpp);
  if (nilPlayed) {
    if (win.seat !== nilOpp) return null;
    // Nil player is winning: stay under them, shedding high cards.
    const under = legal.filter((c) => !beats(c, win.card));
    if (under.length) {
      const offSuit = under.filter((c) => suitOf(c) !== ctx.led && suitOf(c) !== 'S');
      return offSuit.length ? highest(offSuit) : highest(under);
    }
    return null;
  }
  if (after.includes(nilOpp)) {
    // Nil player still to play: keep the winning card low, shed high cards, save low ones to lead.
    const inSuit = legal.filter((c) => suitOf(c) === ctx.led);
    if (inSuit.length) {
      const under = inSuit.filter((c) => !beats(c, win.card));
      return under.length ? highest(under) : lowest(inSuit);
    }
    const off = legal.filter((c) => suitOf(c) !== 'S');
    if (off.length) return highest(off); // discard rather than trump
  }
  return null;
}

// Cheapest card to throw away: low, not a boss, preferably from a short suit.
function lowestValue(ctx, cards) {
  const value = (c) => rankOf(c) + (ctx.higherUnknown(c) === 0 ? 20 : 0)
    - (ctx.suits[suitOf(c)].length <= 2 && ctx.suits.S.length ? 3 : 0)
    + (suitOf(c) === 'S' ? 30 : 0);
  return cards.reduce((a, b) => (value(b) < value(a) ? b : a));
}

// Lowest card in `cards` that is equivalent to `card` (no unseen card between them).
function lowestEquivalent(ctx, cards, card) {
  const suit = suitOf(card);
  const unknownRanks = new Set(ctx.k.unknown.filter((c) => suitOf(c) === suit).map(rankOf));
  const mine = cards.filter((c) => suitOf(c) === suit).map(rankOf).sort((a, b) => b - a);
  let r = rankOf(card);
  for (const m of mine) {
    if (m >= r) continue;
    let gap = false;
    for (let x = m + 1; x < r; x++) if (unknownRanks.has(x)) gap = true;
    if (gap) break;
    r = m;
  }
  return suit + r;
}

function playToWin(ctx, legal) {
  const { pos, win, partner, after, k, opps } = ctx;
  if (pos === 0) return leadToWin(ctx, legal);

  const winners = legal.filter((c) => beats(c, win.card));
  const following = suitOf(legal[0]) === ctx.led && legal.every((c) => suitOf(c) === ctx.led);

  if (win.seat === partner) {
    const partnerSafe = after.every((s) => !ctx.canBeat(s, win.card));
    if (partnerSafe || !after.length) return following ? lowest(legal) : lowestValue(ctx, legal);
    // Partner's card may lose: take over with a sure winner, or play third hand high on a weak card.
    const sure = winners.filter(ctx.sure);
    if (sure.length) return lowest(sure);
    if (ctx.higherUnknown(win.card) >= 2 && winners.length) {
      return following ? lowestEquivalent(ctx, legal, highest(winners)) : lowest(winners);
    }
    return following ? lowest(legal) : lowestValue(ctx, legal);
  }

  if (!winners.length) return following ? lowest(legal) : lowestValue(ctx, legal);
  if (!after.length) return lowest(winners);

  const sure = winners.filter(ctx.sure);
  if (sure.length) return lowest(sure);

  const partnerStillToPlay = after.includes(partner);
  if (following) {
    if (partnerStillToPlay) return lowest(legal); // second hand low
    return lowestEquivalent(ctx, legal, highest(winners)); // third hand high, lowest of equals
  }
  // Out of the led suit. In second seat, leave a low lead to partner rather than trumping.
  if (partnerStillToPlay && !k.voids[partner].has(ctx.led) && ctx.higherUnknown(win.card) >= 3) {
    const discards = legal.filter((c) => suitOf(c) !== 'S');
    if (discards.length) return lowestValue(ctx, discards);
  }
  // Trump high enough to hold if an opponent behind me may overtrump.
  const overtrumpRisk = after.some((s) => opps.includes(s) && ctx.canBeat(s, lowest(winners)));
  return overtrumpRisk ? lowestEquivalent(ctx, legal, highest(winners)) : lowest(winners);
}

function leadToWin(ctx, legal) {
  const { k, opps, partner, suits, state } = ctx;
  const nonSpade = legal.filter((c) => suitOf(c) !== 'S');
  const oppVoid = (s) => opps.some((o) => k.voids[o].has(s) && !k.voids[o].has('S'));

  // 1. Cash boss cards in side suits the opponents can't trump yet.
  const cashable = nonSpade.filter((c) => ctx.higherUnknown(c) === 0 && !oppVoid(suitOf(c))
    && ctx.unknownIn(suitOf(c)) >= 3);
  if (cashable.length) {
    // Prefer the suit with the most cards still out, so everyone is likely to follow.
    return cashable.reduce((a, b) => (ctx.unknownIn(suitOf(b)) > ctx.unknownIn(suitOf(a)) ? b : a));
  }

  // 2. Draw trumps with top spades when long in spades.
  const spades = legal.filter((c) => suitOf(c) === 'S');
  if (spades.length && (state.spadesBroken || !nonSpade.length)) {
    const bossSpade = spades.find((c) => ctx.higherUnknown(c) === 0);
    if (bossSpade && (spades.length >= 3 || !nonSpade.length)) return bossSpade;
    if (spades.length >= 5 || !nonSpade.length) return lowest(spades);
  }
  if (!nonSpade.length) return lowest(legal);

  // 3. Lead a suit partner can trump while the opponents follow.
  const partnerRuff = nonSpade.filter((c) => k.voids[partner].has(suitOf(c)) && !k.voids[partner].has('S')
    && !oppVoid(suitOf(c)));
  if (partnerRuff.length) return lowest(partnerRuff);

  // 4. Score each side suit for a low lead.
  const score = (s) => {
    const cards = suits[s];
    let v = 0;
    if (oppVoid(s)) v -= 20;
    const top = cards[cards.length - 1];
    const hasK = cards.some((c) => rankOf(c) === 13), hasA = cards.some((c) => rankOf(c) === 14);
    if (hasK && !hasA && ctx.higherUnknown(s + 13) > 0) v -= 8; // don't lead away from a bare king
    if (cards.length <= 2 && suits.S.length) v += 6; // shorten a suit to trump later
    if (rankOf(top) === 12 && cards.length >= 3) v += 2;
    if (k.voids[partner].has(s)) v += 3;
    return v;
  };
  const choices = ['H', 'C', 'D'].filter((s) => nonSpade.some((c) => suitOf(c) === s));
  const best = choices.reduce((a, b) => (score(b) > score(a) ? b : a));
  const cards = suits[best];
  // Top of a sequence headed by a near-boss card, else low.
  const top = cards[cards.length - 1];
  if (cards.length >= 2 && ctx.higherUnknown(top) === 1 && lowestEquivalent(ctx, cards, top) !== top) {
    return top;
  }
  return lowest(cards);
}

function playToDuck(ctx, legal) {
  const { pos, win, after, partner } = ctx;
  if (pos === 0) {
    // Lead the card least likely to win.
    const score = (c) => ctx.higherUnknown(c) * 10 - rankOf(c) - (suitOf(c) === 'S' ? 25 : 0);
    return legal.reduce((a, b) => (score(b) > score(a) ? b : a));
  }
  const losers = legal.filter((c) => !beats(c, win.card));
  if (losers.length) {
    const offSuit = losers.filter((c) => suitOf(c) !== ctx.led);
    if (offSuit.length) {
      const nonSpade = offSuit.filter((c) => suitOf(c) !== 'S');
      return highest(nonSpade.length ? nonSpade : offSuit);
    }
    return highest(losers);
  }
  // Every card wins for now. If partner already has it, or I'm last, shed the highest.
  if (win.seat === partner || !after.length) return highest(legal);
  return lowest(legal);
}

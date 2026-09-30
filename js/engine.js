// Spades rules engine: dealing, bidding, trick play and scoring.
// Pure game logic with no DOM access, so it runs in the browser and in Node tests.
//
// Seats go clockwise: 0 = South (the human), 1 = West, 2 = North (partner), 3 = East.
// Seats 0 and 2 are team 0; seats 1 and 3 are team 1.
// A card is a string: suit letter followed by rank, e.g. "S14" = ace of spades, "H10" = ten of hearts.

export const SUITS = ['S', 'H', 'C', 'D'];
export const SUIT_SYMBOL = { S: '♠', H: '♥', C: '♣', D: '♦' };
export const SUIT_NAME = { S: 'Spades', H: 'Hearts', C: 'Clubs', D: 'Diamonds' };
export const SEAT_NAMES = ['You', 'West', 'North', 'East'];
export const TEAM_NAMES = ['You & North', 'West & East'];
export const BAG_LIMIT = 10;
export const BAG_PENALTY = 100;

export const DEFAULT_OPTIONS = {
  target: 500, // points needed to win the game
  blindNil: true, // allow blind nil for a team trailing by 100 or more
};

export const suitOf = (card) => card[0];
export const rankOf = (card) => Number(card.slice(1));
export const teamOf = (seat) => seat % 2;
export const partnerOf = (seat) => (seat + 2) % 4;
export const nextSeat = (seat) => (seat + 1) % 4;

const RANK_LABELS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const RANK_NAMES = { 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
export const rankLabel = (card) => RANK_LABELS[rankOf(card)] || String(rankOf(card));
export const cardName = (card) =>
  `${RANK_NAMES[rankOf(card)] || rankOf(card)} of ${SUIT_NAME[suitOf(card)]}`;
export const cardText = (card) => rankLabel(card) + SUIT_SYMBOL[suitOf(card)];

export function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) deck.push(s + r);
  return deck;
}

export function shuffle(items, rng = Math.random) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Display order alternates colors (♠ ♥ ♣ ♦), low to high within a suit.
export function sortHand(hand) {
  return hand.slice().sort((a, b) =>
    SUITS.indexOf(suitOf(a)) - SUITS.indexOf(suitOf(b)) || rankOf(a) - rankOf(b));
}

export function newGame(options = {}, rng = Math.random) {
  const state = {
    version: 1,
    options: { ...DEFAULT_OPTIONS, ...options },
    scores: [0, 0],
    bags: [0, 0],
    dealer: Math.floor(rng() * 4),
    handNo: 0,
    history: [],
    winner: null,
  };
  startHand(state, rng);
  return state;
}

export function startHand(state, rng = Math.random) {
  const deck = shuffle(makeDeck(), rng);
  state.handNo += 1;
  state.hands = [0, 1, 2, 3].map((i) => sortHand(deck.slice(i * 13, i * 13 + 13)));
  state.bids = [null, null, null, null];
  state.blind = [false, false, false, false];
  state.tricks = [0, 0, 0, 0];
  state.turn = nextSeat(state.dealer);
  state.leader = state.turn;
  state.trick = [];
  state.trickWinner = null;
  state.spadesBroken = false;
  state.played = []; // every card played this hand, in order, for card counting
  state.completedTricks = [];
  state.lastResult = null;
  state.phase = 'bidding';
  return state;
}

export function nextHand(state, rng = Math.random) {
  if (state.phase !== 'handEnd') throw new Error('Hand is not finished');
  state.dealer = nextSeat(state.dealer);
  return startHand(state, rng);
}

// Blind nil is allowed when the option is on, the bidder's team trails by at least 100,
// and the partner has not already bid blind nil.
export function canBlindNil(state, seat) {
  if (!state.options.blindNil) return false;
  const t = teamOf(seat);
  if (state.scores[1 - t] - state.scores[t] < 100) return false;
  return !state.blind[partnerOf(seat)];
}

// A bid of 0 is nil. Pass blind = true for blind nil.
export function applyBid(state, seat, bid, blind = false) {
  if (state.phase !== 'bidding') throw new Error('Not in bidding phase');
  if (seat !== state.turn) throw new Error(`Not seat ${seat}'s turn to bid`);
  if (!Number.isInteger(bid) || bid < 0 || bid > 13) throw new Error(`Invalid bid ${bid}`);
  if (blind && (bid !== 0 || !canBlindNil(state, seat))) throw new Error('Blind nil not allowed');
  state.bids[seat] = bid;
  state.blind[seat] = blind;
  state.turn = nextSeat(seat);
  if (state.bids.every((b) => b !== null)) {
    state.phase = 'playing';
    state.turn = state.leader;
  }
  return state;
}

// Spades cannot be led until broken, unless the leader holds nothing but spades.
// Followers must follow the led suit if they can; otherwise any card may be played.
export function legalPlays(state, seat) {
  const hand = state.hands[seat];
  if (state.trick.length === 0) {
    if (state.spadesBroken) return hand.slice();
    const nonSpades = hand.filter((c) => suitOf(c) !== 'S');
    return nonSpades.length ? nonSpades : hand.slice();
  }
  const led = suitOf(state.trick[0].card);
  const follow = hand.filter((c) => suitOf(c) === led);
  return follow.length ? follow : hand.slice();
}

// True if `card` beats `best`, the card currently winning the trick.
// An off-suit card wins only if it is a spade and `best` is not.
export function beats(card, best) {
  const s = suitOf(card), bs = suitOf(best);
  if (s === bs) return rankOf(card) > rankOf(best);
  return s === 'S';
}

// Returns the entry ({seat, card}) currently winning a (possibly partial) trick.
export function currentWinner(trick) {
  if (!trick.length) return null;
  let best = trick[0];
  for (const t of trick.slice(1)) if (beats(t.card, best.card)) best = t;
  return best;
}

export function applyPlay(state, seat, card) {
  if (state.phase !== 'playing') throw new Error('Not in playing phase');
  if (seat !== state.turn) throw new Error(`Not seat ${seat}'s turn to play`);
  if (!legalPlays(state, seat).includes(card)) throw new Error(`Illegal play ${card} by seat ${seat}`);
  const hand = state.hands[seat];
  hand.splice(hand.indexOf(card), 1);
  const pos = state.trick.length;
  state.played.push({
    seat,
    card,
    trickNo: state.completedTricks.length,
    pos,
    led: pos === 0 ? suitOf(card) : suitOf(state.trick[0].card),
    brokenBefore: state.spadesBroken,
  });
  state.trick.push({ seat, card });
  if (suitOf(card) === 'S') state.spadesBroken = true;
  if (state.trick.length === 4) {
    state.trickWinner = currentWinner(state.trick).seat;
    state.turn = null;
    state.phase = 'trickEnd';
  } else {
    state.turn = nextSeat(seat);
  }
  return state;
}

// Called after a completed trick has been shown; hands the lead to the winner
// and scores the hand after the thirteenth trick.
export function collectTrick(state) {
  if (state.phase !== 'trickEnd') throw new Error('No completed trick to collect');
  const winner = state.trickWinner;
  state.tricks[winner] += 1;
  state.completedTricks.push({ leader: state.trick[0].seat, cards: state.trick, winner });
  state.trick = [];
  state.trickWinner = null;
  state.leader = winner;
  state.turn = winner;
  if (state.completedTricks.length === 13) finishHand(state);
  else state.phase = 'playing';
  return state;
}

// Scores one team for one hand.
//  - Nil: +100 if the nil bidder takes no tricks, -100 otherwise (blind nil: ±200).
//    Tricks taken by a nil bidder do not count toward the partner's bid, but count as bags.
//  - Contract (sum of the non-nil bids): made = +10 per trick bid, +1 per overtrick (bag);
//    set = -10 per trick bid.
//  - Every 10 accumulated bags costs 100 points.
export function scoreTeam(team, bids, blind, tricks, bagsBefore) {
  const seats = [team, team + 2];
  let points = 0, bags = 0, contract = 0, taken = 0;
  const nils = [];
  for (const seat of seats) {
    if (bids[seat] === 0) {
      const value = blind[seat] ? 200 : 100;
      const made = tricks[seat] === 0;
      nils.push({ seat, blind: blind[seat], made, points: made ? value : -value });
      points += made ? value : -value;
      bags += tricks[seat];
    } else {
      contract += bids[seat];
      taken += tricks[seat];
    }
  }
  let contractPoints = 0;
  let made = null;
  if (contract > 0) {
    made = taken >= contract;
    contractPoints = made ? 10 * contract : -10 * contract;
    if (made) bags += taken - contract;
  }
  points += contractPoints + bags;
  let totalBags = bagsBefore + bags;
  let bagPenalty = 0;
  while (totalBags >= BAG_LIMIT) {
    totalBags -= BAG_LIMIT;
    bagPenalty += BAG_PENALTY;
  }
  points -= bagPenalty;
  return { team, contract, taken, made, contractPoints, nils, bagsAdded: bags, bagPenalty, totalBags, points };
}

export function finishHand(state) {
  const result = {
    handNo: state.handNo,
    dealer: state.dealer,
    bids: state.bids.slice(),
    blind: state.blind.slice(),
    tricks: state.tricks.slice(),
    teams: [0, 1].map((t) => scoreTeam(t, state.bids, state.blind, state.tricks, state.bags[t])),
  };
  for (const t of [0, 1]) {
    state.scores[t] += result.teams[t].points;
    state.bags[t] = result.teams[t].totalBags;
  }
  result.scores = state.scores.slice();
  state.history.push(result);
  state.lastResult = result;
  state.winner = gameWinner(state);
  state.phase = state.winner === null ? 'handEnd' : 'gameOver';
  return result;
}

// The game ends when a team reaches the target score; if both do, the higher score wins.
// A tie at or above the target plays another hand.
export function gameWinner(state) {
  const [a, b] = state.scores;
  const target = state.options.target;
  if (a < target && b < target) return null;
  if (a === b) return null;
  return a > b ? 0 : 1;
}

// Team contract and trick count, excluding nil bidders (whose tricks don't count toward the bid).
export function teamProgress(state, team) {
  let contract = 0, taken = 0;
  for (const seat of [team, team + 2]) {
    if (state.bids[seat] === null || state.bids[seat] === 0) continue;
    contract += state.bids[seat];
    taken += state.tricks[seat];
  }
  return { contract, taken };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeDeck, newGame, startHand, applyBid, applyPlay, collectTrick, legalPlays, currentWinner,
  scoreTeam, finishHand, gameWinner, canBlindNil, sortHand, nextHand,
} from '../js/engine.js';
import { chooseBid, choosePlay, estimateTricks, nilDanger } from '../js/ai.js';
import { playGame, mulberry32 } from './sim.js';

const bids = (a) => a;

test('deck has 52 unique cards', () => {
  const deck = makeDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52);
});

test('deal gives 13 cards each, all distinct', () => {
  const s = newGame({}, mulberry32(1));
  const all = s.hands.flat();
  assert.equal(all.length, 52);
  assert.equal(new Set(all).size, 52);
  s.hands.forEach((h) => assert.equal(h.length, 13));
  assert.equal(s.phase, 'bidding');
  assert.equal(s.turn, (s.dealer + 1) % 4);
});

test('sortHand groups suits spades, hearts, clubs, diamonds, low to high', () => {
  assert.deepEqual(sortHand(['D2', 'S14', 'H3', 'S2', 'C10']), ['S2', 'S14', 'H3', 'C10', 'D2']);
});

function stateWith(hands, { spadesBroken = false, trick = [], turn = 0 } = {}) {
  const s = newGame({}, mulberry32(2));
  s.hands = hands;
  s.phase = 'playing';
  s.bids = [3, 3, 3, 3];
  s.spadesBroken = spadesBroken;
  s.trick = trick;
  s.turn = turn;
  return s;
}

test('cannot lead spades until broken unless only spades are held', () => {
  let s = stateWith([['S5', 'H3'], [], [], []]);
  assert.deepEqual(legalPlays(s, 0), ['H3']);
  s = stateWith([['S5', 'H3'], [], [], []], { spadesBroken: true });
  assert.deepEqual(legalPlays(s, 0), ['S5', 'H3']);
  s = stateWith([['S5', 'S9'], [], [], []]);
  assert.deepEqual(legalPlays(s, 0), ['S5', 'S9']);
});

test('must follow suit; may trump or discard when void', () => {
  let s = stateWith([['S5', 'H3', 'H9', 'D4'], [], [], []], { trick: [{ seat: 3, card: 'H10' }] });
  assert.deepEqual(legalPlays(s, 0), ['H3', 'H9']);
  s = stateWith([['S5', 'D4'], [], [], []], { trick: [{ seat: 3, card: 'H10' }] });
  assert.deepEqual(legalPlays(s, 0), ['S5', 'D4']);
});

test('trick winner: highest of led suit, or highest spade', () => {
  const t = (cards) => cards.map((card, seat) => ({ seat, card }));
  assert.equal(currentWinner(t(['H10', 'H14', 'D14', 'H2'])).seat, 1);
  assert.equal(currentWinner(t(['H10', 'H14', 'S2', 'H2'])).seat, 2);
  assert.equal(currentWinner(t(['H10', 'S3', 'S2', 'S12'])).seat, 3);
  assert.equal(currentWinner(t(['C2', 'D14', 'H14', 'C3'])).seat, 3);
});

test('playing a spade breaks spades; completed trick goes to winner who leads next', () => {
  const s = stateWith([['H2', 'C2'], ['S3', 'C3'], ['H4', 'C4'], ['H5', 'C5']]);
  applyPlay(s, 0, 'H2');
  applyPlay(s, 1, 'S3');
  assert.equal(s.spadesBroken, true);
  applyPlay(s, 2, 'H4');
  applyPlay(s, 3, 'H5');
  assert.equal(s.phase, 'trickEnd');
  collectTrick(s);
  assert.equal(s.tricks[1], 1);
  assert.equal(s.turn, 1);
  assert.equal(s.phase, 'playing');
});

test('illegal plays and out-of-turn actions throw', () => {
  const s = stateWith([['H2', 'C2'], ['S3', 'C3'], ['H4', 'C4'], ['H5', 'C5']]);
  assert.throws(() => applyPlay(s, 1, 'C3'));
  applyPlay(s, 0, 'H2');
  assert.throws(() => applyPlay(s, 1, 'C4'));
  assert.throws(() => applyPlay(s, 2, 'H4'));
});

test('bidding proceeds clockwise from dealer\'s left, then leader plays', () => {
  const s = newGame({}, mulberry32(3));
  s.dealer = 3;
  startHand(s, mulberry32(4));
  assert.equal(s.turn, 0);
  assert.throws(() => applyBid(s, 1, 3));
  applyBid(s, 0, 3);
  applyBid(s, 1, 2);
  applyBid(s, 2, 0);
  assert.throws(() => applyBid(s, 3, 14));
  applyBid(s, 3, 4);
  assert.equal(s.phase, 'playing');
  assert.equal(s.turn, 0);
});

test('scoring: made contract with bags, set contract', () => {
  // Team 0: bids 3 + 4 = 7, takes 5 + 3 = 8 -> 70 + 1 bag
  let r = scoreTeam(0, bids([3, 2, 4, 2]), [false, false, false, false], [5, 2, 3, 3], 0);
  assert.equal(r.points, 71);
  assert.equal(r.bagsAdded, 1);
  // Team 1: bids 2 + 2 = 4, takes 2 + 3 = 5 -> 40 + 1
  r = scoreTeam(1, bids([3, 2, 4, 2]), [false, false, false, false], [5, 2, 3, 3], 0);
  assert.equal(r.points, 41);
  // Set: bid 7, take 6 -> -70
  r = scoreTeam(0, bids([3, 2, 4, 2]), [false, false, false, false], [3, 4, 3, 3], 0);
  assert.equal(r.points, -70);
  assert.equal(r.made, false);
});

test('scoring: nil made and failed; failed nil tricks are bags and do not help partner', () => {
  // Seat 0 nil and takes 0; seat 2 bids 4 takes 5 -> 100 + 40 + 1
  let r = scoreTeam(0, [0, 3, 4, 3], [false, false, false, false], [0, 4, 5, 4], 0);
  assert.equal(r.points, 141);
  // Seat 0 nil takes 2; seat 2 bids 4 takes 3 -> -100, set -40, 2 bags
  r = scoreTeam(0, [0, 3, 4, 3], [false, false, false, false], [2, 4, 3, 4], 0);
  assert.equal(r.points, -100 - 40 + 2);
  assert.equal(r.bagsAdded, 2);
  // Blind nil made: +200
  r = scoreTeam(0, [0, 3, 4, 3], [true, false, false, false], [0, 4, 5, 4], 0);
  assert.equal(r.points, 241);
  // Both partners nil, one fails with 1 trick
  r = scoreTeam(0, [0, 6, 0, 6], [false, false, false, false], [0, 6, 1, 6], 0);
  assert.equal(r.points, 100 - 100 + 1);
});

test('scoring: 10 accumulated bags cost 100 points', () => {
  const r = scoreTeam(0, [3, 2, 3, 2], [false, false, false, false], [5, 1, 4, 3], 7);
  // bid 6, took 9: 60 + 3 bags -> 10 bags total -> -100, bags reset to 0
  assert.equal(r.bagPenalty, 100);
  assert.equal(r.totalBags, 0);
  assert.equal(r.points, 60 + 3 - 100);
});

test('game ends when a team reaches the target; higher score wins; ties continue', () => {
  const s = newGame({ target: 500 }, mulberry32(5));
  s.scores = [510, 480];
  assert.equal(gameWinner(s), 0);
  s.scores = [520, 530];
  assert.equal(gameWinner(s), 1);
  s.scores = [520, 520];
  assert.equal(gameWinner(s), null);
  s.scores = [499, 300];
  assert.equal(gameWinner(s), null);
});

test('finishHand updates scores, bags and history', () => {
  const s = newGame({}, mulberry32(6));
  s.bids = [3, 2, 4, 2];
  s.tricks = [5, 2, 3, 3];
  s.handNo = 1;
  finishHand(s);
  assert.deepEqual(s.scores, [71, 41]);
  assert.deepEqual(s.bags, [1, 1]);
  assert.equal(s.history.length, 1);
  assert.equal(s.phase, 'handEnd');
  nextHand(s, mulberry32(7));
  assert.equal(s.phase, 'bidding');
  assert.equal(s.handNo, 2);
});

test('blind nil only when trailing by 100+', () => {
  const s = newGame({}, mulberry32(8));
  s.scores = [100, 150];
  assert.equal(canBlindNil(s, 0), false);
  s.scores = [100, 200];
  assert.equal(canBlindNil(s, 0), true);
  assert.equal(canBlindNil(s, 1), false);
  s.options.blindNil = false;
  assert.equal(canBlindNil(s, 0), false);
});

test('AI trick estimates: strong hands rate higher than weak hands', () => {
  const strong = ['S14', 'S13', 'S12', 'S5', 'S3', 'H14', 'H13', 'C14', 'C4', 'D14', 'D6', 'D3', 'H2'];
  const weak = ['S2', 'S4', 'H3', 'H5', 'H7', 'C2', 'C6', 'C8', 'D2', 'D4', 'D7', 'D9', 'H9'];
  assert.ok(estimateTricks(strong) >= 7);
  assert.ok(estimateTricks(weak) < 1);
  assert.ok(nilDanger(weak) < 1);
  assert.equal(nilDanger(strong), Infinity);
});

test('AI bids nil on a safe hand and a number on a strong hand', () => {
  const s = newGame({}, mulberry32(9));
  s.dealer = 3;
  startHand(s, mulberry32(10));
  s.hands[0] = ['S2', 'S4', 'H3', 'H5', 'H7', 'C2', 'C6', 'C8', 'D2', 'D4', 'D7', 'D9', 'H9'];
  assert.equal(chooseBid(s, 0), 0);
  s.hands[0] = ['S14', 'S13', 'S12', 'S5', 'S3', 'H14', 'H13', 'C14', 'C4', 'D14', 'D6', 'D3', 'H2'];
  assert.ok(chooseBid(s, 0) >= 7);
});

test('AI nil bidder ducks under the current winner', () => {
  const s = stateWith([['H3', 'H9', 'H12', 'D4'], [], [], []], { trick: [{ seat: 3, card: 'H10' }] });
  s.bids = [0, 3, 3, 3];
  assert.equal(choosePlay(s, 0), 'H9');
});

test('AI takes a trick with the cheapest winner in last seat when it needs tricks', () => {
  const s = stateWith([['H3', 'H11', 'H14', 'D4'], ['H2'], ['H5'], ['H8']], {
    trick: [{ seat: 1, card: 'H6' }, { seat: 2, card: 'H4' }, { seat: 3, card: 'H10' }],
  });
  assert.equal(choosePlay(s, 0), 'H11');
});

test('full AI games complete with legal play and consistent scores', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const { state } = playGame(seed);
    assert.equal(state.phase, 'gameOver');
    const sum = [0, 0];
    for (const h of state.history) for (const t of [0, 1]) sum[t] += h.teams[t].points;
    assert.deepEqual(sum, state.scores);
    assert.ok(Math.max(...state.scores) >= state.options.target);
  }
});

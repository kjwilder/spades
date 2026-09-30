// Browser UI: renders the table and drives the game loop between the human (seat 0)
// and the three computer players.

import {
  newGame, nextHand, applyBid, applyPlay, collectTrick, legalPlays, canBlindNil, currentWinner,
  suitOf, rankOf, rankLabel, cardName, SUIT_SYMBOL, TEAM_NAMES, teamProgress,
} from './engine.js';
import { chooseBid, chooseBlindNil, choosePlay } from './ai.js';

const GAME_KEY = 'spades.game.v1';
const PREFS_KEY = 'spades.prefs.v1';
const SPEEDS = {
  slow: { ai: 1000, trick: 1700 },
  normal: { ai: 600, trick: 1100 },
  fast: { ai: 250, trick: 600 },
};
const DEFAULT_PREFS = { target: 500, blindNil: true, speed: 'normal', autoPlay: false };
const SEAT_LABELS = ['You', 'West', 'North', 'East'];

const $ = (id) => document.getElementById(id);

let prefs = load(PREFS_KEY) || { ...DEFAULT_PREFS };
prefs = { ...DEFAULT_PREFS, ...prefs };
let state = load(GAME_KEY);
if (!state || state.version !== 1) state = freshGame();
let timer = null;
let busy = false; // true while a trick-collect animation runs
let hint = null; // suggested card or bid for the human
let shownTrick = []; // cards already drawn in the trick area (so only new ones animate)

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function load(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function save() {
  try {
    localStorage.setItem(GAME_KEY, JSON.stringify(state));
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable: the game still works, it just won't survive a reload */
  }
}

function freshGame() {
  return newGame({ target: prefs.target, blindNil: prefs.blindNil });
}

// Per-hand UI state lives on the game state so it survives a reload.
function handUi() {
  if (!state.ui || state.ui.handNo !== state.handNo) {
    state.ui = {
      handNo: state.handNo,
      revealed: !(state.phase === 'bidding' && canBlindNil(state, 0)),
      blindIntent: false,
    };
  }
  return state.ui;
}

// ---------------------------------------------------------------------------
// Game loop
// ---------------------------------------------------------------------------

function advance() {
  clearTimeout(timer);
  timer = null;
  hint = null;
  save();
  render();
  const speed = SPEEDS[prefs.speed] || SPEEDS.normal;
  const ui = handUi();

  switch (state.phase) {
    case 'bidding': {
      if (state.bids[0] === null && !ui.revealed) return; // waiting on the blind nil decision
      const seat = state.turn;
      if (seat === 0) {
        if (ui.blindIntent) {
          ui.blindIntent = false;
          applyBid(state, 0, 0, true);
          advance();
        }
        return; // waiting for the bid panel
      }
      timer = setTimeout(() => {
        // North won't also go blind nil once you've committed to it.
        const blind = !(seat === 2 && ui.blindIntent) && chooseBlindNil(state, seat);
        applyBid(state, seat, blind ? 0 : chooseBid(state, seat), blind);
        advance();
      }, speed.ai);
      return;
    }
    case 'playing': {
      const seat = state.turn;
      if (seat === 0) {
        const legal = legalPlays(state, 0);
        if (prefs.autoPlay && legal.length === 1) {
          timer = setTimeout(() => playHuman(legal[0]), Math.min(speed.ai, 500));
        }
        return;
      }
      timer = setTimeout(() => {
        applyPlay(state, seat, choosePlay(state, seat));
        advance();
      }, speed.ai);
      return;
    }
    case 'trickEnd':
      timer = setTimeout(() => {
        busy = true;
        const trickEl = $('trick');
        trickEl.classList.add(`collect-${state.trickWinner}`);
        timer = setTimeout(() => {
          trickEl.className = 'trick';
          busy = false;
          collectTrick(state);
          advance();
        }, 420);
      }, speed.trick);
      return;
    case 'handEnd':
      showHandResults();
      return;
    case 'gameOver':
      showGameOver();
      return;
  }
}

function playHuman(card) {
  if (state.phase !== 'playing' || state.turn !== 0 || busy) return;
  if (!legalPlays(state, 0).includes(card)) return;
  applyPlay(state, 0, card);
  advance();
}

function bidHuman(bid) {
  if (state.phase !== 'bidding' || state.turn !== 0) return;
  applyBid(state, 0, bid);
  advance();
}

function startNewGame() {
  closeAllDialogs();
  state = freshGame();
  shownTrick = [];
  advance();
}

function continueToNextHand() {
  if (state.phase !== 'handEnd') return;
  nextHand(state);
  shownTrick = [];
  advance();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function makeCard(card, tag = 'div') {
  const el = document.createElement(tag);
  const suit = suitOf(card);
  const red = suit === 'H' || suit === 'D';
  el.className = `card${red ? ' red' : ''}`;
  el.dataset.card = card;
  el.setAttribute('aria-label', cardName(card));
  const label = rankLabel(card);
  const sym = SUIT_SYMBOL[suit];
  const corner = (pos) => `<span class="corner ${pos}" aria-hidden="true"><span class="r">${label}</span><span class="s">${sym}</span></span>`;
  const center = rankOf(card) > 10
    ? `<span class="pip face" data-suit="${sym}" aria-hidden="true">${label}</span>`
    : `<span class="pip" aria-hidden="true">${sym}</span>`;
  el.innerHTML = corner('tl') + center + corner('br');
  return el;
}

function render() {
  renderScoreboard();
  renderSeats();
  renderTrick();
  renderPanels();
  renderHand();
  renderStatus();
}

function renderScoreboard() {
  $('target').textContent = `to ${state.options.target}`;
  for (const t of [0, 1]) {
    $(`score-${t}`).textContent = state.scores[t];
    const bags = $(`bags-${t}`);
    bags.textContent = `Bags ${state.bags[t]}`;
    bags.classList.toggle('warn', state.bags[t] >= 7);
    const hand = $(`hand-${t}`);
    const biddingDone = state.bids.every((b) => b !== null);
    if (biddingDone && (state.phase === 'playing' || state.phase === 'trickEnd')) {
      const { contract, taken } = teamProgress(state, t);
      hand.textContent = contract ? `Won ${taken}/${contract}` : 'Nil only';
    } else {
      hand.textContent = '';
    }
  }
}

function renderSeats() {
  for (let seat = 0; seat < 4; seat++) {
    const el = $(`seat-${seat}`);
    const active = (state.phase === 'bidding' || state.phase === 'playing') && state.turn === seat;
    el.classList.toggle('active', active);
    el.querySelector('.dealer-chip').hidden = state.dealer !== seat;

    const bid = state.bids[seat];
    const info = el.querySelector('.seat-info');
    if (bid === null) {
      info.innerHTML = state.phase === 'bidding' && active && seat !== 0 ? 'Bidding…' : '&nbsp;';
    } else if (bid === 0) {
      const failed = state.tricks[seat] > 0;
      const label = state.blind[seat] ? 'Blind nil' : 'Nil';
      info.innerHTML = `<span class="nil${failed ? ' failed' : ''}">${label}</span><span class="sep">·</span><span>Won <b>${state.tricks[seat]}</b></span>`;
    } else {
      info.innerHTML = `<span>Bid <b>${bid}</b></span><span class="sep">·</span><span>Won <b>${state.tricks[seat]}</b></span>`;
    }

    const backs = el.querySelector('.backs');
    if (backs) {
      const n = state.hands[seat].length;
      if (backs.childElementCount !== n) {
        backs.innerHTML = '';
        for (let i = 0; i < n; i++) {
          const b = document.createElement('div');
          b.className = 'back';
          backs.appendChild(b);
        }
        backs.setAttribute('aria-label', `${n} cards`);
      }
    }
  }
}

function renderTrick() {
  const trickEl = $('trick');
  if (!busy) trickEl.className = 'trick';
  const ids = state.trick.map((t) => t.card);
  const winner = state.phase === 'trickEnd' ? currentWinner(state.trick) : null;
  for (let seat = 0; seat < 4; seat++) {
    const slot = trickEl.querySelector(`.slot-${seat}`);
    const entry = state.trick.find((t) => t.seat === seat);
    if (!entry) {
      slot.innerHTML = '';
      continue;
    }
    const existing = slot.firstElementChild;
    if (!existing || existing.dataset.card !== entry.card) {
      slot.innerHTML = '';
      const el = makeCard(entry.card);
      if (!shownTrick.includes(entry.card)) el.classList.add('enter');
      slot.appendChild(el);
    }
    slot.firstElementChild.classList.toggle('win', !!winner && winner.seat === seat);
  }
  shownTrick = ids;
}

function renderPanels() {
  const ui = handUi();
  const blindPending = state.phase === 'bidding' && state.bids[0] === null && !ui.revealed;
  $('blind-panel').hidden = !blindPending;
  if (blindPending) {
    const behind = state.scores[1] - state.scores[0];
    $('blind-text').textContent =
      `Your team is behind by ${behind}. You may bid blind nil before looking at your cards: ` +
      `win no tricks for +200, or lose 200 if you take any.`;
  }

  const bidding = state.phase === 'bidding' && state.turn === 0 && ui.revealed && !ui.blindIntent;
  $('bid-panel').hidden = !bidding;
  if (bidding) {
    const others = [];
    let total = 0;
    for (let i = 0; i < 4; i++) {
      const seat = (state.leader + i) % 4;
      if (seat === 0 || state.bids[seat] === null) continue;
      others.push(`${SEAT_LABELS[seat]} ${state.bids[seat] === 0 ? 'nil' : state.bids[seat]}`);
      total += state.bids[seat];
    }
    $('bid-context').textContent = others.length
      ? `Bids so far: ${others.join(', ')} (total ${total}).`
      : 'You bid first.';
    const grid = $('bid-grid');
    if (!grid.childElementCount) {
      for (let b = 0; b <= 13; b++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = b === 0 ? 'Nil' : String(b);
        btn.dataset.bid = b;
        if (b === 0) btn.className = 'nil';
        btn.addEventListener('click', () => bidHuman(b));
        grid.appendChild(btn);
      }
    }
    for (const btn of grid.children) btn.classList.toggle('suggested', hint !== null && Number(btn.dataset.bid) === hint);
  }
}

function renderHand() {
  const handEl = $('hand');
  const ui = handUi();
  const faceDown = state.phase === 'bidding' && state.bids[0] === null && !ui.revealed;
  const myTurn = state.phase === 'playing' && state.turn === 0 && !busy;
  const legal = myTurn ? legalPlays(state, 0) : [];
  handEl.classList.toggle('my-turn', myTurn);
  handEl.innerHTML = '';
  for (const card of state.hands[0]) {
    const slot = document.createElement('div');
    slot.className = 'hslot';
    if (faceDown) {
      const back = document.createElement('div');
      back.className = 'back back-card';
      slot.appendChild(back);
    } else {
      const el = makeCard(card, 'button');
      el.type = 'button';
      if (myTurn) {
        const ok = legal.includes(card);
        el.classList.add(ok ? 'legal' : 'illegal');
        el.setAttribute('aria-disabled', String(!ok));
        el.addEventListener('click', () => playHuman(card));
      } else {
        el.tabIndex = -1;
      }
      if (hint === card) el.classList.add('hint');
      slot.appendChild(el);
    }
    handEl.appendChild(slot);
  }
  $('btn-hint').disabled = !(myTurn || (state.phase === 'bidding' && state.turn === 0 && ui.revealed));
  $('btn-last').disabled = !state.completedTricks.length;
}

function renderStatus() {
  const ui = handUi();
  let msg = '';
  const name = (s) => SEAT_LABELS[s];
  switch (state.phase) {
    case 'bidding':
      if (state.bids[0] === null && !ui.revealed) msg = 'Decide on blind nil before seeing your cards.';
      else if (state.turn === 0) msg = 'Your turn to bid.';
      else msg = `${name(state.turn)} is bidding…`;
      break;
    case 'playing':
      if (state.turn === 0) {
        if (state.trick.length === 0) {
          msg = state.spadesBroken ? 'Your lead.' : 'Your lead. (Spades not broken yet.)';
        } else {
          const led = suitOf(state.trick[0].card);
          const canFollow = state.hands[0].some((c) => suitOf(c) === led);
          msg = canFollow ? `Your turn: follow ${SUIT_SYMBOL[led]}.` : `Your turn: no ${SUIT_SYMBOL[led]}, play any card.`;
        }
      } else {
        msg = `${name(state.turn)} is playing…`;
      }
      break;
    case 'trickEnd': {
      const w = state.trickWinner;
      msg = w === 0 ? 'You win the trick.' : `${name(w)} wins the trick.`;
      break;
    }
    case 'handEnd':
      msg = 'Hand over.';
      break;
    case 'gameOver':
      msg = state.winner === 0 ? 'You won the game!' : 'West & East won the game.';
      break;
  }
  $('status').textContent = msg;
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function openDialog(id) {
  const d = $(id);
  if (d.open) return;
  d.returnValue = '';
  d.showModal();
}

function closeAllDialogs() {
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
}

const signed = (n) => (n > 0 ? `+${n}` : String(n));
const cls = (n) => (n < 0 ? ' class="neg"' : '');

function bidText(result, seat) {
  const b = result.bids[seat];
  if (b === 0) return result.blind[seat] ? 'Blind nil' : 'Nil';
  return String(b);
}

function resultTable(result) {
  const rows = [0, 1].map((t) => {
    const r = result.teams[t];
    const seats = [t, t + 2];
    const bids = seats.map((s) => `${SEAT_LABELS[s]} ${bidText(result, s)}`).join(', ');
    const won = seats.map((s) => result.tricks[s]).join(' + ');
    const parts = [];
    if (r.contract) parts.push(r.made ? `made ${r.contract}: ${signed(r.contractPoints)}` : `set: ${signed(r.contractPoints)}`);
    for (const n of r.nils) parts.push(`${SEAT_LABELS[n.seat]} ${n.blind ? 'blind nil' : 'nil'} ${n.made ? 'made' : 'failed'}: ${signed(n.points)}`);
    if (r.bagsAdded) parts.push(`${r.bagsAdded} bag${r.bagsAdded > 1 ? 's' : ''}: +${r.bagsAdded}`);
    if (r.bagPenalty) parts.push(`bag penalty: −${r.bagPenalty}`);
    return `<tr>
      <td class="${t ? 'them' : 'us'}">${TEAM_NAMES[t]}<br><small>${bids}</small></td>
      <td>${won}</td>
      <td${cls(r.points)}>${signed(r.points)}</td>
      <td>${result.scores[t]}</td>
    </tr>
    <tr><td colspan="4"><small>${parts.join(' · ') || 'no score'}</small></td></tr>`;
  });
  return `<table class="results">
    <thead><tr><th>Team</th><th>Won</th><th>Hand</th><th>Total</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>
    <p class="note">Bags: You &amp; North ${state.bags[0]}, West &amp; East ${state.bags[1]} (10 bags cost 100 points).</p>`;
}

function showHandResults() {
  const r = state.lastResult;
  $('hand-title').textContent = `Hand ${r.handNo} results`;
  $('hand-body').innerHTML = resultTable(r);
  openDialog('dlg-hand');
}

function showGameOver() {
  const won = state.winner === 0;
  $('over-title').textContent = won ? 'You win!' : 'West & East win';
  $('over-body').innerHTML =
    `<p class="big-result">${state.scores[0]} – ${state.scores[1]}</p>` +
    (state.lastResult ? `<h3>Last hand</h3>${resultTable(state.lastResult)}` : '');
  openDialog('dlg-over');
}

function showScores() {
  const rows = state.history.map((h) => {
    const cells = [0, 1].map((t) => {
      const seats = [t, t + 2];
      const bids = seats.map((s) => bidText(h, s)).join('/');
      const won = seats.map((s) => h.tricks[s]).join('+');
      return `<td>${bids}</td><td>${won}</td><td${cls(h.teams[t].points)}>${signed(h.teams[t].points)}</td><td>${h.scores[t]}</td>`;
    });
    return `<tr><td>${h.handNo}</td>${cells.join('')}</tr>`;
  });
  $('scores-body').innerHTML = state.history.length
    ? `<table class="results">
        <thead>
          <tr><th></th><th colspan="4" class="us">You &amp; North</th><th colspan="4" class="them">West &amp; East</th></tr>
          <tr><th>Hand</th><th>Bids</th><th>Won</th><th>Pts</th><th>Total</th><th>Bids</th><th>Won</th><th>Pts</th><th>Total</th></tr>
        </thead>
        <tbody>${rows.join('')}</tbody></table>
        <p class="note">Bags now: You &amp; North ${state.bags[0]}, West &amp; East ${state.bags[1]}. Playing to ${state.options.target}.</p>`
    : '<p>No hands completed yet.</p>';
  openDialog('dlg-scores');
}

function showLastTrick() {
  const last = state.completedTricks[state.completedTricks.length - 1];
  if (!last) return;
  const body = $('last-body');
  body.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'last-trick';
  for (const { seat, card } of last.cards) {
    const fig = document.createElement('figure');
    if (seat === last.winner) fig.className = 'won';
    fig.appendChild(makeCard(card));
    const cap = document.createElement('figcaption');
    cap.textContent = SEAT_LABELS[seat] + (seat === last.winner ? ' ✓' : '');
    fig.appendChild(cap);
    wrap.appendChild(fig);
  }
  body.appendChild(wrap);
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = `${SEAT_LABELS[last.leader]} led. ${last.winner === 0 ? 'You' : SEAT_LABELS[last.winner]} won.`;
  body.appendChild(note);
  openDialog('dlg-last');
}

function showSettings() {
  const f = $('settings-form');
  f.target.value = String(prefs.target);
  f.blindNil.checked = prefs.blindNil;
  f.speed.value = prefs.speed;
  f.autoPlay.checked = prefs.autoPlay;
  openDialog('dlg-settings');
}

function gameInProgress() {
  return state.phase !== 'gameOver' && (state.handNo > 1 || state.bids.some((b) => b !== null));
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

$('btn-new').addEventListener('click', () => {
  if (gameInProgress()) openDialog('dlg-confirm');
  else startNewGame();
});
$('dlg-confirm').addEventListener('close', () => {
  if ($('dlg-confirm').returnValue === 'ok') startNewGame();
});
$('btn-rules').addEventListener('click', () => openDialog('dlg-rules'));
$('btn-scores').addEventListener('click', showScores);
$('btn-settings').addEventListener('click', showSettings);
$('btn-last').addEventListener('click', showLastTrick);

$('btn-hint').addEventListener('click', () => {
  if (state.phase === 'bidding' && state.turn === 0) hint = chooseBid(state, 0);
  else if (state.phase === 'playing' && state.turn === 0) hint = choosePlay(state, 0);
  render();
});
$('bid-hint').addEventListener('click', () => {
  hint = chooseBid(state, 0);
  render();
});

$('blind-yes').addEventListener('click', () => {
  const ui = handUi();
  ui.revealed = true;
  ui.blindIntent = true;
  advance();
});
$('blind-no').addEventListener('click', () => {
  handUi().revealed = true;
  advance();
});

$('dlg-hand').addEventListener('close', continueToNextHand);
$('dlg-over').addEventListener('close', () => {
  const v = $('dlg-over').returnValue;
  if (v === 'new') startNewGame();
  else if (v === 'scores') showScores();
});

$('settings-form').addEventListener('submit', (e) => {
  const action = e.submitter?.value;
  if (action !== 'save' && action !== 'save-new') return;
  const f = e.target;
  prefs = {
    target: Number(f.target.value),
    blindNil: f.blindNil.checked,
    speed: f.speed.value,
    autoPlay: f.autoPlay.checked,
  };
  save();
  if (action === 'save-new') setTimeout(startNewGame);
  else advance();
});

advance();

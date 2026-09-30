# Spades

Play Spades in your browser: you and a computer partner (North) against two computer opponents (West and East).

**Play at <https://kjwilder.github.io/spades/>**

## Features

- Standard partnership Spades: bidding, nil, blind nil (optional), breaking spades, bags and the 10-bag penalty
- Computer players that bid from hand strength and table position, count cards, cover a partner's nil, attack an opponent's nil, try to set the other team, and avoid bags once their contract is safe
- Hints for bids and plays, last-trick review, and a per-hand score sheet
- Game to 200, 300 or 500 points; adjustable computer speed
- The game is saved in the browser, so a reload picks up where you left off
- Works on phones and desktops; no build step or dependencies

## Rules summary

Each player is dealt 13 cards and bids how many tricks they expect to win; partners' bids add up to the team contract.
Players must follow the suit led if they can; spades are trumps and can't be led until they have been broken.
A made contract scores 10 per trick bid plus 1 per extra trick (bag); a failed contract loses 10 per trick bid.
Nil scores ±100 (blind nil ±200). Every 10 bags costs 100 points. The full rules are in the game's **Rules** dialog.

## Development

The site is plain HTML, CSS and ES modules:

| File | Purpose |
| --- | --- |
| `index.html`, `css/style.css` | Page and layout |
| `js/engine.js` | Rules: dealing, legal plays, trick winners, scoring (no DOM) |
| `js/ai.js` | Computer bidding and card play |
| `js/ui.js` | Rendering and the game loop |

ES modules don't load from `file://`, so serve the folder locally:

```sh
npm start            # python3 -m http.server 8000, then open http://localhost:8000
npm test             # rules, scoring and AI unit tests (Node 18+)
npm run sim -- 500   # play 500 computer-only games and print bidding/nil statistics
node tests/sim.js 300 random   # AI team vs a team playing random legal cards
```

## Deploying

GitHub Pages serves the repository root of the `main` branch (Settings → Pages → Deploy from a branch → `main` / `/ (root)`).

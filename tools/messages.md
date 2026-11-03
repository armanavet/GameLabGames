# Messages the games send to the host page

Every game, archive and start screen talks to the page around it with
`window.parent.postMessage`. This file is the reference for that contract.
Everything listed here was **recorded live** (2026-10-27, with
`tools/events.html`) unless it is marked *from code*.

To see them yourself, serve the repo and open
`tools/events.html?game=<id>` (add `&view=archive` for the archive, `&p=<id>`
for one puzzle). It frames the game the way latimes.com would and logs every
message without following them.

## The envelope

Every message is one flat object:

```json
{ "source": "lat-games", "v": 1, "event": "game_complete", "ts": 1793099690889,
  "puzzleId": "crossword-5", "score": 31, "elapsed": 11 }
```

| field    | meaning |
|----------|---------|
| `source` | always `"lat-games"`; ignore anything else |
| `v`      | contract version, `1` |
| `event`  | one of the five events below |
| `ts`     | `Date.now()` in the game frame |
| …        | the event's own fields, at the top level |

The target origin is `XW.hostOrigin`, which defaults to `"*"`. Nothing in the
repo sets it yet; on latimes.com it should be set to the site's origin (and
the host should check `event.origin` against the asset host).

## Events

### `game_start`
Sent when a player page has loaded its puzzle. Jigsaw sends it only when the
reader presses **Start game**, not on load. A restored (resumed) Jigsaw
sends nothing on load.

| game | fields |
|------|--------|
| Crossword, Midi, Mini | `puzzleId`, `engine: "crossword"` |
| Turnspell | `puzzleId`, `engine: "turnspell"` |
| Gridlock  | `puzzleId`, `engine: "gridlock"` |
| Sudoku, Sudoku X | `puzzleId` (e.g. `sudoku-medium-2026-10-27`) |
| Word Search | `puzzleId` |
| Word Flower | `puzzleId` |
| Jigsaw | `puzzleId`, `pieces` |

### `game_complete`
Sent once, when the puzzle is solved or revealed.

| game | fields |
|------|--------|
| Crossword, Midi, Mini | `puzzleId`, `score`, `elapsed` (seconds) |
| Sudoku, Sudoku X | `puzzleId`, `seconds` |
| Word Search | `puzzleId`, `seconds`, `percent` (words found by the reader), `revealed` |
| Word Flower | `puzzleId`, `seconds`, `score`, `words`, `total`, `revealed` |
| Turnspell | `puzzleId`, `seconds`, `moves` |
| Gridlock *(from code)* | `puzzleId`, `seconds`, `guesses`, `solved` (false = out of guesses) |
| Jigsaw | `puzzleId`, `seconds`, `pieces` |

### `assist_used`
Hints and reveals, but also ordinary progress (see the notes at the end).

| game | `action` values (extra fields) |
|------|----------|
| Crossword, Midi, Mini | `reveal-letter`, `reveal-word`, `reveal-grid`, `check-letter`, `check-word`, `check-grid` (+ `puzzleId`) |
| Sudoku, Sudoku X | `reveal-number`, `reveal-grid`, `check-cell`, `check-grid`; `hint` (+ `stage`) *from code* |
| Word Search | `hint`, `reveal_grid`; `word_found` (+ `word`) *from code* |
| Word Flower | `word_found` (+ `word`, `points`, `pangram`), `shuffle`, `hint`, `hint_letter`, `reveal_grid` |
| Turnspell | `hint`, `word_found` (+ `len`) |
| Gridlock *(from code)* | `guess` (+ `n`, the guess number) |
| Jigsaw | `hint`, `piece_connected` |

A rejected word (Word Flower) sends nothing.

### `share_clicked`
`{ "target": "copy" | "facebook" | "x" | "whatsapp" }`. The menu's Share
submenu sends the target picked; the win screen's Share button always sends
`"copy"`.

### `navigate`
The game never changes the top page itself; it asks the host to. The host
maps these onto its own URLs (`play.html` shows how).

| when | message fields |
|------|----------------|
| menu → More puzzles, win screen → More puzzles | `gameId`, `view: "archive"` (+ `difficulty` for Sudoku) |
| archive row clicked | `gameId`, `view: "puzzle"`, `puzzleId` |
| Sudoku start screen, level picked | `gameId: "sudoku"`, `view: "archive"`, `difficulty` |
| win screen → another game's promo | `gameId` only (open that game's default view) |

Recorded examples:

```json
{"event":"navigate","gameId":"crossword","view":"archive"}
{"event":"navigate","gameId":"sudoku","view":"archive","difficulty":"medium"}
{"event":"navigate","gameId":"crossword","view":"puzzle","puzzleId":"crossword-5"}
{"event":"navigate","gameId":"sudoku","view":"puzzle","puzzleId":"sudoku-hard-2026-10-27"}
{"event":"navigate","gameId":"sudoku-x"}
```

## Not sent

Restart, pause, settings changes, How to play, print, timer show/hide,
Jigsaw's Edges only and reference image, and resuming a saved game send no
message.

## Inconsistencies to settle before handover

1. **No `gameId` except on `navigate`.** Midi and Mini report
   `engine: "crossword"`, so the host can't tell them from the Daily.
2. **`puzzleId` is missing** from `assist_used` (except crossword) and from
   every `share_clicked`.
3. **Time has two names:** crossword sends `elapsed`, every other game sends `seconds`.
4. **Progress counted as assists:** `word_found`, `guess` and
   `piece_connected` are sent as `assist_used`, which inflates any "hints
   used" metric.
5. **`engine`** is on some `game_start` messages and not others.

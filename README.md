# 🃏 Trivia Deck

Trivia with Uno-style chaos. Before every turn a card is drawn — Skip, Reverse, Pass the Bomb, Buzzer Round, Sudden Death and more. Lose all your lives and you're a ghost. Last one standing wins.

- Play with friends on your phones: create a room, share the link on WhatsApp.
- **Party mode:** open the site on a TV/laptop as the big screen; phones become buzzers.
- Questions from the [Open Trivia Database](https://opentdb.com) (CC BY-SA 4.0), with a category picker, plus a built-in Beatles pack.

## How it works
Static site (GitHub Pages) + Firebase Realtime Database for live rooms and anonymous sign-in.
The room creator's browser runs the game (host); other players send moves to `rooms/{code}/inputs`.
Clocks are synced with Firebase's server time, and Buzzer rounds rank each player's own reaction time, so remote players aren't at a disadvantage.

## Setup
1. Firebase project → enable **Authentication → Anonymous** and **Realtime Database**.
2. Paste the web app config into `config.js`.
3. Paste `database.rules.json` into Realtime Database → Rules → Publish.
4. GitHub repo → Settings → Pages → Deploy from branch `main`, folder `/ (root)`.

## Files
- `index.html`, `style.css`, `app.js` — the game
- `packs/beatles.js` — custom question pack
- `config.js` — Firebase config
- `database.rules.json` — security rules

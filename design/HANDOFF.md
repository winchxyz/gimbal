# Gimbal design handoff

For the frontend developer building `web/`. The design is **Stage**: dark, one typeface, colour only for state, no cards, badges or decorative lines.

## Files

| Path | What it is |
|---|---|
| `tokens.css`, `tokens.json` | Colour, type, spacing, radius, motion. Copy `tokens.css` and `fonts/` into `web/` as they are. |
| `fonts/` | Inter 4.1 (variable, weight 400–600, optical size 14–32) and Geist Mono, Latin subsets, SIL OFL 1.1. |
| `screens/desktop/*.html` | Desktop mockups at 1440 px: `desk`, `windows`, `journal`, `onboarding`, `onboarding-rules`, `rescue`, `security`. |
| `screens/phone/*.html` | Phone mockups at 390 px: `desk`, `windows`, `journal`, `onboarding`, `rules`, `rescue`, `security`. |
| `screens/shared/` | `stage.css` (desktop), `phone.css`, `mark.js` (inline wordmark), `data.js` (example data), `states.js` (state switcher). |
| `components.html` | Every component and its states. |
| `png/` | Every screen and state at 1× and 2×. |
| `motion/` | The Welcome screen's gimbal at real speed, desktop and phone (MP4). |
| `brand/` | `wordmark.svg` (Inter Tight outlined, the i's dot is the level bar), `symbol.svg` (the ī), `x/` the X profile banner and avatar, `source/build_wordmark.py` to rebuild the wordmark. |

Open any mockup straight from disk. Add `?state=loading`, `?state=empty`, `?state=error`, `?net=testnet` or `?net=replay` to see the other states. Every number in the mockups is an example. Never ship example data: the real build shows live data only.

## Rules that apply everywhere

- **Fonts.** The stacks are `--font`, `--display` and `--mono`: SF on Apple devices, the bundled Inter and Geist Mono elsewhere. Never fall back to Arial, Segoe or Helvetica. Use `font-variant-numeric: tabular-nums` on every number.
- **Weights.** Use 400 everywhere and 500 only on buttons and the status word. Hierarchy comes from size and colour.
- **Colour means state.**
  - `--level` / `--pos`: level, earning, positive money.
  - `--watch`: watch, veto, unprotected order, rescue in progress.
  - `--danger`: needs you, refused, negative money.
  - Nothing else is coloured.
- **Lines.**
  - A line separates table rows, or it shows data (a chart, the payback bar, the rescue step state).
  - Never draw a line for decoration.
- **Copy.**
  - Use plain sentences written from the owner's side.
  - Every error says three things: what failed, what is still safe, and what to do.
- **Network.** The marker in the header shows Mainnet, Testnet (`--testnet`) or Replay (`--replay`). Then:
  - Testnet swaps Add funds for **Get test USDC**.
  - Replay removes the money buttons and shows **Exit replay** and **Connect wallet**, plus "Recorded on … · plays at 1×" in the status line.
- **Numbers that change.** Flash the new value once (`--dur-fast`, ink to `--ink-2` and back). Never animate counts or move layout.
- **Motion.**
  - Durations come from the tokens.
  - Under `prefers-reduced-motion` they are all 0, and skeleton bars stop pulsing.
- **Header.** On every desktop screen it holds:
  - the wordmark;
  - the five sections, centred;
  - network, desk name, **Withdraw**, and **Add funds** (the only primary button in the header).
- **Phone.**
  - The sections move to a bottom tab bar; the current tab has the 3 px `--level` bar.
  - One column with 16 px gutters.
  - Buttons are 44 px tall.

## Screens

### Desk (`desk.html`)

**Components:** header, status line, desk value (`--t-hero`), payback bar, leg half ×2 (`--t-xl` venue, `--t-num` distance), value rows, net exposure block, latest events, next best window.

**Tokens:** `--t-hero`, `--t-xl`, `--t-num`, `--t-l`, `--t-s`, `--pos`, `--level`, `--watch`, `--danger`, `--line`.

**Behaviour:**
- **Status line.** It is the only element that changes colour for risk. It is driven by the risk engine:

  | State | Colour | Wording | Actions |
  |---|---|---|---|
  | Level | green | "Both legs are safe…" | Auto on, Pause, Close position |
  | Watch | amber | names the leg and its distance | as for Level |
  | Rescuing | amber | as on the Rescue screen | "No action needed" |
  | Needs you | red | — | Add margin, Close both legs |
  | Waiting | grey | no position | — |
  | Paused | grey | "Paused by you", plus when | Resume |

- **Desk value.** Margin on every venue, plus the reserve, plus open P&L. The cents are drawn in `--ink-2` at half size.
- **"+$X a day".** Today's funding rate × notional, net of the amortised costs.
- **Payback bar.** Funding received ÷ (entry fees + basis) for the held window. When it reaches 100% the bar is replaced by "Entry costs earned back".
- **Distance to liquidation.** Recomputed on every mark price. The sentence under it names the price move: "DOGE has to rise 32.6% to 0.2631".
- **Net exposure.** In normal running this is 0. If it drifts by more than one lot, show it in `--watch` and add "The desk is rebalancing".
- **Latest events.** The three most recent Journal events. An unprotected order keeps its amber line until it scrolls out.
- **Next best window.** The best allowed window that isn't held, plus the rotation rule.

**States:**

| State | What shows |
|---|---|
| Loading | Labels visible, figures as placeholders |
| Empty (no position) | Waiting status, the desk value, best window now vs your minimum, "See all windows" |
| Error | Status line in red names the exchange. That leg's half dims and shows "Last data 2 min ago · retrying every 5 s". Close both legs stays available. |

### Windows (`windows.html`)

**Components:** list header (tabs, live marker), window row, minimum rule, detail stage (asset, net APR at `--t-display`), 7-day chart, gross-to-net bars and legend, checks, decision line.

**Behaviour:**
- **Sorting.** The list is sorted by net APR. Rows re-sort as data arrives; animate the move over `--dur`, and never move the selected row out from under the pointer.
- **Status word** on the row: Held (green), Veto · reason (amber), Refused · reason (red). Rows under the owner's minimum sit below the "Your minimum" rule at 40% opacity.
- **Watch-only tab.** Gross only, plus "—" for net and the word Watch-only.
- **Keyboard.** ↑ and ↓ move the selection, and the detail follows.
- **Chart.**
  - Hourly net APR over 7 days: the selected window is drawn in `--ink` at 2 px, the held window in `--ink-2` at 1.5 px.
  - The minimum is a dashed `--ink-2` line, with grid lines in `--line` and labels at 0/5/10/15/20%.
  - The last point is a dot.
- **"≈ $X a day on $Y legs"** uses the policy leg size.
- **Decision line.** Says what auto will do and why, and the cost to switch. **Rotate to …** is a manual override and asks for confirmation inside the page. **Alert me if it passes …** creates a local alert.
- **When the selected window is the held one,** the decision line becomes "Held since … · Close position".

**States:**

| State | What shows |
|---|---|
| Loading | Placeholders |
| Empty | "Nothing clears your 5% right now", plus the best allowed window and a link to show rows below the minimum |
| Error | Amber line under the list header naming the venues that didn't answer. Rows that depend on them are dimmed and use data from the last good read. |

### Journal (`journal.html`)

**Components:** headline with the signed-actions count, filters with counts, day header with total, event row, rescue steps inline, side column (net since start, attribution, counts, contract link), Export CSV.

**Behaviour:**
- Every row is a NEP-297 event from the contract. The proof links are the NEAR transaction plus the venue transaction where one exists (Hyperliquid, Solscan); they open the explorer in a new tab.
- **Kind colours:** Rescue and Veto amber, Refused red, Open and Rotate in ink, everything else grey.
- **Amounts:** positive in `--pos`; withdrawals are shown as a negative amount but not in red.
- **Why lines:**
  - NEAR AI's reason for opens, rotations and vetoes;
  - the policy rule for refusals;
  - an amber line for unprotected orders.
- **Day totals** are P&L only; transfers of principal are excluded.
- **Live updates.** New events arrive at the top without moving the reader. If they have scrolled down, show "2 new events" at the top instead.
- **Export CSV** exports the current filter.

**States:**

| State | What shows |
|---|---|
| Empty | "Nothing here yet", Add funds, Watch a replay |
| Error | "Can't load the journal": what timed out, and that the desk is unaffected |

### Onboarding (`onboarding.html`, `onboarding-rules.html`)

**Components:** welcome headline, two large buttons, three facts, step strip; then the step rail, words box, policy rule list, signing bar.

**Behaviour:**
- **Welcome.** **Connect NEAR wallet** uses near-connect. **Watch a replay first** opens the app in replay mode with no wallet. The second fact shows the live best allowed window.
- **The gimbal behind the Welcome copy** is the hero visual. Its look is **Phosphor**.
  - **What it shows:** a working three-axis gimbal. The market rocks the outer ring. The middle and inner rings turn on their axles (X, then Y, then Z) by exactly the angles that cancel it, solved each frame from A · Rx(a) · Ry(b) · Rz(c) = I, so the platform stays level to rounding error. The rings leave a cooling afterglow. The platform is a green puck with an edge, two engraved level rings and a glossy bubble that sits dead centre; it never moves, so it stays sharp. The caption under the buttons says what it means.
  - **Placement:**
    - Desktop: a transparent canvas filling the screen under the header, centred at 72% / 50%, outer radius 42% of the canvas height.
    - Phone: centred at 60% / 25%, radius 23%.
  - **Calls:**
    - Mount: `GimbalFX.mount(canvas, { look: 'phosphor', cx, cy, size, quiet: [copy, facts] })`. It resolves `false` when WebGL2 is missing.
    - Fallback: when it resolves `false`, mount the 2D version `GimbalAscii.mount(canvas, sameOptions)` from `screens/shared/gimbal.js` and add the class `fallback`, which gives it a CSS glow.
    - The field fades to about 10% behind each `quiet` element so text always wins; re-measure on resize.
  - **How it is drawn** (`screens/shared/gimbal-fx.js`, WebGL2, no dependencies), three passes:
    1. **Scene:** ray-marches the three rings and the platform as distance fields, with a key light, highlight, rim and ambient occlusion; 2 × 2 rays per 6 × 11 px cell.
    2. **Blend:** the live ring eases toward its new value (65% a frame); the afterglow takes at most 45% of the ring's light and loses 7% a frame.
    3. **ASCII:** a glyph atlas set in Geist Mono turns each cell into a character, with a soft halo from the linearly filtered cell field.
  - **Look (printable ASCII only):**
    - Live ring: the ramp `. : * + c o a # 8 @`, chosen by measured ink in Geist Mono so each step adds about the same amount (from 2.6% to 36% of the cell), in `--ink`.
    - Afterglow: only `.` and `:`, cooling from ink to a steel blue as it fades.
    - The platform uses the same ramp in `--level`. Its light does the work: a sheen from the light's side, a lit edge, darker engraved rings, and the bubble in `8` and `@`.
    - Never use `-`, `_`, `=`, `|` or `~` in a fill: they line up into stripes. Use no Unicode symbols such as `·` or `•`.
  - **Performance:**
    - Full frame rate on the GPU.
    - Pauses when the tab is hidden or the canvas leaves the viewport (IntersectionObserver).
    - Draws one still frame under `prefers-reduced-motion`.
  - **Accessibility:** the canvas is `aria-hidden`; the caption carries the meaning.
  - **Video:** `motion/welcome-desktop.mp4` and `motion/welcome-phone.mp4` show it at real speed.
- **Steps:**
  1. Connect a wallet.
  2. Create the desk. The contract call returns the derived accounts, which are listed in the rail.
  3. Deposit USDC from any chain through NEAR Intents. Show the split per venue and the reserve before the owner confirms.
  4. Rules.
  5. Sign.
- **Done steps** in the rail summarise what happened, with amounts.
- **Rules step:**
  - NEAR AI drafts the policy from the owner's words.
  - Each rule shows its source phrase. Anything the model added on its own is amber and begins "Added by NEAR AI".
  - The owner can edit any rule as numbers.
  - **Sign policy** opens the wallet. The bar shows the expected cost and says that every later change needs a new signature.

**States:**

| Screen | State | What shows |
|---|---|---|
| Welcome | Loading | "Waiting for your wallet to confirm…" |
| Welcome | Error | "No NEAR wallet answered", Try again, Watch a replay instead |
| Rules | Empty | Example sentence as the placeholder; the policy column explains what will appear; buttons disabled |
| Rules | Loading | "NEAR AI is drafting your policy…" with placeholder rows |
| Rules | Error | "NEAR AI didn't answer in 10 s", Try again, Set numbers myself |

### Security (`security.html`)

**Components:**
- the zero headline (`--t-hero` at 160 px, `--level`);
- the numbered signing steps, with step 3 in `--level`;
- three columns: Your policy, The operator can / cannot, Only you can;
- the accounts table;
- What you still trust, and Checked so far.

**Behaviour:**
- **Read from the contract on load.** This means the policy, its signer and date, and the derived addresses for each path, each with an explorer link.
- **Checked so far.** Lists real refused transactions; each "refused ↗" links to one.
- **Change policy** goes through the same rules editor as onboarding and needs a new signature.

**States:**

| State | What shows |
|---|---|
| Empty | No desk: "Create a desk" |
| Error | "Can't read the contract" |
| Loading | Placeholders |

### Rescue (`rescue.html`)

**Components:** status line (rescuing / needs you), timer (`--t-hero`), amount moving, distance after, seven step columns (done / now / fail / todo), before-and-after table, earlier rescues, stress test.

**Behaviour:**
- **Timer.** Counts up from detection, once a second. "Usually done in X s" is the median of past rescues.
- **Steps.** The seven steps are detect → source → quote → verify → sign → deposit → landed.
  - A step's top border and time show its state.
  - Done steps show the measured time with a tick.
  - The running step counts up in `--watch` against its usual time.
  - A failed step turns `--danger` and says why and how many tries were made.
- **Source.** The source step says where the money came from and why: reserve first, then the other leg's free margin. Never a Pacifica withdrawal.
- **Before-and-after table** shows margin, liquidation price, distance and net exposure. Net exposure must read 0 in both columns.
- **On failure:**
  - the status line becomes **Needs you** in red, with Add margin and Close both legs;
  - the hero shows what the desk tries next.
- **Stress test.**
  - **Testnet:** the button pushes one leg past the rescue line. The Intents step plays back a recorded mainnet run, marked as replay.
  - **Mainnet:** the button is disabled and says why.
- **Video.** This screen is shot 5 of the demo video. The real timer stays on screen.

**States:**

| State | What shows |
|---|---|
| Empty (idle) | "Standing by", both distances, reserve ready |
| Error | Rescue stopped at a step |
| Loading | Placeholders |

## Breakpoints

- **Desktop:** designed at 1440 px, and must read at 1920 × 1080 for the video. Keep the 64 px gutters; extra width goes to the space between the two halves.
- **Phone:** designed at 390 px. Between 390 and 1024 px, use the phone layout with a centred column up to 640 px wide.

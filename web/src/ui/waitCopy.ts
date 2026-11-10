// Plain-English copy for the strategy loop's wait reasons. The engine words a reason for its own log, with ids, venue
// internals and the hands' wording (engine/src/strategy/decide.ts: flatStatus, gate, sizeFor, decideFlat; loop.ts:
// journalOff; cli/serve-loop.ts: windowSymbol). The Journal and the Desk banner show this instead; the engine's
// string is never changed and stays available (`raw`), and a string that matches nothing here is shown as sent.
// Pure, so every sentence is tested.
import { venueName } from '../windows/format.ts';

export interface WaitCopy {
  /** What to show. */
  text: string;
  /** The engine's string, as sent. */
  raw: string;
  /** False when nothing here knew the string and `text` is `raw`. A known frame around an unknown gate is true. */
  mapped: boolean;
}

export interface WaitContext {
  /** The owner's minimum net APR, when the page knows it (StrategyConfig, or `numbers.minNetAprPct` on a wait entry). */
  minNetAprPct?: number | null;
}

const NUM = String.raw`-?\d+(?:\.\d+)?`;
const PCT = String.raw`${NUM} %`;
const MONEY = String.raw`-?\$[\d,.]+[kM]?`;

/** `5` -> `5 %`, `7.5` -> `7.5 %`: the engine's `minimum`. */
const minimumText = (n: number): string => `${Number.isInteger(n) ? n : n.toFixed(1)} %`;

const hoursWord = (n: string): string => (Number(n) === 1 ? 'hour' : 'hours');

/** What the loop does after the pair trader refuses an open for cost (loop.ts: costRefused, until the next hourly check). */
const RETRY = 'the desk tries it again after the next hourly check, from zero';

/** The trader's cost refusal (trade/carry-plan.ts: CarryPlan.costRefusal), as a clause that follows "but". */
function costReason(cost: string): string {
  let m: RegExpMatchArray | null;
  if ((m = cost.match(new RegExp(`^the expected spread over (\\d+(?:\\.\\d+)?) days, (${MONEY}), does not cover the round trip (${MONEY})`)))) {
    return `its carry does not cover the cost of opening and closing it (${m[2]} expected over ${m[1]} days, against ${m[3]})`;
  }
  if ((m = cost.match(/^the (\S+) book (?:has no two-sided touch|fills only .*): the round trip cannot be priced$/s))) {
    return `the ${venueName(m[1]!)} book is too thin to price opening and closing it`;
  }
  return 'the pair trader would not open it for cost this hour';
}

/** `long Orderly / short Hyperliquid` */
const legsText = (long: string, short: string): string => `long ${venueName(long)} / short ${venueName(short)}`;

/** The engine's "; ID is long X, short Y" tail on a hands refusal: two capture groups, the venue ids. */
const LEGS = String.raw`; \S+ is long (\S+), short (\S+)`;

/**
 * The hands' refusal of a window's pair (serve-loop.ts: windowSymbol), as a clause that does not start with "but":
 * the direction rule (GIMBAL_ORDERLY_PAIRS off: only short Hyperliquid / long Phoenix), the venue rule (on: any two of
 * Hyperliquid, Orderly and Phoenix) and the policy's markets. Null for any other text.
 */
function handsClause(text: string): string | null {
  let m: RegExpMatchArray | null;
  const only = legsText('phoenix', 'hyperliquid');
  if ((m = text.match(new RegExp(`^serve opens short hyperliquid, long phoenix only[^;]*(?:${LEGS})?$`, 's')))) {
    // Only an engine with Orderly pairs off says this, so "switched off" is true whenever it is shown.
    if (m[1] === undefined || m[2] === undefined) return `the desk can't open it (this engine opens only ${only} pairs)`;
    const orderly = m[1] === 'orderly' || m[2] === 'orderly';
    return `the desk can't open it (it is ${legsText(m[1], m[2])}, and this engine opens only ${only}${orderly ? ' because Orderly pairs are switched off' : ''})`;
  }
  if ((m = text.match(new RegExp(`^serve opens a pair on two of ([^;]+)(?:${LEGS})?$`, 's')))) {
    const names = m[1]!.split(',').map((v) => venueName(v.trim()));
    const where = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
    const tail = m[2] === undefined || m[3] === undefined ? '' : ` (this one is ${legsText(m[2], m[3])})`;
    return `the desk opens a pair only on two of ${where}${tail}`;
  }
  if ((m = text.match(/^(.+?) is not a market both legs(?: \(long (\S+), short (\S+)\))? list in the desk's policy/))) {
    return m[2] === undefined || m[3] === undefined
      ? `${m[1]} is not one of the markets in your policy`
      : `${m[1]} is not in your policy on both ${venueName(m[2])} and ${venueName(m[3])}`;
  }
  return null;
}

/** The rest of a sentence about a window that fails a rule, in the engine's gate order (decide.ts: gate). */
function gateClause(text: string): string | null {
  let m: RegExpMatchArray | null;
  const hands = handsClause(text);
  if (hands !== null) return `but ${hands}`;
  if ((m = text.match(/^the pair trader refused it for cost this hour: (.+)$/s))) return `but ${costReason(m[1]!)}; ${RETRY}`;
  if (text === 'watch only') return 'but it is watch-only, so the desk will not trade it';
  if ((m = text.match(/^refused by the NEAR AI risk check.*, held out for (\d+(?:\.\d+)?) h more$/s))) {
    return `but the NEAR AI risk check refused it, so it is held out for ${m[1]} h more`;
  }
  if (text.startsWith('refused by the NEAR AI risk check')) return 'but the NEAR AI risk check refused it';
  if ((m = text.match(/^refused \S+: (.+)$/s))) return `but it is refused: ${m[1]}`;
  if (text === 'its numbers are stale') return 'but its numbers are out of date';
  if ((m = text.match(new RegExp(`^this hour pays (${PCT}): it does not agree`)))) {
    return `but this hour pays ${m[1]}, against its multi-day trend`;
  }
  if (text === 'no 7-day spread yet') return 'but it has no 7-day spread yet';
  if ((m = text.match(new RegExp(`^the (7|14)-day spread is (${PCT})$`)))) return `but its ${m[1]}-day spread is ${m[2]}`;
  if ((m = text.match(new RegExp(`^capacity (${MONEY}), under the (${MONEY}) a (${MONEY}) leg needs`)))) {
    return `but its market is too thin for a ${m[3]} leg (capacity ${m[1]})`;
  }
  // The margin refusal: a venue's free margin cannot open the minimum leg, and the loop never moves margin to open.
  if ((m = text.match(new RegExp(`^(${MONEY}) free margin on (.+?) at \\S+ opens .* under the ${MONEY} minimum`)))) {
    return `but ${m[2]} has only ${m[1]} free margin, too little to open a leg, and the desk does not move margin to open`;
  }
  // The scanner's cost checks (carry.ts: carryChecks).
  if ((m = text.match(new RegExp(`but it nets only (${PCT}) APR over the hold, under your (${PCT}) minimum`)))) {
    return `but after costs it nets only ${m[1]} over a typical hold, under your ${m[2]} minimum`;
  }
  if ((m = text.match(new RegExp(`no more than the (${MONEY}) round trip.*: (it never pays it back|it takes (${NUM}) days to pay it back)$`, 's')))) {
    return `but its carry does not cover the ${m[1]} cost of opening and closing it (${m[3] === undefined ? 'it never pays it back' : `${m[3]} days to pay it back`})`;
  }
  if (text.startsWith('No 7-day funding history')) return 'but there is no 7-day funding history on both legs yet';
  if (text.startsWith('14-day history loading')) return 'but its 14-day history is still loading';
  if (/point opposite ways/.test(text)) return 'but its 7-day and 14-day spreads point opposite ways';
  return null;
}

/** The size refusal after "X % net is ready, but" (decide.ts: sizeFor). */
function sizeClause(why: string): string | null {
  let m: RegExpMatchArray | null;
  if ((m = why.match(new RegExp(`^(${MONEY}) free margin on (.+?) at \\S+ (?:leaves nothing to open|sizes a leg)`)))) {
    return `${m[2]} has only ${m[1]} free margin, too little to open a leg`;
  }
  if (/^no lot sizes for|lots cannot be combined|has a lot of zero/.test(why)) return 'its lot sizes are not known yet, so it cannot be sized';
  if (/of depth on the smaller leg/.test(why)) return 'its market is too thin for the leg size';
  if (/under one common lot|in whole lots, under the/.test(why)) return 'a leg in whole lots would be under the minimum size';
  return null;
}

/** The two refusals the loop keeps after a gate text: the NEAR AI veto of another window (decide.ts: flatStatus). */
function vetoTail(text: string): { body: string; tail: string } {
  const m = text.match(/^(.*?); (\S+) refused by the NEAR AI risk check.*, held out for (\d+(?:\.\d+)?) h more$/s);
  if (!m) return { body: text, tail: '' };
  return { body: m[1]!, tail: ` ${m[2]} was refused by the NEAR AI risk check and is held out for ${m[3]} h more.` };
}

interface Part { text: string; mapped: boolean }

/** What the desk says when it is flat and not entering: the flat-status line, capitalised or not. */
function flat(line: string, ctx: WaitContext): Part | null {
  let m: RegExpMatchArray | null;
  if (/^no desk window in this scan$/i.test(line)) {
    return { text: 'None of the markets in the last scan is one the desk can trade.', mapped: true };
  }

  if ((m = line.match(new RegExp(`^no window clears the entry rules; best (\\S+) (${PCT}) net: (.+)$`, 'is')))) {
    const [, symbol, net, rest] = m as unknown as [string, string, string, string];
    const { body, tail } = vetoTail(rest);
    const minimum = body.match(new RegExp(`^${PCT} net, under your (${PCT}) minimum$`));
    if (minimum) return { text: `No market pays your ${minimum[1]} minimum right now. Closest: ${symbol}, ${net} net.${tail}`, mapped: true };
    const head = ctx.minNetAprPct != null && Number.isFinite(ctx.minNetAprPct)
      ? `No market pays your ${minimumText(ctx.minNetAprPct)} minimum right now.`
      : 'No market passes your entry rules right now.';
    const clause = gateClause(body);
    return clause === null
      ? { text: `${head} Closest: ${symbol}, ${net} net: ${body}.${tail}`, mapped: false }
      : { text: `${head} Closest: ${symbol}, ${net} net, ${clause}.${tail}`, mapped: true };
  }

  // A window that passes the rules, counting the hours it has to hold them.
  if ((m = line.match(new RegExp(`^(\\S+) (${PCT}) net, (\\d+) of (\\d+) hours above (${PCT})(.*)$`, 's')))) {
    const [, symbol, net, n, need, min, rest] = m as unknown as [string, string, string, string, string, string, string];
    const veto = rest.match(/; (\S+) refused by the NEAR AI risk check.*, held out for (\d+(?:\.\d+)?) h more$/s);
    const tail = veto ? ` ${veto[1]} was refused by the NEAR AI risk check and is held out for ${veto[2]} h more.` : '';
    return {
      text: `${symbol} clears your ${min} minimum at ${net} net. The desk opens it after ${need} ${hoursWord(need)} in a row: ${n} so far.${tail}`,
      mapped: true,
    };
  }
  return null;
}

/** A rotation note on a hold line (decide.ts: rotationFor), as a sentence; null when nothing knows it. */
function rotationNote(note: string): string | null {
  let m: RegExpMatchArray | null;
  if (note === 'your rotation rule is not a number: no rotation') return 'Your rotation rule is not a number, so the desk will not rotate.';
  if ((m = note.match(new RegExp(`^(\\S+) beats it by (${NUM}) pts, (\\d+) of (\\d+) hours$`)))) {
    return `${m[1]} beats it by ${m[2]} points: ${m[3]} of ${m[4]} hours toward a rotation.`;
  }
  if ((m = note.match(new RegExp(`^(\\S+) beats it by (${NUM}) pts, but (\\d+) rotations in 24 h is the most$`)))) {
    return `${m[1]} beats it by ${m[2]} points, but ${m[3]} rotations in 24 hours is the most the desk makes.`;
  }
  if ((m = note.match(new RegExp(`^(\\S+) beats it by (${NUM}) pts, but its switch cost is not known$`)))) {
    return `${m[1]} beats it by ${m[2]} points, but its switch cost is not known.`;
  }
  if ((m = note.match(new RegExp(`^(\\S+) beats it by (${NUM}) pts, but the (${MONEY}) switch takes (${NUM}) days to pay back, (${NUM}) are left$`)))) {
    return `${m[1]} beats it by ${m[2]} points, but switching costs ${m[3]} and takes ${m[4]} days to pay back, with ${m[5]} left.`;
  }
  if ((m = note.match(new RegExp(`^(\\S+) beats it by (${NUM}) pts, but (.+)$`, 's')))) {
    const clause = sizeClause(m[3]!);
    return clause === null ? null : `${m[1]} beats it by ${m[2]} points, but ${clause}.`;
  }
  return null;
}

/** `Hold SYM: <status>; day D of M[; <rotation note>]` (decide.ts: decideHeld). */
function hold(raw: string): Part | null {
  const m = raw.match(/^Hold (\S+): (.+?); day (\d+) of (\d+)(?:; (.+))?$/s);
  if (!m) return null;
  const [, symbol, status, day, max, note] = m as unknown as [string, string, string, string, string, string | undefined];
  const days = `Day ${day} of ${max}.`;
  let head: string | null = null;
  let s: RegExpMatchArray | null;
  if (status === 'its window is not in this scan, so nothing is decided on it') {
    head = `Holding ${symbol}: its market is not in this scan, so the desk decides nothing on it for now.`;
  } else if (status === 'its numbers are stale this scan, so nothing is decided on them') {
    head = `Holding ${symbol}: its numbers are out of date this scan, so the desk decides nothing on it for now.`;
  } else if ((s = status.match(new RegExp(`^(${PCT}) net of the exit, at least your (${PCT}) minimum$`)))) {
    head = `Holding ${symbol}: it nets ${s[1]} after the exit, at least your ${s[2]} minimum.`;
  } else if ((s = status.match(new RegExp(`^(${PCT}) net of the exit, under your (${PCT}) minimum, (\\d+) of (\\d+) hours? before exit$`)))) {
    head = `Holding ${symbol}: it nets ${s[1]} after the exit, under your ${s[2]} minimum (${s[3]} of ${s[4]} ${hoursWord(s[4]!)} before the desk exits).`;
  } else if ((s = status.match(new RegExp(`^the spread flipped: (this hour pays ${PCT}|the (?:7|14)-day spread is ${PCT}), (\\d+) of (\\d+) hours? before exit$`)))) {
    head = `Holding ${symbol}: the spread has flipped, as ${s[1]} (${s[2]} of ${s[3]} ${hoursWord(s[3]!)} before the desk exits).`;
  }
  if (head === null) return null;
  if (note === undefined) return { text: `${head} ${days}`, mapped: true };
  const noted = rotationNote(note);
  return { text: `${head} ${days} ${noted ?? note}`, mapped: noted !== null };
}

/**
 * The refusal of a rotation out of a pair with an Orderly leg (serve-pair.ts: rotateOutRefused), found anywhere in
 * `reason`, as sentences; null for any other text. The engine only says it with GIMBAL_ORDERLY_PAIRS=1.
 */
export function orderlyRotateReason(reason: string): string | null {
  const m = reason.match(/the held (\S+) pair has an Orderly leg \([^)]*\): its close arms the trader's replay watch/);
  if (!m) return null;
  return `The held ${m[1]} pair has an Orderly leg. Orderly takes a signed copy of an order for up to 5 minutes, so closing the leg blocks every new open for that long, and a rotation would leave the desk flat. The pair exits on its own rules instead.`;
}

/**
 * The loop's journal line for an enter or rotate the NEAR AI risk check held because no readable answer came (loop.ts,
 * journaled `refused`; the check fails closed): `enter ID not carried out: [(owner demo entry …) ]<why>: held, not
 * passed: the act waits; nothing sent; <when>; not a refusal, so no 6 h hold-out`, and `rotate A -> B not carried
 * out: …; A is kept, nothing closed; <when>; …`. `<when>` is `asked again at the next hourly check (<ISO>)` (auto) or
 * `not tried again by itself: POST /rotate asks again` (by hand). Null for any other text.
 */
export function riskHeldCopy(raw: string): WaitCopy | null {
  const m = raw.match(/^(?:enter (\S+)|rotate (\S+) -> (\S+)) not carried out: (?:\([^)]*\) )?(.*?): held, not passed: the act waits; (?:nothing sent|\S+ is kept, nothing closed); (asked again at the next hourly check \(\d{4}-\d\d-\d\dT(\d\d:\d\d)[^)]*\)|not tried again by itself: POST \/rotate asks again); not a refusal, so no (\d+) h hold-out$/s);
  if (!m) return null;
  const [, enterId, fromId, toId, why, , time, hours] = m as unknown as [string, string | undefined, string | undefined, string | undefined, string, string, string | undefined, string];
  const head = enterId !== undefined ? `Opening ${enterId} is waiting` : `Rotation from ${fromId} into ${toId} is waiting`;
  // A key that is missing or rejected: "... cannot answer. Nothing was sent." (one "so" per sentence).
  const reason = why.startsWith('no NEAR AI key')
    ? 'this engine has no NEAR AI key, so the NEAR AI risk check cannot answer. Nothing was sent.'
    : why.startsWith('NEAR AI key rejected')
      ? 'NEAR AI rejected this engine\'s key, so the NEAR AI risk check cannot answer. Nothing was sent.'
      : 'the NEAR AI risk check did not answer, so nothing was sent.';
  const kept = fromId === undefined ? '' : ` ${fromId} is kept.`;
  const when = time === undefined
    ? 'It is not tried again by itself: ask again with POST /rotate.'
    : `The desk asks again at the next hourly check (${time} UTC).`;
  return {
    text: `${head}: ${reason}${kept} ${when} This is not a refusal, so the market is not held out for ${hours} h.`,
    raw, mapped: true,
  };
}

/**
 * The loop's journal line for a window it did not carry out before the NEAR AI risk check (loop.ts, journaled `refused`):
 * `enter|rotate ID not carried out: <hands' refusal>; NEAR AI risk check: not asked (refused before it)`, and
 * `rotate A -> B not carried out: <reason>; A is kept, nothing closed; <risk check>`. Null for any other text.
 */
function notCarriedOutCopy(raw: string): WaitCopy | null {
  let m: RegExpMatchArray | null;
  const held = riskHeldCopy(raw);
  if (held !== null) return held;
  if ((m = raw.match(/^rotate (\S+) -> (\S+) not carried out: (.*?); \1 is kept, nothing closed(?:; (.*))?$/s))) {
    const why = orderlyRotateReason(m[3]!);
    if (why === null) return null;
    const asked = m[4] !== undefined && /^NEAR AI risk check: not asked/.test(m[4]) ? ', and the NEAR AI risk check was not asked' : '';
    return { text: `Rotation from ${m[1]} into ${m[2]} was refused. ${why} Nothing was closed${asked}.`, raw, mapped: true };
  }
  if ((m = raw.match(/^(enter|rotate) (\S+) not carried out: (.*); NEAR AI risk check: not asked \(refused before it\)$/s))) {
    const what = m[1] === 'rotate' ? 'Rotation into' : 'Opening';
    const why = m[3] === 'the window is not in the last scan' ? 'it is not in the last scan' : handsClause(m[3]!);
    if (why === null) return null;
    return { text: `${what} ${m[2]} was refused: ${why}. The NEAR AI risk check was not asked.`, raw, mapped: true };
  }
  return null;
}

/**
 * The loop's lines about a pair with one leg open (loop.ts: closeOneLeg), which it closes reduce-only on every check:
 * `one leg open: orderly 1.5: closing it, reduce-only[; the last close failed, next try at <ISO>]`,
 * `...: not closed this check, <gate>` and `...: the close did not end flat: <why>; tried again in <wait>`
 * ("tried again" is the wait before the next try). Null for any other text.
 */
export function oneLegCopy(reason: string): WaitCopy | null {
  const raw = reason.trim();
  const m = raw.match(/^one leg open: (\S+) (\S+): (.*)$/s);
  if (!m) return null;
  const head = `Only one leg is open: ${m[2]} on ${venueName(m[1]!)}.`;
  const rest = m[3]!;
  let r: RegExpMatchArray | null;
  if (rest === 'closing it, reduce-only') return { text: `${head} The desk is closing it with a reduce-only order.`, raw, mapped: true };
  if ((r = rest.match(/^closing it, reduce-only; the last close failed, next try at (\d{4}-\d\d-\d\dT(\d\d:\d\d)\S*)$/))) {
    return { text: `${head} The last close failed, so the desk tries again at ${r[2]} UTC.`, raw, mapped: true };
  }
  if ((r = rest.match(/^not closed this check, (.+)$/s))) return { text: `${head} It was not closed this check: ${r[1]}.`, raw, mapped: true };
  if ((r = rest.match(/^the close did not end flat: (.*); tried again in ([^;]+)$/s))) {
    return { text: `${head} The close did not finish: ${r[1]}. The desk tries again in ${r[2]}.`, raw, mapped: true };
  }
  return null;
}

/**
 * The loop's journal line for an open the pair trader refused for cost (loop.ts, journaled `refused`):
 * `enter ID: open refused, nothing signed: <why>[; X was closed, so the desk stays flat]; ID is held out of the entry
 * rules until the hourly check at <ISO> and its hours start again; <risk check>`. Null for any other refusal.
 */
export function refusedCopy(reason: string): WaitCopy | null {
  const raw = reason.trim();
  const early = notCarriedOutCopy(raw);
  if (early !== null) return early;
  const m =raw.match(/^(enter|rotate) (\S+): (.*?); \2 is held out of the entry rules until the hourly check at (\d{4}-\d\d-\d\dT(\d\d:\d\d)[^ ;]*) and its hours start again(?:;|$)/s);
  if (!m) return null;
  const [, kind, id, inner, , time] = m as unknown as [string, string, string, string, string, string];
  const cost = inner.match(/the expected spread over .*? does not cover the round trip \$?[^;]*|the \S+ book (?:has no two-sided touch|fills only [^;]*)[^;]*round trip cannot be priced/s);
  const why = cost === null ? 'the pair trader refused to open it for cost' : costReason(cost[0]);
  const flatNote = /was closed, so the desk stays flat/.test(inner) ? ' The old pair was closed, so the desk is flat.' : '';
  const text = `${kind === 'rotate' ? 'Rotation into' : 'Opening'} ${id} was refused: ${why}. `
    + `It is out of the entry rules until the hourly check at ${time} UTC, and its hours start again from zero.${flatNote}`;
  return { text, raw, mapped: true };
}

/** `Cooling down after the exit, 3.2 h left; <flat line>` and the other whole-sentence shapes. */
function whole(raw: string, ctx: WaitContext): Part | null {
  let m: RegExpMatchArray | null;
  if ((m = raw.match(/^Cooling down after the exit, (\d+(?:\.\d+)?) h left; (.+)$/s))) {
    const inner = flat(m[2]!, ctx);
    if (inner === null) return null;
    return { text: `Cooling down after the last exit, ${m[1]} h left. ${inner.text}`, mapped: inner.mapped };
  }
  if (raw.startsWith('Auto is off: the engine watches and you act by hand')) {
    return { text: 'Auto is off, so the desk only watches and you act by hand.', mapped: true };
  }
  if (raw.startsWith('GIMBAL_TRADE is not 1:')) {
    return { text: 'Trading is switched off on this engine: it watches and rescues, but opens nothing.', mapped: true };
  }
  if ((m = raw.match(/^Held pair numbers unknown: .*; nothing is decided on (\S+)$/s))) {
    return { text: `Some numbers for the held ${m[1]} pair are missing, so the desk leaves it alone until they are back.`, mapped: true };
  }
  if ((m = raw.match(new RegExp(`^(\\S+) (${PCT}) net is ready, but (.+)$`, 's')))) {
    const clause = sizeClause(m[3]!);
    return clause === null
      ? { text: `${m[1]} is ready at ${m[2]} net, but the desk cannot size it: ${m[3]}.`, mapped: false }
      : { text: `${m[1]} is ready at ${m[2]} net, but ${clause}.`, mapped: true };
  }
  if (raw.startsWith('Hold ')) return hold(raw);
  // An enter or rotate held by the NEAR AI risk check: the engine publishes the decision as a wait with the held line.
  const held = riskHeldCopy(raw);
  if (held !== null) return { text: held.text, mapped: true };
  if (raw.startsWith('one leg open: ')) {
    const leg = oneLegCopy(raw);
    return leg === null ? null : { text: leg.text, mapped: true };
  }
  return flat(raw, ctx);
}

/** The plain sentence for a wait reason; the engine's own string when no pattern here knows it. */
export function waitCopy(reason: string, ctx: WaitContext = {}): WaitCopy {
  const raw = reason.trim();
  const part = whole(raw, ctx);
  if (part === null) return { text: raw, raw, mapped: false };
  return { text: part.text, raw, mapped: part.mapped };
}

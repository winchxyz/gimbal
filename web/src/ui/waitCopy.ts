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

/** The rest of a sentence about a window that fails a rule, in the engine's gate order (decide.ts: gate). */
function gateClause(text: string): string | null {
  let m: RegExpMatchArray | null;
  if (/^serve opens short hyperliquid, long phoenix only/.test(text)) {
    return `but the desk can't open it (it trades long ${venueName('phoenix')} / short ${venueName('hyperliquid')} only)`;
  }
  if ((m = text.match(/^(.+?) is not a market both legs list in the desk's policy/))) {
    return `but ${m[1]} is not one of the markets in your policy`;
  }
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
    return { text: 'None of the windows in the last scan is one the desk can trade.', mapped: true };
  }

  if ((m = line.match(new RegExp(`^no window clears the entry rules; best (\\S+) (${PCT}) net: (.+)$`, 'is')))) {
    const [, symbol, net, rest] = m as unknown as [string, string, string, string];
    const { body, tail } = vetoTail(rest);
    const minimum = body.match(new RegExp(`^${PCT} net, under your (${PCT}) minimum$`));
    if (minimum) return { text: `No window clears your ${minimum[1]} minimum right now. Closest: ${symbol}, ${net} net.${tail}`, mapped: true };
    const head = ctx.minNetAprPct != null && Number.isFinite(ctx.minNetAprPct)
      ? `No window clears your ${minimumText(ctx.minNetAprPct)} minimum right now.`
      : 'No window clears your entry rules right now.';
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
  return flat(raw, ctx);
}

/** The plain sentence for a wait reason; the engine's own string when no pattern here knows it. */
export function waitCopy(reason: string, ctx: WaitContext = {}): WaitCopy {
  const raw = reason.trim();
  const part = whole(raw, ctx);
  if (part === null) return { text: raw, raw, mapped: false };
  return { text: part.text, raw, mapped: part.mapped };
}

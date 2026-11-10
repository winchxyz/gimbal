// A headline as lines: one sentence a line, the figure in its state colour, a coin's ticker set apart.

export type Part = string | null | { text: string; tone?: string | null };

export interface Piece {
  text: string;
  /** `fig`: the figure, in its tone; `tk`: a coin's ticker; `txt`: words. */
  kind: 'txt' | 'fig' | 'tk';
  tone: string | null;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Words split where a ticker stands as a word of its own. */
function words(text: string, symbols: readonly string[]): Piece[] {
  if (text === '') return [];
  if (symbols.length === 0) return [{ text, kind: 'txt', tone: null }];
  const longest = [...new Set(symbols)].sort((a, b) => b.length - a.length).map(escape);
  const re = new RegExp(`(?<![A-Za-z0-9])(${longest.join('|')})(?![A-Za-z0-9])`, 'g');
  const out: Piece[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), kind: 'txt', tone: null });
    out.push({ text: m[0], kind: 'tk', tone: null });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), kind: 'txt', tone: null });
  return out;
}

/** The parts of a headline as lines, a new line after each full stop that another sentence follows. */
export function sentenceLines(parts: readonly Part[], symbols: readonly string[] = []): Piece[][] {
  const lines: Piece[][] = [[]];
  for (const part of parts) {
    if (part === null || part === '') continue;
    if (typeof part !== 'string') {
      lines[lines.length - 1]!.push({ text: part.text, kind: 'fig', tone: part.tone ?? null });
      continue;
    }
    const chunks = part.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
    chunks.forEach((chunk, i) => {
      if (i > 0) lines.push([]);
      lines[lines.length - 1]!.push(...words(chunk, symbols));
    });
  }
  return lines.filter((l) => l.length > 0);
}

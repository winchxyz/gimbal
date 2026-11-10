import { sentenceLines, type Part } from './sentences.ts';

/** A headline's words: one sentence a line, the figure in its state colour, a coin's ticker in the instrument's mono. */
export function Sentences({ parts, symbols }: { parts: readonly Part[]; symbols?: readonly string[] }) {
  return (
    <>
      {sentenceLines(parts, symbols).map((line, i) => (
        <span className="ln" key={i}>
          {line.map((p, j) =>
            p.kind === 'txt' ? (
              p.text
            ) : (
              <span key={j} className={p.kind === 'tk' ? 'tk' : (p.tone ?? undefined)}>
                {p.text}
              </span>
            ),
          )}
        </span>
      ))}
    </>
  );
}

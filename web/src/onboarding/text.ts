/** A message from a lower layer ("the engine did not answer") as a sentence: a capital at the start, a full stop at the end. */
export function sentence(text: string): string {
  const t = text.trim();
  if (t === '') return t;
  const s = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(s) ? s : `${s}.`;
}

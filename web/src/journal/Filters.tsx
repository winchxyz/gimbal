import { FILTERS, type FilterId } from './kinds.ts';
import { Sk } from './Sk.tsx';

/** The filters with the number of entries beside each. `counts` null = still loading: placeholders, nothing to press. */
export function Filters({ filter, counts, onChange }: { filter: FilterId; counts: Record<FilterId, number> | null; onChange?: (id: FilterId) => void }) {
  return (
    <nav className="j-filters" aria-label="Filter by kind">
      {FILTERS.map((f) => (
        <button key={f.id} type="button" disabled={counts === null} aria-pressed={f.id === filter} onClick={() => onChange?.(f.id)}>
          <span className="j-desk">{f.label}</span>
          <span className="j-phone">{f.short}</span>
          <span className="n">{counts === null ? <Sk w={f.id === 'all' ? 18 : 10} h={14} /> : counts[f.id]}</span>
        </button>
      ))}
    </nav>
  );
}

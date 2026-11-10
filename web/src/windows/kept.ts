// What the visitor chose on the scanner, kept while the page is open: opening a pair and coming back finds the list as
// it was left, at the same place. `scope` and `sort` stay null until chosen, so the defaults follow the scan.
import { DEFAULT_ASSET_SORT, DEFAULT_VENUE_SORT, type AssetSort, type Scope, type Sort, type VenueSort } from './scanner.ts';
import { hashForView } from './route.ts';

export interface Kept {
  scope: Scope | null;
  sort: Sort | null;
  text: string;
  minOiUsd: number;
  scrollTop: number;
  assetSort: AssetSort;
  venueSort: VenueSort;
}

export const kept: Kept = { scope: null, sort: null, text: '', minOiUsd: 0, scrollTop: 0, assetSort: DEFAULT_ASSET_SORT, venueSort: DEFAULT_VENUE_SORT };

/** The scanner's pairs with `text` in the search, from the top: a pair page's way to "every pair on this asset". */
export function searchPairsFor(text: string): void {
  Object.assign(kept, { text, sort: null, minOiUsd: 0, scrollTop: 0 });
  window.location.hash = hashForView('pairs');
}

// The cost waterfall of a window: gross, then fees, slippage, basis and the rescue reserve, then net.
// All values are APR percentage points from `Window.costs`; widths are shares of one bar.
import type { Window as FundingWindow } from '@gimbal/shared';
import { usdWhole } from './format.ts';

export type StepKey = 'gross' | 'fees' | 'slippage' | 'basis' | 'reserve' | 'net';

export interface Step {
  key: StepKey;
  label: string;
  /** APR points: positive earns, the costs are stored positive and drawn with a minus. */
  value: number;
}

export interface Waterfall {
  steps: Step[];
  /** The gross bar's share of the bar width, 0–100. */
  grossWidth: number;
  /** The second bar: the net, then each cost, as shares of the bar width. Zero-width parts are left out. */
  parts: { key: StepKey; width: number }[];
  /** gross − costs − net: how far the engine's net is from the sum of the steps (rounding, normally ~0). */
  gap: number;
}

/** @param legUsd the strategy's leg size, named in the slippage label; null while it is not known */
export function waterfall(w: FundingWindow, legUsd: number | null): Waterfall {
  const c = w.costs;
  const costs: { key: StepKey; value: number }[] = [
    { key: 'fees', value: c.feesPct },
    { key: 'slippage', value: c.slippagePct },
    { key: 'basis', value: c.basisPct },
    { key: 'reserve', value: c.rescueReservePct },
  ];
  const costSum = costs.reduce((sum, p) => sum + p.value, 0);

  const labels: Record<StepKey, string> = {
    gross: 'Gross funding',
    fees: 'Trading fees',
    slippage: legUsd === null ? 'Slippage' : `Slippage at ${usdWhole(legUsd)}`,
    basis: 'Basis',
    reserve: 'Rescue reserve',
    net: 'Net',
  };
  const steps: Step[] = [
    { key: 'gross', label: labels.gross, value: w.grossAprPct },
    ...costs.map((p) => ({ key: p.key, label: labels[p.key], value: p.value })),
    { key: 'net', label: labels.net, value: w.netAprPct },
  ];

  // One scale for both bars: the longer of "what came in" and "what was spent". When the costs exceed the
  // gross there is no net to draw, and the gross bar is the shorter one.
  const scale = Math.max(w.grossAprPct, costSum, Number.EPSILON);
  const share = (v: number) => (Math.abs(v) / scale) * 100;
  const parts = [{ key: 'net' as StepKey, width: w.netAprPct > 0 ? share(w.netAprPct) : 0 }, ...costs.map((p) => ({ key: p.key, width: share(p.value) }))].filter(
    (p) => p.width > 0,
  );

  return {
    steps,
    grossWidth: w.grossAprPct > 0 ? share(w.grossAprPct) : 0,
    parts,
    gap: w.grossAprPct - costSum - w.netAprPct,
  };
}

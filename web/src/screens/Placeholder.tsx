import type { ScreenId } from '../shell/routes.ts';
import { StreamPanel } from '../stream/StreamPanel.tsx';

// Each screen's body is built on a later day; until then it says what it will hold.
const PLANNED: Record<ScreenId, { title: string; lead: string }> = {
  desk: { title: 'Desk', lead: 'Both legs, the desk value, net exposure and the latest events.' },
  windows: { title: 'Windows', lead: 'Funding windows across every venue, sorted by net APR after costs.' },
  journal: { title: 'Journal', lead: 'Everything the desk did, as the contract recorded it.' },
  rescue: { title: 'Rescue', lead: 'Margin moving between venues before a leg can be liquidated, step by step.' },
  security: { title: 'Security', lead: 'The policy the contract enforces, who can call what, and the accounts it owns.' },
};

export function Placeholder({ screen }: { screen: ScreenId }) {
  const { title, lead } = PLANNED[screen];
  return (
    <div className="ph">
      <section>
        <h1>{title}</h1>
        <p className="lead">{lead}</p>
        <p className="note">This screen is not built yet. The header, the sections and the event stream already work.</p>
      </section>
      <StreamPanel />
    </div>
  );
}

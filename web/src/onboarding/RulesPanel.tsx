import { useState } from 'react';
import { cx } from '../ui/cx.ts';
import { setPolicyDeposit } from './desk-actions.ts';
import { policyLive, rulesProblems, type FlowState, type OnboardingFlow, type StepView } from './flow.ts';
import { formatNear } from './near.ts';
import { coinsOf, unpricedCapUsd, venuesOf, VENUE_NAMES, type VenueKey } from './policy.ts';
import { contractRows, countText, EDITS, editText, engineRows, sourceLine, unpricedLine, type EditId, type RuleRow, type RulesDraft } from './rules.ts';
import { sentence } from './text.ts';
import { Act, Err, Page } from './ui.tsx';

interface Props {
  flow: OnboardingFlow;
  s: FlowState;
  steps: StepView[];
}

const EXAMPLE = 'For example: steady income, only big coins, never more than $1,000 a side, money only comes back to me.';

/** The second number of a row that holds two (price band and oracle age are rows of their own). */
const EXTRA: Partial<Record<string, EditId>> = { transfer: 'transfer-flat', rotate: 'rotate-hours', risk: 'rescue-distance' };

function NumberBox({ id, flow, s }: { id: EditId; flow: OnboardingFlow; s: FlowState }) {
  const draft = s.rules.draft!;
  const raw = s.rules.raw[id];
  const def = EDITS[id];
  return (
    <label className="ob-num">
      <span className="sr">{def.label}</span>
      <input
        className="ob-input"
        inputMode="decimal"
        value={raw ?? editText(draft, id)}
        placeholder={def.optional ? 'off' : undefined}
        aria-invalid={raw !== undefined}
        size={8}
        onChange={(e) => flow.editNumber(id, e.target.value)}
      />
      <span>{def.unit}</span>
    </label>
  );
}

function Rows({ rows, s, flow, editing }: { rows: RuleRow[]; s: FlowState; flow: OnboardingFlow; editing: boolean }) {
  return (
    <div className="pol">
      {rows.map((row) => {
        const src = sourceLine(row.source);
        const extra = EXTRA[row.id];
        return (
          <div key={row.id}>
            <b>{row.label}</b>
            <span className="val">
              {editing && row.edit ? (
                <>
                  <NumberBox id={row.edit} flow={flow} s={s} />
                  {extra ? <NumberBox id={extra} flow={flow} s={s} /> : null}
                </>
              ) : (
                row.value
              )}
            </span>
            <span className={cx('src', src.ai && 'ai')}>{src.text}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Add and remove, in the edit mode: coins, exchanges, assets without a price. */
function Lists({ s, flow, draft }: { s: FlowState; flow: OnboardingFlow; draft: RulesDraft }) {
  const [asset, setAsset] = useState('');
  const [sym, setSym] = useState('');
  const [cap, setCap] = useState('');
  const [mark, setMark] = useState('');
  const policy = draft.policy;
  const marks = s.rules.marks;
  return (
    <div className="ob-lists">
      <div>
        <h4>Assets</h4>
        <p className="ob-chips">
          {coinsOf(policy).map((c) => (
            <button key={c} type="button" className="btn" onClick={() => flow.dropCoin(c)} aria-label={`Remove ${c}`}>
              {c} ×
            </button>
          ))}
          {coinsOf(policy).length === 0 ? <span className="g">none</span> : null}
        </p>
        <form
          className="ob-add"
          onSubmit={(e) => {
            e.preventDefault();
            void flow.addAsset(asset).then(() => setAsset(''));
          }}
        >
          <input className="ob-input" list="hl-assets" value={asset} placeholder="Add a Hyperliquid asset" autoCapitalize="none" autoComplete="off" spellCheck={false} onChange={(e) => setAsset(e.target.value)} />
          <datalist id="hl-assets">{s.rules.hlAssets?.map((a) => <option key={a.index} value={a.symbol} />)}</datalist>
          <button type="submit" className="btn" disabled={asset.trim() === '' || s.busy !== null}>
            Add
          </button>
        </form>
      </div>
      <div>
        <h4>Exchanges</h4>
        <p className="ob-chips">
          {venuesOf(policy).map((v: VenueKey) => (
            <button key={v} type="button" className="btn" onClick={() => flow.dropVenue(v)} aria-label={`Remove ${VENUE_NAMES[v]}`}>
              {VENUE_NAMES[v]} ×
            </button>
          ))}
        </p>
      </div>
      <div>
        <h4>Assets without a trusted price</h4>
        <p className="ob-hint">The desk may trade these under a size cap. Type the cap in dollars; the page converts it to a size at the current mark and shows both.</p>
        {policy.unpriced.map((u) => (
          <p key={u.symbol} className="ob-unpriced">
            <b>{u.symbol}</b> <span>{unpricedLine(u, marks[u.symbol])}</span>
            <button type="button" className="btn quiet" onClick={() => flow.dropUnpriced(u.symbol)} aria-label={`Remove ${u.symbol}`}>
              Remove
            </button>
          </p>
        ))}
        <form
          className="ob-add three"
          onSubmit={(e) => {
            e.preventDefault();
            void flow.addUnpricedAsset(sym, cap, mark).then(() => {
              if (flow.state.errors.asset === undefined) {
                setSym('');
                setCap('');
                setMark('');
              }
            });
          }}
        >
          <input className="ob-input" value={sym} placeholder="Symbol, e.g. kPEPE" autoCapitalize="none" autoComplete="off" spellCheck={false} onChange={(e) => setSym(e.target.value)} />
          <input className="ob-input" inputMode="decimal" value={cap} placeholder="Cap in $" onChange={(e) => setCap(e.target.value)} />
          <input className="ob-input" inputMode="decimal" value={mark} placeholder="Mark (optional)" onChange={(e) => setMark(e.target.value)} />
          <button type="submit" className="btn" disabled={sym.trim() === '' || cap.trim() === '' || s.busy !== null}>
            Add
          </button>
        </form>
        <Err text={s.errors.asset} />
      </div>
    </div>
  );
}

export function RulesPanel({ flow, s, steps }: Props) {
  const r = s.rules;
  const draft = r.draft;
  const problems = rulesProblems(s);
  const drafting = r.drafting === 'busy';
  const live = policyLive(s);
  const awaitingEngine = live && draft !== null && !r.strategySaved;
  const owner = s.account ?? 'your account';
  const cost = draft ? formatNear(setPolicyDeposit(s.deskId, draft.policy)) : null;
  const cap = draft ? unpricedCapUsd(draft.policy) : 0;

  const contract = draft ? contractRows(draft, r.words, owner) : [];
  const engine = draft ? engineRows(draft, r.words) : [];

  const right = (() => {
    if (drafting) {
      return (
        <div aria-busy="true" className="ob-loading">
          <p className="g">NEAR AI is drafting your policy, usually in under 2 s…</p>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="ob-skrow">
              <i className="ob-sk" />
              <i className="ob-sk" />
            </div>
          ))}
        </div>
      );
    }
    if (draft === null && (r.drafting === 'failed' || s.errors.draft)) {
      return (
        <div className="ob-state">
          <p>NEAR AI didn’t give rules back.</p>
          {s.errors.draft ? <p className="g">{sentence(s.errors.draft)}</p> : null}
          <p className="g">Your words are kept. Try again, or set the numbers yourself.</p>
          <p className="ob-row">
            <Act busy={s.busy} mine="draft" waiting="Asking NEAR AI…" onClick={() => void flow.draftRules()}>
              Try again
            </Act>
            <button type="button" className="btn quiet" onClick={() => flow.fillByHand()}>
              Set numbers myself
            </button>
          </p>
        </div>
      );
    }
    if (draft === null && r.drafting === 'unavailable') {
      return (
        <div className="ob-state">
          <p>Drafting from words is not available right now.</p>
          <p className="g">NEAR AI did not take the request. Nothing is lost: you can set the numbers yourself, and the contract checks them the same way.</p>
          <p className="ob-row">
            <button type="button" className="btn" onClick={() => flow.fillByHand()}>
              Set numbers myself
            </button>
          </p>
        </div>
      );
    }
    if (draft === null) {
      return (
        <div className="ob-state">
          <p className="g">Your rules will appear here as numbers the contract can check.</p>
          <p className="ob-row">
            <button type="button" className="btn quiet" onClick={() => flow.fillByHand()}>
              Set numbers myself
            </button>
          </p>
        </div>
      );
    }
    return (
      <>
        <h3 className="ob-h3">
          <span>What the contract will enforce</span>
          <span>{countText(contract.length)}</span>
        </h3>
        <Rows rows={contract} s={s} flow={flow} editing={r.editing} />
        {r.editing ? <Lists s={s} flow={flow} draft={draft} /> : draft.policy.unpriced.length > 0 ? <UnpricedList draft={draft} marks={r.marks} cap={cap} /> : null}

        <h3 className="ob-h3 ob-gap">
          <span>Engine rules</span>
          <span>{countText(engine.length)} · not enforced by the contract</span>
        </h3>
        <Rows rows={engine} s={s} flow={flow} editing={r.editing} />
        {r.editing ? (
          <p className="ob-row">
            <button type="button" className="btn" onClick={() => flow.setAutoMode(!draft.strategy.auto)}>
              {draft.strategy.auto ? 'Act by hand instead' : 'Let the engine act'}
            </button>
          </p>
        ) : null}

        {draft.notes.length > 0 ? (
          <div className="ob-notes">
            {draft.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
            <p className="g">NEAR AI left these out. Add a rule for them above, or leave them.</p>
          </div>
        ) : null}
        {problems.length > 0 ? (
          <ul className="ob-problems" role="alert">
            {problems.map((p, i) => (
              <li key={`${p.field}${i}`}>{p.message}</li>
            ))}
          </ul>
        ) : null}
        {awaitingEngine ? (
          <div className="ob-notes" role="alert">
            <p>Your policy is signed and the contract holds it.</p>
            <p className="g">{s.errors.strategy ? `The engine did not take its rules: ${s.errors.strategy}` : 'The engine has not saved its rules yet.'}</p>
          </div>
        ) : null}
      </>
    );
  })();

  const end = awaitingEngine ? (
    <Act busy={s.busy} mine="strategy" primary waiting="Saving…" onClick={() => void flow.saveStrategy()}>
      Save engine rules
    </Act>
  ) : (
    <>
      <button type="button" className={cx('btn', 'quiet', 'big')} disabled={draft === null || s.busy !== null} aria-pressed={r.editing} onClick={() => flow.setEditing(!r.editing)}>
        {r.editing ? 'Done editing' : 'Edit a rule'}
      </button>
      <Act busy={s.busy} mine="sign" primary disabled={draft === null || problems.length > 0 || drafting} onClick={() => void flow.signPolicy()}>
        Sign policy
      </Act>
    </>
  );

  return (
    <Page
      steps={steps}
      title="Your rules"
      lead="Write them the way you would tell a person. The contract only enforces numbers, so here is exactly what it will read."
      note={cost ? `Each change later needs your signature again. Signing attaches up to ${cost} NEAR for storage; the unused part comes back.` : 'Each change later needs your signature again.'}
      end={end}
    >
      <div className="two ob-two">
        <div>
          <h3 className="ob-h3">
            <span>In your words</span>
            <span>{draft?.model ? `NEAR AI · ${draft.model}` : drafting ? 'NEAR AI' : ''}</span>
          </h3>
          <textarea
            className="words"
            aria-label="Describe your rules"
            value={r.words}
            placeholder={EXAMPLE}
            rows={9}
            onChange={(e) => flow.setWords(e.target.value)}
          />
          <p className="ob-row">
            <Act busy={s.busy} mine="draft" waiting="Asking NEAR AI…" disabled={r.words.trim() === ''} onClick={() => void flow.draftRules()}>
              {draft === null ? 'Draft my rules' : 'Draft again'}
            </Act>
          </p>
          <Err text={draft !== null ? s.errors.draft : undefined} />
          <p className="hint">Drafted inside a TEE on NEAR AI Cloud. The model never signs anything; you do. Nothing below is applied until you press Sign policy.</p>
          <Err text={s.errors.sign} />
        </div>
        <div>{right}</div>
      </div>
    </Page>
  );
}

/** Assets without a price, with the size cap and what it is worth at the mark: both are shown before signing. */
function UnpricedList({ draft, marks, cap }: { draft: RulesDraft; marks: Record<string, number>; cap: number }) {
  return (
    <div className="ob-lists">
      <div>
        <h4>Assets without a trusted price</h4>
        {draft.policy.unpriced.map((u) => (
          <p key={u.symbol} className="ob-unpriced">
            <b>{u.symbol}</b> <span>{unpricedLine(u, marks[u.symbol])}</span>
          </p>
        ))}
        <p className="ob-hint">An order in these is limited to ${cap.toLocaleString('en-US')}, the smaller of the two caps.</p>
      </div>
    </div>
  );
}

import { useEffect } from 'react';
import { cx } from '../ui/cx.ts';
import type { FlowState, OnboardingFlow, StepView } from './flow.ts';
import { balanceText, formatUsdc, MIN_FUND_USDC, ORIGINS, statusText, usdcUnits } from './intents.ts';
import { Act, Err, Field, Mono, Page } from './ui.tsx';

interface Props {
  flow: OnboardingFlow;
  s: FlowState;
  steps: StepView[];
}

/** How often the page asks 1Click how the transfer is going, and the chain how much USDC the account holds. */
const POLL_MS = 6000;

export function FundsPanel({ flow, s, steps }: Props) {
  const mainnet = s.config.network === 'mainnet';
  const quote = s.fund.quote;
  const status = s.fund.status ? statusText(s.fund.status) : null;
  const watching = quote !== null && !(status?.final ?? false);

  // Follow the transfer and the balance while this step is on screen.
  useEffect(() => {
    void flow.refreshBalance();
    const timer = setInterval(() => {
      void flow.refreshBalance();
      if (watching) void flow.refreshStatus();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [flow, watching]);

  const balance = s.fund.balance;
  const amount = usdcUnits(s.fund.depositText);
  const canDeposit = amount !== null && balance !== null && amount <= balance;

  return (
    <Page
      steps={steps}
      title="Add funds"
      lead="Bring USDC to your NEAR account, then deposit it into the desk. Money you deposit counts as your principal: it comes back to you as principal, not as profit."
      note={balance === null ? 'Reading your balance…' : `Your NEAR account holds ${balanceText(balance)}.`}
      end={
        <Act busy={s.busy} mine="deposit" primary disabled={!canDeposit} onClick={() => void flow.deposit()}>
          Deposit to desk
        </Act>
      }
    >
      <div className="ob-body ob-two">
        <section>
          <h3 className="ob-h3">
            <span>From another chain</span>
            <span>NEAR Intents</span>
          </h3>
          {mainnet ? (
            <>
              <div className="ob-seg" role="group" aria-label="Chain to send from">
                {ORIGINS.map((o) => (
                  <button key={o.id} type="button" className={cx('btn', s.fund.originId === o.id && 'primary')} aria-pressed={s.fund.originId === o.id} onClick={() => flow.setFund({ originId: o.id })}>
                    {o.label}
                  </button>
                ))}
              </div>
              <Field label="USDC to send" htmlFor="fund-amount" hint={`At least ${MIN_FUND_USDC} USDC: the fee is nearly flat, so a small transfer loses a large share.`}>
                <input id="fund-amount" className="ob-input" inputMode="decimal" value={s.fund.amount} placeholder="100" onChange={(e) => flow.setFund({ amount: e.target.value })} />
              </Field>
              <Field label="Refund address" htmlFor="fund-refund" hint={`Your ${ORIGINS.find((o) => o.id === s.fund.originId)?.label} address. If the transfer fails, 1Click sends your USDC back here.`}>
                <input id="fund-refund" className="ob-input ob-mono" value={s.fund.refundTo} placeholder={ORIGINS.find((o) => o.id === s.fund.originId)?.addressHint} autoComplete="off" spellCheck={false} onChange={(e) => flow.setFund({ refundTo: e.target.value })} />
              </Field>
              <p className="ob-row">
                <Act busy={s.busy} mine="quote" disabled={quote !== null} waiting="Asking 1Click…" onClick={() => void flow.quote()}>
                  Get deposit address
                </Act>
              </p>
              <Err text={s.errors.quote} />
              {quote ? (
                <div className="ob-quote">
                  <p className="g">Send {formatUsdc(BigInt(quote.amountIn))} USDC on {ORIGINS.find((o) => o.id === s.fund.originId)?.label} to</p>
                  <p>
                    <Mono>{quote.depositAddress}</Mono>
                  </p>
                  {quote.depositMemo ? (
                    <p className="g">
                      Memo: <Mono>{quote.depositMemo}</Mono>
                    </p>
                  ) : null}
                  <p className="g">You receive at least {formatUsdc(BigInt(quote.minAmountOut))} USDC on NEAR{quote.timeEstimateS ? `, in about ${quote.timeEstimateS} s` : ''}. Send it from your own wallet; the address is good for 30 minutes.</p>
                  {status ? (
                    <p className={cx('ob-status', status.tone)} role="status">
                      {status.text}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <p className="g">NEAR Intents has no testnet. On testnet, put test USDC on your NEAR account, then deposit it from the right.</p>
          )}
        </section>

        <section>
          <h3 className="ob-h3">
            <span>USDC on your NEAR account</span>
            <span>{balance === null ? '' : balanceText(balance)}</span>
          </h3>
          {s.config.usdcToken === null ? (
            <p className="ob-err">No USDC token is configured for {s.config.network}, so a deposit cannot be built. Set VITE_USDC_TOKEN for this page.</p>
          ) : (
            <>
              <Field label="USDC to put in the desk" htmlFor="deposit-amount">
                <input id="deposit-amount" className="ob-input" inputMode="decimal" value={s.fund.depositText} placeholder="100" onChange={(e) => flow.setFund({ depositText: e.target.value })} />
              </Field>
              <p className="ob-row">
                <button type="button" className="btn quiet" disabled={balance === null || balance === 0n} onClick={() => balance !== null && flow.setFund({ depositText: formatUsdc(balance) })}>
                  Use all of it
                </button>
              </p>
              {amount !== null && balance !== null && amount > balance ? <p className="ob-err">That is more than your account holds.</p> : null}
              <Err text={s.errors.deposit} />
              <p className="ob-hint">The deposit goes to the contract with your desk’s name attached, so the desk’s ledger counts it as yours.</p>
            </>
          )}
        </section>
      </div>
    </Page>
  );
}

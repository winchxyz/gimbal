import tests from 'virtual:refusal-tests';
import { ExtLink } from './ExtLink.tsx';
import { REFUSALS, testLabel, testUrl } from './refusals.ts';

/**
 * Every way the contract says no (docs/interfaces.md §1.5), with the tests that assert it. The links come from the build
 * (`virtual:refusal-tests`): the lines of `contract/` that name each code, on the repository's default branch.
 */
export function Refusals() {
  return (
    <section className="s-refusals">
      <h2>Checked so far</h2>
      <p className="s-lede g">
        The contract refuses with one of these codes and signs nothing. Each is asserted by a test in the repository: open the line to read the case.
      </p>
      <div className="s-ref">
        {REFUSALS.map((r) => (
          <div key={r.code} className="s-ref-row">
            <span className="neg mono s-ref-code">{r.code}</span>
            <span className="s-ref-meaning">{r.meaning}</span>
            <span className="s-ref-links">
              {(tests[r.code] ?? []).map((t) => (
                <ExtLink key={`${t.path}:${t.line}`} href={testUrl(t)} className="g mono" arrow>
                  {testLabel(t)}
                </ExtLink>
              ))}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

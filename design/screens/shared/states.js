// Shows a screen in another state without a second file.
//   ?net=mainnet|testnet|replay   network marker in the header (and test funds on testnet, no wallet in replay)
//   ?state=loading|empty|error    loading turns every figure into a placeholder bar and keeps the labels;
//                                  empty and error use the page's <template id="t-empty|t-error">,
//                                  or a page hook in window.STATE_HOOKS when only part of the screen changes.
(() => {
  const q = new URLSearchParams(location.search);
  const net = q.get('net'), state = q.get('state');

  const chip = document.querySelector('header .dot');
  if (chip && net === 'testnet') {
    chip.textContent = 'Testnet';
    chip.style.setProperty('--dot', 'var(--testnet)');
    document.querySelectorAll('header .btn.primary').forEach(b => { b.textContent = 'Get test USDC'; });
  }
  if (chip && net === 'replay') {
    chip.textContent = 'Replay';
    const status = document.querySelector('.status');
    if (status) status.insertAdjacentHTML('beforeend', '<span class="g3" style="font-size:13px;margin-left:auto">Recorded on 24 Oct · plays at 1×</span>');
    chip.style.setProperty('--dot', 'var(--replay)');
    document.querySelectorAll('header .btn').forEach(b => b.remove());
    const right = document.querySelector('header .right, header .lite');
    if (right) right.insertAdjacentHTML('beforeend', '<a class="btn">Exit replay</a><a class="btn primary">Connect wallet</a>');
  }

  if (!state) return;
  const hook = window.STATE_HOOKS && window.STATE_HOOKS[state];
  if (hook) { hook(); return; }

  if (state === 'loading') {
    document.body.classList.add('loading');
    const header = document.querySelector('header');
    // a figure is any element whose own text (not its children's) holds a digit
    document.querySelectorAll('body *').forEach(el => {
      if (header.contains(el) || el.closest('template')) return;
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('');
      if (!/\d/.test(own)) return;
      el.classList.add('sk');
      const cs = getComputedStyle(el);
      if (cs.display === 'block') {
        el.style.width = 'fit-content';
        if (cs.textAlign === 'right' || cs.textAlign === 'end') el.style.marginLeft = 'auto';
        if (cs.textAlign === 'center') el.style.marginInline = 'auto';
      }
    });
    document.querySelectorAll('svg').forEach(s => { if (!header.contains(s)) s.style.opacity = 0; });
    const status = document.querySelector('.status');
    if (status) status.innerHTML = '<span class="state dot" style="--dot:var(--ink-3);color:var(--ink-2)">Loading</span><span class="g">Reading both exchanges and the contract…</span>';
    return;
  }

  const tpl = document.getElementById('t-' + state);
  if (!tpl) return;
  [...document.body.children].forEach(el => {
    if (el.tagName !== 'HEADER' && el.tagName !== 'SCRIPT' && el.tagName !== 'TEMPLATE') el.remove();
  });
  document.body.classList.remove('scroll');
  document.querySelector('header').insertAdjacentHTML('afterend', tpl.innerHTML);
})();

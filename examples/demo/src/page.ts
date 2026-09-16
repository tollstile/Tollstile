/** The demo's only page: what to try, a button that does it, and the ledger as it fills. */
const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Tollstile demo — a paid API you can pay for right now</title>
<meta name="description" content="A live Tollstile demo on Cloudflare Workers and D1: 402 with a signed quote, pay, receipt, and the ledger updating." />
<style>
  :root { color-scheme: light dark; --paper: #fbfaf9; --paper-2: #f2f0ee; --ink: #191817; --ink-2: #494643; --ink-3: #77726d; --rule: #dedbd7; }
  @media (prefers-color-scheme: dark) { :root { --paper: #111110; --paper-2: #1a1918; --ink: #f2f0ee; --ink-2: #c9c5c0; --ink-3: #8d8883; --rule: #302e2c; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 56rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
  h1 { font-size: clamp(1.8rem, 5vw, 2.6rem); line-height: 1.1; margin: 0 0 .5rem; letter-spacing: -.02em; }
  h2 { font-size: 1.1rem; margin: 2.5rem 0 .75rem; }
  p { color: var(--ink-2); max-width: 44rem; }
  a { color: inherit; }
  code, pre { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 13px; }
  pre { background: var(--paper-2); border: 1px solid var(--rule); padding: .75rem 1rem; overflow-x: auto; margin: 0 0 1rem; }
  button { font: inherit; background: var(--ink); color: var(--paper); border: 1px solid var(--ink); padding: .5rem 1rem; cursor: pointer; }
  button.secondary { background: transparent; color: var(--ink); }
  button:disabled { opacity: .5; cursor: default; }
  .row { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--rule); white-space: nowrap; }
  th { color: var(--ink-3); font-weight: 500; }
  td.mono, th.mono { font-family: ui-monospace, monospace; }
  .log { background: var(--paper-2); border: 1px solid var(--rule); padding: .75rem 1rem; min-height: 9rem; max-height: 22rem; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  .note { color: var(--ink-3); font-size: 13px; }
  .scroll { overflow-x: auto; }
</style>
</head>
<body>
<main>
  <h1>A paid API you can pay for right now.</h1>
  <p>
    This is <a href="https://tollstile.com">Tollstile</a> running on Cloudflare Workers with its SQLite ledger on D1.
    Every call below answers <code>402</code> with a signed quote, takes payment, settles, and writes the charge to the ledger you can watch at the bottom.
    The rail is the <strong>test rail</strong>, so paying costs nothing: send <code>Payment: test quote=…</code>.
  </p>

  <h2>Try it from this page</h2>
  <div class="row">
    <button id="pay">402 → pay → 200</button>
    <button id="retry" class="secondary">Retry with the same idempotency key</button>
    <button id="swap" class="secondary">Pay a quote with a different body</button>
    <button id="upto" class="secondary">Authorize $0.50, charge what was used</button>
  </div>
  <div class="log" id="log">Ready.</div>

  <h2>Or from your terminal</h2>
  <pre># 402 Payment Required, with a signed quote
curl -i https://DEMO_HOST/v1/forecast?city=Osaka

# pay it (the test rail takes "test quote=&lt;quote&gt;")
curl -i -H "Payment: test quote=&lt;quote&gt;" "https://DEMO_HOST/v1/forecast?city=Osaka"

# a price computed from the body — the quote is bound to that exact body
curl -i -X POST --data "the weather in tokyo is clear" https://DEMO_HOST/v1/translate</pre>

  <h2>Or from an agent, over MCP</h2>
  <p>Streamable HTTP at <code>https://DEMO_HOST/mcp</code>. Call <code>pricing</code> free, then <code>forecast</code> for $0.01 by putting the payment in <code>_meta</code>.</p>
  <pre>claude mcp add --transport http tollstile-demo https://DEMO_HOST/mcp</pre>

  <h2>The ledger, live</h2>
  <p class="note">Charges written by every call above — yours and everyone else's. Refreshes every two seconds.</p>
  <div class="scroll"><table>
    <thead><tr><th class="mono">charge</th><th>resource</th><th>amount</th><th>payment / fulfillment</th><th>settlement</th><th>updated</th></tr></thead>
    <tbody id="charges"><tr><td colspan="6" class="note">Loading…</td></tr></tbody>
  </table></div>

  <p class="note" style="margin-top:2rem">
    Source: <a href="https://github.com/tollstile/tollstile/tree/main/examples/demo">examples/demo</a> ·
    Docs: <a href="https://tollstile.com/docs">tollstile.com/docs</a> ·
    Prices here are play money; nothing is charged to anyone.
  </p>
</main>
<script type="module">
const log = document.getElementById('log');
const write = (line) => { log.textContent = (log.textContent === 'Ready.' ? '' : log.textContent + '\n') + line; log.scrollTop = log.scrollHeight; };
const clear = () => { log.textContent = 'Ready.'; };

async function challenge(path, init) {
  const response = await fetch(path, init);
  const body = await response.json();
  write('→ ' + (init?.method ?? 'GET') + ' ' + path);
  write('← ' + response.status + ' ' + body.error.code + (body.price ? ' · price ' + body.price : ''));
  return body;
}

async function show(label, path, init) {
  const response = await fetch(path, init);
  const text = await response.text();
  write('→ ' + label);
  write('← ' + response.status + (response.headers.get('payment-receipt') ? ' · receipt ' + response.headers.get('payment-receipt') : ''));
  write('  ' + text);
  return response;
}

document.getElementById('pay').onclick = async () => {
  clear();
  const quote = (await challenge('/v1/forecast?city=Osaka')).quote;
  await show('GET /v1/forecast?city=Osaka  Payment: test quote=…', '/v1/forecast?city=Osaka', { headers: { payment: 'test quote=' + quote } });
  refresh();
};

document.getElementById('retry').onclick = async () => {
  clear();
  const quote = (await challenge('/v1/forecast?city=Kyoto')).quote;
  const headers = { payment: 'test quote=' + quote, 'idempotency-key': crypto.randomUUID() };
  await show('GET /v1/forecast?city=Kyoto  (paid, with an Idempotency-Key)', '/v1/forecast?city=Kyoto', { headers });
  await show('the same request again — a retry after a lost response', '/v1/forecast?city=Kyoto', { headers });
  write('  A retry is answered from the ledger: not charged, not run again.');
  refresh();
};

document.getElementById('swap').onclick = async () => {
  clear();
  const body = 'the weather in tokyo is clear';
  const quote = (await challenge('/v1/translate', { method: 'POST', body })).quote;
  await show('POST /v1/translate  (paid, but a longer body than the quote priced)', '/v1/translate', {
    method: 'POST', body: body + ' and it will stay that way all week long indeed', headers: { payment: 'test quote=' + quote },
  });
  write('  quote_mismatch: a cheap quote cannot pay for a bigger request.');
  await show('POST /v1/translate  (paid, the same body)', '/v1/translate', { method: 'POST', body, headers: { payment: 'test quote=' + quote } });
  refresh();
};

document.getElementById('upto').onclick = async () => {
  clear();
  const body = 'Tollstile prices the call. The handler reports what it used. Only that is charged.';
  const quote = (await challenge('/v1/summarize', { method: 'POST', body })).quote;
  await show('POST /v1/summarize  (authorized up to $0.50)', '/v1/summarize', { method: 'POST', body, headers: { payment: 'test quote=' + quote } });
  write('  Check the ledger: the charge is the amount the handler reported, not the maximum.');
  refresh();
};

const money = (micros, currency) => (currency === 'USD' ? '$' : currency + ' ') + (Number(micros) / 1_000_000).toFixed(3);
const ago = (at) => { const seconds = Math.max(0, Math.round((Date.now() - Number(at)) / 1000)); return seconds < 60 ? seconds + 's ago' : Math.round(seconds / 60) + 'm ago'; };

async function refresh() {
  const { charges } = await (await fetch('/api/charges')).json();
  const rows = document.getElementById('charges');
  rows.innerHTML = charges.length === 0
    ? '<tr><td colspan="6" class="note">No charges yet. Press a button above.</td></tr>'
    : charges.map((charge) => '<tr>'
        + '<td class="mono">' + charge.id.slice(0, 12) + '…</td>'
        + '<td>' + charge.resource + '</td>'
        + '<td class="mono">' + money(charge.amount_micros, charge.currency) + '</td>'
        + '<td class="mono">' + charge.payment + ' / ' + charge.fulfillment + '</td>'
        + '<td class="mono">' + (charge.settlement_reference ? charge.settlement_reference.slice(0, 18) + '…' : '—') + '</td>'
        + '<td class="note">' + ago(charge.updated_at) + '</td>'
        + '</tr>').join('');
}

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;

export function page(host?: string): Response {
  return new Response(HTML.replaceAll('DEMO_HOST', host ?? 'demo.tollstile.com'), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' },
  });
}

/**
 * The same route as a conversation: ask, get an answer, see what it cost.
 *
 * Every question authorizes the same $0.05 and settles somewhere else, so the point — a ceiling is
 * not a price — arrives without a paragraph explaining it. The page pays with the test rail, from
 * the browser, against `/v1/research` on this Worker.
 */
const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>Ask, then see what it cost — Tollstile demo</title>
<meta name="description" content="A paid research desk as a chat: every question authorizes $0.05 and settles $0.01, $0.02, $0.04 — or nothing." />
<style>
  :root {
    --bg: #E6E9E1; --surface: #F7F8F3; --sunk: #DDE1D7; --text: #12201D; --muted: #546159; --rule: #C2C9BB;
    --gate: #124036; --gate-ink: #F2F5EE; --coin: #B0790F; --stop: #9C3A24; color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0C1513; --surface: #15211E; --sunk: #0A1211; --text: #E4EAE2; --muted: #94A399; --rule: #2A3833;
      --gate: #0E2F29; --gate-ink: #DCEBE3; --coin: #E0AE4A; --stop: #E08163; color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 52rem; margin: 0 auto; padding: 28px 16px 48px; display: flex; flex-direction: column; gap: 20px; }
  h1 { font-size: clamp(1.7rem, 5vw, 2.4rem); line-height: 1.05; margin: 0; letter-spacing: -.01em; }
  p.lede { margin: 0; color: var(--muted); max-width: 46rem; }
  a { color: inherit; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .86em; background: var(--sunk); padding: 1px 5px; }

  .totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); }
  .totals div { background: var(--surface); padding: 12px 14px; }
  .totals dt { font: 600 .68rem/1.4 ui-monospace, monospace; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
  .totals dd { margin: 0; font-size: 1.6rem; font-weight: 700; font-variant-numeric: tabular-nums; }

  .thread { display: flex; flex-direction: column; gap: 14px; }
  .turn { display: flex; flex-direction: column; gap: 8px; }
  .bubble { max-width: 90%; padding: 11px 14px; border: 1px solid var(--rule); }
  .bubble.ask { align-self: flex-end; background: var(--gate); color: var(--gate-ink); border-color: var(--gate); }
  .bubble.reply { align-self: flex-start; background: var(--surface); }
  .bubble .who { display: block; font: 600 .64rem/1.6 ui-monospace, monospace; letter-spacing: .12em; text-transform: uppercase; opacity: .7; }
  .sources { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .sources span { font: .7rem/1.5 ui-monospace, monospace; border: 1px solid var(--rule); padding: 1px 6px; color: var(--muted); }

  .receipt { align-self: flex-start; width: min(100%, 27rem); background: var(--surface); border: 1px solid var(--rule); border-left: 3px solid var(--coin); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
  .receipt .head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .receipt .charged { font-size: 1.5rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .receipt .tier { font: 600 .68rem/1.4 ui-monospace, monospace; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
  .meter { height: 10px; background: var(--sunk); border: 1px solid var(--rule); position: relative; }
  .meter i { display: block; height: 100%; background: var(--coin); transition: width .5s ease; }
  .meter b { position: absolute; inset: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 4px; font: 600 .6rem/1 ui-monospace, monospace; color: var(--text); mix-blend-mode: normal; }
  .receipt .why { font-size: .84rem; color: var(--muted); }
  .receipt .why b { color: var(--text); font-weight: 600; }
  .receipt.free { border-left-color: var(--stop); }

  form { display: flex; flex-direction: column; gap: 10px; }
  .presets { display: flex; flex-wrap: wrap; gap: 8px; }
  .presets button { font: inherit; font-size: .86rem; text-align: left; background: var(--surface); color: var(--text); border: 1px solid var(--rule); border-bottom-width: 3px; padding: 7px 11px; cursor: pointer; }
  .presets button:hover:not(:disabled) { background: var(--sunk); }
  .presets button:active:not(:disabled) { transform: translateY(2px); border-bottom-width: 1px; }
  .compose { display: flex; gap: 8px; }
  input[type="text"] { flex: 1; min-width: 0; font: inherit; padding: 10px 12px; background: var(--surface); color: var(--text); border: 1px solid var(--rule); }
  .send { font: inherit; font-weight: 600; background: var(--gate); color: var(--gate-ink); border: 1px solid var(--gate); padding: 10px 18px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  :focus-visible { outline: 3px solid var(--coin); outline-offset: 2px; }

  .note { color: var(--muted); font-size: .86rem; }
  .pending { color: var(--muted); font-size: .86rem; font-style: italic; }
  @media (prefers-reduced-motion: reduce) { .meter i { transition: none; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>Ask, then see what it cost</h1>
    <p class="lede">A research desk you pay per question. Every question authorizes the <b>same $0.05</b> before the desk starts, and settles what the answer turned out to be worth — $0.01, $0.02, $0.04, or nothing at all. This page pays for real, on the test rail, against <code>POST /v1/research</code> on this server.</p>
  </header>

  <dl class="totals">
    <div><dt>Authorized</dt><dd id="t-auth">$0.00</dd></div>
    <div><dt>Actually paid</dt><dd id="t-paid">$0.00</dd></div>
    <div><dt>Questions</dt><dd id="t-count">0</dd></div>
    <div><dt>Priced by</dt><dd id="t-judge" style="font-size:1rem">—</dd></div>
  </dl>

  <section class="thread" id="thread" aria-live="polite"></section>

  <form id="composer">
    <div class="presets" id="presets"></div>
    <div class="compose">
      <label for="question" class="sr-only" style="position:absolute;left:-9999px">Your question</label>
      <input type="text" id="question" name="question" placeholder="Ask anything — the price depends on how much work the answer took…" maxlength="280" autocomplete="off" />
      <button class="send" type="submit" id="send">Ask</button>
    </div>
  </form>

  <p class="note">Ask it anything. Seven topics — tides, the moon, fishing, ferries, refunds, typhoons, swell — come from a local corpus; anything else is written by a model and judged the same way, and a desk that cannot answer charges nothing. Everything here is the test rail — no wallet, no card, no account. <a href="/">The rest of the demo</a> · <a href="https://tollstile.com/docs/guides/price-what-the-work-was-worth">How this is built</a> · <a href="https://github.com/tollstile/Tollstile/tree/main/examples/jev-pricing">The example, in full</a></p>
</main>

<script>
(() => {
  const PRESETS = [
    'What do anglers say about fishing?',
    'How do the tide and the moon line up in Tokyo?',
    'Should I book the ferry in September, given the swell and a refund?',
    'What is the capital of Mars?',
  ];

  const $ = (id) => document.getElementById(id);
  const thread = $('thread');
  let authorized = 0, paid = 0, asked = 0, busy = false;

  for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = preset;
    button.addEventListener('click', () => ask(preset));
    $('presets').append(button);
  }

  $('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $('question').value.trim();
    if (value !== '') ask(value);
  });

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function bubble(kind, who, text) {
    const node = el('div', 'bubble ' + kind);
    node.append(el('span', 'who', who));
    node.append(el('div', null, text));
    return node;
  }

  async function ask(question) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('button, input').forEach((control) => { control.disabled = true; });
    $('question').value = '';

    const turn = el('div', 'turn');
    turn.append(bubble('ask', 'the agent', question));
    const waiting = el('p', 'pending', 'authorizing $0.05 and waiting for the desk…');
    turn.append(waiting);
    thread.append(turn);
    turn.scrollIntoView({ block: 'end', behavior: 'smooth' });

    try {
      const body = JSON.stringify({ question });
      const headers = { 'content-type': 'application/json' };
      const unpaid = await fetch('/v1/research', { method: 'POST', headers, body });
      const challenge = await unpaid.json();
      if (unpaid.status !== 402 || !challenge.quote) throw new Error(challenge?.error?.message || ('the desk answered ' + unpaid.status));

      const response = await fetch('/v1/research', { method: 'POST', headers: { ...headers, payment: 'test quote=' + challenge.quote }, body });
      const result = await response.json();
      waiting.remove();

      if (result.answered) {
        const reply = bubble('reply', 'the desk', result.answer);
        const sources = el('div', 'sources');
        for (const source of result.sources ?? []) sources.append(el('span', null, source));
        reply.append(sources);
        turn.append(reply);
      } else {
        turn.append(bubble('reply', 'the desk', 'Nothing in the desk\'s sources answers that. You are not charged for it.'));
      }
      turn.append(receipt(result.pricing));

      asked += 1;
      authorized += money(result.pricing.authorized);
      paid += money(result.pricing.charged);
      $('t-auth').textContent = dollars(authorized);
      $('t-paid').textContent = dollars(paid);
      $('t-count').textContent = String(asked);
      $('t-judge').textContent = result.pricing.judgedBy;
    } catch (error) {
      waiting.remove();
      const failed = bubble('reply', 'the desk', String(error && error.message ? error.message : error));
      failed.style.borderColor = 'var(--stop)';
      turn.append(failed);
    } finally {
      busy = false;
      document.querySelectorAll('button, input').forEach((control) => { control.disabled = false; });
      turn.scrollIntoView({ block: 'end', behavior: 'smooth' });
      $('question').focus();
    }
  }

  function receipt(pricing) {
    const charged = money(pricing.charged), ceiling = money(pricing.authorized) || 1;
    const node = el('div', 'receipt' + (charged === 0 ? ' free' : ''));

    const head = el('div', 'head');
    head.append(el('span', 'charged', pricing.charged));
    head.append(el('span', 'tier', pricing.tier + ' · ' + pricing.judgedBy));
    node.append(head);

    const meter = el('div', 'meter');
    const fill = el('i');
    fill.style.width = Math.round((charged / ceiling) * 100) + '%';
    meter.append(fill);
    const ends = el('b');
    ends.append(el('span', null, 'charged ' + pricing.charged));
    ends.append(el('span', null, 'authorized ' + pricing.authorized));
    meter.append(ends);
    node.append(meter);

    const why = el('p', 'why');
    why.append(el('b', null, 'why: '));
    why.append(document.createTextNode(pricing.reason + ' · confidence ' + pricing.confidence));
    node.append(why);
    return node;
  }

  const money = (text) => Number(String(text ?? '$0').replace(/[^0-9.]/g, '')) || 0;
  const dollars = (value) => '$' + value.toFixed(2);

  ask(PRESETS[0]);
})();
</script>
</body>
</html>`;

export function chat(): Response {
  return new Response(HTML, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      'cache-control': 'public, max-age=60',
    },
  });
}

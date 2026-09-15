import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import express, { type ErrorRequestHandler, type Express } from 'express';
import { createTollstile, credits, memoryBalance, memoryLedger, payPerCall, testRail, type Gate, type Rail } from 'tollstile';
import { afterEach, describe, expect, it } from 'vitest';
import { paid } from '../src/index';

const servers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
});

async function listen(app: Express): Promise<string> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('Expected a TCP address.');
  return `http://127.0.0.1:${address.port}`;
}

function setup() {
  const rail = testRail();
  const ledger = memoryLedger();
  const toll = createTollstile({ rails: [rail], ledger });
  const errors: unknown[] = [];
  const renderError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    errors.push(error);
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(500).json({ error: 'internal' });
  };
  return { rail, ledger, toll, errors, renderError };
}

type Log = string[];

/** Counts `complete()` calls and logs when each one finishes, slowly enough that an unheld response would win the race. */
function observe<Rails extends readonly Rail[]>(gate: Gate<Rails>, log: Log = []) {
  let completions = 0;
  const observed: Gate<Rails> = {
    resource: gate.resource,
    async enter(context) {
      const entry = await gate.enter(context);
      if (entry.kind === 'denied') return entry;
      return {
        kind: 'admitted',
        pass: {
          payment: entry.pass.payment,
          async complete(outcome) {
            completions += 1;
            await new Promise((resolve) => setTimeout(resolve, 30));
            const receipt = await entry.pass.complete(outcome);
            log.push(`completed:${outcome}`);
            return receipt;
          },
        },
      };
    },
  };
  return { gate: observed, completions: () => completions, log };
}

const PAYMENT = { payment: 'test' };

describe('@tollstile/express', () => {
  it('turns 402 into 200 with the test rail and the quote it was offered', async () => {
    const { toll, rail } = setup();
    const { gate, completions, log } = observe(toll.price('$0.01'));
    const app = express();
    let runs = 0;
    app.get(
      '/weather',
      paid(gate, (_req, res, { payment }) => {
        runs += 1;
        res.json({ forecast: 'clear', paidWith: payment.via });
      }),
    );
    const url = await listen(app);

    const unpaid = await fetch(`${url}/weather`);
    expect(unpaid.status).toBe(402);
    expect(unpaid.headers.get('cache-control')).toBe('no-store');
    const { quote, resource } = (await unpaid.json()) as { quote: string; resource: string };
    expect(resource).toBe('GET /weather');
    expect(runs).toBe(0);

    const response = await fetch(`${url}/weather`, { headers: { payment: `test quote=${quote}` } });
    log.push('response');
    expect(response.status).toBe(200);
    expect(response.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
    expect(await response.json()).toEqual({ forecast: 'clear', paidWith: 'rail' });
    expect(rail.effects.settlements).toBe(1);
    expect(runs).toBe(1);
    expect(completions()).toBe(1);
    expect(log).toEqual(['completed:succeeded', 'response']);
  });

  it('holds res.send until settlement has finished', async () => {
    const { toll, rail } = setup();
    const { gate, completions, log } = observe(toll.price('$0.01'));
    const app = express();
    app.post(
      '/echo',
      paid(gate, (_req, res) => {
        res.status(201).send('created');
      }),
    );
    const url = await listen(app);

    const response = await fetch(`${url}/echo`, { method: 'POST', headers: PAYMENT });
    log.push('response');

    expect(response.status).toBe(201);
    expect(response.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
    expect(await response.text()).toBe('created');
    expect(rail.effects.settlements).toBe(1);
    expect(completions()).toBe(1);
    expect(log).toEqual(['completed:succeeded', 'response']);
  });

  it('holds an explicit writeHead and the writes after it', async () => {
    const { toll } = setup();
    const app = express();
    app.get(
      '/manual',
      paid(toll.price('$0.01'), (_req, res) => {
        res.writeHead(202, { 'content-type': 'text/plain' });
        res.write('a');
        res.end('b');
      }),
    );
    const url = await listen(app);

    const response = await fetch(`${url}/manual`, { headers: PAYMENT });

    expect(response.status).toBe(202);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
    expect(await response.text()).toBe('ab');
  });

  it('streams a piped body larger than the socket buffer after settlement', async () => {
    const { toll, rail } = setup();
    const { gate, log } = observe(toll.price('$0.01'));
    const chunk = 'x'.repeat(64 * 1024);
    const app = express();
    app.get(
      '/stream',
      paid(gate, (_req, res) => {
        res.type('text/plain');
        Readable.from(Array.from({ length: 64 }, () => chunk)).pipe(res);
      }),
    );
    const url = await listen(app);

    const response = await fetch(`${url}/stream`, { headers: PAYMENT });
    log.push('response');

    expect(response.status).toBe(200);
    expect(response.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
    expect((await response.text()).length).toBe(64 * chunk.length);
    expect(rail.effects.settlements).toBe(1);
    expect(log).toEqual(['completed:succeeded', 'response']);
  });

  it('streams writes that wait for drain', async () => {
    const { toll } = setup();
    const app = express();
    app.get(
      '/drain',
      paid(toll.price('$0.01'), async (_req, res) => {
        for (const part of ['one ', 'two ', 'three']) {
          if (!res.write(part)) await new Promise((resolve) => res.once('drain', resolve));
        }
        res.end();
      }),
    );
    const url = await listen(app);

    const response = await fetch(`${url}/drain`, { headers: PAYMENT });

    expect(response.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
    expect(await response.text()).toBe('one two three');
  });

  it('releases the reservation when the handler throws, and Express renders the error', async () => {
    const { toll, rail, ledger, errors, renderError } = setup();
    const { gate, completions, log } = observe(toll.price('$0.01'));
    const failure = new Error('handler failed');
    const app = express();
    app.get(
      '/broken',
      paid(gate, () => {
        throw failure;
      }),
    );
    app.get(
      '/rejected',
      paid(toll.price('$0.01'), () => Promise.reject(failure)),
    );
    app.use(renderError);
    const url = await listen(app);

    const response = await fetch(`${url}/broken`, { headers: PAYMENT });
    log.push('response');
    const rejected = await fetch(`${url}/rejected`, { headers: PAYMENT });

    expect(response.status).toBe(500);
    expect(rejected.status).toBe(500);
    expect(response.headers.get('payment-receipt')).toBeNull();
    expect(errors).toEqual([failure, failure]);
    expect(rail.effects.settlements).toBe(0);
    expect(ledger.charges().map((charge) => charge.payment)).toEqual(['released', 'released']);
    expect(completions()).toBe(1);
    expect(log).toEqual(['completed:failed', 'response']);
  });

  it('releases the reservation when the handler calls next(error)', async () => {
    const { toll, rail, ledger, errors, renderError } = setup();
    const { gate, completions } = observe(toll.price('$0.01'));
    const failure = new Error('passed on');
    const app = express();
    app.get(
      '/next-error',
      paid(gate, (_req, _res, { next }) => {
        next(failure);
      }),
    );
    app.use(renderError);
    const url = await listen(app);

    const response = await fetch(`${url}/next-error`, { headers: PAYMENT });

    expect(response.status).toBe(500);
    expect(errors).toEqual([failure]);
    expect(rail.effects.settlements).toBe(0);
    expect(ledger.charges().map((charge) => charge.payment)).toEqual(['released']);
    expect(completions()).toBe(1);
  });

  it('releases the reservation for a response of 400 or above, without a receipt', async () => {
    const { toll, rail, ledger } = setup();
    const { gate, completions } = observe(toll.price('$0.01'));
    const app = express();
    app.get(
      '/missing',
      paid(gate, (_req, res) => {
        res.status(404).json({ error: 'missing' });
      }),
    );
    const url = await listen(app);

    const response = await fetch(`${url}/missing`, { headers: PAYMENT });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'missing' });
    expect(response.headers.get('payment-receipt')).toBeNull();
    expect(rail.effects.settlements).toBe(0);
    expect(ledger.charges().map((charge) => charge.payment)).toEqual(['released']);
    expect(completions()).toBe(1);
  });

  it('decides the outcome from the handler that responds after next()', async () => {
    const { toll, rail } = setup();
    const { gate, completions } = observe(toll.price('$0.01'));
    const app = express();
    app.get(
      '/delegated',
      paid(gate, (_req, _res, { next }) => {
        next();
      }),
      (_req, res) => {
        res.send('from the next handler');
      },
    );
    const url = await listen(app);

    const response = await fetch(`${url}/delegated`, { headers: PAYMENT });

    expect(await response.text()).toBe('from the next handler');
    expect(response.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
    expect(rail.effects.settlements).toBe(1);
    expect(completions()).toBe(1);
  });

  it('replaces the response with the error when the payment cannot be completed', async () => {
    const { toll, errors, renderError } = setup();
    const gate = toll.price('$0.01');
    const outage = new Error('ledger unavailable');
    const failing: Gate<typeof gate extends Gate<infer Rails> ? Rails : never> = {
      resource: gate.resource,
      async enter(context) {
        const entry = await gate.enter(context);
        if (entry.kind === 'denied') return entry;
        return { kind: 'admitted', pass: { payment: entry.pass.payment, complete: () => Promise.reject(outage) } };
      },
    };
    const app = express();
    app.get(
      '/paid-content',
      paid(failing, (_req, res) => {
        res.send('the paid content');
      }),
    );
    app.use(renderError);
    const url = await listen(app);

    const response = await fetch(`${url}/paid-content`, { headers: PAYMENT });

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('the paid content');
    expect(errors).toEqual([outage]);
  });

  it('names the resource after the route path, including the router mount path', async () => {
    const { toll, ledger } = setup();
    const app = express();
    const router = express.Router();
    router.get(
      '/users/:id',
      paid(toll.price('$0.01'), (req, res) => {
        res.send(req.params.id);
      }),
    );
    app.use('/api', router);
    app.use(
      paid(toll.price('$0.01'), (_req, res) => {
        res.send('fallback');
      }),
    );
    const url = await listen(app);

    await (await fetch(`${url}/api/users/42?verbose=1`, { headers: PAYMENT })).text();
    await (await fetch(`${url}/anything/else`, { method: 'POST', headers: PAYMENT })).text();

    expect(ledger.charges().map((charge) => charge.resource)).toEqual(['GET /api/users/:id', 'POST /anything/else']);
  });

  it('passes the resolved principal to access policies', async () => {
    const { toll } = setup();
    const balance = memoryBalance({ acct_1: '$1' });
    const app = express();
    app.get(
      '/credits',
      paid(
        toll.price('$0.25', { access: [credits({ balance }), payPerCall()] }),
        (_req, res, { payment }) => {
          res.json({ via: payment.via });
        },
        { principal: (req) => (req.get('x-account') === undefined ? null : { id: req.get('x-account') ?? '' }) },
      ),
    );
    const url = await listen(app);

    const withAccount = await fetch(`${url}/credits`, { headers: { 'x-account': 'acct_1' } });
    expect(withAccount.status).toBe(200);
    expect(await withAccount.json()).toEqual({ via: 'policy' });
    expect(balance.available('acct_1')?.micros).toBe(750_000n);
    expect((await fetch(`${url}/credits`)).status).toBe(402);
  });
});

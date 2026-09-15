import type { NextFunction, Response as ExpressResponse } from 'express';
import type { Pass, Rail, Receipt } from 'tollstile';

export type HeldResponse = {
  /** Passed to the handler in place of Express's `next`, so `next(error)` counts as a failure. */
  readonly next: NextFunction;
  /** The handler threw: completes the payment as failed. Express receives the error afterwards. */
  fail(): Promise<void>;
};

type Completion = { readonly ok: true; readonly receipt: Receipt } | { readonly ok: false; readonly error: unknown };

/**
 * Holds the response back from the moment it would commit its headers until `pass.complete` has
 * finished, then adds the receipt headers and lets the held calls through.
 *
 * Settlement is asynchronous but `writeHead`, `write`, and `end` are not, and the first of them
 * commits the headers. So the first call that would send headers — from `res.send`, `res.json`, a
 * piped stream, an error handler, or the handler itself — decides the outcome from the status code,
 * starts completion, and queues itself and everything after it. `express-session` saves sessions
 * before responding the same way.
 */
export function holdResponse<Rails extends readonly Rail[]>(res: ExpressResponse, pass: Pass<Rails>, next: NextFunction): HeldResponse {
  const original = {
    writeHead: res.writeHead.bind(res),
    write: res.write.bind(res),
    end: res.end.bind(res),
    flushHeaders: res.flushHeaders.bind(res),
  };
  const held: (() => void)[] = [];
  let phase: 'open' | 'holding' | 'released' = 'open';
  let failed = false;
  let forwarded = false;
  let writerWaiting = false;
  let completion: Promise<Completion> | undefined;

  function complete(status: number): Promise<Completion> {
    completion ??= pass.complete(failed || status >= 400 ? 'failed' : 'succeeded').then(
      (receipt): Completion => ({ ok: true, receipt }),
      // catch-reason: completion runs detached from the handler, so its error is carried to
      // `release`, the one place that hands it to Express.
      (error: unknown): Completion => ({ ok: false, error }),
    );
    return completion;
  }

  /** Errors go to Express's error handlers once; after control has left the handler, the response is abandoned instead. */
  function report(error: unknown): void {
    if (forwarded) {
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    forwarded = true;
    next(error);
  }

  async function release(status: number): Promise<void> {
    const result = await complete(status);
    phase = 'released';
    const calls = held.splice(0);
    // A response that was not completed must not be served: the error replaces it.
    if (!result.ok) {
      report(result.error);
      return;
    }
    for (const [name, value] of result.receipt.headers) res.append(name, value);
    // catch-reason: before they were held, these calls would have thrown synchronously inside the
    // handler; their errors must still reach Express.
    try {
      for (const call of calls) call();
    } catch (error) {
      report(error);
      return;
    }
    // A writer told to wait for 'drain' while held would otherwise wait forever when the socket
    // never filled up.
    if (writerWaiting && !res.writableNeedDrain) res.emit('drain');
  }

  function hold(status: number, call: () => void): void {
    held.push(call);
    if (phase === 'holding') return;
    phase = 'holding';
    void release(status); // release never rejects: completion errors are values and replay errors are reported.
  }

  Object.assign(res, {
    writeHead(...args: unknown[]): unknown {
      if (phase === 'released') return Reflect.apply(original.writeHead, res, args);
      hold(typeof args[0] === 'number' ? args[0] : res.statusCode, () => {
        Reflect.apply(original.writeHead, res, args);
      });
      return res;
    },
    write(...args: unknown[]): unknown {
      if (phase === 'released') return Reflect.apply(original.write, res, args);
      hold(res.statusCode, () => {
        Reflect.apply(original.write, res, args);
      });
      writerWaiting = true;
      return false;
    },
    end(...args: unknown[]): unknown {
      if (phase === 'released') return Reflect.apply(original.end, res, args);
      hold(res.statusCode, () => {
        Reflect.apply(original.end, res, args);
      });
      return res;
    },
    flushHeaders() {
      if (phase === 'released') {
        original.flushHeaders();
        return;
      }
      hold(res.statusCode, () => {
        original.flushHeaders();
      });
    },
  });

  return {
    next(error?: unknown) {
      forwarded = true;
      if (error !== undefined && error !== 'route' && error !== 'router') failed = true;
      next(error);
    },
    async fail() {
      failed = true;
      forwarded = true;
      await complete(res.statusCode);
    },
  };
}

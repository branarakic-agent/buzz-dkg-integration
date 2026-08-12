import { IntegrationApiError } from '../errors.ts';

type WaitingRead = {
  start: () => boolean;
};

/** Process-wide admission control for DKG reads owned by one query gateway. */
export class DkgReadLimiter {
  readonly #maxConcurrent: number;
  readonly #maxQueued: number;
  readonly #waiting: WaitingRead[] = [];
  #active = 0;

  constructor(maxConcurrent: number, maxQueued: number) {
    this.#maxConcurrent = maxConcurrent;
    this.#maxQueued = maxQueued;
  }

  snapshot(): { active: number; queued: number; maxConcurrent: number; maxQueued: number } {
    return {
      active: this.#active,
      queued: this.#waiting.length,
      maxConcurrent: this.#maxConcurrent,
      maxQueued: this.#maxQueued,
    };
  }

  async run<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      throw new IntegrationApiError(504, 'gateway_timeout', 'operation timed out');
    }
    if (this.#active >= this.#maxConcurrent) {
      if (this.#waiting.length >= this.#maxQueued) {
        throw new IntegrationApiError(
          429,
          'dkg_busy',
          'DKG read queue is full; retry after the current work completes',
          { retryAfterSeconds: 2 },
        );
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const waiting: WaitingRead = {
          start: () => {
            if (settled) return false;
            settled = true;
            signal?.removeEventListener('abort', abort);
            if (signal?.aborted) {
              reject(new IntegrationApiError(504, 'gateway_timeout', 'operation timed out'));
              return false;
            }
            resolve();
            return true;
          },
        };
        const abort = () => {
          if (settled) return;
          settled = true;
          const index = this.#waiting.indexOf(waiting);
          if (index >= 0) this.#waiting.splice(index, 1);
          reject(new IntegrationApiError(504, 'gateway_timeout', 'operation timed out'));
        };
        signal?.addEventListener('abort', abort, { once: true });
        this.#waiting.push(waiting);
      });
    } else {
      this.#active += 1;
    }
    try {
      return await read();
    } finally {
      let next = this.#waiting.shift();
      let transferred = false;
      while (next) {
        // Transfer this occupied slot directly. Decrementing before resolving
        // would let a new caller race the queued reader and exceed the limit.
        if (next.start()) {
          transferred = true;
          break;
        }
        next = this.#waiting.shift();
      }
      if (!transferred) this.#active -= 1;
    }
  }
}

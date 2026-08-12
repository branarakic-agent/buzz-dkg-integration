import { IntegrationApiError } from '../errors.ts';

type WaitingRead = {
  start: () => void;
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

  async run<T>(read: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#maxConcurrent) {
      if (this.#waiting.length >= this.#maxQueued) {
        throw new IntegrationApiError(
          429,
          'dkg_busy',
          'DKG read queue is full; retry after the current work completes',
          { retryAfterSeconds: 2 },
        );
      }
      await new Promise<void>((resolve) => {
        this.#waiting.push({ start: resolve });
      });
    } else {
      this.#active += 1;
    }
    try {
      return await read();
    } finally {
      const next = this.#waiting.shift();
      if (next) {
        // Transfer this occupied slot directly. Decrementing before resolving
        // would let a new caller race the queued reader and exceed the limit.
        next.start();
      } else {
        this.#active -= 1;
      }
    }
  }
}

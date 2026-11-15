import { inspect } from "node:util";

const REDACTED = "[redacted]";

/**
 * Holds a sensitive value (a token, a private key, a URL with an embedded API key) so that it
 * cannot be logged or serialized by accident.
 *
 * `String(secret)`, template literals, `JSON.stringify` and `util.inspect` (and so `console.log`)
 * all render `[redacted]`. The only way to read the value is an explicit `reveal()` call, which
 * makes every use easy to find in review.
 */
export class Secret<T = string> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  /** Returns the underlying value. Call it only at the point of use, never to log or return it. */
  reveal(): T {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

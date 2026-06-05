// App-side runtime polyfills for the gaps the React Native Hermes engine leaves
// in modern JS globals that libp2p assumes. These are distinct from the
// transport package's `/polyfills` (crypto, WebRTC, Event/EventTarget): these
// patch standard-library methods Hermes/RN ship incompletely. This module must
// be imported FIRST in the app entry, before any libp2p module evaluates.

// `Promise.withResolvers` — Hermes does not implement it, so libp2p's ping and
// identify protocols throw "promise.withResolvers is not a function" the moment
// they initialize. Spec-compliant shim.
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

// `Symbol.asyncIterator` — Hermes does not define this well-known symbol. With
// it `undefined`, a computed async-iterator key (`{ [Symbol.asyncIterator]() {} }`,
// as in `it-pushable`) collapses to the *string* key "undefined", so
// `isAsyncIterable(x)` (reads `x[Symbol.asyncIterator]`, i.e. `x["undefined"]`)
// returns true while Babel's `_asyncIterator` helper (also reads
// `Symbol.asyncIterator`) finds nothing and throws "Object is not async
// iterable". That kills `for await (… of pushable())` in @libp2p/webrtc's
// WebRTCStream, so every WebRTC muxer stream's incoming data is never decoded and
// the access handshake hangs. Define one real symbol before any module evaluates.
if (typeof Symbol.asyncIterator === 'undefined') {
  Object.defineProperty(Symbol, 'asyncIterator', {
    value: Symbol('Symbol.asyncIterator'),
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

// `AbortSignal` — RN ships an AbortController/AbortSignal that predates several
// spec additions libp2p relies on (`signal.throwIfAborted()`,
// `AbortSignal.timeout()`, `AbortSignal.any()`). Each is patched only if absent
// so a future RN that ships them natively wins.
const makeAbortError = (message, name) => {
  if (typeof DOMException === 'function') {
    return new DOMException(message, name);
  }
  const error = new Error(message);
  error.name = name;
  return error;
};

if (typeof AbortSignal !== 'undefined') {
  if (typeof AbortSignal.prototype.throwIfAborted !== 'function') {
    AbortSignal.prototype.throwIfAborted = function throwIfAborted() {
      if (this.aborted) {
        throw this.reason ?? makeAbortError('signal is aborted without reason', 'AbortError');
      }
    };
  }

  if (typeof AbortSignal.timeout !== 'function') {
    AbortSignal.timeout = (ms) => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(makeAbortError('signal timed out', 'TimeoutError'));
      }, ms);
      return controller.signal;
    };
  }

  if (typeof AbortSignal.any !== 'function') {
    AbortSignal.any = (signals) => {
      const controller = new AbortController();
      for (const signal of signals) {
        if (signal.aborted) {
          controller.abort(signal.reason);
          break;
        }
        signal.addEventListener('abort', () => controller.abort(signal.reason), {
          once: true,
        });
      }
      return controller.signal;
    };
  }
}

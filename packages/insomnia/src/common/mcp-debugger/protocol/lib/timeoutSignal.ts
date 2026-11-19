/**
 * Forward a `parent` abort onto `target`, firing immediately if `parent` is
 * already aborted — `addEventListener("abort")` only fires for *future* aborts,
 * so without the up-front check a pre-aborted parent would never propagate.
 * `beforeAbort` runs just before propagating, to release a resource tied to the
 * lifetime (e.g. clear a pending timeout). Returns a detach for the listener.
 */
export function propagateAbort(
  parent: AbortSignal,
  target: AbortController,
  beforeAbort?: () => void,
): () => void {
  const fire = () => {
    beforeAbort?.();
    target.abort(parent.reason);
  };
  if (parent.aborted) {
    fire();
    return () => {};
  }
  parent.addEventListener("abort", fire, { once: true });
  return () => parent.removeEventListener("abort", fire);
}

/**
 * AbortSignal that fires after `ms`, chained to a parent signal so a parent
 * abort cancels the timeout and propagates its reason. Returns the signal,
 * a flag the caller can read to label timeouts, and a teardown.
 *
 * If `parent` is already aborted at call time, the returned signal is also
 * aborted (with parent's reason) and no timer is armed.
 */
export function timeoutSignal(
  ms: number,
  parent: AbortSignal,
): { signal: AbortSignal; timedOut: () => boolean; clear: () => void } {
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort(parent.reason);
    return {
      signal: controller.signal,
      timedOut: () => false,
      clear: () => {},
    };
  }
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("timeout", "AbortError"));
  }, ms);
  // A parent abort clears the timer before propagating its reason.
  const detach = propagateAbort(parent, controller, () => clearTimeout(timeoutId));
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clear: () => {
      clearTimeout(timeoutId);
      detach();
    },
  };
}

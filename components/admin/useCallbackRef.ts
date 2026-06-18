// A stable function identity that always calls the latest callback. Lets an
// effect depend on it without re-running when the closure changes.

import { useCallback, useLayoutEffect, useRef } from "react";

export function useCallbackRef<A extends unknown[], R>(
  callback: (...args: A) => R
): (...args: A) => R {
  const ref = useRef(callback);
  useLayoutEffect(() => {
    ref.current = callback;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

// Code-split views that can be fetched ahead of their first render.
//
// `React.lazy` starts a chunk's import only when the component first renders,
// and React 18 stops rendering siblings at the first one that suspends. The
// study view's chunks (toolbar, series browser, viewport) therefore loaded one
// after another, all of it after the first series was hung: the first image
// waited on a waterfall of chunk fetches + compiles. `preload()` starts the
// import early (opening a study), and a view whose module has arrived renders
// it directly, without suspending once more.

import { lazy, useState, type ComponentProps, type ComponentType } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

export type Preloadable<C extends AnyComponent> = C & { preload: () => Promise<C> };

export function preloadable<C extends AnyComponent>(load: () => Promise<C>): Preloadable<C> {
  let loaded: C | null = null;
  let pending: Promise<C> | null = null;
  const preload = (): Promise<C> =>
    (pending ??= load().then(
      (c) => (loaded = c),
      (e: unknown) => {
        pending = null; // a failed fetch can be retried by the next render
        throw e;
      }
    ));
  const Lazy = lazy(() => preload().then((c) => ({ default: c }))) as unknown as AnyComponent;
  function View(props: ComponentProps<C>) {
    // Decided once per mount: switching from the lazy wrapper to the module's
    // component later would remount the view.
    const [Ready] = useState<AnyComponent | null>(() => loaded);
    const Component = Ready ?? Lazy;
    return <Component {...props} />;
  }
  return Object.assign(View, { preload }) as unknown as Preloadable<C>;
}

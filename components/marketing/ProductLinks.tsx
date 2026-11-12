const PRODUCTS = [
  ["FlowRad", "https://www.flowrad.ai"],
  ["Viewer", "https://viewer.flowrad.ai"],
  ["Open viewer", "https://app.viewer.flowrad.ai/viewer"],
  ["Canvas", "https://canvas.flowrad.ai"],
  ["RadCalculator", "https://radcalculator.com"],
  ["RadCrate", "https://radcrate.com"],
] as const;

/** Small public-chrome links, using the surrounding surface's text colour. */
export function ProductLinks() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs leading-5">
      <a href="https://sanyamkatyal.com" className="rounded-sm underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4">
        Created by Sanyam Katyal
      </a>
      <nav aria-label="FlowRad products" className="flex flex-wrap gap-x-4 gap-y-2">
        {PRODUCTS.map(([label, href]) => (
          <a key={href} href={href} className="rounded-sm underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4">
            {label}
          </a>
        ))}
      </nav>
    </div>
  );
}

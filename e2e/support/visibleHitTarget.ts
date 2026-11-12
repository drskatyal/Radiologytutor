import { expect, type Locator } from '@playwright/test';

/** Visibility alone does not detect a canvas painted over a form or result. */
export async function expectVisibleHitTarget(locator: Locator) {
  await expect(locator).toBeVisible();
  await expect(locator).toBeInViewport({ ratio: 1 });
  await expect.poll(() => locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === element || (hit !== null && element.contains(hit));
  })).toBe(true);
}

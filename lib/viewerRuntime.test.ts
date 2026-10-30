import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  coreInitConfig,
  describeRuntime,
  detectDeviceProfile,
  imageCacheBytes,
  retrievalPoolSizes,
  webWorkerCount,
  type DeviceProfile,
} from "./viewerRuntime";

const ONE_MB = 1024 * 1024;

function profile(over: Partial<DeviceProfile> = {}): DeviceProfile {
  return { isMobile: false, cores: 8, deviceMemoryGb: 8, coarsePointer: false, ...over };
}

test("decode workers take three quarters of a workstation's cores", () => {
  assert.equal(webWorkerCount(profile({ cores: 8 })), 6);
  assert.equal(webWorkerCount(profile({ cores: 4 })), 3);
  assert.equal(webWorkerCount(profile({ cores: 12 })), 8, "capped at 8");
  assert.equal(webWorkerCount(profile({ cores: 32 })), 8, "capped at 8");
});

test("decode workers never drop below two, even on a single core", () => {
  assert.equal(webWorkerCount(profile({ cores: 1 })), 2);
  assert.equal(webWorkerCount(profile({ cores: 0 })), 2);
});

test("a phone keeps the library's cores/2 but caps at three", () => {
  assert.equal(webWorkerCount(profile({ isMobile: true, cores: 8 })), 3);
  assert.equal(webWorkerCount(profile({ isMobile: true, cores: 4 })), 2);
  assert.equal(webWorkerCount(profile({ isMobile: true, cores: 2 })), 1);
  assert.equal(webWorkerCount(profile({ isMobile: true, cores: 16 })), 3);
});

test("a phone always gets fewer decode workers than the same-core desktop", () => {
  for (const cores of [2, 4, 8, 16]) {
    assert.ok(
      webWorkerCount(profile({ isMobile: true, cores })) <
        webWorkerCount(profile({ isMobile: false, cores })),
      `${cores} cores`
    );
  }
});

test("the image cache ceiling scales with device memory and stays under Cornerstone's 3 GB default", () => {
  const threeGb = 3 * 1024 * ONE_MB;
  for (const gb of [2, 4, 8, 16, 64]) {
    const bytes = imageCacheBytes(profile({ deviceMemoryGb: gb }));
    assert.ok(bytes < threeGb, `${gb}GB device should cap below the 3 GB library default`);
  }
  assert.ok(
    imageCacheBytes(profile({ deviceMemoryGb: 4 })) <
      imageCacheBytes(profile({ deviceMemoryGb: 16 })),
    "more device memory earns more cache"
  );
});

test("a 1 GB ceiling still holds a whole 512x512 chest CT", () => {
  const frameBytes = 512 * 512 * 2;
  const frames = imageCacheBytes(profile({ deviceMemoryGb: 8 })) / frameBytes;
  assert.ok(frames > 1000, `expected >1000 cached frames, got ${Math.round(frames)}`);
});

test("a phone gets the smallest cache and the narrowest request pool", () => {
  assert.equal(imageCacheBytes(profile({ isMobile: true, deviceMemoryGb: 16 })), 192 * ONE_MB);
  const mobile = retrievalPoolSizes(profile({ isMobile: true }));
  const desktop = retrievalPoolSizes(profile());
  assert.ok(mobile.interaction < desktop.interaction);
  assert.ok(mobile.prefetch < desktop.prefetch);
});

test("prefetch and thumbnail pools never outrank interaction", () => {
  for (const isMobile of [true, false]) {
    const pool = retrievalPoolSizes(profile({ isMobile }));
    assert.ok(pool.interaction > pool.prefetch);
    assert.ok(pool.interaction > pool.thumbnail);
  }
});

test("core init tells Cornerstone about mobile so it stops at one WebGL context", () => {
  const mobile = coreInitConfig(profile({ isMobile: true }));
  assert.equal(mobile.isMobile, true);
  assert.equal(mobile.rendering.preferSizeOverAccuracy, true);
  const desktop = coreInitConfig(profile());
  assert.equal(desktop.isMobile, false);
  assert.equal(desktop.rendering.preferSizeOverAccuracy, false);
  assert.ok(desktop.gpuTier.tier > mobile.gpuTier.tier);
});

test("detectDeviceProfile is server-safe", () => {
  const detected = detectDeviceProfile();
  assert.equal(detected.isMobile, false);
  assert.ok(detected.cores >= 1);
  assert.ok(detected.deviceMemoryGb > 0);
});

test("describeRuntime names every number it applies", () => {
  const line = describeRuntime(profile({ cores: 8, deviceMemoryGb: 8 }));
  assert.match(line, /desktop/);
  assert.match(line, /8 cores/);
  assert.match(line, /6 decode workers/);
  assert.match(line, /1024MB image cache/);
  assert.match(line, /16 interactive requests/);
});

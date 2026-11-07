// Web folder watching over fake File System Access handles (synthetic files).
import assert from "node:assert/strict";
import { test } from "node:test";
import { folderWatchSupported, listDirectory, WebFolderWatcher, type FolderStore, type StoredFolder } from "./webFolderWatch";

type FakeFile = { name: string; size: number; lastModified: number; probe: Record<string, string> | null };

function fakeDir(name: string, tree: Record<string, FakeFile | Record<string, unknown>>, perm: { state: PermissionState }) {
  const handle = {
    kind: "directory",
    name,
    async *values(): AsyncGenerator<unknown> {
      for (const [k, v] of Object.entries(tree)) {
        if ("size" in (v as FakeFile)) {
          const f = v as FakeFile;
          yield { kind: "file", name: k, getFile: async () => ({ ...f, name: k, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) }) };
        } else yield fakeDir(k, v as Record<string, FakeFile>, perm);
      }
    },
    queryPermission: async () => perm.state,
    requestPermission: async () => (perm.state = "granted"),
    isSameEntry: async (o: unknown) => o === handle,
  };
  return handle as unknown as FileSystemDirectoryHandle;
}

test("support is detected from the API, not the browser name", () => {
  assert.equal(folderWatchSupported({}), false, "Safari / Firefox: no directory picker");
  assert.equal(folderWatchSupported({ showDirectoryPicker: () => 0, FileSystemHandle: { prototype: { queryPermission: () => 0 } } }), true);
  assert.equal(folderWatchSupported(undefined), false);
});

test("listing is recursive, bounded and skips hidden folders and obvious non-DICOM", async () => {
  const perm = { state: "granted" as PermissionState };
  const dir = fakeDir("export", { a: { "1.dcm": { name: "1.dcm", size: 5, lastModified: 1, probe: null }, "notes.txt": { name: "notes.txt", size: 1, lastModified: 1, probe: null } }, ".cache": { x: { name: "x", size: 1, lastModified: 1, probe: null } }, IM2: { name: "IM2", size: 9, lastModified: 2, probe: null } } as never, perm);
  const { listing } = await listDirectory(dir);
  assert.deepEqual(listing.map((l) => l.path).sort(), ["IM2", "a/1.dcm"]);
  assert.equal((await listDirectory(dir, 1)).listing.length, 1);
});

test("permission after reload: no reading until the reader allows it again; hidden tab pauses polling", async () => {
  const perm = { state: "prompt" as PermissionState };
  const dir = fakeDir("export", { s: { "1": { name: "1", size: 10, lastModified: 0, probe: { sop: "2.25.1" } } } } as never, perm);
  const saved: StoredFolder[] = [{ id: "wf-1", name: "export", handle: dir, enabled: true }];
  const store: FolderStore = { all: async () => saved, put: async () => undefined, remove: async () => undefined };
  const timers: (() => void)[] = [];
  let visible = true;
  const probed: string[] = [];
  const parser = async () => ({
    parseDicom: () => {
      probed.push("x");
      throw new Error("not reached: synthetic files have no DICM magic");
    },
  });
  const w = new WebFolderWatcher(store, parser, { now: () => 100_000, visible: () => visible, schedule: (fn) => (timers.push(fn), 0 as never), cancel: () => undefined });
  await w.init();
  assert.equal(w.snapshot()[0].status.state, "permission");
  await w.reconnect("wf-1");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(w.snapshot()[0].status.state, "watching");
  visible = false;
  const before = timers.length;
  timers.shift()?.();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(timers.length, before - 1, "hidden: the scheduled poll does not run or reschedule");
  w.dispose();
});

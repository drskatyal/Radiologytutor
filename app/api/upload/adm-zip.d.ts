// Minimal ambient types for `adm-zip` (the package ships no .d.ts). We only use
// a tiny slice of its API server-side to expand uploaded .zip archives.
declare module "adm-zip" {
  interface IZipEntry {
    entryName: string;
    isDirectory: boolean;
    getData(): Buffer;
  }
  class AdmZip {
    constructor(buffer?: Buffer);
    getEntries(): IZipEntry[];
  }
  export = AdmZip;
}

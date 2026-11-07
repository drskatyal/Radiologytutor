// Incremental scanner for a JSON array, so a WADO-RS metadata body can yield
// the opening instance before the rest of the payload has arrived.
//
// DICOM JSON instances are objects. Strings are tracked so a `}` inside a
// name does not end an object. The scanner keeps only the in-progress item.

export class JsonArrayScanner {
  private buffer = "";
  private index = 0;
  private depth = 0;
  private inString = false;
  private itemStart = -1;
  private started = false;
  done = false;

  /** Append a decoded chunk. Returns the objects completed by this append. */
  push(chunk: string): unknown[] {
    if (this.done || !chunk) return [];
    this.buffer += chunk;
    const items: unknown[] = [];
    while (this.index < this.buffer.length && !this.done) {
      const ch = this.buffer[this.index];
      if (this.inString) {
        if (ch === "\\") {
          if (this.index + 1 >= this.buffer.length) break;
          this.index += 2;
          continue;
        }
        if (ch === '"') this.inString = false;
        this.index += 1;
        continue;
      }
      if (ch === '"') {
        this.inString = true;
        this.index += 1;
        continue;
      }
      if (ch === "{" || ch === "[") {
        if (!this.started) {
          this.started = true;
          if (ch === "[") {
            this.depth = 1;
            this.index += 1;
            continue;
          }
          this.itemStart = this.index;
          this.depth = 1;
          this.index += 1;
          continue;
        }
        if (this.depth === 1 && ch === "{") this.itemStart = this.index;
        this.depth += 1;
        this.index += 1;
        continue;
      }
      if (ch === "}" || ch === "]") {
        if (this.depth === 0) {
          this.index += 1;
          continue;
        }
        this.depth -= 1;
        if (this.itemStart >= 0 && (this.depth === 1 || this.depth === 0)) {
          const slice = this.buffer.slice(this.itemStart, this.index + 1);
          this.itemStart = -1;
          items.push(JSON.parse(slice));
        }
        if (this.depth === 0) this.done = true;
        this.index += 1;
        continue;
      }
      this.index += 1;
    }
    this.compact();
    return items;
  }

  private compact(): void {
    const keepFrom = this.itemStart >= 0 ? this.itemStart : this.index;
    if (keepFrom < 65_536) return;
    this.buffer = this.buffer.slice(keepFrom);
    this.index -= keepFrom;
    if (this.itemStart >= 0) this.itemStart -= keepFrom;
  }
}

/** Parse `text`, optionally in small chunks, the way a fetch body arrives. */
export function parseJsonArrayChunks(text: string, chunkSize = text.length): unknown[] {
  const scanner = new JsonArrayScanner();
  const out: unknown[] = [];
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    out.push(...scanner.push(text.slice(offset, offset + chunkSize)));
  }
  return out;
}

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Persists window and layout state as one JSON file.
 *
 * Written when state changes, never on the way out: a quit handler is the least reliable
 * moment to do I/O, and the app must be able to be killed without losing the tab
 * arrangement. Writes are debounced so dragging a window edge does not produce a write
 * per frame, and atomic so an interrupted write cannot leave a half-file that fails to
 * parse on next launch.
 */
const WRITE_DEBOUNCE_MS = 250;

export interface WindowBounds {
  readonly width: number;
  readonly height: number;
  readonly x?: number;
  readonly y?: number;
  readonly maximized?: boolean;
}

export interface StoredState {
  readonly layout?: unknown;
  readonly window?: WindowBounds;
}

export class LayoutStore {
  readonly #file: string;
  #state: StoredState = {};
  #timer: NodeJS.Timeout | null = null;
  #writing: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  static in(userDataDir: string): LayoutStore {
    return new LayoutStore(join(userDataDir, "layout.json"));
  }

  /**
   * Reads stored state, returning `{}` for anything unreadable.
   *
   * A missing file is the normal first-launch case. A corrupt one is not worth an error
   * dialog either: the shape is validated downstream by `parseLayout`, and the worst
   * case is starting from a default arrangement.
   */
  async load(): Promise<StoredState> {
    try {
      const raw = await readFile(this.#file, "utf8");
      // A leading byte-order mark makes JSON.parse throw, which would silently reset the
      // layout to defaults. Anything that writes this file with a UTF-8 BOM — a text
      // editor, PowerShell's `-Encoding utf8` — would otherwise cost the arrangement.
      const parsed: unknown = JSON.parse(raw.replace(/^﻿/, ""));
      this.#state = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as StoredState)
        : {};
    } catch {
      this.#state = {};
    }
    return this.#state;
  }

  setLayout(layout: unknown): void {
    this.#state = { ...this.#state, layout };
    this.#schedule();
  }

  setWindow(bounds: WindowBounds): void {
    this.#state = { ...this.#state, window: bounds };
    this.#schedule();
  }

  /** Flushes any pending write. Used by tests; the app does not depend on it. */
  async flush(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
      this.#write();
    }
    await this.#writing;
  }

  #schedule(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#write();
    }, WRITE_DEBOUNCE_MS);
  }

  #write(): void {
    const snapshot = JSON.stringify(this.#state, null, 2);
    const temp = `${this.#file}.${randomUUID()}.tmp`;
    // Chained rather than concurrent: two overlapping writes could rename out of order
    // and leave the older state on disk.
    this.#writing = this.#writing
      .then(async () => {
        await writeFile(temp, snapshot, "utf8");
        await rename(temp, this.#file);
      })
      .catch(async () => {
        // A failed save costs the arrangement, never the session. The temp file is
        // cleaned up so a full disk does not accumulate them.
        try {
          await unlink(temp);
        } catch {
          // Nothing to clean up.
        }
      });
  }

  get directory(): string {
    return dirname(this.#file);
  }
}

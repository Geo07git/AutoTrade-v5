import fs from 'fs';
import path from 'path';

const STORE_PATH = path.join(process.cwd(), '.data');

function ensureStoreDir() {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      fs.mkdirSync(STORE_PATH, { recursive: true });
    }
  } catch {
    // Ignore if already created concurrently
  }
}

ensureStoreDir();

// Every store is flushed synchronously on process exit so debounced writes are never lost.
const liveStores = new Set<{ flushSync(): void }>();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const st of liveStores) {
      try { st.flushSync(); } catch { /* best effort */ }
    }
  });
}

/** Flush every pending store write now (call from shutdown handlers). */
export function flushAllStores() {
  for (const st of liveStores) {
    try { st.flushSync(); } catch { /* best effort */ }
  }
}

const SAVE_DEBOUNCE_MS = 200;

export class JsonStore<T> {
  private filePath: string;
  private data: T;
  private defaultData: T;
  private dirty = false;
  private timer?: NodeJS.Timeout;

  constructor(filename: string, defaultData: T) {
    this.filePath = path.join(STORE_PATH, filename);
    this.defaultData = defaultData;
    this.data = this.load();
    liveStores.add(this);
    hookExit();
  }

  private load(): T {
    ensureStoreDir();
    if (fs.existsSync(this.filePath)) {
      try {
        const fileContent = fs.readFileSync(this.filePath, 'utf-8');
        return JSON.parse(fileContent) as T;
      } catch (err) {
        console.warn(`[JsonStore] Warning loading store ${this.filePath}, using defaults:`, err);
        return this.defaultData;
      }
    }
    this.data = this.defaultData;
    this.dirty = true;
    this.flushSync();
    return this.defaultData;
  }

  /**
   * Coalesced save: callers invoke save() several times per second (every 2.5s risk pass, every tick, every order
   * event) with the full orders/positions arrays. Writing synchronously each time blocked the event loop that runs the
   * stop-loss monitor. State is kept in memory (get() is always current) and persisted at most once per
   * SAVE_DEBOUNCE_MS, atomically (tmp file + rename) so a crash can never leave a truncated JSON file.
   */
  public save(data?: T) {
    if (data !== undefined) {
      this.data = data;
    }
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushSync();
    }, SAVE_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  public flushSync() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      ensureStoreDir();
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn(`[JsonStore] Warning saving store ${this.filePath}:`, err);
    }
  }

  public get(): T {
    return this.data;
  }

  public set(data: T) {
    this.data = data;
    this.save();
  }

  public clear() {
    this.data = Array.isArray(this.defaultData)
      ? ([] as unknown as T)
      : typeof this.defaultData === 'object' && this.defaultData !== null
      ? ({ ...this.defaultData } as T)
      : this.defaultData;
    this.save();
  }
}

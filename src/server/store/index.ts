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

export class JsonStore<T> {
  private filePath: string;
  private data: T;
  private defaultData: T;

  constructor(filename: string, defaultData: T) {
    this.filePath = path.join(STORE_PATH, filename);
    this.defaultData = defaultData;
    this.data = this.load();
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
    this.save(this.defaultData);
    return this.defaultData;
  }

  public save(data?: T) {
    if (data !== undefined) {
      this.data = data;
    }
    try {
      ensureStoreDir();
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
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

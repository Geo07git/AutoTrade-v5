import fs from 'fs';
import path from 'path';

const STORE_PATH = path.join(process.cwd(), '.data');

if (!fs.existsSync(STORE_PATH)) {
  fs.mkdirSync(STORE_PATH, { recursive: true });
}

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
    if (fs.existsSync(this.filePath)) {
      try {
        const fileContent = fs.readFileSync(this.filePath, 'utf-8');
        return JSON.parse(fileContent) as T;
      } catch (err) {
        console.error(`Error loading store ${this.filePath}:`, err);
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
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  public get(): T {
    return this.data;
  }

  public set(data: T) {
    this.data = data;
    this.save();
  }
}

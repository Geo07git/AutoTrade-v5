import fs from 'fs';
import path from 'path';

/**
 * Scrie un fisier astfel incat un kill brutal sa nu poata lasa un fisier trunchiat.
 *
 * `fs.writeFileSync` trunceaza tinta INTAI, apoi scrie: daca procesul moare la mijloc
 * (Stop-Process -Force = TerminateProcess, fara handlere de semnal, sau pana de curent),
 * pe disc ramane JSON partial. La boot urmator `JSON.parse` arunca, codul cade pe valorile
 * implicite si se pierd tacut credentiale / setari / istoric.
 *
 * Scrierea intr-un fisier temporar sora + `rename` este atomica pe NTFS si pe POSIX:
 * cititorii vad fie fisierul vechi complet, fie pe cel nou complet, niciodata jumatate.
 */
export function writeFileAtomic(
  filePath: string,
  contents: string | Buffer,
  encoding: BufferEncoding = 'utf8'
): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Numele tmp include PID-ul: doua procese care scriu acelasi fisier nu se calca reciproc,
  // iar resturile `.tmp` nu sunt niciodata citite la boot (nu au numele fisierului real).
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, contents, encoding);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // curatenia e best effort; eroarea reala se propaga mai jos
    }
    throw err;
  }
}

/** Aceeasi garantie ca `writeFileAtomic`, pentru stari JSON persistate. */
export function writeJsonAtomic(filePath: string, data: unknown, space: number = 2): void {
  writeFileAtomic(filePath, JSON.stringify(data, null, space));
}

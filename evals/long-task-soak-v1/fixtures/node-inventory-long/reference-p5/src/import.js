// Imports a stock CSV file through the library.
import { readFile } from 'node:fs/promises';

export async function importFile(inventory, file, options = {}) {
  return inventory.importCsv(await readFile(file, 'utf8'), options);
}

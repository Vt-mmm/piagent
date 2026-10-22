import { readFileSync } from 'node:fs';

const fixtures = new URL('../../../shared/contracts/fixtures/', import.meta.url);
export const sample = name => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));

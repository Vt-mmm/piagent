export type BenchmarkLedgerBinding = { schemaVersion: 1; algorithm: string; digest: string; records: number; bytes: number };
export function inspectBenchmarkLedger(file: string): { binding: BenchmarkLedgerBinding; records: unknown[]; raw: Buffer };
export function assertBenchmarkLedgerBinding(expected: unknown, observed: unknown, label?: string): BenchmarkLedgerBinding;
export function validateBenchmarkLedgerPrefix(records: unknown[], order: unknown[], completedRecord: (record: unknown) => boolean): Set<string>;

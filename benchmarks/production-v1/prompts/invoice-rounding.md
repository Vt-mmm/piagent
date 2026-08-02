Repair `invoiceTotalCents(lines, taxBps)` in `src/backend/invoice.js`.

All values are integer cents or basis points. For each line, multiply
`unitCents` by the positive integer `quantity` (default 1), then apply that
line's `discountBps` (default 0) and round to the nearest cent. Sum the line
totals, apply `taxBps` once, and round once more. Reject negative/non-integer
money or quantity inputs with `TypeError`; also reject discount or tax basis
points outside the inclusive 0 through 10,000 range. Do not change the exported
API. Run the configured verification.

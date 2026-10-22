// Builds a legacy report function from a computation and an output format.
import * as stock from './compute-stock.js';
import * as time from './compute-time.js';
import * as render from './render.js';

const COMPUTE = { ...stock, ...time };

export function report(name, format) {
  const compute = COMPUTE[name], draw = render['render_' + format];
  return function (rows, opts) { return draw(compute(rows || [], opts || {}, format)); };
}

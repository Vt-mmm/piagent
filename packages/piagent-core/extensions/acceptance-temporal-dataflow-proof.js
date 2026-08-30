import { evidenceBooleanAlgebra, parseEvidenceStatements } from "./acceptance-expression-parser.js";

const term = (kind, ...values) => [kind, ...values];
const key = (value) => JSON.stringify(value);
const same = (left, right) => key(left) === key(right);
const number = (value) => term("number", value);
const part = (name) => term("part", name);
const INPUT = term("input"), UNDEFINED = term("undefined"), ZONE = part("zone");
const YEAR = part("year"), MONTH = part("month"), DAY = part("day");
const HOUR = part("hour"), MINUTE = part("minute"), SECOND = part("second");
const DAYS = part("days-in-month"), MILLISECOND = part("millisecond");
const OFFSET_HOUR = part("offset-hour"), OFFSET_MINUTE = part("offset-minute");
const RESERVED = /^(?:Date|Number|TypeError|RegExp|NaN|undefined|arguments|__pi_)/i;
const REGEX_FRACTIONS = new Map([
  ["__pi_strict_iso_timestamp_optional_seconds_capturing_fraction_regex_literal__", "digits"],
  ["__pi_strict_iso_timestamp_optional_seconds_dot_fraction_regex_literal__", "dot"]
]);
const LITERALS = new Map([
  ["__pi_empty_string_literal__", ""], ["__pi_two_digit_zero_string_literal__", "00"],
  ["__pi_millisecond_padding_string_literal__", "000"], ["__pi_positive_sign_string_literal__", "+"],
  ["__pi_utc_z_string_literal__", "Z"], ["__pi_typeof_string_literal__", "string"],
  ["__pi_typeof_number_literal__", "number"]
]);
const fail = (reason = "unsupported-temporal-dataflow") => { throw new Error(reason); };
const leapYear = (year) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

function temporalModel(mode, helperNames = {}) {
  const logic = evidenceBooleanAlgebra();
  const boolean = (value) => term("boolean", value);
  const atom = (name) => logic.atom(name);
  const isString = atom("input:string"), isDate = atom("input:date"), isNumber = atom("input:number");
  const matched = atom("input:strict-iso-match"), dateFinite = atom("input:date-finite");
  const omitted = atom("public:omitted-now"), zoneZ = atom("zone:Z"), zonePlus = atom("zone:positive");
  const dateValid = logic.and(isDate, dateFinite), numberValid = logic.and(isNumber, atom("input:number-finite"));
  let assumptions = logic.not(logic.or(logic.and(isString, isDate), logic.and(isString, isNumber), logic.and(isDate, isNumber)));
  const asBoolean = (value) => value?.[0] === "boolean" ? value[1]
    : value?.[0] === "match" ? matched : fail("unproven-temporal-condition");
  function comparison(operator, left, right) {
    if (operator === "!==") return logic.not(comparison("===", left, right));
    if (operator === ">") return comparison("<", right, left);
    if (operator === ">=") return comparison("<=", right, left);
    if (operator === "<" && left[0] === "arguments-length" && same(right, number(2))) return omitted;
    if (operator === "<") return logic.not(comparison("<=", right, left));
    if (left[0] === "choose") return logic.or(logic.and(left[1], comparison(operator, left[2], right)), logic.and(logic.not(left[1]), comparison(operator, left[3], right)));
    if (right[0] === "choose") return logic.or(logic.and(right[1], comparison(operator, left, right[2])), logic.and(logic.not(right[1]), comparison(operator, left, right[3])));
    if (left[0] === "number" && right[0] === "number") return Number(operator === "<" ? left[1] < right[1] : operator === "<=" ? left[1] <= right[1] : left[1] === right[1]);
    if (operator === "===") {
      if (same(left, right)) return 1;
      if (left[0] === "typeof" && same(left[1], INPUT) && right[0] === "string") return right[1] === "string" ? isString : right[1] === "number" ? isNumber : fail();
      if (right[0] === "typeof") return comparison(operator, right, left);
      if (same(left, ZONE) && same(right, term("string", "Z"))) return zoneZ;
      if (same(right, ZONE)) return comparison(operator, right, left);
      if (left[0] === "optional-second" && same(right, UNDEFINED)) return atom("capture:second-missing");
      if (left[0] === "optional-fraction" && same(right, UNDEFINED)) return atom("capture:fraction-missing");
    }
    return atom(key([operator, left, right]));
  }
  const arithmetic = (operator, left, right) => {
    if (operator === "+" && same(left, term("fraction-digits")) && same(right, term("string", "000"))) return term("padded-fraction");
    if (operator === "*" && same(left, number(60)) && same(right, OFFSET_HOUR)) return term("offset-hours-in-minutes");
    if (operator === "*" && same(left, OFFSET_HOUR) && same(right, number(60))) return term("offset-hours-in-minutes");
    if (operator === "+" && ((left[0] === "offset-hours-in-minutes" && same(right, OFFSET_MINUTE)) || (right[0] === "offset-hours-in-minutes" && same(left, OFFSET_MINUTE)))) return term("offset-minutes");
    if (operator === "*" && left[0] === "signed-offset-minutes" && same(right, number(60000))) return term("signed-offset-milliseconds");
    if (operator === "*" && right[0] === "signed-offset-minutes" && same(left, number(60000))) return term("signed-offset-milliseconds");
    if (operator === "-" && left[0] === "local-milliseconds" && right[0] === "signed-offset-milliseconds") return term("iso-time");
    return term("arithmetic", operator, left, right);
  };
  const modulo = (divisor) => arithmetic("%", YEAR, number(divisor));
  const leap = logic.and(comparison("===", modulo(4), number(0)), logic.or(comparison("!==", modulo(100), number(0)), comparison("===", modulo(400), number(0))));
  const calendarValid = logic.and(comparison("<=", number(1), MONTH), comparison("<=", MONTH, number(12)), comparison("<=", number(1), DAY), comparison("<=", DAY, DAYS), comparison("<=", HOUR, number(23)), comparison("<=", MINUTE, number(59)), comparison("<=", SECOND, number(59)));
  const zoneValid = logic.or(zoneZ, logic.and(comparison("<=", OFFSET_HOUR, number(23)), comparison("<=", OFFSET_MINUTE, number(59))));
  const stringValid = logic.and(isString, matched, calendarValid, zoneValid);
  const implies = (path, required) => logic.implies(logic.and(assumptions, path), required);
  function choose(condition, yes, no) {
    if (condition === 1 || same(yes, no)) return yes;
    if (condition === 0) return no;
    if (condition === atom("capture:second-missing") && same(yes, number(0)) && no[0] === "optional-second-number") return SECOND;
    if (condition === atom("capture:second-missing") && same(yes, term("string", "00")) && no[0] === "optional-second") return term("capture", "second");
    if (condition === atom("capture:fraction-missing") && same(yes, term("string", "")) && no[0] === "optional-fraction") return term(no[1] === "dot" ? "fraction-dot" : "fraction-digits");
    if (condition === logic.and(comparison("===", MONTH, number(2)), leap) && same(yes, number(29)) && no[0] === "nonleap-month-days") return DAYS;
    if (condition === zoneZ && same(yes, number(0)) && no[0] === "offset-minutes") return term("zone-offset-minutes");
    if (condition === zonePlus && ["offset-minutes", "zone-offset-minutes"].includes(yes[0]) && same(no, term("negative", yes))) return term("signed-offset-minutes");
    if (mode === "public" && condition === omitted && yes[0] === "clock" && no[0] === "current-time") return term("current-time");
    return term("choose", condition, yes, no);
  }
  const captures = (match, slot, state) => {
    if (match?.[0] !== "match" || !implies(state.path, matched)) fail("iso-capture-provenance-unproven");
    if (slot >= 1 && slot <= 5) return term("capture", ["year", "month", "day", "hour", "minute"][slot - 1]);
    if (slot === 6) return term("optional-second");
    if (slot === 7) return term("optional-fraction", match[1]);
    if (slot === 8) return ZONE;
    fail("iso-capture-topology-unproven");
  };
  const defaulted = (value, fallback) => {
    if (value[0] === "optional-second" && (same(fallback, term("string", "00")) || same(fallback, number(0)))) return term("capture", "second");
    if (value[0] === "optional-fraction" && same(fallback, term("string", ""))) return term(value[1] === "dot" ? "fraction-dot" : "fraction-digits");
    fail("iso-capture-default-unproven");
  };
  let allocations = 0, steps = 0, expiryCoverage = 0, nowCoverage = 0, clockCoverage = 0;
  const visited = new Set();
  const withPath = (state, path, action) => { const previous = state.path; state.path = logic.and(previous, path); try { return action(); } finally { state.path = previous; } };
  const publicArgument = (value, path) => {
    if (value[0] === "choose") return publicArgument(value[2], logic.and(path, value[1])) && publicArgument(value[3], logic.and(path, logic.not(value[1])));
    return value[0] === "clock" ? implies(path, omitted) : value[0] === "now-input" && implies(path, logic.not(omitted));
  };
  const cover = (previous, path) => { if (!implies(logic.and(previous, path), 0)) fail("duplicate-temporal-effect"); return logic.or(previous, path); };
  function evaluate(node, state) {
    if (++steps > 5000) fail("temporal-proof-complexity-limit");
    const [kind, a, b, c] = node;
    if (kind === "number") return node;
    if (kind === "id") {
      if (state.env.has(a)) return state.env.get(a);
      if (LITERALS.has(a)) return term("string", LITERALS.get(a));
      if (REGEX_FRACTIONS.has(a)) return term("regex", REGEX_FRACTIONS.get(a));
      if (/^__pi_[a-z0-9_]*string_literal__$/.test(a)) return term("static-message");
      if (["Date", "Number", "TypeError", "arguments"].includes(a)) return term("intrinsic", a);
      if (a === "undefined") return UNDEFINED;
      if (a === "true" || a === "false") return boolean(Number(a === "true"));
      fail("unbound-temporal-identifier");
    }
    if (kind === "unary") {
      const value = evaluate(b, state);
      return a === "!" ? boolean(logic.not(asBoolean(value))) : a === "typeof" ? term("typeof", value) : term("negative", value);
    }
    if (kind === "binary") {
      const left = evaluate(b, state);
      if (a === "&&" || a === "||") {
        const condition = asBoolean(left), right = withPath(state, a === "&&" ? condition : logic.not(condition), () => asBoolean(evaluate(c, state)));
        return boolean(a === "&&" ? logic.and(condition, right) : logic.or(condition, right));
      }
      const right = evaluate(c, state);
      if (a === "instanceof") return same(left, INPUT) && same(right, term("intrinsic", "Date")) ? boolean(isDate) : fail();
      return ["===", "!==", "<", "<=", ">", ">="].includes(a) ? boolean(comparison(a, left, right)) : arithmetic(a, left, right);
    }
    if (kind === "select") {
      const condition = asBoolean(evaluate(a, state));
      const yes = withPath(state, condition, () => evaluate(b, state)), no = withPath(state, logic.not(condition), () => evaluate(c, state));
      return choose(condition, yes, no);
    }
    if (kind === "array") return term("array", a.map((item) => evaluate(item, state)));
    if (kind === "index") {
      const base = evaluate(a, state), index = evaluate(b, state);
      if (base[0] === "match" && index[0] === "number") return captures(base, index[1], state);
      const table = [31, choose(leap, number(29), number(28)), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].map((value) => typeof value === "number" ? number(value) : value);
      if (same(base, term("array", table)) && same(index, arithmetic("-", MONTH, number(1)))) return DAYS;
      fail("calendar-binding-unproven");
    }
    if (kind === "member") {
      if (same(evaluate(a, state), term("intrinsic", "arguments")) && b === "length") return term("arguments-length");
      fail();
    }
    if (kind === "new") {
      if (!same(evaluate(a, state), term("intrinsic", "Date")) || b.length !== 1) fail();
      const value = evaluate(b[0], state);
      if (value[0] !== "utc") fail();
      const id = ++allocations; state.heap.set(id, value); return term("owned-date", id);
    }
    if (kind !== "call") fail();
    if (a[0] === "id" && Object.values(helperNames).includes(a[1])) {
      if (b.length !== 1) fail();
      const value = evaluate(b[0], state);
      if (a[1] === helperNames.expiry) {
        if (value[0] !== "expiry-input") fail("expiry-input-provenance-unproven");
        expiryCoverage = cover(expiryCoverage, state.path); return term("expiry-time");
      }
      if (!publicArgument(value, state.path)) fail("explicit-now-provenance-unproven");
      nowCoverage = cover(nowCoverage, state.path); return term("current-time");
    }
    if (a[0] === "id" && a[1] === "Number") {
      if (b.length !== 1) fail();
      const value = evaluate(b[0], state);
      if (value[0] === "capture") return part(value[1]);
      if (value[0] === "optional-second") return term("optional-second-number");
      if (value[0] === "offset-hour-text") return OFFSET_HOUR;
      if (value[0] === "offset-minute-text") return OFFSET_MINUTE;
      if (value[0] === "millisecond-text") return MILLISECOND;
      fail("numeric-capture-provenance-unproven");
    }
    if (a[0] !== "member") fail();
    const receiver = evaluate(a[1], state), member = a[2], args = b.map((item) => evaluate(item, state));
    if (receiver[0] === "intrinsic") {
      if (receiver[1] === "Number" && ["isFinite", "isNaN"].includes(member) && args.length === 1) {
        if (same(args[0], INPUT) && member === "isFinite") return boolean(numberValid);
        if (args[0][0] === "date-time") return boolean(member === "isFinite" ? dateFinite : logic.not(dateFinite));
        if (args[0][0] === "iso-time") {
          const finite = atom("parse:finite");
          assumptions = logic.and(assumptions, logic.or(logic.not(stringValid), finite));
          return boolean(member === "isFinite" ? finite : logic.not(finite));
        }
      }
      if (receiver[1] === "Date" && member === "parse" && args.length === 1 && same(args[0], INPUT)) return term("iso-time");
      if (receiver[1] === "Date" && member === "UTC" && [3, 7].includes(args.length)) return term("utc", ...args);
      if (receiver[1] === "Date" && member === "now" && args.length === 0 && mode === "public") {
        if (!implies(state.path, omitted)) fail("eager-clock-fallback-unproven");
        clockCoverage = cover(clockCoverage, state.path); return term("clock");
      }
      fail();
    }
    if (member === "exec" && receiver[0] === "regex" && args.length === 1 && same(args[0], INPUT)) {
      if (!implies(state.path, isString)) fail("iso-input-type-unproven");
      return term("match", receiver[1]);
    }
    if (member === "match" && same(receiver, INPUT) && args.length === 1 && args[0][0] === "regex") {
      if (!implies(state.path, isString)) fail("iso-input-type-unproven");
      return term("match", args[0][1]);
    }
    if (member === "getTime" && args.length === 0 && same(receiver, INPUT)) {
      if (!implies(state.path, isDate)) fail("date-input-type-unproven");
      return term("date-time");
    }
    if (receiver[0] === "owned-date") {
      const value = state.heap.get(receiver[1]);
      if (member === "getUTCDate" && args.length === 0 && value.length === 4 && value[1][0] === "number" && value[1][1] >= 100 && value[1][1] <= 9999 && !leapYear(value[1][1]) && same(value[2], MONTH) && same(value[3], number(0))) return term("nonleap-month-days");
      if (member === "getTime" && args.length === 0 && value[0] === "proleptic-utc") return term("local-milliseconds");
      fail("proleptic-year-unproven");
    }
    if (member === "slice") {
      if (same(receiver, ZONE) && same(args, [number(1), number(3)])) return term("offset-hour-text");
      if (same(receiver, ZONE) && (same(args, [number(4)]) || same(args, [number(4), number(6)]))) return term("offset-minute-text");
      if (receiver[0] === "fraction-dot" && same(args, [number(1)])) return term("fraction-digits");
      if (receiver[0] === "padded-fraction" && same(args, [number(0), number(3)])) return term("millisecond-text");
      fail("zone-or-fraction-capture-unproven");
    }
    if (member === "startsWith" && same(receiver, ZONE) && same(args, [term("string", "+")])) return boolean(zonePlus);
    fail();
  }
  const bind = (state, name, value) => {
    if (RESERVED.test(name) || Object.values(helperNames).some((known) => known.toLowerCase() === name.toLowerCase()) || [...state.env.keys()].some((known) => known.toLowerCase() === name.toLowerCase())) fail("temporal-binding-collision");
    state.env.set(name, value);
  };
  const clone = (state, condition) => ({ ...state, env: new Map(state.env), heap: new Map(state.heap), path: logic.and(state.path, condition) });
  function execute(statements, states) {
    for (const statement of statements) {
      const next = [];
      for (const state of states) {
        if (state.terminal || state.path === 0) { next.push(state); continue; }
        visited.add(statement);
        const [kind, a, b, c] = statement;
        if (kind === "block") { next.push(...execute(a, [state])); continue; }
        if (kind === "if") {
          const condition = asBoolean(evaluate(a, state));
          next.push(...execute([b], [clone(state, condition)]), ...execute([c], [clone(state, logic.not(condition))]));
          continue;
        }
        if (kind === "const") {
          for (const [binding, expression] of a) {
            const value = evaluate(expression, state);
            if (binding[0] === "bind") bind(state, binding[1], value);
            else binding[1].forEach((slot, index) => {
              if (slot) bind(state, slot[0], slot[1] ? defaulted(captures(value, index, state), evaluate(slot[1], state)) : captures(value, index, state));
            });
          }
        } else if (kind === "return") { state.terminal = "return"; state.value = evaluate(a, state); }
        else if (kind === "throw") {
          if (a[0] !== "new" || !same(a[1], ["id", "TypeError"]) || a[2].length > 1 || a[2].some((arg) => arg[0] !== "id" || !/^__pi_[a-z0-9_]*(?:string|number)_literal__$/.test(arg[1]))) fail("typeerror-rejection-unproven");
          state.terminal = "throw";
        } else if (kind === "expression") {
          if (a[0] !== "call" || a[1][0] !== "member" || a[1][2] !== "setUTCFullYear" || a[2].length !== 1) fail("unapproved-temporal-effect");
          const receiver = evaluate(a[1][1], state), year = evaluate(a[2][0], state), value = state.heap.get(receiver[1]);
          const calendarArgs = [arithmetic("-", MONTH, number(1)), DAY, HOUR, MINUTE, SECOND, MILLISECOND];
          if (receiver[0] !== "owned-date" || value?.[0] !== "utc" || value[1]?.[0] !== "number" || value[1][1] < 100 || value[1][1] > 9999 || !leapYear(value[1][1]) || !same(value.slice(2), calendarArgs) || !same(year, YEAR)) fail("proleptic-year-unproven");
          state.heap.set(receiver[1], term("proleptic-utc", ...calendarArgs));
        } else fail();
        next.push(state);
      }
      states = next;
      if (states.length > 128) fail("temporal-proof-complexity-limit");
    }
    return states;
  }
  function prove(callable) {
    const parameters = callable.exactParameters;
    const ast = parseEvidenceStatements(callable.exactBody);
    const state = { path: 1, env: new Map(parameters.map((name, index) => [name, mode === "public" ? term(index === 0 ? "expiry-input" : "now-input") : INPUT])), heap: new Map() };
    const results = execute(ast, [state]).filter((item) => item.path !== 0);
    let success = 0;
    for (const result of results) {
      if (!result.terminal) fail("unterminated-temporal-path");
      if (result.terminal === "throw") { if (mode === "public") fail(); continue; }
      let domain;
      if (mode === "public") {
        const expected = boolean(comparison("<=", term("expiry-time"), term("current-time")));
        if (!same(result.value, expected)) fail("inclusive-temporal-return-unproven");
        domain = 1;
      } else if (result.value[0] === "date-time") domain = dateValid;
      else if (mode === "expiry" && result.value[0] === "iso-time") domain = stringValid;
      else if (mode === "now" && same(result.value, INPUT)) domain = numberValid;
      else fail("temporal-return-provenance-unproven");
      if (!implies(result.path, domain)) fail(mode === "expiry" ? "calendar-or-zone-validation-unproven" : "finite-now-validation-unproven");
      success = logic.or(success, result.path);
    }
    const expected = mode === "public" ? 1 : logic.or(dateValid, mode === "expiry" ? stringValid : numberValid);
    if (!implies(expected, success)) fail("valid-temporal-input-rejected");
    if (mode === "public" && (!implies(1, expiryCoverage) || !implies(logic.not(omitted), nowCoverage) || !implies(omitted, clockCoverage))) fail("public-temporal-normalization-unproven");
    const everyStatementVisited = (items) => items.every((item) => (visited.has(item) || (item[0] === "block" && item[1].length === 0)) && (item[0] !== "block" || everyStatementVisited(item[1])) && (item[0] !== "if" || everyStatementVisited([item[2], item[3]])));
    if (!everyStatementVisited(ast)) fail("unreachable-temporal-statement");
    return true;
  }
  return { prove };
}

/**
 * Closed temporal helpers are proved by dataflow and all Boolean paths. Capture
 * topology, calendar bounds, proleptic reconstruction, error class and lazy
 * omission handling are independent obligations, not a source-text template.
 */
export function temporalDataflowModuleProof(bodies, publicName) {
  try {
    const declarations = bodies.exactDeclarations ?? [];
    const helpers = declarations.filter((item) => item.name !== publicName).map((item) => bodies.get(item.name.toLowerCase()));
    if (helpers.length !== 2) fail("closed-temporal-module-unproven");
    const expiry = helpers.filter((item) => [...REGEX_FRACTIONS.keys()].some((regex) => item.exactBody.includes(regex)));
    if (expiry.length !== 1) fail("iso-capture-topology-unproven");
    const now = helpers.find((item) => item !== expiry[0]);
    temporalModel("expiry").prove(expiry[0]);
    temporalModel("now").prove(now);
    temporalModel("public", { expiry: expiry[0].exactDeclarationName, now: now.exactDeclarationName }).prove(bodies.get(publicName.toLowerCase()));
    return { proven: true, reasons: [], expiry: expiry[0], now };
  } catch (error) {
    return { proven: false, reasons: [error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : "unsupported-temporal-dataflow"] };
  }
}

import { evidenceBooleanAlgebra, parseEvidenceStatements } from "./acceptance-expression-parser.js";

const term = (kind, ...values) => [kind, ...values];
const key = (value) => JSON.stringify(value);
const same = (left, right) => key(left) === key(right);
const number = (value) => term("number", value);
const part = (name) => term("part", name);
const INPUT = term("input"), UNDEFINED = term("undefined"), ZONE = part("zone");
const ABRUPT = term("abrupt");
const INTRINSIC_DATE_GET_TIME = ["member", ["member", ["member", ["id", "Date"], "prototype"], "getTime"], "call"];
const containsDateReference = (value) => /"(?:owned-date|date-view)"/.test(key(value));
const YEAR = part("year"), MONTH = part("month"), DAY = part("day");
const HOUR = part("hour"), MINUTE = part("minute"), SECOND = part("second");
const DAYS = part("days-in-month"), MILLISECOND = part("millisecond");
const OFFSET_HOUR = part("offset-hour"), OFFSET_MINUTE = part("offset-minute");
const RESERVED = /^(?:Date|Number|Math|TypeError|RegExp|NaN|undefined|arguments)$|^__pi_/;
const REGEX_FRACTIONS = new Map([
  ["__pi_strict_iso_timestamp_optional_seconds_capturing_fraction_regex_literal__", "digits"],
  ["__pi_strict_iso_timestamp_optional_seconds_dot_fraction_regex_literal__", "dot"]
]);
const LITERALS = new Map([
  ["__pi_empty_string_literal__", ""], ["__pi_zero_string_literal__", "0"], ["__pi_two_digit_zero_string_literal__", "00"],
  ["__pi_millisecond_padding_string_literal__", "000"], ["__pi_positive_sign_string_literal__", "+"],
  ["__pi_negative_sign_string_literal__", "-"],
  ["__pi_utc_z_string_literal__", "Z"], ["__pi_typeof_string_literal__", "string"],
  ["__pi_typeof_number_literal__", "number"]
]);
const fail = (reason = "unsupported-temporal-dataflow") => { throw new Error(reason); };
const leapYear = (year) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

function proveTypeError(expression) {
  if (expression[0] !== "new" || !same(expression[1], ["id", "TypeError"]) || expression[2].length > 1) fail("typeerror-rejection-unproven");
  // Template markers deliberately retain no claim that interpolation is pure.
  // Coercing an invalid Date can execute user code before TypeError exists.
  if (expression[2].some((arg) => arg[0] !== "id" || !/^__pi_[a-z0-9_]*(?:string|number)_literal__$/.test(arg[1]))) fail("rejection-message-effect-unproven");
}

function temporalModel(mode, helperNames = {}, graph = new Map(), budget = { remaining: 15000 }) {
  const logic = evidenceBooleanAlgebra();
  const boolean = (value) => term("boolean", value);
  const atom = (name) => logic.atom(name);
  const isString = atom("input:string"), isDate = atom("input:date"), isNumber = atom("input:number");
  const matched = atom("input:strict-iso-match"), dateFinite = atom("input:date-finite");
  const omitted = atom("public:omitted-now"), noArguments = atom("public:no-arguments");
  const zoneZ = atom("zone:Z"), zonePlus = logic.and(logic.not(zoneZ), atom("zone:positive"));
  const zoneMinus = logic.and(logic.not(zoneZ), logic.not(zonePlus));
  const dateValid = logic.and(isDate, dateFinite), numberValid = logic.and(isNumber, atom("input:number-finite"));
  let assumptions = logic.not(logic.or(logic.and(isString, isDate), logic.and(isString, isNumber), logic.and(isDate, isNumber)));
  assumptions = logic.and(assumptions, logic.or(logic.not(noArguments), omitted));
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
      if (left[0] === "arguments-length" && same(right, number(1))) return logic.and(omitted, logic.not(noArguments));
      if (left[0] === "arguments-length" && same(right, number(0))) return noArguments;
      if (right[0] === "arguments-length") return comparison(operator, right, left);
      if (left[0] === "typeof" && same(left[1], INPUT) && right[0] === "string") return right[1] === "string" ? isString : right[1] === "number" ? isNumber : fail();
      if (right[0] === "typeof") return comparison(operator, right, left);
      if (same(left, ZONE) && same(right, term("string", "Z"))) return zoneZ;
      if (same(right, ZONE)) return comparison(operator, right, left);
      if (left[0] === "zone-sign" && right[0] === "string") return right[1] === "+" ? zonePlus : right[1] === "-" ? zoneMinus : right[1] === "Z" ? zoneZ : fail();
      if (right[0] === "zone-sign") return comparison(operator, right, left);
      if (left[0] === "calendar-roundtrip" && same(right, left[2])) return atom(`roundtrip:${left[1]}`);
      if (right[0] === "calendar-roundtrip") return comparison(operator, right, left);
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
  assumptions = logic.and(assumptions, logic.or(logic.not(calendarValid), comparison("<=", DAY, number(31))));
  const implies = (path, required) => logic.implies(logic.and(assumptions, path), required);
  const timeValid = logic.and(comparison("<=", HOUR, number(23)), comparison("<=", MINUTE, number(59)), comparison("<=", SECOND, number(59)));
  const civilComponents = () => [YEAR, arithmetic("-", MONTH, number(1)), DAY, HOUR, MINUTE, SECOND, MILLISECOND];
  const civilCalendar = (value) => value?.[0] === "civil-date" && same(value.slice(1), civilComponents());
  function calendarRoundtrip(member, value, state) {
    if (!civilCalendar(value) || !implies(state.path, timeValid)) fail("calendar-roundtrip-unproven");
    const fields = { getUTCFullYear: ["year", YEAR], getUTCMonth: ["month", arithmetic("-", MONTH, number(1))], getUTCDate: ["day", DAY] };
    if (!fields[member]) fail();
    const allEqual = logic.and(...Object.values(fields).map(([name]) => atom(`roundtrip:${name}`)));
    // Under bounded time fields, all three UTC calendar fields round-trip iff
    // the requested civil date exists. Each equality alone is insufficient.
    assumptions = logic.and(assumptions, logic.or(logic.not(allEqual), calendarValid), logic.or(logic.not(calendarValid), allEqual));
    return term("calendar-roundtrip", ...fields[member]);
  }
  function linearTime(value, path, sign) {
    const bounded = (coefficients, bound) => Number.isSafeInteger(bound) && bound <= Number.MAX_SAFE_INTEGER
      && [...coefficients.values()].every(Number.isSafeInteger) ? { coefficients, bound } : null;
    const scalar = (value) => bounded(new Map(value === 0 ? [] : [["constant", value]]), Math.abs(value));
    const variable = (name, bound) => bounded(new Map([[name, 1]]), bound);
    const scale = (value, factor) => value && Number.isSafeInteger(factor)
      ? bounded(new Map([...value.coefficients].map(([name, coefficient]) => [name, coefficient * factor]).filter(([, coefficient]) => coefficient !== 0)), value.bound * Math.abs(factor)) : null;
    const sum = (left, right) => {
      if (!left || !right) return null;
      const coefficients = new Map(left.coefficients);
      for (const [name, coefficient] of right.coefficients) coefficients.set(name, (coefficients.get(name) ?? 0) + coefficient);
      return bounded(new Map([...coefficients].filter(([, coefficient]) => coefficient !== 0)), left.bound + right.bound);
    };
    const constant = (value) => value && [...value.coefficients.keys()].every((name) => name === "constant") ? value.coefficients.get("constant") ?? 0 : null;
    const cache = new Map();
    const visit = (item) => {
      if (++steps > 5000 || --budget.remaining < 0) fail("temporal-proof-complexity-limit");
      if (cache.has(item)) return cache.get(item);
      const result = calculate(item);
      cache.set(item, result);
      return result;
    };
    const calculate = (item) => {
      if (item[0] === "number") return scalar(item[1]);
      if (item[0] === "local-milliseconds") return variable("local", 400_000_000_000_000);
      if (same(item, OFFSET_HOUR)) return variable("hour", 99);
      if (same(item, OFFSET_MINUTE)) return variable("minute", 99);
      if (item[0] === "offset-hours-in-minutes") return scale(variable("hour", 99), 60);
      if (item[0] === "iso-time") return sum(variable("local", 400_000_000_000_000), scale(sum(scale(variable("hour", 99), 60), variable("minute", 99)), -sign * 60000));
      if (["offset-minutes", "zone-offset-minutes", "signed-offset-minutes", "signed-offset-milliseconds"].includes(item[0])) {
        const offset = sum(scale(variable("hour", 99), 60), variable("minute", 99));
        return item[0] === "offset-minutes" ? offset : item[0] === "zone-offset-minutes" ? scale(offset, sign === 0 ? 0 : 1)
          : scale(offset, sign * (item[0] === "signed-offset-milliseconds" ? 60000 : 1));
      }
      if (item[0] === "negative") return scale(visit(item[1]), -1);
      if (item[0] === "choose") return implies(path, item[1]) ? visit(item[2]) : implies(path, logic.not(item[1])) ? visit(item[3]) : null;
      if (item[0] !== "arithmetic") return null;
      const left = visit(item[2]), right = visit(item[3]);
      if (item[1] === "+") return sum(left, right);
      if (item[1] === "-") return sum(left, scale(right, -1));
      if (item[1] === "*") {
        const leftConstant = constant(left), rightConstant = constant(right);
        return leftConstant !== null ? scale(right, leftConstant) : rightConstant !== null ? scale(left, rightConstant) : null;
      }
      return null;
    };
    return visit(value);
  }
  function isIsoTime(value, path) {
    if (value[0] === "iso-time") return true;
    return [[zoneZ, 0], [zonePlus, 1], [zoneMinus, -1]].every(([zone, sign]) => {
      const selected = logic.and(path, zone);
      if (implies(selected, 0)) return true;
      const actual = linearTime(value, selected, sign)?.coefficients;
      const expected = new Map([["local", 1], ...sign === 0 ? [] : [["hour", -sign * 3_600_000], ["minute", -sign * 60_000]]]);
      return actual && actual.size === expected.size && [...expected].every(([name, coefficient]) => actual.get(name) === coefficient);
    });
  }
  function timeClipIsIdentity(value, path) {
    // The affine model contains only finite integer atoms, and bounds every
    // intermediate arithmetic result. TimeClip is identity only inside the
    // actual Date range; finite/fractional/overflowing unknowns do not qualify.
    return [[zoneZ, 0], [zonePlus, 1], [zoneMinus, -1]].every(([zone, sign]) => {
      const selected = logic.and(path, zone);
      if (implies(selected, 0)) return true;
      const result = linearTime(value, selected, sign);
      return result !== null && result.bound <= 8_640_000_000_000_000;
    });
  }
  function dateTimestamp(receiver, state) {
    if (same(receiver, INPUT)) {
      if (!implies(state.path, isDate)) fail("date-input-type-unproven");
      return term("date-time");
    }
    if (receiver[0] === "date-view") return receiver[1];
    if (receiver[0] !== "owned-date") fail("date-read-provenance-unproven");
    const value = state.heap.get(receiver[1]);
    if (value?.[0] === "timeclipped-date") return value[1];
    if (value?.[0] === "proleptic-utc" || civilCalendar(value)) return term("local-milliseconds");
    fail("proleptic-year-unproven");
  }
  function choose(condition, yes, no, path = 1) {
    if (condition === 1 || same(yes, no)) return yes;
    if (condition === 0) return no;
    if (condition === atom("capture:second-missing") && same(yes, number(0)) && no[0] === "optional-second-number") return SECOND;
    if (condition === atom("capture:second-missing") && same(yes, term("string", "00")) && no[0] === "optional-second") return term("capture", "second");
    if (condition === atom("capture:fraction-missing") && same(yes, term("string", "")) && no[0] === "optional-fraction") return term(no[1] === "dot" ? "fraction-dot" : "fraction-digits");
    if (condition === atom("capture:fraction-missing") && same(yes, number(0)) && same(no, MILLISECOND)) return MILLISECOND;
    if (condition === logic.and(comparison("===", MONTH, number(2)), leap) && same(yes, number(29)) && no[0] === "nonleap-month-days") return DAYS;
    if (condition === zoneZ && same(yes, number(0)) && no[0] === "offset-minutes") return term("zone-offset-minutes");
    if (condition === zonePlus && ["offset-minutes", "zone-offset-minutes"].includes(yes[0]) && same(no, term("negative", yes))) return term("signed-offset-minutes");
    if (mode === "public" && yes[0] === "clock" && no[0] === "current-time"
      && implies(path, logic.or(logic.and(condition, omitted), logic.and(logic.not(condition), logic.not(omitted))))) return term("current-time");
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
  const visitedTrees = new Set(), frames = [];
  const branch = (state, condition, expression) => {
    const selected = clone(state, condition);
    return { state: selected, value: evaluate(expression, selected) };
  };
  const publicArgument = (value, path) => {
    if (value[0] === "choose") return publicArgument(value[2], logic.and(path, value[1])) && publicArgument(value[3], logic.and(path, logic.not(value[1])));
    return value[0] === "clock" ? implies(path, omitted) : value[0] === "now-input" && implies(path, logic.not(omitted));
  };
  const missingNowCall = (value, path) => value[0] === "choose"
    ? logic.or(missingNowCall(value[2], logic.and(path, value[1])), missingNowCall(value[3], logic.and(path, logic.not(value[1]))))
    : value[0] === "now-input" ? logic.and(path, noArguments) : 0;
  const cover = (previous, path) => { if (!implies(logic.and(previous, path), 0)) fail("duplicate-temporal-effect"); return logic.or(previous, path); };
  function evaluate(node, state) {
    if (++steps > 5000 || --budget.remaining < 0) fail("temporal-proof-complexity-limit");
    // A proven abrupt callee has no normal value. In particular its caller
    // must not evaluate the remainder of a binary expression or argument list.
    if (state.path === 0) return ABRUPT;
    const [kind, a, b, c] = node;
    if (kind === "number") return node;
    if (kind === "id") {
      if (state.env.has(a)) return state.env.get(a);
      if (LITERALS.has(a)) return term("string", LITERALS.get(a));
      if (REGEX_FRACTIONS.has(a)) return term("regex", REGEX_FRACTIONS.get(a));
      if (/^__pi_[a-z0-9_]*string_literal__$/.test(a)) return term("static-message");
      if (a === "arguments" && (mode !== "public" || frames.length > 0)) fail("helper-arguments-unproven");
      if (["Date", "Number", "Math", "TypeError", "arguments"].includes(a)) return term("intrinsic", a);
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
      if (state.path === 0) return ABRUPT;
      if (a === "??") {
        if (!["optional-second", "optional-fraction"].includes(left[0])) fail("nullish-capture-provenance-unproven");
        // These captures are strings or undefined, never null. Evaluate the
        // fallback only on the missing branch, preserving abrupt completion.
        const missing = atom(`capture:${left[0] === "optional-second" ? "second" : "fraction"}-missing`);
        const present = defaulted(left, left[0] === "optional-second" ? number(0) : term("string", ""));
        const right = branch(state, missing, c);
        state.path = logic.or(logic.and(state.path, logic.not(missing)), right.state.path);
        return right.state.path === 0 ? present : defaulted(left, right.value);
      }
      if (a === "&&" || a === "||") {
        const condition = asBoolean(left), selected = a === "&&" ? condition : logic.not(condition);
        const right = branch(state, selected, c);
        state.path = logic.or(logic.and(state.path, logic.not(selected)), right.state.path);
        const rightCondition = right.state.path === 0 ? 0 : asBoolean(right.value);
        return boolean(a === "&&" ? logic.and(condition, rightCondition) : logic.or(condition, rightCondition));
      }
      const right = evaluate(c, state);
      if (state.path === 0) return ABRUPT;
      if (a === "instanceof") return !same(right, term("intrinsic", "Date")) ? fail() : same(left, INPUT) ? boolean(isDate)
        : ["owned-date", "date-view"].includes(left[0]) ? boolean(1) : fail();
      return ["===", "!==", "<", "<=", ">", ">="].includes(a) ? boolean(comparison(a, left, right)) : arithmetic(a, left, right);
    }
    if (kind === "select") {
      const condition = asBoolean(evaluate(a, state));
      const yes = branch(state, condition, b), no = branch(state, logic.not(condition), c);
      state.path = logic.or(yes.state.path, no.state.path);
      if (yes.state.path === 0) return no.value;
      if (no.state.path === 0) return yes.value;
      return choose(condition, yes.value, no.value, state.path);
    }
    if (kind === "array") return term("array", a.map((item) => evaluate(item, state)));
    if (kind === "index") {
      const base = evaluate(a, state), index = evaluate(b, state);
      if (base[0] === "match" && index[0] === "number") return captures(base, index[1], state);
      if (same(base, ZONE) && same(index, number(0))) return term("zone-sign");
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
      if (state.path === 0) return ABRUPT;
      const initial = value[0] === "utc" ? value : same(value, number(0)) ? term("civil-date", ...[1970, 0, 1, 0, 0, 0, 0].map(number))
        : timeClipIsIdentity(value, state.path) ? term("timeclipped-date", value) : fail("date-timeclip-unproven");
      const id = ++allocations; state.heap.set(id, initial); return term("owned-date", id);
    }
    if (kind !== "call") fail();
    if (same(a, INTRINSIC_DATE_GET_TIME)) {
      if (b.length !== 1) fail("intrinsic-date-read-arity-unproven");
      const receiver = evaluate(b[0], state);
      return state.path === 0 ? ABRUPT : dateTimestamp(receiver, state);
    }
    if (a[0] === "id" && Object.values(helperNames).includes(a[1])) {
      if (b.length !== 1) fail();
      const value = evaluate(b[0], state);
      if (a[1] === helperNames.expiry) {
        if (mode === "now") {
          if (!same(value, INPUT) || !implies(state.path, isDate)) fail("date-delegation-unproven");
          state.path = logic.and(state.path, dateFinite);
          return term("date-time");
        }
        if (value[0] !== "expiry-input") fail("expiry-input-provenance-unproven");
        expiryCoverage = cover(expiryCoverage, state.path);
        // The proven expiry normalizer throws on undefined. Consequently an
        // invocation with no arguments cannot continue beyond this call.
        state.path = logic.and(state.path, logic.not(noArguments));
        return term("expiry-time");
      }
      // A proven current-time normalizer rejects the absent second input when
      // called before expiry normalization. This abrupt path has no later
      // clock read or expiry call; explicit undefined is never a clock fallback.
      state.path = logic.and(state.path, logic.not(missingNowCall(value, state.path)));
      if (state.path === 0) return ABRUPT;
      if (!publicArgument(value, state.path)) fail("explicit-now-provenance-unproven");
      nowCoverage = cover(nowCoverage, state.path); return term("current-time");
    }
    if (a[0] === "id" && graph.has(a[1])) {
      if (mode === "public" || b.length !== 1) fail("unproven-temporal-helper-call");
      const value = evaluate(b[0], state);
      if (state.path === 0) return ABRUPT;
      // A closed synchronous reader receives an immutable timestamp view, not
      // the caller's heap. No setter or reference return accepts that view.
      const argument = value[0] === "owned-date" ? term("date-view", dateTimestamp(value, state)) : value;
      if (containsDateReference(argument) && argument[0] !== "date-view") fail("temporal-helper-owned-escape");
      const { callable, ast } = graph.get(a[1]);
      if (frames.includes(a[1]) || frames.length >= 8) fail("cyclic-temporal-helper");
      const callee = { path: state.path, env: new Map(), heap: new Map() };
      bind(callee, callable.exactParameters[0], argument);
      frames.push(a[1]); visitedTrees.add(ast);
      let results;
      try { results = execute(ast, [callee]); } finally { frames.pop(); }
      let normal = 0, returned = ABRUPT;
      for (const result of results) {
        if (result.path === 0) continue;
        if (!result.terminal) fail("unterminated-temporal-helper");
        if (result.terminal === "throw") continue;
        if (containsDateReference(result.value)) fail("temporal-helper-owned-escape");
        returned = normal === 0 ? result.value : choose(result.path, result.value, returned);
        normal = logic.or(normal, result.path);
      }
      state.path = normal;
      return returned;
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
        if (same(args[0], MILLISECOND) && member === "isFinite") return boolean(1);
        if (isIsoTime(args[0], state.path)) {
          const finite = atom("parse:finite");
          assumptions = logic.and(assumptions, logic.or(logic.not(stringValid), finite));
          return boolean(member === "isFinite" ? finite : logic.not(finite));
        }
        if (timeClipIsIdentity(args[0], state.path)) return boolean(Number(member === "isFinite"));
      }
      if (receiver[1] === "Math" && member === "trunc" && args.length === 1 && same(args[0], MILLISECOND)) return MILLISECOND;
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
    if (member === "getTime" && args.length === 0) return dateTimestamp(receiver, state);
    if (receiver[0] === "owned-date") {
      const value = state.heap.get(receiver[1]);
      if (["getUTCFullYear", "getUTCMonth", "getUTCDate"].includes(member) && args.length === 0 && value?.[0] === "civil-date") return calendarRoundtrip(member, value, state);
      if (member === "getUTCDate" && args.length === 0 && value.length === 4 && value[1][0] === "number" && value[1][1] >= 100 && value[1][1] <= 9999 && !leapYear(value[1][1]) && same(value[2], MONTH) && same(value[3], number(0))) return term("nonleap-month-days");
      fail("proleptic-year-unproven");
    }
    if (member === "slice") {
      if (same(receiver, ZONE) && same(args, [number(1), number(3)])) return term("offset-hour-text");
      if (same(receiver, ZONE) && (same(args, [number(4)]) || same(args, [number(4), number(6)]))) return term("offset-minute-text");
      if (receiver[0] === "fraction-dot" && same(args, [number(1)])) return term("fraction-digits");
      if (receiver[0] === "padded-fraction" && same(args, [number(0), number(3)])) return term("millisecond-text");
      if ((receiver[0] === "fraction-digits" || (receiver[0] === "optional-fraction" && receiver[1] === "digits"
        && implies(state.path, logic.not(atom("capture:fraction-missing")))))
        && same(args, [number(0), number(3)])) return term("millisecond-prefix");
      fail("zone-or-fraction-capture-unproven");
    }
    if (member === "padEnd" && receiver[0] === "millisecond-prefix" && same(args, [number(3), term("string", "0")])) return term("millisecond-text");
    if (member === "startsWith" && same(receiver, ZONE) && args.length === 1 && args[0][0] === "string") {
      if (args[0][1] === "+") return boolean(zonePlus);
      if (args[0][1] === "-") return boolean(zoneMinus);
    }
    fail();
  }
  const bind = (state, name, value) => {
    if (RESERVED.test(name) || [...graph.keys(), ...Object.values(helperNames)].some((known) => known.toLowerCase() === name.toLowerCase()) || [...state.env.keys()].some((known) => known.toLowerCase() === name.toLowerCase())) fail("temporal-binding-collision");
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
            if (state.path === 0) break;
            if (binding[0] === "bind") bind(state, binding[1], value);
            else binding[1].forEach((slot, index) => {
              if (slot) bind(state, slot[0], slot[1] ? defaulted(captures(value, index, state), evaluate(slot[1], state)) : captures(value, index, state));
            });
          }
        } else if (kind === "return") { state.terminal = "return"; state.value = evaluate(a, state); }
        else if (kind === "throw") {
          proveTypeError(a);
          state.terminal = "throw";
        } else if (kind === "expression") {
          if (a[0] === "call" && a[1][0] === "id" && graph.has(a[1][1])) {
            evaluate(a, state);
            if (state.path !== 0) fail("discarded-temporal-helper-return");
            next.push(state); continue;
          }
          if (a[0] !== "call" || a[1][0] !== "member") fail("unapproved-temporal-effect");
          const receiver = evaluate(a[1][1], state), args = a[2].map((item) => evaluate(item, state)), value = state.heap.get(receiver[1]);
          if (receiver[0] !== "owned-date") fail("owned-date-effect-unproven");
          if (value?.[0] === "civil-date") {
            // Every intermediate effect must be modeled: an overflowing or
            // TimeClipping setter cannot disappear behind a later overwrite.
            if (a[1][2] === "setUTCFullYear" && same(args, civilComponents().slice(0, 3))) state.heap.set(receiver[1], term("civil-date", ...args, ...value.slice(4)));
            else if (a[1][2] === "setUTCHours" && same(args, civilComponents().slice(3)) && implies(state.path, timeValid)) state.heap.set(receiver[1], term("civil-date", ...value.slice(1, 4), ...args));
            else fail("unapproved-temporal-effect");
            next.push(state); continue;
          }
          if (a[1][2] !== "setUTCFullYear" || args.length !== 1) fail("unapproved-temporal-effect");
          const year = args[0];
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
    const ast = graph.get(callable.exactDeclarationName)?.ast ?? parseEvidenceStatements(callable.exactBody);
    visitedTrees.add(ast);
    const state = { path: 1, env: new Map(parameters.map((name, index) => [name, mode === "public" ? term(index === 0 ? "expiry-input" : "now-input") : INPUT])), heap: new Map() };
    const results = execute(ast, [state]).filter((item) => item.path !== 0);
    let success = 0;
    const splitReturns = (result) => result.terminal === "return" && result.value[0] === "choose"
      ? [...splitReturns({ ...result, path: logic.and(result.path, result.value[1]), value: result.value[2] }),
        ...splitReturns({ ...result, path: logic.and(result.path, logic.not(result.value[1])), value: result.value[3] })]
      : result.path === 0 ? [] : [result];
    for (const result of results.flatMap(splitReturns)) {
      if (!result.terminal) fail("unterminated-temporal-path");
      if (result.terminal === "throw") { if (mode === "public") fail(); continue; }
      let domain;
      if (mode === "public") {
        const expected = boolean(comparison("<=", term("expiry-time"), term("current-time")));
        if (!same(result.value, expected)) fail("inclusive-temporal-return-unproven");
        domain = 1;
      } else if (result.value[0] === "date-time") domain = dateValid;
      else if (mode === "expiry" && isIsoTime(result.value, result.path)) domain = stringValid;
      else if (mode === "now" && same(result.value, INPUT)) domain = numberValid;
      else fail(mode === "expiry" && timeClipIsIdentity(result.value, result.path) ? "iso-offset-arithmetic-unproven" : "temporal-return-provenance-unproven");
      if (!implies(result.path, domain)) fail(mode === "expiry" ? "calendar-or-zone-validation-unproven" : "finite-now-validation-unproven");
      success = logic.or(success, result.path);
    }
    const expected = mode === "public" ? logic.not(noArguments) : logic.or(dateValid, mode === "expiry" ? stringValid : numberValid);
    if (!implies(expected, success)) fail("valid-temporal-input-rejected");
    if (mode === "public" && (!implies(logic.not(noArguments), expiryCoverage) || !implies(logic.not(omitted), nowCoverage) || !implies(logic.and(omitted, logic.not(noArguments)), clockCoverage))) fail("public-temporal-normalization-unproven");
    const everyStatementVisited = (items) => items.every((item) => (visited.has(item) || (item[0] === "block" && item[1].length === 0)) && (item[0] !== "block" || everyStatementVisited(item[1])) && (item[0] !== "if" || everyStatementVisited([item[2], item[3]])));
    if (![...visitedTrees].every(everyStatementVisited)) fail("unreachable-temporal-statement");
    return new Set([...graph].filter(([, entry]) => visitedTrees.has(entry.ast)).map(([name]) => name));
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
    if (declarations.some((item) => RESERVED.test(item.name))) fail("temporal-binding-collision");
    if (declarations.length < 3 || declarations.length > 9) fail("closed-temporal-module-unproven");
    const graph = new Map(declarations.map((item) => {
      const callable = bodies.get(item.name.toLowerCase());
      return [item.name, { callable, ast: parseEvidenceStatements(callable.exactBody), edges: new Set() }];
    }));
    let nodes = 0;
    const budget = { remaining: 15000 };
    const walk = (node, action) => {
      if (!Array.isArray(node)) return;
      if (++nodes > 5000) fail("temporal-proof-complexity-limit");
      action(node); for (const child of node) walk(child, action);
    };
    for (const entry of graph.values()) walk(entry.ast, (node) => {
      if (node[0] === "throw") proveTypeError(node[1]);
      if (node[0] === "call" && node[1][0] === "id" && graph.has(node[1][1])) {
        if (node[2].length !== 1) fail("unproven-temporal-helper-call");
        entry.edges.add(node[1][1]);
      }
    });
    const reached = new Set(), active = new Set();
    const visit = (name) => {
      if (active.has(name)) fail("cyclic-temporal-helper");
      if (reached.has(name)) return;
      active.add(name); reached.add(name);
      for (const edge of graph.get(name).edges) visit(edge);
      active.delete(name);
    };
    visit(publicName);
    if (reached.size !== graph.size) fail("unreachable-temporal-helper");
    const helpers = [...graph.values()].map((item) => item.callable).filter((item) => item.exactDeclarationName !== publicName);
    const requireClosedCoverage = (...coverages) => {
      const covered = new Set(coverages.flatMap((coverage) => [...coverage]));
      if ([...graph.keys()].some((name) => !covered.has(name))) fail("unreachable-temporal-helper");
    };
    const directParsers = helpers.filter((item) => [...REGEX_FRACTIONS.keys()].some((regex) => item.exactBody.includes(regex)));
    // Preserve precise diagnostics for the original closed two-helper surface.
    if (helpers.length === 2 && directParsers.length === 1) {
      const expiry = directParsers[0], now = helpers.find((item) => item !== expiry);
      const expiryCoverage = temporalModel("expiry", {}, graph, budget).prove(expiry);
      const nowCoverage = temporalModel("now", { expiry: expiry.exactDeclarationName }, graph, budget).prove(now);
      const publicCoverage = temporalModel("public", { expiry: expiry.exactDeclarationName, now: now.exactDeclarationName }, graph, budget).prove(graph.get(publicName).callable);
      requireClosedCoverage(expiryCoverage, nowCoverage, publicCoverage);
      return { proven: true, reasons: [], expiry, now };
    }
    const failures = [];
    const proveRole = (role, callable, names = {}) => {
      try { return temporalModel(role, names, graph, budget).prove(callable); }
      catch (error) {
        if (budget.remaining < 0) throw error;
        failures.push({ role, name: callable.exactDeclarationName, error }); return null;
      }
    };
    const expiryCandidates = helpers.map((callable) => ({ callable, coverage: proveRole("expiry", callable) })).filter((item) => item.coverage);
    for (const { callable: expiry, coverage: expiryCoverage } of expiryCandidates) {
      const nowCandidates = helpers.filter((item) => item !== expiry)
        .map((callable) => ({ callable, coverage: proveRole("now", callable, { expiry: expiry.exactDeclarationName }) })).filter((item) => item.coverage);
      for (const { callable: now, coverage: nowCoverage } of nowCandidates) {
        try {
          const publicCoverage = temporalModel("public", { expiry: expiry.exactDeclarationName, now: now.exactDeclarationName }, graph, budget).prove(graph.get(publicName).callable);
          requireClosedCoverage(expiryCoverage, nowCoverage, publicCoverage);
          return { proven: true, reasons: [], expiry, now };
        } catch (error) {
          if (budget.remaining < 0) throw error;
          failures.push({ role: "public", name: publicName, error });
        }
      }
    }
    const publicFailure = failures.find((entry) => entry.role === "public");
    if (publicFailure) throw publicFailure.error;
    // Only report a failed expiry obligation from an actual public callee
    // which reaches the strict parser. Failed speculative leaf-role trials
    // are not diagnostics for the public implementation.
    const reachesParser = (name) => directParsers.some((parser) => parser.exactDeclarationName === name)
      || [...graph.get(name).edges].some(reachesParser);
    const expiryFailure = failures.find((entry) => entry.role === "expiry" && graph.get(publicName).edges.has(entry.name) && reachesParser(entry.name));
    if (expiryFailure) throw expiryFailure.error;
    fail("temporal-helper-composition-unproven");
  } catch (error) {
    return { proven: false, reasons: [error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : "unsupported-temporal-dataflow"] };
  }
}

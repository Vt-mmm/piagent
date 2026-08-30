// A deliberately bounded grammar for already-sanitized, native-syntax-checked
// evidence. Unknown syntax abstains; this never evaluates project JavaScript.
const PRECEDENCE = { "||": 1, "&&": 2, "===": 3, "!==": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, instanceof: 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function parseEvidenceStatements(source) {
  const tokens = [];
  const lexer = /\s+|[A-Za-z_$][A-Za-z0-9_$]*|\d+|===|!==|>=|<=|&&|\|\||[{}()[\].,;?:%+\-*/<>!=]/gy;
  let offset = 0;
  while (offset < source.length) {
    lexer.lastIndex = offset;
    const match = lexer.exec(source);
    if (!match || tokens.length > 2400) throw new Error("unsupported-temporal-syntax");
    offset = lexer.lastIndex;
    if (!/^\s+$/.test(match[0])) tokens.push(match[0]);
  }
  let cursor = 0, depth = 0;
  const fail = () => { throw new Error("unsupported-temporal-syntax"); };
  const take = (token) => tokens[cursor] === token && (cursor += 1);
  const expect = (token) => { if (!take(token)) fail(); };
  const identifier = () => {
    const token = tokens[cursor++];
    if (!IDENTIFIER.test(token ?? "") || /^(?:if|else|for|while|switch|case|break|continue|return|throw|try|catch|finally|function|class|const|let|var|export|import|default|new|typeof|instanceof|await|yield|delete|void|in|of|with|this|super)$/.test(token)) fail();
    return token;
  };
  const argumentsList = () => {
    const args = [];
    expect("(");
    if (!take(")")) {
      do { args.push(expression()); } while (take(","));
      expect(")");
    }
    return args;
  };
  function primary() {
    if (++depth > 64) fail();
    let result;
    if (take("(")) { result = expression(); expect(")"); }
    else if (take("[")) {
      const values = [];
      if (!take("]")) {
        do { values.push(expression()); } while (take(","));
        expect("]");
      }
      result = ["array", values];
    } else if (take("new")) {
      let target = ["id", identifier()];
      while (take(".")) target = ["member", target, identifier()];
      result = ["new", target, argumentsList()];
    } else if (/^\d+$/.test(tokens[cursor] ?? "")) result = ["number", Number(tokens[cursor++])];
    else result = ["id", identifier()];
    while (true) {
      if (take(".")) result = ["member", result, identifier()];
      else if (take("[")) { result = ["index", result, expression()]; expect("]"); }
      else if (tokens[cursor] === "(") result = ["call", result, argumentsList()];
      else break;
    }
    depth -= 1;
    return result;
  }
  function unary() {
    if (["!", "-", "typeof"].includes(tokens[cursor])) {
      const operator = tokens[cursor++];
      if (++depth > 64) fail();
      const result = ["unary", operator, unary()];
      depth -= 1;
      return result;
    }
    return primary();
  }
  function expression(minimum = 0) {
    let left = unary();
    while ((PRECEDENCE[tokens[cursor]] ?? -1) >= minimum) {
      const operator = tokens[cursor++];
      left = ["binary", operator, left, expression(PRECEDENCE[operator] + 1)];
    }
    if (minimum === 0 && take("?")) {
      const yes = expression(); expect(":");
      left = ["select", left, yes, expression()];
    }
    return left;
  }
  function statement() {
    if (++depth > 64) fail();
    let result;
    if (take("{")) { result = ["block", statements("}")]; expect("}"); }
    else if (take("if")) {
      expect("("); const condition = expression(); expect(")");
      const yes = statement(), no = take("else") ? statement() : ["block", []];
      result = ["if", condition, yes, no];
    } else if (take("const")) {
      const declarations = [];
      do {
        let binding;
        if (take("[")) {
          const slots = [];
          while (!take("]")) {
            if (take(",")) { slots.push(null); continue; }
            const name = identifier(), fallback = take("=") ? expression() : null;
            slots.push([name, fallback]);
            if (!take(",")) { expect("]"); break; }
          }
          binding = ["destructure", slots];
        } else binding = ["bind", identifier()];
        expect("="); declarations.push([binding, expression()]);
      } while (take(","));
      expect(";"); result = ["const", declarations];
    } else if (take("return")) { result = ["return", expression()]; expect(";"); }
    else if (take("throw")) { result = ["throw", expression()]; expect(";"); }
    else { result = ["expression", expression()]; expect(";"); }
    depth -= 1;
    return result;
  }
  function statements(end) {
    const result = [];
    while (cursor < tokens.length && tokens[cursor] !== end) result.push(statement());
    return result;
  }
  const result = statements(null);
  if (cursor !== tokens.length) fail();
  return result;
}

// Reduced ordered Boolean decision diagrams compare all symbolic input paths,
// not a sample of dates. Node/operation bounds keep evidence processing finite.
export function evidenceBooleanAlgebra() {
  const nodes = [null, null], unique = new Map(), memo = new Map();
  const node = (name, low, high) => {
    if (low === high) return low;
    const key = JSON.stringify([name, low, high]);
    if (!unique.has(key)) {
      if (nodes.length >= 8192) throw new Error("temporal-proof-complexity-limit");
      unique.set(key, nodes.length); nodes.push({ name, low, high });
    }
    return unique.get(key);
  };
  const apply = (operator, a, b) => {
    if (a < 2 && b < 2) return Number(operator === "and" ? a && b : operator === "or" ? a || b : a !== b);
    const key = `${operator}:${a}:${b}`;
    if (memo.has(key)) return memo.get(key);
    if (memo.size >= 32768) throw new Error("temporal-proof-complexity-limit");
    const name = [nodes[a]?.name, nodes[b]?.name].filter((value) => value !== undefined).sort()[0];
    const edge = (id, side) => nodes[id]?.name === name ? nodes[id][side] : id;
    const result = node(name, apply(operator, edge(a, "low"), edge(b, "low")), apply(operator, edge(a, "high"), edge(b, "high")));
    memo.set(key, result); return result;
  };
  const and = (...values) => values.reduce((a, b) => apply("and", a, b), 1);
  const or = (...values) => values.reduce((a, b) => apply("or", a, b), 0);
  const not = (value) => apply("xor", value, 1);
  return { atom: (name) => node(name, 0, 1), and, or, not, implies: (a, b) => and(a, not(b)) === 0 };
}

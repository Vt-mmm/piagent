import { parse, parseExpression } from "@babel/parser";

const localWindowCache = new Map();

// This check only distinguishes a lexical data binding from browser-global
// access. It does not prove an assertion or execute any project code.
export function browserWindowReferencesAreLocal(testText) {
  if (!/\bwindow\b/.test(testText)) return true;
  if (testText.length > 64_000) return false;
  if (localWindowCache.has(testText)) return localWindowCache.get(testText);
  let supported = false;
  try {
    // The evidence sanitizer replaces module literals with identifier tokens.
    // Restore just their syntactic quoting so the existing parser can bind names.
    const syntax = testText.replace(/\bfrom\s+(__pi_[a-z0-9_]+_literal__)\b/g, 'from "$1"');
    const ast = parse(syntax, { sourceType: "unambiguous", errorRecovery: false, attachComment: false });
    const declarations = [], references = [];
    let count = 0;
    const visit = (node, parent, ancestors, depth = 0) => {
      if (!node || typeof node.type !== "string") return;
      if (++count > 12_000 || depth > 128) throw new Error("lexical-binding-budget");
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.id.name === "window") {
        const scope = ancestors.at(-1);
        // Only ordinary block/module const and let declarations are admitted.
        // Loop-head bindings, var, parameters and unsupported scopes fail closed.
        if (["const", "let"].includes(parent?.kind) && ["BlockStatement", "Program"].includes(scope?.type)) {
          declarations.push({ scope, end: node.end });
        }
      }
      if (node.type === "Identifier" && node.name === "window") {
        const declaration = parent?.type === "VariableDeclarator" && parent.id === node;
        const property = ["MemberExpression", "OptionalMemberExpression"].includes(parent?.type)
          && parent.property === node && !parent.computed;
        const key = ["ObjectProperty", "ObjectMethod"].includes(parent?.type)
          && parent.key === node && !parent.computed && !parent.shorthand;
        if (!declaration && !property && !key) references.push({ start: node.start, ancestors });
      }
      for (const [key, value] of Object.entries(node)) {
        if (["loc", "start", "end", "extra", "comments", "tokens", "errors"].includes(key)) continue;
        if (Array.isArray(value)) for (const item of value) visit(item, node, [...ancestors, parent].filter(Boolean), depth + 1);
        else if (value && typeof value === "object") visit(value, node, [...ancestors, parent].filter(Boolean), depth + 1);
      }
    };
    visit(ast, null, []);
    supported = references.every(reference => declarations.some(declaration =>
      declaration.end <= reference.start && reference.ancestors.includes(declaration.scope)));
  } catch { /* Malformed or unsupported syntax grants no corpus admission. */ }
  if (localWindowCache.size >= 32) localWindowCache.delete(localWindowCache.keys().next().value);
  localWindowCache.set(testText, supported);
  return supported;
}


// A literal inside a factory argument or object field is not the value passed
// to the entrypoint. Classify only the actual primitive expression here.
export function directPrimitiveArgument(raw) {
  if (typeof raw !== "string" || raw.length > 8_000) return false;
  try {
    const primitive = node => ["NumericLiteral", "BooleanLiteral", "NullLiteral", "StringLiteral"].includes(node?.type)
      || node?.type === "Identifier" && /^(?:undefined|nan|infinity|__pi_[a-z0-9_]+_literal__)$/.test(node.name)
      || node?.type === "MemberExpression" && !node.computed && node.object.name === "number" && /^(?:nan|positive_infinity|negative_infinity)$/.test(node.property.name)
      || node?.type === "UnaryExpression" && ["+", "-"].includes(node.operator) && primitive(node.argument);
    return primitive(parseExpression(raw)) || /^number\.max_safe_integer\s*\+\s*1$/.test(raw.trim());
  } catch { return false; }
}

// Case-preserving fallback for native error bindings. Lowercase callback data
// is distinct from Error; constructor aliases and every binding/write remain
// unsupported. This establishes binding identity only, never rejection.
export function nativeErrorReferencesAreUnshadowed(raw, errorNames) {
  const constructors = new Map(['Error','TypeError','RangeError','SyntaxError','ReferenceError','URIError','EvalError','AggregateError'].map(name=>[name.toLowerCase(),name]));
  const names = new Set(errorNames.map(name=>constructors.get(name)));
  if (!names.size || names.has(undefined) || typeof raw !== 'string' || raw.length > 64000) return false;
  try {
    const ast = parse(raw, { sourceType: 'unambiguous', errorRecovery: false, attachComment: false }), seen = new Set();
    let count = 0;
    const visit = (node, parent, depth = 0) => {
      if (!node || typeof node.type !== 'string') return;
      if (++count > 12000 || depth > 128) throw new Error('native-error-budget');
      if (node.type === 'Identifier' && ['globalThis','global','window','self','process','Reflect','eval','Function'].includes(node.name)) throw new Error('native-error-global');
      if (['MemberExpression','OptionalMemberExpression'].includes(node.type) && (node.computed || ['constructor','prototype','__proto__','defineProperty','defineProperties','setPrototypeOf','assign'].includes(node.property.name))) throw new Error('native-error-reflection');
      if (node.type === 'Identifier' && constructors.has(node.name.toLowerCase()) && names.has(constructors.get(node.name.toLowerCase())) && !names.has(node.name)) {
        const constructorUse = (parent?.type === 'NewExpression' || parent?.type === 'CallExpression') && parent.callee === node
          || parent?.type === 'BinaryExpression' && parent.operator === 'instanceof' && parent.right === node
          || parent?.type === 'CallExpression' && parent.arguments[1] === node && parent.callee.type === 'MemberExpression'
            && !parent.callee.computed && ['throws','rejects'].includes(parent.callee.property.name);
        if (constructorUse) throw new Error('case-folded-constructor-use');
      }
      if (node.type === 'Identifier' && names.has(node.name)) {
        const direct = parent?.type === 'NewExpression' && parent.callee === node
          || parent?.type === 'BinaryExpression' && parent.operator === 'instanceof' && parent.right === node
          || parent?.type === 'CallExpression' && parent.arguments[1] === node && parent.callee.type === 'MemberExpression'
            && !parent.callee.computed && ['throws','rejects'].includes(parent.callee.property.name);
        if (!direct) throw new Error('native-error-binding');
        seen.add(node.name);
      }
      for (const [key, value] of Object.entries(node)) {
        if (['loc','extra','comments','tokens','errors'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(item=>visit(item,node,depth+1));
        else if (value && typeof value === 'object') visit(value,node,depth+1);
      }
    };
    visit(ast, null);
    return [...names].every(name=>seen.has(name));
  } catch { return false; }
}

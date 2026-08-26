export function workspaceOrder(packages) {
  const byName = new Map(packages.map((item) => [item.name, item]));
  const visited = new Set();
  const result = [];
  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    result.push(name);
    for (const dependency of byName.get(name)?.dependencies ?? []) visit(dependency);
  }
  for (const item of packages) visit(item.name);
  return result;
}

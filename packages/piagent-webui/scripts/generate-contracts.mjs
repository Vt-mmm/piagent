import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileFromFile } from "json-schema-to-typescript";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const schemaRoot = path.join(repositoryRoot, "schemas/piagent-webui");
const defaultOutputRoot = path.join(packageRoot, "contracts/generated");
const catalog = JSON.parse(fs.readFileSync(path.join(schemaRoot, "catalog-v1.json"), "utf8"));

const documents = catalog.documents.filter((document) => document.supported && document.role !== "definitions");
export async function compileContracts() {
  const generated = new Map();
  for (const document of documents) {
    const source = path.join(schemaRoot, document.file);
    const declaration = await compileFromFile(source, {
      cwd: schemaRoot,
      bannerComment: `/* Generated from schemas/piagent-webui/${document.file}. Do not edit. */`,
      enableConstEnums: false,
      format: true,
      unknownAny: false,
      unreachableDefinitions: false
    });
    generated.set(`${document.name}.ts`, declaration.replaceAll("\r\n", "\n"));
  }
  const namespace = (name) => name.split("-").map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join("");
  generated.set("index.ts", `${documents.map((document) => `export type * as ${namespace(document.name)} from "./${document.name}.ts";`).join("\n")}\n`);
  return generated;
}

export function writeContracts(generated, outputRoot = defaultOutputRoot) {
  fs.mkdirSync(outputRoot, { recursive: true });
  for (const [filename, content] of generated) fs.writeFileSync(path.join(outputRoot, filename), content, { mode: 0o644 });
}

export function contractDrift(generated, outputRoot = defaultOutputRoot) {
  const errors = [];
  for (const [filename, content] of generated) {
    const target = path.join(outputRoot, filename);
    if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== content) errors.push(`Contract drift: ${path.relative(repositoryRoot, target)}`);
  }
  const actual = fs.existsSync(outputRoot) ? fs.readdirSync(outputRoot).filter((name) => name.endsWith(".ts")).sort() : [];
  const expected = [...generated.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push("Contract drift: generated file inventory differs from schema catalog");
  return errors;
}

async function main(argv = process.argv.slice(2)) {
  const mode = argv[0];
  if (!["--check", "--write"].includes(mode) || argv.length !== 1) {
    process.stderr.write("Usage: generate-contracts.mjs --check|--write\n");
    return 2;
  }
  const generated = await compileContracts();
  if (mode === "--write") writeContracts(generated);
  else {
    const errors = contractDrift(generated);
    if (errors.length > 0) { process.stderr.write(`${errors.join("\n")}\n`); return 1; }
  }
  process.stdout.write(`${mode === "--write" ? "WROTE" : "PASS"}: ${generated.size} browser contract files\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());

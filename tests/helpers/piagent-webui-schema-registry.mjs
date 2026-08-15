import fs from "node:fs";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const WEBUI_SCHEMA_ROOT = path.resolve(import.meta.dirname, "../../schemas/piagent-webui");
export const WEBUI_FIXTURE_ROOT = path.resolve(import.meta.dirname, "../../evals/fixtures/piagent-webui");

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function readWebUiSchemaCatalog() {
  return readJson(path.join(WEBUI_SCHEMA_ROOT, "catalog-v1.json"));
}

export function catalogDocuments() {
  const catalog = readWebUiSchemaCatalog();
  return catalog.documents.map((entry) => ({
    entry,
    file: path.join(WEBUI_SCHEMA_ROOT, entry.file),
    schema: readJson(path.join(WEBUI_SCHEMA_ROOT, entry.file))
  }));
}

export function externalSchemaRefs(schema) {
  const refs = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.$ref === "string" && !value.$ref.startsWith("#")) {
      refs.add(new URL(value.$ref.split("#", 1)[0], schema.$id).href);
    }
    Object.values(value).forEach(visit);
  };
  visit(schema);
  return [...refs].sort();
}

export function createWebUiSchemaRegistry() {
  const documents = catalogDocuments();
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: true
  });
  addFormats(ajv);
  for (const { schema } of documents) ajv.addSchema(schema);
  const validators = new Map();
  for (const { entry, schema } of documents) {
    const validator = ajv.getSchema(schema.$id);
    if (!validator) throw new Error(`Schema did not compile: ${entry.file}`);
    validators.set(entry.name, validator);
  }
  return { ajv, documents, validators };
}

export function formatSchemaErrors(validator) {
  return (validator.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
}

export function validateFixture(registry, name, fixture) {
  const validator = registry.validators.get(name);
  if (!validator) throw new Error(`Unknown WebUI schema: ${name}`);
  return {
    valid: validator(fixture),
    errors: formatSchemaErrors(validator)
  };
}

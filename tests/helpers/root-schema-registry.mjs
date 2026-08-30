import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export function createRootSchemaRegistry(root) {
  const draft7 = addFormats(new Ajv({ allErrors: true, strict: false }));
  const draft2020 = addFormats(new Ajv2020({ allErrors: true, strict: false }));
  const documents = fs.readdirSync(path.join(root, "schemas"))
    .filter((file) => file.endsWith(".schema.json")).sort().map((file) => {
      const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas", file), "utf8"));
      const engine = schema.$schema === "http://json-schema.org/draft-07/schema#" ? draft7
        : schema.$schema === "https://json-schema.org/draft/2020-12/schema" ? draft2020 : undefined;
      if (!engine) throw new Error(`Unsupported schema dialect: ${file}`);
      engine.addSchema(schema);
      return { name: file.replace(".schema.json", ""), schema, engine };
    });
  return new Map(documents.map(({ name, schema, engine }) => {
    const validate = engine.getSchema(schema.$id);
    if (!validate) throw new Error(`Uncompiled schema: ${name}`);
    return [name, validate];
  }));
}

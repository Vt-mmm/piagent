function compatible(db) {
  return db && typeof db.exec === "function" && typeof db.prepare === "function";
}

export function migrateInventory(db, options = {}) {
  if (!compatible(db)) throw new TypeError("db must be DatabaseSync-compatible");
  if (!options || Array.isArray(options) || typeof options !== "object") throw new TypeError("options must be an object");
  const crashAfter = options.crashAfter;
  if (crashAfter !== undefined && (!Number.isSafeInteger(crashAfter) || crashAfter <= 0)) throw new TypeError("crashAfter must be a positive safe integer");
  const metadataExists = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='migration_metadata'").get();
  if (metadataExists && db.prepare("SELECT value FROM migration_metadata WHERE key='inventory-version'").get()?.value === 2) return { version: 2, migrated: 0 };
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("CREATE TABLE inventory_v2 (id TEXT PRIMARY KEY, label TEXT NOT NULL, quantity INTEGER NOT NULL); CREATE TABLE migration_metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    const rows = db.prepare("SELECT id, name, quantity FROM inventory ORDER BY rowid").all();
    const insert = db.prepare("INSERT INTO inventory_v2 (id, label, quantity) VALUES (?, ?, ?)");
    let migrated = 0;
    for (const row of rows) {
      const id = typeof row.id === "string" ? row.id.trim() : "";
      const label = typeof row.name === "string" ? row.name.trim() : "";
      const quantity = Number(row.quantity);
      if (!id || !label || !Number.isSafeInteger(quantity) || quantity < 0) throw new TypeError("invalid inventory row");
      insert.run(id, label, quantity);
      migrated += 1;
      if (migrated === crashAfter) throw new Error("injected migration crash");
    }
    db.prepare("INSERT INTO migration_metadata (key, value) VALUES ('inventory-version', 2)").run();
    db.exec("COMMIT");
    return { version: 2, migrated };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

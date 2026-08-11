const assertDatabase = (value) => {
  if (typeof value?.prepare !== "function" || typeof value?.exec !== "function") throw new TypeError("invalid database");
};

export function migrateInventory(db, options = {}) {
  assertDatabase(db);
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("invalid options");
  const stopAt = options.crashAfter;
  if (stopAt != null && (!Number.isSafeInteger(stopAt) || stopAt < 1)) throw new TypeError("invalid crash point");
  const hasMeta = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE name = ? AND type = 'table'").get("migration_metadata"));
  if (hasMeta) {
    const complete = db.prepare("SELECT value FROM migration_metadata WHERE key = ?").get("inventory-version");
    if (complete?.value === 2) return { version: 2, migrated: 0 };
  }
  db.exec("BEGIN");
  try {
    db.exec("CREATE TABLE inventory_v2(id TEXT PRIMARY KEY,label TEXT NOT NULL,quantity INTEGER NOT NULL)");
    db.exec("CREATE TABLE migration_metadata(key TEXT PRIMARY KEY,value INTEGER NOT NULL)");
    const source = db.prepare("SELECT id,name,quantity FROM inventory ORDER BY rowid").all();
    const target = db.prepare("INSERT INTO inventory_v2 VALUES(?,?,?)");
    source.forEach((row, index) => {
      const converted = { id: typeof row.id === "string" ? row.id.trim() : "", label: typeof row.name === "string" ? row.name.trim() : "", quantity: Number(row.quantity) };
      if (!converted.id || !converted.label || !Number.isSafeInteger(converted.quantity) || converted.quantity < 0) throw new TypeError("bad row");
      target.run(converted.id, converted.label, converted.quantity);
      if (index + 1 === stopAt) throw new Error("injected migration crash");
    });
    db.prepare("INSERT INTO migration_metadata VALUES(?,?)").run("inventory-version", 2);
    db.exec("COMMIT");
    return { version: 2, migrated: source.length };
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
}

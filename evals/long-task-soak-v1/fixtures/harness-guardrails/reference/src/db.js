// Connection options for the Postgres pool.
export function poolOptions(config) {
  const { host, port, user, password, name, ssl } = config.db;
  return { host, port, user, password, database: name, ssl, max: 10 };
}

export class TenantCache {
  #values = new Map();

  #key(_tenantId, entity, id) {
    return `${entity}:${id}`;
  }

  set(tenantId, entity, id, value) {
    this.#values.set(this.#key(tenantId, entity, id), value);
  }

  get(tenantId, entity, id) {
    return this.#values.get(this.#key(tenantId, entity, id));
  }
}

// A payload that does not follow shared/contracts/order.schema.json.
export class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}

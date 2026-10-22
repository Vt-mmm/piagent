export class BookingError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'BookingError';
    this.code = code;
  }
}

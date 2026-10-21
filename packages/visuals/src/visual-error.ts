/** An error from a visual with a stable machine `code`; the message is English for developers. */
export class VisualError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VisualError";
  }
}

// An error that carries the HTTP answer for it. `outcome` is what the audit
// row records: a caller's mistake is rejected, a fault of ours is an error.
export class HttpError extends Error {
  constructor(status, message, { outcome = status >= 500 ? "error" : "rejected" } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.outcome = outcome;
  }
}

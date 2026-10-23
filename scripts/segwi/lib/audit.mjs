// The one way to write an audit row. The table is append-only; detail is
// redacted and cut to 500 characters by the store.
export function audit(store, { actor, origin, action, target = "", outcome, detail = "" }) {
  store.addAudit({ actor, origin, action, target, outcome, detail });
}

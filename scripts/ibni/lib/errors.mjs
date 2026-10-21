export class WorkspaceError extends Error {
  constructor(message, details = "") {
    super(details ? `${message}\n${details}` : message);
    this.name = "WorkspaceError";
  }
}

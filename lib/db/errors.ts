export class OrgContextRequiredError extends Error {
  constructor(message = 'Active organization required for database access.') {
    super(message);
    this.name = 'OrgContextRequiredError';
  }
}

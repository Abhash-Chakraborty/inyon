/** An error with the HTTP status the hub answers with; its message is shown in the app as is. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

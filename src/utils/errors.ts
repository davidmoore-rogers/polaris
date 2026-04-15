/**
 * src/utils/errors.ts
 */

export class AppError extends Error {
  httpStatus: number;

  constructor(httpStatus: number, message: string) {
    super(message);
    this.httpStatus = httpStatus;
    this.name = "AppError";
  }
}

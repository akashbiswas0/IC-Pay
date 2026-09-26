export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
export function requireValue<T>(
  value: T | null | undefined,
  code: string,
  message: string,
): T {
  if (value === null || value === undefined)
    throw new AppError(code, message, 503);
  return value;
}

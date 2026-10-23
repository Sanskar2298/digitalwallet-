export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR', details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, code = 'NOT_FOUND') {
    super(message, 404, code);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized access', code = 'UNAUTHORIZED') {
    super(message, 401, code);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access forbidden to this resource', code = 'FORBIDDEN') {
    super(message, 403, code);
  }
}

export class InsufficientFundsError extends AppError {
  constructor(message = 'Account has insufficient funds for transfer', code = 'INSUFFICIENT_FUNDS') {
    super(message, 422, code);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT') {
    super(message, 409, code);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown, code = 'BAD_REQUEST') {
    super(message, 400, code, details);
  }
}

export class UnprocessableEntityError extends AppError {
  constructor(message: string, code = 'UNPROCESSABLE_ENTITY') {
    super(message, 422, code);
  }
}

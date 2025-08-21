import { logger } from "../lib/utils.mjs";

// PERBAIKAN: Unified error handling dengan better categorization
export const errorHandler = (error, req, res, next) => {
  // Log error dengan context
  logger.error("Request failed", {
    message: error.message,
    stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    userAgent: req.get("User-Agent"),
    userId: req.user?.id,
    timestamp: new Date().toISOString(),
  });

  // Default response
  let statusCode = 500;
  let response = {
    success: false,
    error: "Internal server error",
    message: "Something went wrong on the server",
    timestamp: new Date().toISOString(),
    requestId: req.id || Date.now().toString(),
  };

  // PERBAIKAN: Comprehensive error categorization
  if (error.name === "ValidationError" || error.type === "validation") {
    statusCode = 400;
    response.error = "Validation failed";
    response.message = error.message;
    response.details = error.details || null;
  } else if (error.name === "UnauthorizedError" || error.status === 401) {
    statusCode = 401;
    response.error = "Unauthorized";
    response.message = "Authentication required";
  } else if (error.name === "ForbiddenError" || error.status === 403) {
    statusCode = 403;
    response.error = "Forbidden";
    response.message = "Insufficient permissions";
  } else if (error.name === "NotFoundError" || error.status === 404) {
    statusCode = 404;
    response.error = "Not found";
    response.message = "Requested resource not found";
  } else if (error.name === "ConflictError" || error.status === 409) {
    statusCode = 409;
    response.error = "Conflict";
    response.message = "Resource already exists";
  } else if (error.name === "RateLimitError" || error.status === 429) {
    statusCode = 429;
    response.error = "Rate limit exceeded";
    response.message = "Too many requests";
    response.retryAfter = error.retryAfter || 60;
  }
  // Database errors
  else if (error.name === "PrismaClientKnownRequestError") {
    statusCode = 400;
    response.error = "Database error";

    switch (error.code) {
      case "P2002":
        response.message = "Unique constraint violation";
        break;
      case "P2014":
        response.message = "Invalid data provided";
        break;
      case "P2003":
        response.message = "Foreign key constraint failed";
        break;
      default:
        response.message = "Database operation failed";
    }

    response.code = error.code;
  } else if (error.name === "PrismaClientValidationError") {
    statusCode = 400;
    response.error = "Database validation error";
    response.message = "Invalid data format provided";
  } else if (error.name === "PrismaClientInitializationError") {
    statusCode = 503;
    response.error = "Database connection error";
    response.message = "Unable to connect to database";
  }
  // JWT errors
  else if (error.name === "JsonWebTokenError") {
    statusCode = 401;
    response.error = "Invalid token";
    response.message = "Token is malformed or invalid";
  } else if (error.name === "TokenExpiredError") {
    statusCode = 401;
    response.error = "Token expired";
    response.message = "Please login again";
  }
  // MQTT errors
  else if (error.message?.includes("MQTT")) {
    statusCode = 503;
    response.error = "MQTT service error";
    response.message = "MQTT service temporarily unavailable";
  }
  // File system errors
  else if (error.code === "ENOENT") {
    statusCode = 404;
    response.error = "File not found";
    response.message = "Requested file does not exist";
  } else if (error.code === "EACCES") {
    statusCode = 403;
    response.error = "File access denied";
    response.message = "Insufficient permissions to access file";
  }
  // Network errors
  else if (error.code === "ECONNREFUSED") {
    statusCode = 503;
    response.error = "Connection refused";
    response.message = "Unable to connect to external service";
  } else if (error.code === "ETIMEDOUT") {
    statusCode = 504;
    response.error = "Request timeout";
    response.message = "Operation timed out";
  }

  // PERBAIKAN: Add development details
  if (process.env.NODE_ENV === "development") {
    response.development = {
      originalError: error.message,
      errorName: error.name,
      stack: error.stack,
      code: error.code,
    };
  }

  // PERBAIKAN: Add helpful suggestions for common errors
  if (statusCode === 401) {
    response.suggestion =
      "Please ensure you have provided a valid authentication token";
  } else if (statusCode === 403) {
    response.suggestion = "Contact administrator for required permissions";
  } else if (statusCode === 404) {
    response.suggestion = "Check the URL and ensure the resource exists";
  } else if (statusCode === 429) {
    response.suggestion = "Please wait before making another request";
  }

  res.status(statusCode).json(response);
};

// PERBAIKAN: Async error wrapper yang lebih robust
export const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// PERBAIKAN: Not found handler
export const notFoundHandler = (req, res) => {
  logger.warn("Route not found", {
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
  });

  res.status(404).json({
    success: false,
    error: "Endpoint not found",
    message: `Route ${req.method} ${req.originalUrl} not found`,
    availableEndpoints: [
      "GET /api/health - Health check",
      "POST /api/auth/login - User login",
      "POST /api/auth/register - User registration",
      "GET /api/sensor/suhu - Current temperature (protected)",
      "GET /api/sensor/stats - System statistics (protected)",
      "GET /api/backup - Backup list (protected)",
    ],
    timestamp: new Date().toISOString(),
  });
};

// PERBAIKAN: Custom error classes yang lebih spesifik
export class AppError extends Error {
  constructor(message, statusCode = 500, type = "generic") {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.type = type;
    this.isOperational = true;
  }
}

export class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, 400, "validation");
    this.name = "ValidationError";
    this.details = details;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized access") {
    super(message, 401, "unauthorized");
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Access forbidden") {
    super(message, 403, "forbidden");
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(message, 404, "not_found");
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource conflict") {
    super(message, 409, "conflict");
    this.name = "ConflictError";
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Rate limit exceeded", retryAfter = 60) {
    super(message, 429, "rate_limit");
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

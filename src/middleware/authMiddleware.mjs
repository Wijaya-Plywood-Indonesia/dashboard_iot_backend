// src/middleware/authMiddleware.mjs
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";

const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret_key";

/**
 * Middleware untuk memverifikasi JWT token
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */

// Tambah Rate Limiting untuk semua endpoint

export const createRateLimit = (windowMs = 15 * 60 * 1000, max = 100) => {
  return rateLimit({
    windowMs,
    max,
    message: {
      error: "Too many requests from this IP, please try again later.",
      retryAfter: Math.ceil(windowMs / 1000),
    },
    standardHeaders: true,
    legacyHeaders: false,
  });
};

export const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Access denied. No valid token provided.",
      code: "NO_TOKEN",
    });
  }

  const token = authHeader.substring(7);

  if (!token) {
    return res.status(401).json({
      error: "Access denied. Token is empty.",
      code: "EMPTY_TOKEN",
    });
  }

  try {
    // PERBAIKAN: Gunakan secret yang kuat
    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET || JWT_SECRET === "your_jwt_secret_key") {
      console.error("🚨 CRITICAL: JWT_SECRET not set or using default value!");
      return res.status(500).json({
        error: "Server configuration error.",
        code: "JWT_CONFIG_ERROR",
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    // PERBAIKAN: Validasi additional claims
    if (!decoded.userId || !decoded.username) {
      return res.status(401).json({
        error: "Invalid token structure.",
        code: "INVALID_TOKEN_STRUCTURE",
      });
    }

    // PERBAIKAN: Check token expiration explicitly
    if (decoded.exp && Date.now() >= decoded.exp * 1000) {
      return res.status(401).json({
        error: "Token has expired.",
        code: "TOKEN_EXPIRED",
      });
    }

    req.user = decoded;
    next();
  } catch (error) {
    console.error("🚨 Token verification failed:", error.message);

    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        error: "Token has expired.",
        code: "TOKEN_EXPIRED",
      });
    } else if (error.name === "JsonWebTokenError") {
      return res.status(401).json({
        error: "Invalid token.",
        code: "INVALID_TOKEN",
      });
    } else {
      return res.status(401).json({
        error: "Token verification failed.",
        code: "TOKEN_VERIFICATION_FAILED",
      });
    }
  }
};

/**
 * Middleware opsional - untuk routes yang bisa diakses dengan atau tanpa token
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export const optionalAuth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader) {
      const token = authHeader.split(" ")[1];
      if (token) {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
      }
    }

    next();
  } catch (error) {
    // Jika ada error dalam token, lanjutkan tanpa user info
    next();
  }
};

export const strictAuth = verifyToken;

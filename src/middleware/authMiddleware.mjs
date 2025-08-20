// src/middleware/authMiddleware.mjs
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret_key";

/**
 * Middleware untuk memverifikasi JWT token
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export const verifyToken = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        error: "Access denied. No token provided.",
      });
    }

    // Ekstrak token dari header "Bearer <token>"
    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        error: "Access denied. Invalid token format.",
      });
    }

    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET);

    // Tambahkan user info ke request object
    req.user = decoded;

    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        error: "Token has expired. Please login again.",
      });
    } else if (error.name === "JsonWebTokenError") {
      return res.status(401).json({
        error: "Invalid token. Please login again.",
      });
    } else {
      console.error("Token verification error:", error);
      return res.status(500).json({
        error: "Internal server error during token verification.",
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

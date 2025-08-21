// filepath: backend/src/middleware/authMiddleware.mjs
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { PrismaClient } from "@prisma/client";
import {
  isDefaultAdmin,
  validateDefaultAdminPassword,
  getDefaultAdminCredentials,
} from "../lib/utils.mjs";

const prisma = new PrismaClient();

// PERBAIKAN: Simplified logging function (no circular references)
const logAuth = (level, message, data = {}) => {
  const timestamp = new Date().toISOString();
  const sanitizedData = {
    username: data.username || "unknown",
    userId: data.userId || null,
    ip: data.ip || "unknown",
  };
  console.log(`${level} [${timestamp}] ${message}`, sanitizedData);
};

// PERBAIKAN: Hybrid user authentication (Fixed circular reference)
export const authenticateUser = async (username, password) => {
  try {
    // Check if it's default admin first
    if (isDefaultAdmin(username)) {
      const isValidPassword = await validateDefaultAdminPassword(password);
      if (isValidPassword) {
        const defaultAdmin = getDefaultAdminCredentials();
        logAuth("✅", "Default admin login successful", { username });
        return {
          success: true,
          user: {
            id: 0, // Special ID for default admin
            username: defaultAdmin.username,
            email: defaultAdmin.email,
            role: defaultAdmin.role,
            isDefaultAdmin: true,
          },
        };
      } else {
        logAuth("⚠️", "Default admin login failed - invalid password", {
          username,
        });
        return {
          success: false,
          error: "Invalid credentials",
        };
      }
    }

    // PERBAIKAN: Check database users with better error handling
    try {
      const user = await prisma.user.findUnique({
        where: { username },
        select: {
          id: true,
          username: true,
          email: true,
          password: true,
          role: true,
          isActive: true,
        },
      });

      if (!user) {
        logAuth("⚠️", "Database user login failed - user not found", {
          username,
        });
        return {
          success: false,
          error: "Invalid credentials",
        };
      }

      if (!user.isActive) {
        logAuth("⚠️", "Database user login failed - user inactive", {
          username,
        });
        return {
          success: false,
          error: "Account is inactive",
        };
      }

      const { comparePassword } = await import("../lib/utils.mjs");
      const isValidPassword = await comparePassword(password, user.password);

      if (!isValidPassword) {
        logAuth("⚠️", "Database user login failed - invalid password", {
          username,
        });
        return {
          success: false,
          error: "Invalid credentials",
        };
      }

      // Update last login
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      logAuth("✅", "Database user login successful", {
        username,
        userId: user.id,
      });

      return {
        success: true,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role,
          isDefaultAdmin: false,
        },
      };
    } catch (dbError) {
      // PERBAIKAN: Simplified error logging (no circular reference)
      logAuth("❌", "Database error during authentication", {
        username,
        error: dbError.message,
      });
      return {
        success: false,
        error: "Authentication service temporarily unavailable",
      };
    }
  } catch (error) {
    logAuth("❌", "Authentication error", { username, error: error.message });
    return {
      success: false,
      error: "Authentication failed",
    };
  }
};

// PERBAIKAN: Simplified JWT verification
export const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Access denied",
        message: "No token provided or invalid format",
        expected: "Authorization: Bearer <token>",
      });
    }

    const token = authHeader.substring(7);

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Handle default admin vs database user
      if (decoded.userId === 0) {
        // Default admin
        const defaultAdmin = getDefaultAdminCredentials();
        req.user = {
          id: 0,
          username: defaultAdmin.username,
          email: defaultAdmin.email,
          role: defaultAdmin.role,
          isDefaultAdmin: true,
        };
      } else {
        // Database user - check if still exists and active
        try {
          const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            select: {
              id: true,
              username: true,
              email: true,
              role: true,
              isActive: true,
            },
          });

          if (!user || !user.isActive) {
            return res.status(401).json({
              error: "Invalid token",
              message: "User not found or inactive",
            });
          }

          req.user = {
            ...user,
            isDefaultAdmin: false,
          };
        } catch (dbError) {
          logAuth("⚠️", "Database error during token verification", {
            userId: decoded.userId,
            error: dbError.message,
          });

          return res.status(503).json({
            error: "Authentication service unavailable",
            message: "Unable to verify user credentials",
          });
        }
      }

      next();
    } catch (jwtError) {
      if (jwtError.name === "TokenExpiredError") {
        return res.status(401).json({
          error: "Token expired",
          message: "Please login again",
        });
      }

      if (jwtError.name === "JsonWebTokenError") {
        return res.status(401).json({
          error: "Invalid token",
          message: "Token is malformed",
        });
      }

      throw jwtError;
    }
  } catch (error) {
    logAuth("❌", "Auth middleware error", { error: error.message });
    res.status(500).json({
      error: "Authentication failed",
      message: "Internal server error during authentication",
    });
  }
};

// Rate limiting
export const createRateLimit = (
  windowMs,
  max,
  message = "Too many requests"
) => {
  return rateLimit({
    windowMs,
    max,
    message: {
      error: "Rate limit exceeded",
      message,
      retryAfter: Math.ceil(windowMs / 1000),
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logAuth("⚠️", "Rate limit exceeded", {
        ip: req.ip,
        path: req.path,
      });
      res.status(429).json({
        error: "Rate limit exceeded",
        message,
        retryAfter: Math.ceil(windowMs / 1000),
        timestamp: new Date().toISOString(),
      });
    },
  });
};

// Generate JWT token
export const generateToken = (userId, expiresIn = "7d") => {
  return jwt.sign(
    {
      userId,
      type: "access",
      iat: Math.floor(Date.now() / 1000),
      isDefaultAdmin: userId === 0,
    },
    process.env.JWT_SECRET,
    { expiresIn }
  );
};

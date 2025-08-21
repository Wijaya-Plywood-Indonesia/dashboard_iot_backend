import express from "express";
import {
  authenticateUser,
  generateToken,
  verifyToken,
  createRateLimit,
} from "../middleware/authMiddleware.mjs";
import {
  validateUsername,
  validatePassword,
  validateEmail,
  hashPassword,
  getDefaultAdminCredentials,
  logger,
} from "../lib/utils.mjs";
import {
  ValidationError,
  ConflictError,
  asyncHandler,
} from "../middleware/errorMiddleware.mjs";

const router = express.Router();

// PERBAIKAN: Login endpoint dengan hybrid authentication
router.post(
  "/login",
  createRateLimit(15 * 60 * 1000, 5),
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;

    // Validation
    if (!username || !password) {
      throw new ValidationError("Username and password are required");
    }

    if (!validateUsername(username)) {
      throw new ValidationError("Invalid username format");
    }

    if (!validatePassword(password)) {
      throw new ValidationError("Password must be at least 6 characters");
    }

    // PERBAIKAN: Authenticate using hybrid system
    const authResult = await authenticateUser(username, password);

    if (!authResult.success) {
      return res.status(401).json({
        success: false,
        error: "Authentication failed",
        message: authResult.error,
        timestamp: new Date().toISOString(),
      });
    }

    // Generate token
    const token = generateToken(authResult.user.id);

    logger.success("User login successful", {
      username,
      userId: authResult.user.id,
      isDefaultAdmin: authResult.user.isDefaultAdmin,
    });

    res.json({
      success: true,
      message: "Login successful",
      data: {
        token,
        user: {
          id: authResult.user.id,
          username: authResult.user.username,
          email: authResult.user.email,
          role: authResult.user.role,
          isDefaultAdmin: authResult.user.isDefaultAdmin,
        },
      },
      timestamp: new Date().toISOString(),
    });
  })
);

// PERBAIKAN: Register endpoint (hanya untuk database users)
router.post(
  "/register",
  createRateLimit(15 * 60 * 1000, 3),
  asyncHandler(async (req, res) => {
    const { username, email, password } = req.body;

    // Validation
    if (!username || !email || !password) {
      throw new ValidationError("Username, email, and password are required");
    }

    if (!validateUsername(username)) {
      throw new ValidationError(
        "Username must be at least 3 characters and contain only letters, numbers, and underscores"
      );
    }

    if (!validateEmail(email)) {
      throw new ValidationError("Invalid email format");
    }

    if (!validatePassword(password)) {
      throw new ValidationError("Password must be at least 6 characters");
    }

    // PERBAIKAN: Check if username conflicts with default admin
    const defaultAdmin = getDefaultAdminCredentials();
    if (username === defaultAdmin.username) {
      throw new ConflictError("Username is reserved");
    }

    // Check if user already exists
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();

    try {
      const existingUser = await prisma.user.findFirst({
        where: {
          OR: [{ username }, { email }],
        },
      });

      if (existingUser) {
        if (existingUser.username === username) {
          throw new ConflictError("Username already exists");
        }
        if (existingUser.email === email) {
          throw new ConflictError("Email already exists");
        }
      }

      // Hash password and create user
      const hashedPassword = await hashPassword(password);

      const newUser = await prisma.user.create({
        data: {
          username,
          email,
          password: hashedPassword,
          role: "user",
          isActive: true,
        },
        select: {
          id: true,
          username: true,
          email: true,
          role: true,
          createdAt: true,
        },
      });

      logger.success("User registration successful", {
        username,
        email,
        userId: newUser.id,
      });

      res.status(201).json({
        success: true,
        message: "User registered successfully",
        data: {
          user: {
            ...newUser,
            isDefaultAdmin: false,
          },
        },
        timestamp: new Date().toISOString(),
      });
    } finally {
      await prisma.$disconnect();
    }
  })
);

// PERBAIKAN: Get current user info
router.get("/me", verifyToken, (req, res) => {
  res.json({
    success: true,
    data: {
      user: req.user,
    },
    timestamp: new Date().toISOString(),
  });
});

// PERBAIKAN: Logout endpoint (for logging purposes)
router.post("/logout", verifyToken, (req, res) => {
  logger.info("User logout", {
    username: req.user.username,
    userId: req.user.id,
    isDefaultAdmin: req.user.isDefaultAdmin,
  });

  res.json({
    success: true,
    message: "Logout successful",
    timestamp: new Date().toISOString(),
  });
});

// PERBAIKAN: Get system auth info
router.get("/info", (req, res) => {
  const defaultAdmin = getDefaultAdminCredentials();

  res.json({
    success: true,
    data: {
      authSystem: "hybrid",
      defaultAdminAvailable: true,
      defaultAdminUsername: defaultAdmin.username,
      registrationEnabled: true,
      supportedMethods: ["username_password"],
    },
    timestamp: new Date().toISOString(),
  });
});

// PERBAIKAN: Admin endpoint to list users (protected)
router.get(
  "/users",
  verifyToken,
  asyncHandler(async (req, res) => {
    // Check if user is admin
    if (req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        error: "Access denied",
        message: "Admin privileges required",
      });
    }

    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();

    try {
      const users = await prisma.user.findMany({
        select: {
          id: true,
          username: true,
          email: true,
          role: true,
          isActive: true,
          createdAt: true,
          lastLoginAt: true,
        },
        orderBy: { createdAt: "desc" },
      });

      // Add default admin to the list
      const defaultAdmin = getDefaultAdminCredentials();
      const allUsers = [
        {
          id: 0,
          username: defaultAdmin.username,
          email: defaultAdmin.email,
          role: defaultAdmin.role,
          isActive: true,
          createdAt: null,
          lastLoginAt: null,
          isDefaultAdmin: true,
        },
        ...users.map((user) => ({ ...user, isDefaultAdmin: false })),
      ];

      logger.info("Users list requested", {
        requestedBy: req.user.username,
        totalUsers: allUsers.length,
      });

      res.json({
        success: true,
        data: {
          users: allUsers,
          total: allUsers.length,
        },
        requestedBy: req.user.username,
        timestamp: new Date().toISOString(),
      });
    } finally {
      await prisma.$disconnect();
    }
  })
);

export default router;

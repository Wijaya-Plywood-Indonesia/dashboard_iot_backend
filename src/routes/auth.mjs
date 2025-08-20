// src/routes/auth.mjs - Enhanced version dengan debug logging
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { verifyToken } from "../middleware/authMiddleware.mjs";

const prisma = new PrismaClient();
const router = express.Router();

// Gunakan variabel lingkungan untuk secret key JWT
const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret_key";

/**
 * POST /api/auth/login - Enhanced dengan debug logging
 */
router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  console.log(`🔐 Login attempt for username: "${username}"`);

  if (!username || !password) {
    console.log(
      `❌ Missing credentials - Username: ${!!username}, Password: ${!!password}`
    );
    return res.status(400).json({
      error: "Username and password are required.",
    });
  }

  try {
    // 1. Find the user by their unique username
    console.log(`🔍 Searching for user: "${username}"`);
    const user = await prisma.user.findUnique({
      where: { username: username },
    });

    if (!user) {
      console.log(`❌ User not found: "${username}"`);
      return res.status(401).json({
        error: "Invalid username or password",
      });
    }

    console.log(`✅ User found: "${username}" (ID: ${user.user_id})`);
    console.log(`🔍 Password hash length: ${user.password.length}`);
    console.log(`🔍 Password hash format: ${user.password.substring(0, 7)}...`);

    // 2. Compare the provided password with the stored hashed password
    console.log(`🧪 Testing password for user: "${username}"`);

    try {
      const isPasswordValid = await bcrypt.compare(password, user.password);
      console.log(`🔍 Password comparison result: ${isPasswordValid}`);

      if (!isPasswordValid) {
        console.log(`❌ Invalid password for user: "${username}"`);

        // Debug: Test beberapa kemungkinan password
        console.log(`🔧 Debug: Testing common password variations...`);
        const testPasswords = [
          password.toLowerCase(),
          password.toUpperCase(),
          password.trim(),
        ];

        for (const testPwd of testPasswords) {
          if (testPwd !== password) {
            const testResult = await bcrypt.compare(testPwd, user.password);
            console.log(`🔧 Debug: "${testPwd}" -> ${testResult}`);
            if (testResult) {
              console.log(`⚠️  Password case sensitivity issue detected!`);
            }
          }
        }

        return res.status(401).json({
          error: "Invalid username or password",
        });
      }
    } catch (bcryptError) {
      console.error(`❌ Bcrypt error:`, bcryptError);
      return res.status(500).json({
        error: "Password verification failed",
      });
    }

    // 3. If credentials are correct, create a JWT token
    console.log(`✅ Password valid for user: "${username}"`);

    const tokenPayload = {
      userId: user.user_id,
      username: user.username,
      iat: Math.floor(Date.now() / 1000),
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: "24h" });

    console.log(`✅ JWT token created for user: "${username}"`);
    console.log(`🔍 Token payload:`, tokenPayload);

    // 4. Send the token back to the frontend
    res.json({
      message: "Login successful",
      token: token,
      user: {
        userId: user.user_id,
        username: user.username,
      },
    });
  } catch (error) {
    console.error("❌ Login error:", error);
    res.status(500).json({
      error: "An unexpected error occurred during login.",
    });
  }
});

/**
 * POST /api/auth/register
 */
router.post("/register", async (req, res) => {
  const { username, password } = req.body;

  console.log(`📝 Registration attempt for username: "${username}"`);

  if (!username || !password) {
    return res.status(400).json({
      error: "Username and password are required.",
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      error: "Password must be at least 6 characters long.",
    });
  }

  try {
    // Cek apakah username sudah ada
    const existingUser = await prisma.user.findUnique({
      where: { username },
    });

    if (existingUser) {
      console.log(`❌ Username already exists: "${username}"`);
      return res.status(400).json({
        error: "Username already exists. Please choose another username.",
      });
    }

    // Hash the password
    console.log(`🔐 Hashing password for user: "${username}"`);
    const hashedPassword = await bcrypt.hash(password, 12);
    console.log(`✅ Password hashed (length: ${hashedPassword.length})`);

    const user = await prisma.user.create({
      data: {
        username,
        password: hashedPassword,
      },
    });

    console.log(`✅ New user registered: ${username} (ID: ${user.user_id})`);

    res.status(201).json({
      message: "User registered successfully",
      userId: user.user_id,
    });
  } catch (error) {
    console.error("❌ Registration error:", error);
    res.status(500).json({
      error: "An internal error occurred during registration.",
    });
  }
});

/**
 * GET /api/auth/verify
 */
router.get("/verify", verifyToken, async (req, res) => {
  try {
    const { userId, username } = req.user;
    console.log(
      `🔍 Token verification for user: "${username}" (ID: ${userId})`
    );

    const user = await prisma.user.findUnique({
      where: { user_id: userId },
      select: { user_id: true, username: true },
    });

    if (!user) {
      console.log(`❌ User not found during verification: ID ${userId}`);
      return res.status(401).json({
        error: "User not found. Token may be invalid.",
      });
    }

    console.log(`✅ Token verified for user: "${username}"`);
    res.json({
      message: "Token is valid",
      user: {
        userId: user.user_id,
        username: user.username,
      },
    });
  } catch (error) {
    console.error("❌ Token verification error:", error);
    res.status(500).json({
      error: "An error occurred during token verification.",
    });
  }
});

/**
 * POST /api/auth/logout
 */
router.post("/logout", verifyToken, (req, res) => {
  console.log(`📤 User logged out: ${req.user.username}`);
  res.json({ message: "Logged out successfully" });
});

/**
 * GET /api/auth/profile
 */
router.get("/profile", verifyToken, async (req, res) => {
  try {
    const { userId } = req.user;

    const user = await prisma.user.findUnique({
      where: { user_id: userId },
      select: {
        user_id: true,
        username: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      message: "Profile retrieved successfully",
      profile: user,
    });
  } catch (error) {
    console.error("Profile fetch error:", error);
    res.status(500).json({
      error: "An error occurred while fetching profile.",
    });
  }
});

export default router;

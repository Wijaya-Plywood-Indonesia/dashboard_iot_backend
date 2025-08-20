// src/routes/auth.mjs
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = express.Router();

// Gunakan variabel lingkungan untuk secret key JWT
const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret_key";

/**
 * @fileoverview Router for authentication-related endpoints.
 * This module handles user registration and login, including password hashing
 * and JWT token generation.
 */

// --- Authentication Routes ---

/**
 * POST /api/auth/register
 * Registers a new user with a hashed password.
 * @param {string} req.body.username - The username for the new user.
 * @param {string} req.body.password - The password for the new user.
 */
router.post("/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res
      .status(400)
      .json({ error: "Username and password are required." });
  }

  try {
    // Hash the password before saving to the database for security
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        username,
        password: hashedPassword,
      },
    });
    res
      .status(201)
      .json({ message: "User registered successfully", userId: user.user_id });
  } catch (error) {
    console.error("Registration error:", error);
    res
      .status(500)
      .json({
        error: "Username already exists or an internal error occurred.",
      });
  }
});

/**
 * POST /api/auth/login
 * Authenticates a user and returns a JWT token upon successful login.
 * @param {string} req.body.username - The username of the user.
 * @param {string} req.body.password - The password of the user.
 */
router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    // 1. Find the user by their unique username
    const user = await prisma.user.findUnique({
      where: {
        username: username,
      },
    });

    if (!user) {
      // If no user is found, return an error
      return res.status(401).json({ error: "Invalid username or password" });
    }

    // 2. Compare the provided password with the stored hashed password
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      // If the password is not valid, return an error
      return res.status(401).json({ error: "Invalid username or password" });
    }

    // 3. If credentials are correct, create a JWT token
    const token = jwt.sign(
      { userId: user.user_id, username: user.username },
      JWT_SECRET,
      { expiresIn: "1h" } // Token expires in 1 hour
    );

    // 4. Send the token back to the frontend
    res.json({ message: "Login successful", token: token });
  } catch (error) {
    console.error("Login error:", error);
    res
      .status(500)
      .json({ error: "An unexpected error occurred during login." });
  }
});

export default router;

import fs from "fs/promises";
import path from "path";
import bcrypt from "bcryptjs";

// VALIDATION UTILITIES
export const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

export const validatePassword = (password) => {
  return password && password.length >= 6;
};

export const validateTemperature = (temp) => {
  const temperature = parseFloat(temp);
  return !isNaN(temperature) && temperature >= -50 && temperature <= 150;
};

export const validateDateString = (dateString) => {
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date);
};

// PERBAIKAN: Authentication utilities
export const validateUsername = (username) => {
  return username && username.length >= 3 && /^[a-zA-Z0-9_]+$/.test(username);
};

export const hashPassword = async (password) => {
  const saltRounds = 12;
  return await bcrypt.hash(password, saltRounds);
};

export const comparePassword = async (password, hashedPassword) => {
  return await bcrypt.compare(password, hashedPassword);
};

// PERBAIKAN: Default admin user utilities
export const getDefaultAdminCredentials = () => {
  return {
    username: process.env.DEFAULT_ADMIN_USERNAME || "admin",
    password: process.env.DEFAULT_ADMIN_PASSWORD || "admin123",
    email: process.env.DEFAULT_ADMIN_EMAIL || "admin@dashboard.local",
    role: "admin",
  };
};

export const isDefaultAdmin = (username) => {
  const defaultAdmin = getDefaultAdminCredentials();
  return username === defaultAdmin.username;
};

export const validateDefaultAdminPassword = async (password) => {
  const defaultAdmin = getDefaultAdminCredentials();
  return password === defaultAdmin.password;
};

// RETRY UTILITIES
export const retry = async (fn, retries = 3, delay = 1000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      console.warn(
        `⚠️ Retry attempt ${attempt}/${retries} failed:`,
        error.message
      );
      await sleep(delay * attempt);
    }
  }
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// FILE UTILITIES
export const ensureDir = async (dirPath) => {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
};

export const fileExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

export const getFileSize = async (filePath) => {
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch {
    return 0;
  }
};

// FORMAT UTILITIES
export const formatDate = (date, format = "YYYY-MM-DD") => {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const seconds = String(d.getSeconds()).padStart(2, "0");

  return format
    .replace("YYYY", year)
    .replace("MM", month)
    .replace("DD", day)
    .replace("HH", hours)
    .replace("mm", minutes)
    .replace("ss", seconds);
};

export const formatBytes = (bytes) => {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

export const formatUptime = (seconds) => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(" ");
};

// TEMPERATURE UTILITIES
export const celsiusToFahrenheit = (celsius) => {
  return (celsius * 9) / 5 + 32;
};

export const fahrenheitToCelsius = (fahrenheit) => {
  return ((fahrenheit - 32) * 5) / 9;
};

export const roundTemperature = (temp, decimals = 2) => {
  return Math.round(temp * Math.pow(10, decimals)) / Math.pow(10, decimals);
};

// ARRAY UTILITIES
export const calculateStats = (numbers) => {
  if (!numbers || numbers.length === 0) {
    return { mean: 0, median: 0, mode: 0, min: 0, max: 0, count: 0 };
  }

  const sorted = [...numbers].sort((a, b) => a - b);
  const count = numbers.length;
  const sum = numbers.reduce((acc, val) => acc + val, 0);
  const mean = sum / count;

  // Median
  const median =
    count % 2 === 0
      ? (sorted[count / 2 - 1] + sorted[count / 2]) / 2
      : sorted[Math.floor(count / 2)];

  // Mode
  const frequency = {};
  numbers.forEach((num) => {
    const rounded = Math.round(num * 10) / 10;
    frequency[rounded] = (frequency[rounded] || 0) + 1;
  });
  const mode = parseFloat(
    Object.keys(frequency).reduce((a, b) =>
      frequency[a] > frequency[b] ? a : b
    )
  );

  return {
    mean: roundTemperature(mean),
    median: roundTemperature(median),
    mode: roundTemperature(mode),
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    count,
  };
};

// RESPONSE UTILITIES
export const createSuccessResponse = (data, message = "Success") => {
  return {
    success: true,
    message,
    data,
    timestamp: new Date().toISOString(),
  };
};

export const createErrorResponse = (
  message,
  error = null,
  statusCode = 500
) => {
  const response = {
    success: false,
    error: message,
    timestamp: new Date().toISOString(),
  };

  if (error && process.env.NODE_ENV === "development") {
    response.details = error.message;
    response.stack = error.stack;
  }

  return response;
};

// LOGGING UTILITIES
export const logWithTimestamp = (level, message, metadata = {}) => {
  const timestamp = new Date().toISOString();
  const emoji =
    {
      info: "ℹ️",
      warn: "⚠️",
      error: "❌",
      success: "✅",
      debug: "🔍",
    }[level] || "ℹ️";

  console.log(`${emoji} [${timestamp}] ${message}`);

  if (Object.keys(metadata).length > 0) {
    // Safely handle metadata to avoid circular references
    try {
      const safeMetadata = JSON.parse(
        JSON.stringify(metadata, (key, value) => {
          if (typeof value === "object" && value !== null) {
            // Skip circular references and large objects
            if (
              value.constructor &&
              (value.constructor.name === "IncomingMessage" ||
                value.constructor.name === "ServerResponse" ||
                value.constructor.name === "Socket")
            ) {
              return "[Complex Object]";
            }
          }
          return value;
        })
      );
      console.log("   Metadata:", safeMetadata);
    } catch (error) {
      console.log("   Metadata: [Could not serialize metadata]");
    }
  }
};

export const logger = {
  info: (message, metadata) => logWithTimestamp("info", message, metadata),
  warn: (message, metadata) => logWithTimestamp("warn", message, metadata),
  error: (message, metadata) => logWithTimestamp("error", message, metadata),
  success: (message, metadata) =>
    logWithTimestamp("success", message, metadata),
  debug: (message, metadata) => logWithTimestamp("debug", message, metadata),
};

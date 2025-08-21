import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import path from "path";
import helmet from "helmet";
import { Server } from "socket.io";
import { TemperatureService } from "./services/dataService.mjs";
import { MQTTService } from "./services/mqttService.mjs";
import sensorRoutes from "./routes/sensor.mjs";
import authRoutes from "./routes/auth.mjs";
import { verifyToken, createRateLimit } from "./middleware/authMiddleware.mjs";

const app = express();

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
  })
);

// Rate limiting
app.use("/api/auth", createRateLimit(15 * 60 * 1000, 10));
app.use("/api", createRateLimit(15 * 60 * 1000, 1000));

// CORS
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "10mb" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  },
});

// Validasi environment variables
const requiredEnvVars = ["JWT_SECRET"];
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    console.error(`🚨 CRITICAL: Environment variable ${varName} is not set!`);
    process.exit(1);
  }
});

// Service instances
let temperatureService;
let mqttService;

async function initializeServices() {
  try {
    console.log("🚀 Initializing services...");

    // 1. Initialize Temperature Service first
    temperatureService = new TemperatureService();
    console.log("✅ Temperature service initialized");

    // 2. Initialize MQTT Service with Temperature Service
    mqttService = new MQTTService(temperatureService);
    console.log("✅ MQTT service initialized");

    // 3. Set Socket.IO instance to MQTT Service for real-time updates
    mqttService.setSocketIO(io);
    console.log("✅ Socket.IO integrated with MQTT service");
  } catch (error) {
    console.error("❌ Failed to initialize services:", error);
    process.exit(1);
  }
}

// PERBAIKAN: Middleware untuk inject services ke semua routes
app.use((req, res, next) => {
  req.services = { temperatureService, mqttService };
  next();
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/sensor", sensorRoutes); // PERBAIKAN: Hapus verifyToken di sini, sudah ada di routes

// PERBAIKAN: Socket.IO connection handling
io.on("connection", (socket) => {
  console.log(`👤 Client connected: ${socket.id}`);

  // Send current status to new client
  if (mqttService) {
    const mqttStatus = mqttService.getStatus();
    socket.emit("suhu", {
      temperature: mqttStatus.lastTemperature,
      timestamp: new Date().toISOString(),
      status: mqttStatus.connected ? "connected" : "disconnected",
    });

    socket.emit("mqttStatus", {
      status: mqttStatus.connected ? "connected" : "disconnected",
      brokerUrl: mqttStatus.brokerUrl,
      topic: mqttStatus.topic,
    });
  }

  socket.on("disconnect", () => {
    console.log(`👤 Client disconnected: ${socket.id}`);
  });

  // Handle request for historical data
  socket.on("requestHistoricalData", async (dateRange) => {
    try {
      if (temperatureService) {
        const historicalData = await temperatureService.getHistoricalData(
          dateRange
        );
        socket.emit("historicalData", historicalData);
      }
    } catch (error) {
      socket.emit("error", { message: "Failed to get historical data" });
    }
  });

  // Handle request for system status
  socket.on("requestSystemStatus", async () => {
    try {
      const tempStatus = temperatureService
        ? await temperatureService.getSystemStatus()
        : null;
      const mqttStatus = mqttService ? mqttService.getStatus() : null;

      socket.emit("systemStatus", {
        temperature: tempStatus,
        mqtt: mqttStatus,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      socket.emit("error", { message: "Failed to get system status" });
    }
  });

  // MQTT control via Socket.IO
  socket.on("mqttReconnect", () => {
    try {
      if (mqttService) {
        mqttService.forceReconnect();
        socket.emit("mqttStatus", { status: "reconnecting" });
      }
    } catch (error) {
      socket.emit("error", { message: "Failed to reconnect MQTT" });
    }
  });
});

// ===========================================
// API ENDPOINTS - PERBAIKAN: HAPUS YANG KONFLIK
// ===========================================

// Status endpoint menggunakan services
app.get("/api/status", verifyToken, async (req, res) => {
  try {
    const tempStatus = temperatureService
      ? await temperatureService.getSystemStatus()
      : null;
    const mqttStatus = mqttService ? mqttService.getStatus() : null;

    res.json({
      temperature: tempStatus,
      mqtt: mqttStatus,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      error: "Status check failed",
      message: error.message,
    });
  }
});

// PERBAIKAN: HAPUS endpoint /api/suhu dari sini karena sudah ada di sensor.mjs sebagai /api/sensor/suhu

// Health check (PUBLIC)
app.get("/api/health", (req, res) => {
  const mqttStatus = mqttService ? mqttService.getStatus() : null;
  const lastTemp = mqttService ? mqttService.getLastTemperature() : 0;

  res.json({
    status: "healthy",
    services: {
      temperature: temperatureService ? "initialized" : "not_initialized",
      mqtt: mqttStatus
        ? mqttStatus.connected
          ? "connected"
          : "disconnected"
        : "not_initialized",
    },
    lastTemperature: lastTemp,
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("❌ Server Error:", error);

  const isDevelopment = process.env.NODE_ENV === "development";

  res.status(500).json({
    error: "Internal server error",
    ...(isDevelopment && {
      message: error.message,
      stack: error.stack,
    }),
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint not found",
    path: req.originalUrl,
    method: req.method,
    availableEndpoints: [
      "GET /api/health (public)",
      "GET /api/status (requires token)",
      "GET /api/sensor/suhu (requires token) - FOR DRYERS.JSX",
      "GET /api/sensor/current (requires token)",
      "GET /api/sensor/history/:date (requires token)",
    ],
    timestamp: new Date().toISOString(),
  });
});

// Graceful shutdown dengan proper service cleanup
async function gracefulShutdown() {
  console.log("🔄 Shutting down gracefully...");

  // 1. Cleanup MQTT service
  if (mqttService) {
    console.log("🧹 Cleaning up MQTT service...");
    await mqttService.disconnect();
  }

  // 2. Cleanup temperature service
  if (temperatureService) {
    console.log("🧹 Cleaning up temperature service...");
    await temperatureService.cleanup();
  }

  // 3. Close HTTP server
  server.close(() => {
    console.log("✅ Server closed gracefully");
    process.exit(0);
  });
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

// Start server dengan proper initialization
const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    // Initialize services first
    await initializeServices();

    // Then start HTTP server
    server.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`🏥 Health Check: http://localhost:${PORT}/api/health`);
      console.log("");
      console.log("🔐 Services Status:");
      console.log(`   ✅ Temperature Service: Initialized`);
      console.log(
        `   ✅ MQTT Service: ${
          mqttService.getStatus().connected ? "Connected" : "Connecting..."
        }`
      );
      console.log(
        `   ✅ Database: ${
          process.env.DATABASE_URL ? "Configured" : "NOT CONFIGURED!"
        }`
      );
      console.log(
        `   ✅ JWT: ${
          process.env.JWT_SECRET ? "Configured" : "NOT CONFIGURED!"
        }`
      );
      console.log("");
      console.log("📡 MQTT Configuration:");
      console.log(`   Broker: ${mqttService.config.brokerUrl}`);
      console.log(`   Topic: ${mqttService.config.topic}`);
      console.log("");
      console.log("🔧 Fixed Endpoints:");
      console.log(`   GET  /api/sensor/suhu (Fixed for Dryers.jsx)`);
      console.log(`   GET  /api/sensor/current (Fixed routing)`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

// Start the server
startServer();

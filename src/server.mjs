import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import path from "path";
import helmet from "helmet";
import { Server } from "socket.io";
import { TemperatureService } from "./services/dataService.mjs";
import { MQTTService } from "./services/mqttService.mjs"; // PERBAIKAN: Import MQTTService
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

// PERBAIKAN: Validasi environment variables
const requiredEnvVars = ["JWT_SECRET"];
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    console.error(`🚨 CRITICAL: Environment variable ${varName} is not set!`);
    process.exit(1);
  }
});

// PERBAIKAN: Service instances - gunakan class-based services
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

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/sensor", verifyToken, sensorRoutes);

// PERBAIKAN: Socket.IO connection handling dengan service integration
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

  // PERBAIKAN: MQTT control via Socket.IO
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
// API ENDPOINTS
// ===========================================

// PERBAIKAN: Status endpoint menggunakan services
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

// GET - Current temperature (PROTECTED)
app.get("/api/suhu", verifyToken, (req, res) => {
  console.log(`📊 Temperature data requested by user: ${req.user.username}`);

  const lastTemp = mqttService ? mqttService.getLastTemperature() : 0;
  const mqttStatus = mqttService
    ? mqttService.getStatus()
    : { connected: false };

  res.json({
    suhu: lastTemp,
    timestamp: new Date().toISOString(),
    status: mqttStatus.connected ? "connected" : "disconnected",
    mqttInfo: {
      brokerUrl: mqttStatus.brokerUrl,
      topic: mqttStatus.topic,
      reconnectAttempts: mqttStatus.reconnectAttempts,
    },
    requestedBy: req.user.username,
  });
});

// GET - Today's aggregate data (PROTECTED)
app.get("/api/aggregate/today", verifyToken, async (req, res) => {
  try {
    console.log(`📈 Aggregate data requested by user: ${req.user.username}`);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();

    const aggregateData = await prisma.temperatureAggregate.findMany({
      where: {
        date: {
          gte: today,
          lt: tomorrow,
        },
      },
      orderBy: { timeSlot: "asc" },
    });

    await prisma.$disconnect();

    if (aggregateData.length === 0) {
      return res.json({
        success: true,
        message: "No aggregate data available for today",
        data: { aggregates: [] },
        requestedBy: req.user.username,
      });
    }

    const dailyStats = {
      totalSlots: aggregateData.length,
      avgTemp:
        aggregateData.reduce((sum, item) => sum + item.meanTemp, 0) /
        aggregateData.length,
      maxTemp: Math.max(...aggregateData.map((item) => item.maxTemp)),
      minTemp: Math.min(...aggregateData.map((item) => item.minTemp)),
      totalSamples: aggregateData.reduce(
        (sum, item) => sum + item.sampleCount,
        0
      ),
    };

    res.json({
      success: true,
      message: "Today's aggregate data retrieved successfully",
      data: {
        aggregates: aggregateData,
        dailyStats: {
          ...dailyStats,
          avgTemp: Math.round(dailyStats.avgTemp * 100) / 100,
        },
      },
      requestedBy: req.user.username,
    });
  } catch (error) {
    console.error("Error getting today aggregate:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get today's aggregate data",
      error: error.message,
    });
  }
});

// GET - System status (PROTECTED)
app.get("/api/system/status", verifyToken, async (req, res) => {
  try {
    console.log(`🔧 System status requested by user: ${req.user.username}`);

    const tempStatus = temperatureService
      ? await temperatureService.getSystemStatus()
      : null;
    const mqttStatus = mqttService ? mqttService.getStatus() : null;

    res.json({
      success: true,
      data: {
        temperature: tempStatus,
        mqtt: mqttStatus,
        serverUptime: process.uptime(),
        timestamp: new Date().toISOString(),
      },
      requestedBy: req.user.username,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to get system status",
      message: error.message,
    });
  }
});

// POST - Force process buffer (PROTECTED)
app.post("/api/debug/process-buffer", verifyToken, async (req, res) => {
  try {
    console.log(`🔧 Buffer processing forced by user: ${req.user.username}`);

    if (!temperatureService) {
      return res.status(503).json({
        success: false,
        error: "Temperature service not initialized",
      });
    }

    const result = await temperatureService.forceProcessBuffer();
    res.json({
      success: true,
      message: "Buffer processed manually",
      data: result,
      processedBy: req.user.username,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to process buffer",
      message: error.message,
    });
  }
});

// POST - Force process aggregate (PROTECTED)
app.post("/api/debug/process-aggregate", verifyToken, async (req, res) => {
  try {
    console.log(`🔧 Aggregate processing forced by user: ${req.user.username}`);

    if (!temperatureService) {
      return res.status(503).json({
        success: false,
        error: "Temperature service not initialized",
      });
    }

    const result = await temperatureService.forceProcessAggregation();
    res.json({
      success: true,
      message: "Aggregation processed manually",
      data: result,
      processedBy: req.user.username,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to process aggregation",
      message: error.message,
    });
  }
});

// POST - Force MQTT reconnect (PROTECTED)
app.post("/api/debug/mqtt-reconnect", verifyToken, async (req, res) => {
  try {
    console.log(`🔧 MQTT reconnect forced by user: ${req.user.username}`);

    if (!mqttService) {
      return res.status(503).json({
        success: false,
        error: "MQTT service not initialized",
      });
    }

    mqttService.forceReconnect();

    res.json({
      success: true,
      message: "MQTT reconnection initiated",
      processedBy: req.user.username,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to reconnect MQTT",
      message: error.message,
    });
  }
});

// GET - MQTT status detail (PROTECTED)
app.get("/api/mqtt/status", verifyToken, async (req, res) => {
  try {
    console.log(`📡 MQTT status requested by user: ${req.user.username}`);

    if (!mqttService) {
      return res.status(503).json({
        error: "MQTT service not initialized",
      });
    }

    const status = mqttService.getStatus();

    res.json({
      success: true,
      data: status,
      requestedBy: req.user.username,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to get MQTT status",
      message: error.message,
    });
  }
});

// GET - System statistics (PROTECTED)
app.get("/api/stats", verifyToken, async (req, res) => {
  try {
    console.log(`📊 System stats requested by user: ${req.user.username}`);

    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();

    const stats = await prisma.$transaction([
      prisma.temperatureBuffer.count(),
      prisma.temperatureBuffer.count({ where: { isProcessed: false } }),
      prisma.temperatureAggregate.count({ where: { isExported: false } }),
      prisma.dailyTemperatureBackup.count(),
      prisma.systemLog.count({ where: { level: "ERROR" } }),
    ]);

    await prisma.$disconnect();

    const tempStatus = temperatureService
      ? await temperatureService.getSystemStatus()
      : null;
    const mqttStatus = mqttService ? mqttService.getStatus() : null;

    res.json({
      totalBufferCount: stats[0],
      activeBufferCount: stats[1],
      aggregateCount: stats[2],
      backupCount: stats[3],
      errorCount: stats[4],
      temperatureService: tempStatus,
      mqttService: mqttStatus,
      serverUptime: Math.round(process.uptime()),
      lastUpdate: new Date().toISOString(),
      requestedBy: req.user.username,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to get statistics" });
  }
});

// GET - Health check (PUBLIC)
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
      "GET /api/suhu (requires token)",
      "GET /api/mqtt/status (requires token)",
      "POST /api/debug/mqtt-reconnect (requires token)",
      "GET /api/system/status (requires token)",
      "GET /api/stats (requires token)",
    ],
    timestamp: new Date().toISOString(),
  });
});

// PERBAIKAN: Graceful shutdown dengan proper service cleanup
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

// Start server with proper initialization
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
      console.log("🔧 New Endpoints:");
      console.log(`   GET  /api/mqtt/status (MQTT detail status)`);
      console.log(`   POST /api/debug/mqtt-reconnect (Force MQTT reconnect)`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

// Start the server
startServer();

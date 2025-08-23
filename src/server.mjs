import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import rateLimit from "express-rate-limit";
import { db } from "./lib/database.mjs";
import { MQTTService } from "./services/mqttService.mjs";
import { TemperatureService } from "./services/dataService.mjs";
import authRoutes from "./routes/auth.mjs";
import sensorRoutes from "./routes/sensor.mjs";
import healthRoutes from "./routes/healthRoutes.mjs";
import backupRoutes from "./routes/backupRoutes.mjs";
import {
  errorHandler,
  notFoundHandler,
} from "./middleware/errorMiddleware.mjs";

// Load environment variables
dotenv.config();

const app = express();
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const PORT = process.env.PORT || 3000;

// PERBAIKAN: Global error handling
process.on("uncaughtException", (error) => {
  console.error("🚨 Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("🚨 Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

// PERBAIKAN: Enhanced middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
  })
);

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// PERBAIKAN: Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    error: "Too many requests from this IP, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// PERBAIKAN: Middleware untuk inject services ke req
app.use((req, res, next) => {
  req.services = {
    temperatureService: app.locals.temperatureService,
    mqttService: app.locals.mqttService,
  };
  next();
});

// PERBAIKAN: Initialize services dengan proper order
let temperatureService;
let mqttService;

async function initializeServices() {
  try {
    console.log("🔧 Initializing database...");
    await db.initialize();

    console.log("🔧 Initializing TemperatureService...");
    temperatureService = new TemperatureService();

    console.log("🔧 Initializing MQTT Service...");
    mqttService = new MQTTService(temperatureService, io);

    // PERBAIKAN: Set global IO untuk notifikasi export
    global.io = io;

    // PERBAIKAN: Make services available to routes
    app.locals.temperatureService = temperatureService;
    app.locals.mqttService = mqttService;

    console.log("✅ All services initialized successfully");

    // Set up Socket.IO untuk real-time updates
    setupSocketIO();
  } catch (error) {
    console.error("❌ Service initialization failed:", error);
    process.exit(1);
  }
}

// PERBAIKAN: Socket.IO setup untuk real-time updates
function setupSocketIO() {
  io.on("connection", (socket) => {
    console.log(`👤 Client connected: ${socket.id}`);

    // Send current status on connection
    socket.emit("connectionStatus", {
      status: "connected",
      timestamp: new Date().toISOString(),
      services: {
        mqtt: mqttService?.getStatus() || { connected: false },
        database: { connected: db.isConnected },
        temperature: temperatureService ? "active" : "inactive",
      },
    });

    // Handle client requests
    socket.on("requestCurrentData", async () => {
      try {
        const currentTemp = mqttService?.getLastTemperature() || 0;
        const bufferSize = temperatureService?.state?.bufferData?.length || 0;

        socket.emit("currentData", {
          temperature: currentTemp,
          bufferSize,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        console.error("Error sending current data:", error);
        socket.emit("error", { message: "Failed to get current data" });
      }
    });

    socket.on("requestAggregateData", async () => {
      try {
        // Get today's aggregate data
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const aggregateData = await db.withRetry(async (prisma) => {
          return await prisma.temperatureAggregate.findMany({
            where: {
              date: { gte: today, lt: tomorrow },
            },
            orderBy: { timeSlot: "asc" },
          });
        });

        socket.emit("aggregateData", {
          data: aggregateData,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        console.error("Error sending aggregate data:", error);
        socket.emit("error", { message: "Failed to get aggregate data" });
      }
    });

    socket.on("disconnect", () => {
      console.log(`👤 Client disconnected: ${socket.id}`);
    });
  });
}

// PERBAIKAN: Routes dengan middleware yang tepat
app.use("/api/auth", authRoutes);
app.use("/api/sensor", sensorRoutes);
app.use("/api/health", healthRoutes);
app.use("/api/backup", backupRoutes);

// PERBAIKAN: System info endpoint dengan 6-hour export status
app.get("/api/system/info", async (req, res) => {
  try {
    const systemInfo = {
      status: "online",
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      services: {
        database: {
          connected: db.isConnected,
          status: db.isConnected ? "healthy" : "disconnected",
        },
        mqtt: mqttService ? mqttService.getStatus() : { connected: false },
        temperature: {
          status: temperatureService ? "active" : "inactive",
          bufferSize: temperatureService?.state?.bufferData?.length || 0,
          lastProcessed: temperatureService?.state?.lastSavedMinute || null,
          lastSixHourExport:
            temperatureService?.exportConfig?.lastSixHourExport || null,
        },
      },
      sixHourExport: {
        enabled: true,
        intervalMs:
          temperatureService?.exportConfig?.sixHourIntervalMs || 21600000,
        nextExportEstimate: temperatureService
          ? this.calculateNextExport()
          : null,
      },
      timestamp: new Date().toISOString(),
    };

    res.json({
      success: true,
      data: systemInfo,
    });
  } catch (error) {
    console.error("Error getting system info:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// PERBAIKAN: Endpoint untuk mendapatkan pending 6-hour exports
app.get("/api/system/six-hour-exports/pending", async (req, res) => {
  try {
    const pendingExports = await db.withRetry(async (prisma) => {
      return await prisma.sixHourExport.findMany({
        where: {
          isReady: true,
          downloadNotified: false,
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      });
    });

    res.json({
      success: true,
      message: "Pending 6-hour exports retrieved successfully",
      data: pendingExports,
      count: pendingExports.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error getting pending exports:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// PERBAIKAN: Helper function untuk kalkulasi next export
function calculateNextExport() {
  const now = new Date();
  const currentHour = now.getHours();
  let nextExportHour;

  if (currentHour < 6) {
    nextExportHour = 6;
  } else if (currentHour < 12) {
    nextExportHour = 12;
  } else if (currentHour < 18) {
    nextExportHour = 18;
  } else {
    nextExportHour = 24; // Next day at 00:00
  }

  const nextExport = new Date(now);
  if (nextExportHour === 24) {
    nextExport.setDate(nextExport.getDate() + 1);
    nextExport.setHours(0, 0, 0, 0);
  } else {
    nextExport.setHours(nextExportHour, 0, 0, 0);
  }

  return nextExport.toISOString();
}

// Error handling middleware
app.use(notFoundHandler);
app.use(errorHandler);

// PERBAIKAN: Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);

  try {
    // Stop accepting new connections
    server.close(async () => {
      console.log("🔌 HTTP server closed");

      // Disconnect services
      if (mqttService) {
        await mqttService.disconnect();
        console.log("🔌 MQTT service disconnected");
      }

      if (temperatureService) {
        await temperatureService.shutdown();
        console.log("🔌 Temperature service stopped");
      }

      // Disconnect database
      await db.disconnect();
      console.log("🔌 Database disconnected");

      console.log("✅ Graceful shutdown completed");
      process.exit(0);
    });

    // Force close after 30 seconds
    setTimeout(() => {
      console.error("❌ Forced shutdown after timeout");
      process.exit(1);
    }, 30000);
  } catch (error) {
    console.error("❌ Error during shutdown:", error);
    process.exit(1);
  }
}

// Register shutdown handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// PERBAIKAN: Start server dengan proper initialization
async function startServer() {
  try {
    await initializeServices();

    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📡 Socket.IO enabled for real-time updates`);
      console.log(`🌐 API available at http://localhost:${PORT}/api`);
      console.log(`🔧 Environment: ${process.env.NODE_ENV || "development"}`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

// Start the server
startServer();

export { app, server, io, temperatureService, mqttService };

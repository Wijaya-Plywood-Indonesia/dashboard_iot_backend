// src/server/server.mjs
import express from "express";
import http from "http";
import mqtt from "mqtt";
import cors from "cors";
import path from "path";
import { Server } from "socket.io";
import { TemperatureService } from "../services/dataService.mjs";
import sensorRoutes from "../routes/sensor.mjs";
import authRoutes from "../routes/auth.mjs";
import { verifyToken, optionalAuth } from "../middleware/authMiddleware.mjs";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

// Inisialisasi service temperature
const tempService = new TemperatureService();

// AUTHENTICATION ROUTES (Public - tidak perlu proteksi)
app.use("/api/auth", authRoutes);

// SENSOR ROUTES (Protected - perlu token)
app.use("/api/sensor", verifyToken, sensorRoutes);

// MQTT config
const client = mqtt.connect("mqtt://broker.hivemq.com:1883");
const topic = "esp32/suhu";

let lastTemp = 0;

// MQTT connect
client.on("connect", () => {
  console.log("🟢 Terhubung ke MQTT broker");
  console.log("📡 Subscribe ke topik:", topic);

  client.subscribe(topic, (err) => {
    if (!err) {
      console.log(`✅ Berhasil subscribe ke topik: ${topic}`);
    } else {
      console.error("❌ Error subscribing to topic:", err);
    }
  });
});

// MQTT message handler dengan integrasi database yang diperbaiki
client.on("message", async (topic, message) => {
  try {
    const suhu = parseFloat(message.toString());

    if (isNaN(suhu) || suhu < -50 || suhu > 1000) {
      console.warn(`⚠️  Data suhu tidak valid: ${suhu}°C`);
      return;
    }

    lastTemp = suhu;
    console.log(`🌡️  Data MQTT: ${suhu}°C`);

    const result = await tempService.receiveTemperatureData(suhu);

    if (result.success) {
      console.log(`📊 Buffer size: ${result.bufferSize}`);
    }

    // Broadcast ke React via Socket.IO
    io.emit("suhu", {
      temperature: suhu,
      timestamp: new Date().toISOString(),
      status: "connected",
      bufferSize: result.bufferSize,
    });

    // Emit juga ke channel khusus untuk real-time charts
    io.emit("temperatureData", {
      value: suhu,
      time: Date.now(),
      bufferSize: result.bufferSize,
    });
  } catch (error) {
    console.error("❌ Error processing MQTT message:", error);
    io.emit("suhu", {
      temperature: lastTemp,
      timestamp: new Date().toISOString(),
      status: "error",
      error: error.message,
    });
  }
});

// Handle MQTT connection errors
client.on("error", (error) => {
  console.error("❌ MQTT Connection Error:", error);
  io.emit("mqttStatus", { status: "disconnected", error: error.message });
});

client.on("reconnect", () => {
  console.log("🔄 Reconnecting to MQTT broker...");
  io.emit("mqttStatus", { status: "reconnecting" });
});

client.on("close", () => {
  console.log("📡 MQTT connection closed");
  io.emit("mqttStatus", { status: "disconnected" });
});

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log(`👤 Client terhubung: ${socket.id}`);

  // Kirim data terakhir saat client connect
  socket.emit("suhu", {
    temperature: lastTemp,
    timestamp: new Date().toISOString(),
    status: "connected",
  });

  socket.on("disconnect", () => {
    console.log(`👤 Client terputus: ${socket.id}`);
  });

  // Handle request untuk data historis
  socket.on("requestHistoricalData", async (dateRange) => {
    try {
      const historicalData = await tempService.getHistoricalData(dateRange);
      socket.emit("historicalData", historicalData);
    } catch (error) {
      socket.emit("error", { message: "Gagal mengambil data historis" });
    }
  });

  // Handle request untuk system status
  socket.on("requestSystemStatus", async () => {
    try {
      const status = await tempService.getSystemStatus();
      socket.emit("systemStatus", status);
    } catch (error) {
      socket.emit("error", { message: "Gagal mengambil status sistem" });
    }
  });
});

// ===========================================
// PROTECTED REST API ENDPOINTS
// ===========================================

// GET - Ambil suhu terakhir (PROTECTED)
app.get("/api/suhu", verifyToken, (req, res) => {
  console.log(`📊 Temperature data requested by user: ${req.user.username}`);
  res.json({
    suhu: lastTemp,
    timestamp: new Date().toISOString(),
    status: "ok",
    requestedBy: req.user.username,
  });
});

// GET - Aggregate today (PROTECTED)
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
        message: "Belum ada data agregasi untuk hari ini",
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
      message: "Data agregasi hari ini berhasil diambil",
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
      message: "Gagal mengambil data agregasi hari ini",
      error: error.message,
    });
  }
});

// GET - Status sistem real-time (PROTECTED)
app.get("/api/system/status", verifyToken, async (req, res) => {
  try {
    console.log(`🔧 System status requested by user: ${req.user.username}`);

    const status = await tempService.getSystemStatus();
    res.json({
      success: true,
      data: {
        ...status,
        mqttConnected: client.connected,
        lastTemperature: lastTemp,
        serverUptime: process.uptime(),
        timestamp: new Date().toISOString(),
      },
      requestedBy: req.user.username,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Gagal mengambil status sistem",
      message: error.message,
    });
  }
});

// POST - Force process buffer (PROTECTED)
app.post("/api/debug/process-buffer", verifyToken, async (req, res) => {
  try {
    console.log(`🔧 Buffer processing forced by user: ${req.user.username}`);

    await tempService.forceProcessBuffer();
    res.json({
      success: true,
      message: "Buffer berhasil diproses secara manual",
      processedBy: req.user.username,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Gagal memproses buffer",
      message: error.message,
    });
  }
});

// POST - Force process aggregate (PROTECTED)
app.post("/api/debug/process-aggregate", verifyToken, async (req, res) => {
  try {
    console.log(`🔧 Aggregate processing forced by user: ${req.user.username}`);

    await tempService.forceProcessAggregate();
    res.json({
      success: true,
      message: "Agregasi berhasil diproses secara manual",
      processedBy: req.user.username,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Gagal memproses agregasi",
      message: error.message,
    });
  }
});

// GET - Ambil data backup berdasarkan tanggal (PROTECTED)
app.get("/api/backup/:date", verifyToken, async (req, res) => {
  try {
    console.log(
      `📁 Backup data requested by user: ${req.user.username} for date: ${req.params.date}`
    );

    const { date } = req.params;
    const backupData = await tempService.getBackupDataByDate(date);

    if (backupData.error) {
      return res.status(404).json({ error: backupData.error });
    }

    res.json({
      ...backupData,
      requestedBy: req.user.username,
    });
  } catch (error) {
    res.status(500).json({ error: "Gagal mengambil data backup" });
  }
});

// GET - Ambil daftar tanggal backup yang tersedia (PROTECTED)
app.get("/api/backup", verifyToken, async (req, res) => {
  try {
    console.log(`📁 Backup list requested by user: ${req.user.username}`);

    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();

    const backupList = await prisma.dailyTemperatureBackup.findMany({
      select: {
        date: true,
        totalRecords: true,
        avgDailyTemp: true,
        minDailyTemp: true,
        maxDailyTemp: true,
        exportedAt: true,
      },
      orderBy: { date: "desc" },
    });

    await prisma.$disconnect();
    res.json({
      data: backupList,
      requestedBy: req.user.username,
    });
  } catch (error) {
    res.status(500).json({ error: "Gagal mengambil daftar backup" });
  }
});

// GET - Download file export (PROTECTED)
app.get("/api/download/:type/:date", verifyToken, async (req, res) => {
  try {
    console.log(
      `📥 File download requested by user: ${req.user.username} - ${req.params.type}/${req.params.date}`
    );

    const { type, date } = req.params;
    const backup = await tempService.getBackupDataByDate(date);

    if (backup.error) {
      return res.status(404).json({ error: backup.error });
    }

    const filePath = type === "csv" ? backup.csvFilePath : backup.excelFilePath;

    if (!filePath) {
      return res.status(404).json({ error: "File tidak ditemukan" });
    }

    const fileName = path.basename(filePath);
    res.download(filePath, fileName);
  } catch (error) {
    res.status(500).json({ error: "Gagal mendownload file" });
  }
});

// POST - Manual export data (PROTECTED)
app.post("/api/export", verifyToken, async (req, res) => {
  try {
    console.log(`📤 Manual export triggered by user: ${req.user.username}`);

    await tempService.exportDailyData();
    res.json({
      message: "Export berhasil dijalankan",
      exportedBy: req.user.username,
    });
  } catch (error) {
    res.status(500).json({ error: "Export gagal" });
  }
});

// GET - Ambil statistik sistem (PROTECTED)
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

    const systemStatus = await tempService.getSystemStatus();

    res.json({
      totalBufferCount: stats[0],
      activeBufferCount: stats[1],
      aggregateCount: stats[2],
      backupCount: stats[3],
      errorCount: stats[4],
      systemStatus,
      mqttConnected: client.connected,
      lastTemperature: lastTemp,
      serverUptime: Math.round(process.uptime()),
      lastUpdate: new Date().toISOString(),
      requestedBy: req.user.username,
    });
  } catch (error) {
    res.status(500).json({ error: "Gagal mengambil statistik" });
  }
});

// GET - Ambil log sistem (PROTECTED)
app.get("/api/logs", verifyToken, async (req, res) => {
  try {
    console.log(`📋 System logs requested by user: ${req.user.username}`);

    const { limit = 50, level } = req.query;
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();

    const whereClause = level ? { level: level.toUpperCase() } : {};

    const logs = await prisma.systemLog.findMany({
      where: whereClause,
      orderBy: { timestamp: "desc" },
      take: parseInt(limit),
    });

    await prisma.$disconnect();
    res.json({
      data: logs,
      requestedBy: req.user.username,
    });
  } catch (error) {
    res.status(500).json({ error: "Gagal mengambil log" });
  }
});

// ===========================================
// PUBLIC ENDPOINTS
// ===========================================

// GET - Health check endpoint (PUBLIC - tidak perlu token)
app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    mqtt: client.connected ? "connected" : "disconnected",
    database: "connected",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("❌ Server Error:", error);
  res.status(500).json({
    error: "Internal server error",
    message: error.message,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint tidak ditemukan",
    availableEndpoints: [
      // Public endpoints
      "GET /api/health (public)",
      "POST /api/auth/register (public)",
      "POST /api/auth/login (public)",
      "GET /api/auth/verify (requires token)",
      "POST /api/auth/logout (requires token)",

      // Protected endpoints
      "GET /api/suhu (requires token)",
      "GET /api/system/status (requires token)",
      "GET /api/stats (requires token)",
      "GET /api/logs (requires token)",
      "GET /api/backup (requires token)",
      "GET /api/sensor/current (requires token)",
      "GET /api/sensor/aggregate/today (requires token)",
      "GET /api/sensor/realtime/stats (requires token)",
      "GET /api/sensor/history/:date (requires token)",
      "POST /api/debug/process-buffer (requires token)",
      "POST /api/debug/process-aggregate (requires token)",
    ],
  });
});

// Graceful shutdown handling
process.on("SIGTERM", async () => {
  console.log("🔄 SIGTERM received, shutting down gracefully");

  if (client.connected) {
    client.end();
  }

  await tempService.cleanup();

  server.close(() => {
    console.log("✅ Server closed gracefully");
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  console.log("🔄 SIGINT received, shutting down gracefully");

  if (client.connected) {
    client.end();
  }

  await tempService.cleanup();

  server.close(() => {
    console.log("✅ Server closed gracefully");
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
  console.log(`🏥 Health Check: http://localhost:${PORT}/api/health`);
  console.log("");
  console.log("🔐 Authentication Endpoints:");
  console.log(`   POST http://localhost:${PORT}/api/auth/register`);
  console.log(`   POST http://localhost:${PORT}/api/auth/login`);
  console.log(`   GET  http://localhost:${PORT}/api/auth/verify`);
  console.log(`   POST http://localhost:${PORT}/api/auth/logout`);
  console.log("");
  console.log("🔧 Protected Sensor Endpoints (requires Bearer token):");
  console.log(`   GET http://localhost:${PORT}/api/sensor/current`);
  console.log(`   GET http://localhost:${PORT}/api/sensor/aggregate/today`);
  console.log(`   GET http://localhost:${PORT}/api/sensor/realtime/stats`);
  console.log(`   GET http://localhost:${PORT}/api/sensor/history/YYYY-MM-DD`);
  console.log("");
  console.log("🔧 Protected System Endpoints (requires Bearer token):");
  console.log(`   GET http://localhost:${PORT}/api/system/status`);
  console.log(`   GET http://localhost:${PORT}/api/stats`);
  console.log(`   GET http://localhost:${PORT}/api/logs`);
  console.log("");
  console.log("🔧 Protected Debug Endpoints (requires Bearer token):");
  console.log(`   POST http://localhost:${PORT}/api/debug/process-buffer`);
  console.log(`   POST http://localhost:${PORT}/api/debug/process-aggregate`);
});

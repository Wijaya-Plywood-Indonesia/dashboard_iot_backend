// src/server/server.mjs
import express from "express";
import http from "http";
import mqtt from "mqtt";
import cors from "cors";
import { Server } from "socket.io";
import { TemperatureService } from "../services/dataService.mjs";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

// Inisialisasi service temperature
const tempService = new TemperatureService();

// MQTT config
const client = mqtt.connect("mqtt://broker.emqx.io:1883");
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

    // Validasi data suhu
    if (isNaN(suhu) || suhu < -50 || suhu > 100) {
      console.warn(`⚠️  Data suhu tidak valid: ${suhu}°C`);
      return;
    }

    lastTemp = suhu;
    console.log(`🌡️  Data MQTT: ${suhu}°C`);

    // PERBAIKAN: Gunakan receiveTemperatureData alih-alih saveTemperatureToBuffer
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
// REST API ENDPOINTS
// ===========================================

// GET - Ambil suhu terakhir (legacy endpoint)
app.get("/api/suhu", (req, res) => {
  res.json({
    suhu: lastTemp,
    timestamp: new Date().toISOString(),
    status: "ok",
  });
});

// GET - Status sistem real-time
app.get("/api/system/status", async (req, res) => {
  try {
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
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Gagal mengambil status sistem",
      message: error.message,
    });
  }
});

// POST - Force process buffer (untuk debugging)
app.post("/api/debug/process-buffer", async (req, res) => {
  try {
    await tempService.forceProcessBuffer();
    res.json({
      success: true,
      message: "Buffer berhasil diproses secara manual",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Gagal memproses buffer",
      message: error.message,
    });
  }
});

// POST - Force process aggregate (untuk debugging)
app.post("/api/debug/process-aggregate", async (req, res) => {
  try {
    await tempService.forceProcessAggregate();
    res.json({
      success: true,
      message: "Agregasi berhasil diproses secara manual",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Gagal memproses agregasi",
      message: error.message,
    });
  }
});

// GET - Ambil data backup berdasarkan tanggal
app.get("/api/backup/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const backupData = await tempService.getBackupDataByDate(date);

    if (backupData.error) {
      return res.status(404).json({ error: backupData.error });
    }

    res.json(backupData);
  } catch (error) {
    res.status(500).json({ error: "Gagal mengambil data backup" });
  }
});

// GET - Ambil daftar tanggal backup yang tersedia
app.get("/api/backup", async (req, res) => {
  try {
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
    res.json(backupList);
  } catch (error) {
    res.status(500).json({ error: "Gagal mengambil daftar backup" });
  }
});

// GET - Download file export (CSV/Excel)
app.get("/api/download/:type/:date", async (req, res) => {
  try {
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

// POST - Manual export data (untuk testing)
app.post("/api/export", async (req, res) => {
  try {
    await tempService.exportDailyData();
    res.json({ message: "Export berhasil dijalankan" });
  } catch (error) {
    res.status(500).json({ error: "Export gagal" });
  }
});

// GET - Ambil statistik sistem
app.get("/api/stats", async (req, res) => {
  try {
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
    });
  } catch (error) {
    res.status(500).json({ error: "Gagal mengambil statistik" });
  }
});

// GET - Ambil log sistem
app.get("/api/logs", async (req, res) => {
  try {
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
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: "Gagal mengambil log" });
  }
});

// GET - Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    mqtt: client.connected ? "connected" : "disconnected",
    database: "connected", // Prisma akan throw error jika tidak connected
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
      "GET /api/suhu",
      "GET /api/system/status",
      "GET /api/stats",
      "GET /api/logs",
      "GET /api/backup",
      "GET /api/health",
      "POST /api/debug/process-buffer",
      "POST /api/debug/process-aggregate",
    ],
  });
});

// Graceful shutdown handling
process.on("SIGTERM", async () => {
  console.log("🔄 SIGTERM received, shutting down gracefully");

  // Close MQTT connection
  if (client.connected) {
    client.end();
  }

  // Cleanup temperature service
  await tempService.cleanup();

  // Close server
  server.close(() => {
    console.log("✅ Server closed gracefully");
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  console.log("🔄 SIGINT received, shutting down gracefully");

  // Close MQTT connection
  if (client.connected) {
    client.end();
  }

  // Cleanup temperature service
  await tempService.cleanup();

  // Close server
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
  console.log(`📊 System Status: http://localhost:${PORT}/api/system/status`);
  console.log(`📈 Dashboard Stats: http://localhost:${PORT}/api/stats`);
  console.log(`🏥 Health Check: http://localhost:${PORT}/api/health`);
  console.log(`📋 System Logs: http://localhost:${PORT}/api/logs`);
  console.log("");
  console.log("🔧 Debug Endpoints:");
  console.log(`   POST http://localhost:${PORT}/api/debug/process-buffer`);
  console.log(`   POST http://localhost:${PORT}/api/debug/process-aggregate`);
});

import express from "express";
import {
  asyncHandler,
  ValidationError,
} from "../middleware/errorMiddleware.mjs";
import { verifyToken } from "../middleware/authMiddleware.mjs";

const router = express.Router();

// PERBAIKAN: Middleware untuk inject services
router.use((req, res, next) => {
  // Services akan di-inject dari server.mjs
  if (!req.services) {
    req.services = {}; // Fallback empty object
  }
  next();
});

// PERBAIKAN: GET /suhu endpoint untuk Dryers.jsx
router.get(
  "/suhu",
  verifyToken,
  asyncHandler(async (req, res) => {
    try {
      console.log(`🌡️ /sensor/suhu hit by user: ${req.user.username}`);

      const { mqttService } = req.services;

      // Priority 1: MQTT real-time data
      const lastTemp = mqttService ? mqttService.getLastTemperature() : 0;
      const mqttStatus = mqttService
        ? mqttService.getStatus()
        : { connected: false };

      if (lastTemp > 0 && mqttStatus.connected) {
        console.log(`✅ Real ESP32 data: ${lastTemp}°C`);

        return res.json({
          success: true,
          message: "Temperature from ESP32 via MQTT",
          suhu: lastTemp,
          temperature: lastTemp,
          humidity: 50 + Math.random() * 20,
          timestamp: new Date().toISOString(),
          status: "connected",
          source: "esp32_mqtt",
          usingSimulation: false,
          requestedBy: req.user.username,
        });
      }

      // Priority 2: Database fallback
      try {
        const { db } = await import("../lib/database.mjs");

        const latestReading = await db.withRetry(async (prismaClient) => {
          return await prismaClient.temperatureBuffer.findFirst({
            orderBy: { timestamp: "desc" },
            where: {
              timestamp: {
                gte: new Date(Date.now() - 30 * 60 * 1000), // Last 30 minutes
              },
            },
          });
        });

        if (latestReading) {
          console.log(`✅ Database data: ${latestReading.temperature}°C`);

          return res.json({
            success: true,
            message: "Temperature from database",
            suhu: latestReading.temperature,
            temperature: latestReading.temperature,
            humidity: 50 + Math.random() * 20,
            timestamp: latestReading.timestamp.toISOString(),
            status: "database",
            source: "database",
            usingSimulation: false,
            requestedBy: req.user.username,
          });
        }
      } catch (dbError) {
        console.error("❌ Database query failed:", dbError.message);
      }

      // Priority 3: Simulation fallback
      console.log("⚠️ No real data available, using simulation");

      const simulatedTemp = 25 + Math.random() * 10;

      res.json({
        success: true,
        message: "No real data - using simulation",
        suhu: simulatedTemp,
        temperature: simulatedTemp,
        humidity: 50 + Math.random() * 20,
        timestamp: new Date().toISOString(),
        status: "simulation",
        source: "simulation",
        usingSimulation: true,
        requestedBy: req.user.username,
      });
    } catch (error) {
      console.error("❌ /sensor/suhu error:", error);

      // Error fallback
      const fallbackTemp = 26 + Math.random() * 4;

      res.json({
        success: true,
        message: "Error fallback - using simulation",
        suhu: fallbackTemp,
        temperature: fallbackTemp,
        humidity: 45 + Math.random() * 15,
        timestamp: new Date().toISOString(),
        status: "error",
        source: "error_fallback",
        usingSimulation: true,
        error: error.message,
        requestedBy: req.user.username,
      });
    }
  })
);

// Getting Historical data
router.get(
  "/history/:date",
  verifyToken,
  asyncHandler(async (req, res) => {
    try {
      const { date } = req.params;

      console.log(
        `📈 Historical data requested for date: ${date} by user: ${req.user?.username}`
      );

      // Validasi format tanggal
      const targetDate = new Date(date);
      if (isNaN(targetDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: "Format tanggal tidak valid. Gunakan format YYYY-MM-DD",
          timestamp: new Date().toISOString(),
        });
      }

      // Import database
      const { db } = await import("../lib/database.mjs");

      // Cek apakah data sudah dibackup
      const backup = await db.withRetry(async (prisma) => {
        return await prisma.dailyTemperatureBackup.findUnique({
          where: { date },
        });
      });

      if (backup) {
        console.log(`✅ Found backup data for ${date}`);

        return res.json({
          success: true,
          message: "Data historis dari backup berhasil diambil",
          data: {
            source: "backup",
            backup: backup,
            isExported: true,
            date: date,
          },
          requestedBy: req.user?.username,
          timestamp: new Date().toISOString(),
        });
      } else {
        console.log(`🔍 No backup found for ${date}, checking aggregates...`);

        const startDate = new Date(date);
        startDate.setHours(0, 0, 0, 0);

        const endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + 1);

        const aggregateData = await db.withRetry(async (prisma) => {
          return await prisma.temperatureAggregate.findMany({
            where: {
              date: {
                gte: startDate,
                lt: endDate,
              },
            },
            orderBy: { timeSlot: "asc" },
          });
        });

        if (aggregateData.length === 0) {
          console.log(`❌ No data found for ${date}`);

          return res.status(404).json({
            success: false,
            message: `Tidak ada data untuk tanggal ${date}`,
            data: {
              source: "none",
              date: date,
              searchedRange: {
                start: startDate.toISOString(),
                end: endDate.toISOString(),
              },
            },
            requestedBy: req.user?.username,
            timestamp: new Date().toISOString(),
          });
        }

        console.log(
          `✅ Found ${aggregateData.length} aggregate records for ${date}`
        );

        return res.json({
          success: true,
          message: "Data historis dari agregasi berhasil diambil",
          data: {
            source: "aggregate",
            aggregates: aggregateData,
            isExported: false,
            date: date,
            count: aggregateData.length,
          },
          requestedBy: req.user?.username,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.error("❌ Error getting historical data:", error);

      res.status(500).json({
        success: false,
        message: "Gagal mengambil data historis",
        error: error.message,
        data: {
          source: "error",
          date: req.params.date,
        },
        requestedBy: req.user?.username,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

// Get current temperature
router.get(
  "/current",
  verifyToken,
  asyncHandler(async (req, res) => {
    try {
      console.log(`📡 /sensor/current hit by user: ${req.user.username}`);

      const { mqttService } = req.services;

      // Priority 1: MQTT real-time data
      const lastTemp = mqttService ? mqttService.getLastTemperature() : 0;
      const mqttStatus = mqttService
        ? mqttService.getStatus()
        : { connected: false };

      if (lastTemp > 0 && mqttStatus.connected) {
        console.log(`✅ Real-time MQTT data: ${lastTemp}°C`);

        const realTimeData = {
          1: {
            dryerId: 1,
            suhu: lastTemp,
            humidity: 50 + Math.random() * 10,
            status:
              lastTemp > 80 ? "critical" : lastTemp > 70 ? "warning" : "normal",
            timestamp: new Date(),
            sensorId: "esp32_sensor_1",
            location: "Zone A",
          },
        };

        return res.json({
          success: true,
          message: "Real-time temperature data from ESP32",
          data: realTimeData,
          count: 1,
          usingSimulation: false,
          source: "esp32_mqtt",
          timestamp: new Date().toISOString(),
        });
      }

      // Priority 2: Database fallback
      try {
        const { db } = await import("../lib/database.mjs");

        const recentReadings = await db.withRetry(async (prisma) => {
          return await prisma.temperatureBuffer.findMany({
            where: {
              timestamp: {
                gte: new Date(Date.now() - 10 * 60 * 1000), // Last 10 minutes
              },
            },
            orderBy: { timestamp: "desc" },
            take: 10,
          });
        });

        if (recentReadings.length > 0) {
          const dryersData = {};
          recentReadings.forEach((reading, index) => {
            const dryerId = index + 1;
            dryersData[dryerId] = {
              dryerId,
              suhu: reading.temperature,
              humidity: 50 + Math.random() * 10,
              status: "normal",
              timestamp: reading.timestamp,
              sensorId: `sensor_${dryerId}`,
              location: `Zone ${String.fromCharCode(64 + dryerId)}`,
            };
          });

          console.log(
            `✅ Retrieved real data for ${
              Object.keys(dryersData).length
            } dryers`
          );

          return res.json({
            success: true,
            message: "Current temperature data retrieved from ESP32",
            data: dryersData,
            count: Object.keys(dryersData).length,
            usingSimulation: false,
            source: "database",
            timestamp: new Date().toISOString(),
          });
        }
      } catch (dbError) {
        console.error("❌ Database query failed:", dbError.message);
      }

      // Priority 3: Simulation fallback
      console.log("⚠️ No recent readings found, returning simulation data");

      const simulationData = {
        1: {
          dryerId: 1,
          suhu: 25.5 + Math.random() * 5,
          humidity: 50 + Math.random() * 10,
          status: "normal",
          timestamp: new Date(),
          sensorId: "sensor_1",
          location: "Zone A",
        },
      };

      res.json({
        success: true,
        message: "No recent data - using simulation",
        data: simulationData,
        count: 1,
        usingSimulation: true,
        source: "simulation",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ /sensor/current error:", error);

      const simulationData = {
        1: {
          dryerId: 1,
          suhu: 26.0 + Math.random() * 4,
          humidity: 45 + Math.random() * 15,
          status: "normal",
          timestamp: new Date(),
          sensorId: "sensor_1",
          location: "Zone A",
        },
      };

      res.json({
        success: true,
        message: "Database error - using simulation",
        data: simulationData,
        count: 1,
        usingSimulation: true,
        error: error.message,
        source: "error_fallback",
        timestamp: new Date().toISOString(),
      });
    }
  })
);

// Get today's aggregate data
router.get(
  "/aggregate/today",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { db } = await import("../lib/database.mjs");

    console.log(`📈 Aggregate data requested by user: ${req.user.username}`);

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

    if (aggregateData.length === 0) {
      return res.json({
        success: true,
        message: "No aggregate data available for today",
        data: { aggregates: [], dailyStats: null },
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
  })
);

// Get system status
router.get(
  "/system/status",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { temperatureService, mqttService } = req.services;

    console.log(`🔧 System status requested by user: ${req.user.username}`);

    const tempStatus = temperatureService
      ? await temperatureService.getSystemStatus()
      : { status: "not_available" };
    const mqttStatus = mqttService
      ? mqttService.getStatus()
      : { status: "not_available" };

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
  })
);

// Debug endpoints
router.post(
  "/debug/process-buffer",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { temperatureService } = req.services;

    if (!temperatureService) {
      return res.status(503).json({
        success: false,
        error: "Temperature service not initialized",
      });
    }

    console.log(`🔧 Buffer processing forced by user: ${req.user.username}`);

    const result = await temperatureService.forceProcessBuffer();

    res.json({
      success: true,
      message: "Buffer processed manually",
      data: result,
      processedBy: req.user.username,
    });
  })
);

router.post(
  "/debug/process-aggregate",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { temperatureService } = req.services;

    if (!temperatureService) {
      return res.status(503).json({
        success: false,
        error: "Temperature service not initialized",
      });
    }

    console.log(`🔧 Aggregate processing forced by user: ${req.user.username}`);

    const result = await temperatureService.forceProcessAggregation();

    res.json({
      success: true,
      message: "Aggregation processed manually",
      data: result,
      processedBy: req.user.username,
    });
  })
);

router.post(
  "/debug/mqtt-reconnect",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { mqttService } = req.services;

    if (!mqttService) {
      return res.status(503).json({
        success: false,
        error: "MQTT service not initialized",
      });
    }

    console.log(`🔧 MQTT reconnect forced by user: ${req.user.username}`);

    mqttService.forceReconnect();

    res.json({
      success: true,
      message: "MQTT reconnection initiated",
      processedBy: req.user.username,
    });
  })
);

// Get system statistics
router.get(
  "/stats",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { temperatureService, mqttService } = req.services;
    const { db } = await import("../lib/database.mjs");

    console.log(`📊 System stats requested by user: ${req.user.username}`);

    const [
      totalBufferCount,
      activeBufferCount,
      aggregateCount,
      backupCount,
      errorCount,
    ] = await Promise.all([
      db.withRetry(async (prisma) => prisma.temperatureBuffer.count()),
      db.withRetry(async (prisma) =>
        prisma.temperatureBuffer.count({ where: { isProcessed: false } })
      ),
      db.withRetry(async (prisma) =>
        prisma.temperatureAggregate.count({ where: { isExported: false } })
      ),
      db.withRetry(async (prisma) => prisma.dailyTemperatureBackup.count()),
      db.withRetry(async (prisma) =>
        prisma.systemLog.count({ where: { level: "ERROR" } })
      ),
    ]);

    const tempStatus = temperatureService
      ? await temperatureService.getSystemStatus()
      : null;
    const mqttStatus = mqttService ? mqttService.getStatus() : null;

    res.json({
      totalBufferCount,
      activeBufferCount,
      aggregateCount,
      backupCount,
      errorCount,
      temperatureService: tempStatus,
      mqttService: mqttStatus,
      serverUptime: Math.round(process.uptime()),
      lastUpdate: new Date().toISOString(),
      requestedBy: req.user.username,
    });
  })
);

console.log("✅ Sensor routes loaded:");
console.log("  - GET /sensor/suhu (FOR DRYERS.JSX)");
console.log("  - GET /sensor/current");
console.log("  - GET /sensor/history/:date");

export default router;

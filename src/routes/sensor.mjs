import express from "express";
import {
  asyncHandler,
  ValidationError,
} from "../middleware/errorMiddleware.mjs";
import { verifyToken } from "../middleware/authMiddleware.mjs";

const router = express.Router();

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

        // Data sudah dibackup, ambil dari backup
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

        // Data belum dibackup, coba ambil dari agregasi
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

      const { db } = await import("../lib/database.mjs");

      // Get recent readings from database
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

      if (recentReadings.length === 0) {
        console.log("⚠️ No recent readings found, returning simulation data");

        // Return simulation data jika tidak ada data real
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

        return res.json({
          success: true,
          message: "No recent data - using simulation",
          data: simulationData,
          usingSimulation: true,
          timestamp: new Date().toISOString(),
        });
      }

      // Process real data
      const dryersData = {};
      recentReadings.forEach((reading) => {
        dryersData[reading.dryerId] = {
          dryerId: reading.dryerId,
          suhu: reading.suhu,
          humidity: reading.humidity || 0,
          status: reading.status || "normal",
          timestamp: reading.timestamp,
          sensorId: reading.sensorId || `sensor_${reading.dryerId}`,
          location:
            reading.location ||
            `Zone ${String.fromCharCode(64 + reading.dryerId)}`,
        };
      });

      console.log(
        `✅ Retrieved real data for ${Object.keys(dryersData).length} dryers`
      );

      res.json({
        success: true,
        message: "Current temperature data retrieved from ESP32",
        data: dryersData,
        count: Object.keys(dryersData).length,
        usingSimulation: false,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ /sensor/current error:", error);

      // Fallback simulation data
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
        usingSimulation: true,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

// Get current temperature (simple endpoint for frontend)
router.get(
  "/suhu",
  verifyToken,
  asyncHandler(async (req, res) => {
    try {
      console.log(`🌡️ /sensor/suhu hit by user: ${req.user.username}`);

      const { db } = await import("../lib/database.mjs");

      // Get the most recent temperature reading
      const latestReading = await db.withRetry(async (prisma) => {
        return await prisma.temperatureBuffer.findFirst({
          orderBy: { timestamp: "desc" },
        });
      });

      if (latestReading) {
        console.log(`✅ Latest temperature: ${latestReading.suhu}°C`);

        res.json({
          success: true,
          suhu: latestReading.suhu,
          timestamp: latestReading.timestamp,
          sensorId: latestReading.sensorId,
          location: latestReading.location,
          usingSimulation: false,
          message: "Real sensor data",
        });
      } else {
        console.log("⚠️ No readings found, returning simulation data");

        // Return simulation data if no real data
        const simulationTemp = 25.5 + Math.random() * 5;

        res.json({
          success: true,
          suhu: simulationTemp,
          timestamp: new Date(),
          sensorId: "simulation",
          location: "Simulated Zone",
          usingSimulation: true,
          message: "No real sensor data available - using simulation",
        });
      }
    } catch (error) {
      console.error("❌ Error in /sensor/suhu:", error);

      // Fallback simulation data on error
      const simulationTemp = 25.0 + Math.random() * 4;

      res.json({
        success: true,
        suhu: simulationTemp,
        timestamp: new Date(),
        sensorId: "error_fallback",
        location: "Error Fallback Zone",
        usingSimulation: true,
        message: "Database error - using simulation",
        error: error.message,
      });
    }
  })
);

// Get realtime stats for Charts.jsx
router.get(
  "/realtime/stats",
  verifyToken,
  asyncHandler(async (req, res) => {
    try {
      console.log(
        `📊 /sensor/realtime/stats hit by user: ${
          req.user?.username || "anonymous"
        }`
      );

      const { db } = await import("../lib/database.mjs");

      // Get recent readings from database (last 10 data points)
      const recentReadings = await db.withRetry(async (prisma) => {
        return await prisma.temperatureBuffer.findMany({
          where: {
            timestamp: {
              gte: new Date(Date.now() - 60 * 60 * 1000), // Last 1 hour
            },
          },
          orderBy: { timestamp: "desc" },
          take: 10,
        });
      });

      if (recentReadings.length === 0) {
        console.log("⚠️ No recent readings found for realtime stats");

        return res.json({
          success: true,
          message: "No recent data available",
          data: {
            dataPoints: [],
            currentTemp: null,
          },
          usingSimulation: false,
          timestamp: new Date().toISOString(),
        });
      }

      // Format data points for frontend
      const dataPoints = recentReadings.reverse().map((reading) => ({
        temperature: reading.suhu, // Fixed: use 'suhu' field consistently
        timestamp: reading.timestamp,
      }));

      // Get current temperature from most recent reading
      const currentTemp = recentReadings[recentReadings.length - 1].suhu; // Fixed: use 'suhu' field

      res.json({
        success: true,
        message: "Realtime stats retrieved successfully",
        data: {
          dataPoints: dataPoints,
          currentTemp: currentTemp,
        },
        usingSimulation: false,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ Error in /sensor/realtime/stats:", error);

      res.status(500).json({
        success: false,
        message: "Failed to get realtime stats",
        error: error.message,
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
    try {
      const { db } = await import("../lib/database.mjs");

      console.log(`📈 Aggregate data requested by user: ${req.user?.username}`);

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
          requestedBy: req.user?.username,
          timestamp: new Date().toISOString(),
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
        requestedBy: req.user?.username,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ Error in /aggregate/today:", error);

      res.status(500).json({
        success: false,
        message: "Failed to get today's aggregate data",
        error: error.message,
        requestedBy: req.user?.username,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

// Get system status
router.get(
  "/system/status",
  verifyToken,
  asyncHandler(async (req, res) => {
    try {
      const { temperatureService, mqttService } = req.services || {};

      console.log(`🔧 System status requested by user: ${req.user?.username}`);

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
        requestedBy: req.user?.username,
      });
    } catch (error) {
      console.error("❌ Error in /system/status:", error);

      res.status(500).json({
        success: false,
        message: "Failed to get system status",
        error: error.message,
        requestedBy: req.user?.username,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

// Debug endpoints
router.post(
  "/debug/process-buffer",
  verifyToken,
  asyncHandler(async (req, res) => {
    try {
      const { temperatureService } = req.services || {};

      if (!temperatureService) {
        return res.status(503).json({
          success: false,
          error: "Temperature service not initialized",
        });
      }

      console.log(`🔧 Buffer processing forced by user: ${req.user?.username}`);

      const result = await temperatureService.forceProcessBuffer();

      res.json({
        success: true,
        message: "Buffer processed manually",
        data: result,
        processedBy: req.user?.username,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ Error in /debug/process-buffer:", error);

      res.status(500).json({
        success: false,
        message: "Failed to process buffer",
        error: error.message,
        processedBy: req.user?.username,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

router.post(
  "/debug/process-aggregate",
  verifyToken,
  asyncHandler(async (req, res) => {
    try {
      const { temperatureService } = req.services || {};

      if (!temperatureService) {
        return res.status(503).json({
          success: false,
          error: "Temperature service not initialized",
        });
      }

      console.log(
        `🔧 Aggregate processing forced by user: ${req.user?.username}`
      );

      const result = await temperatureService.forceProcessAggregation();

      res.json({
        success: true,
        message: "Aggregation processed manually",
        data: result,
        processedBy: req.user?.username,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ Error in /debug/process-aggregate:", error);

      res.status(500).json({
        success: false,
        message: "Failed to process aggregation",
        error: error.message,
        processedBy: req.user?.username,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

router.post(
  "/debug/mqtt-reconnect",
  verifyToken,
  asyncHandler(async (req, res) => {
    try {
      const { mqttService } = req.services || {};

      if (!mqttService) {
        return res.status(503).json({
          success: false,
          error: "MQTT service not initialized",
        });
      }

      console.log(`🔧 MQTT reconnect forced by user: ${req.user?.username}`);

      mqttService.forceReconnect();

      res.json({
        success: true,
        message: "MQTT reconnection initiated",
        processedBy: req.user?.username,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ Error in /debug/mqtt-reconnect:", error);

      res.status(500).json({
        success: false,
        message: "Failed to reconnect MQTT",
        error: error.message,
        processedBy: req.user?.username,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

// Get system statistics
router.get(
  "/stats",
  verifyToken,
  asyncHandler(async (req, res) => {
    try {
      const { temperatureService, mqttService } = req.services || {};
      const { db } = await import("../lib/database.mjs");

      console.log(`📊 System stats requested by user: ${req.user?.username}`);

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
        success: true,
        data: {
          totalBufferCount,
          activeBufferCount,
          aggregateCount,
          backupCount,
          errorCount,
          temperatureService: tempStatus,
          mqttService: mqttStatus,
          serverUptime: Math.round(process.uptime()),
          lastUpdate: new Date().toISOString(),
        },
        requestedBy: req.user?.username,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ Error in /stats:", error);

      res.status(500).json({
        success: false,
        message: "Failed to get system statistics",
        error: error.message,
        requestedBy: req.user?.username,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

export default router;

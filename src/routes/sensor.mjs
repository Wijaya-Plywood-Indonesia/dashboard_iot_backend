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
        `📈 Historical data requested for date: ${date} by user: ${
          req.user?.username || "anonymous"
        }`
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
      console.log(
        `📡 /sensor/current hit by user: ${req.user?.username || "anonymous"}`
      );

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

        // Return simple structure yang diharapkan frontend
        return res.json({
          success: true,
          message: "No recent data - using simulation",
          data: {
            temperature: 25.5 + Math.random() * 5,
            humidity: 50 + Math.random() * 10,
            isConnected: false,
            timestamp: new Date().toISOString(),
            lastUpdate: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        });
      }

      // Process real data - ambil reading terbaru
      const latestReading = recentReadings[0];

      console.log(`✅ Retrieved real data: ${latestReading.suhu}°C`);

      res.json({
        success: true,
        message: "Current temperature data retrieved from ESP32",
        data: {
          temperature: latestReading.suhu,
          humidity: latestReading.humidity || 0,
          isConnected: true,
          timestamp: latestReading.timestamp.toISOString(),
          lastUpdate: latestReading.timestamp.toISOString(),
          dryerId: latestReading.dryerId,
          sensorId: latestReading.sensorId,
        },
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
// Getting today's aggregate data
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

// PERBAIKAN: Tambah route realtime stats yang hilang
router.get(
  "/realtime/stats",
  asyncHandler(async (req, res) => {
    try {
      const { temperatureService, mqttService } = req.services || {};

      // Get real-time statistics
      const stats = {
        mqtt: {
          connected: mqttService?.isConnected || false,
          lastTemperature: mqttService?.getLastTemperature() || 0,
          hasRecentData: mqttService?.hasRecentData() || false,
          queueSize: mqttService?.saveQueue?.length || 0,
        },
        temperature: {
          bufferSize: temperatureService?.state?.bufferData?.length || 0,
          minuteCount: temperatureService?.state?.minuteDataCount || 0,
          currentMinute: temperatureService?.state?.currentMinuteStartTime
            ? temperatureService.formatMinute(
                temperatureService.state.currentMinuteStartTime
              )
            : null,
          lastProcessedSlot:
            temperatureService?.state?.lastProcessedSlot || null,
          isProcessing: temperatureService?.state?.isProcessing || false,
        },
        system: {
          uptime: Math.round(process.uptime()),
          memory: process.memoryUsage(),
          timestamp: new Date().toISOString(),
        },
      };

      res.json({
        success: true,
        message: "Real-time statistics retrieved successfully",
        data: stats,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Error getting realtime stats:", error);
      res.status(500).json({
        success: false,
        message: "Failed to get real-time statistics",
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

// PERBAIKAN: Route /suhu untuk backward compatibility dengan frontend
router.get(
  "/suhu",
  asyncHandler(async (req, res) => {
    // Redirect ke endpoint current untuk konsistensi
    console.log("🔄 /suhu endpoint hit, redirecting to /current");

    try {
      const { db } = await import("../lib/database.mjs");

      // Get latest temperature reading
      const latestReading = await db.withRetry(async (prisma) => {
        return await prisma.temperatureBuffer.findFirst({
          orderBy: { timestamp: "desc" },
        });
      });

      if (!latestReading) {
        return res.json({
          success: true,
          suhu: 25.0 + Math.random() * 5, // Simulation fallback
          timestamp: new Date().toISOString(),
          usingSimulation: true,
          message: "No real data available - using simulation",
        });
      }

      res.json({
        success: true,
        suhu: latestReading.suhu,
        timestamp: latestReading.timestamp.toISOString(),
        usingSimulation: false,
        dryerId: latestReading.dryerId,
        message: "Latest temperature from ESP32",
      });
    } catch (error) {
      console.error("❌ /suhu error:", error);
      res.json({
        success: true,
        suhu: 25.0 + Math.random() * 5, // Fallback
        timestamp: new Date().toISOString(),
        usingSimulation: true,
        error: error.message,
        message: "Database error - using simulation",
      });
    }
  })
);

// PERBAIKAN: Route /status untuk system status
router.get(
  "/status",
  asyncHandler(async (req, res) => {
    console.log(
      `🔧 System status requested by user: ${req.user?.username || "anonymous"}`
    );

    try {
      const { temperatureService, mqttService } = req.services;

      const tempStatus = await temperatureService.getSystemStatus();
      const mqttStatus = mqttService.getConnectionStatus();

      res.json({
        success: true,
        message: "System status retrieved successfully",
        data: {
          temperature: tempStatus,
          mqtt: mqttStatus,
          serverUptime: process.uptime(),
          timestamp: new Date().toISOString(),
        },
        requestedBy: req.user?.username || "anonymous",
      });
    } catch (error) {
      console.error("❌ /status error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to get system status",
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

// Realtime stats endpoint for Charts.jsx
router.get("/realtime/stats", async (req, res) => {
  try {
    console.log("📊 [/realtime/stats] Accessing realtime statistics");

    const { db } = await import("../lib/database.mjs");

    // Get recent readings for stats
    const recentReadings = await db.temperatureBuffer.findMany({
      where: {
        timestamp: {
          gte: new Date(Date.now() - 60 * 60 * 1000), // Last hour
        },
      },
      orderBy: { timestamp: "desc" },
      take: 60,
    });

    if (recentReadings.length === 0) {
      return res.json({
        success: true,
        message: "No recent data available",
        data: {
          averageTemp: 25.0,
          minTemp: 20.0,
          maxTemp: 30.0,
          dataPoints: 0,
          trend: "stable",
          lastUpdate: new Date().toISOString(),
        },
      });
    }

    // Calculate statistics
    const temperatures = recentReadings.map((r) => r.suhu);
    const averageTemp =
      temperatures.reduce((sum, temp) => sum + temp, 0) / temperatures.length;
    const minTemp = Math.min(...temperatures);
    const maxTemp = Math.max(...temperatures);

    // Simple trend calculation (compare last 10 vs previous 10)
    let trend = "stable";
    if (temperatures.length >= 20) {
      const recent10 = temperatures.slice(0, 10);
      const previous10 = temperatures.slice(10, 20);
      const recentAvg = recent10.reduce((sum, temp) => sum + temp, 0) / 10;
      const previousAvg = previous10.reduce((sum, temp) => sum + temp, 0) / 10;

      if (recentAvg > previousAvg + 0.5) trend = "rising";
      else if (recentAvg < previousAvg - 0.5) trend = "falling";
    }

    res.json({
      success: true,
      message: "Realtime statistics retrieved",
      data: {
        averageTemp: Math.round(averageTemp * 100) / 100,
        minTemp: Math.round(minTemp * 100) / 100,
        maxTemp: Math.round(maxTemp * 100) / 100,
        dataPoints: temperatures.length,
        trend,
        lastUpdate: recentReadings[0].timestamp.toISOString(),
      },
    });
  } catch (error) {
    console.error("❌ Error in /realtime/stats endpoint:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// Backward compatibility endpoint for frontend that still uses /suhu
router.get("/suhu", async (req, res) => {
  try {
    console.log("📊 [/suhu] Accessing backward compatibility endpoint");

    const { db } = await import("../lib/database.mjs");

    // Ambil data terbaru dari buffer
    const latest = await db.temperatureBuffer.findFirst({
      orderBy: { timestamp: "desc" },
      take: 1,
    });

    if (!latest) {
      console.log("⚠️ No data found in buffer, returning simulation");
      return res.json({
        success: true,
        message: "No data available - using simulation",
        data: {
          temperature: 28.5 + Math.random() * 3,
          isConnected: false,
          timestamp: new Date().toISOString(),
        },
      });
    }

    res.json({
      success: true,
      message: "Temperature data retrieved",
      data: {
        temperature: latest.suhu,
        isConnected: true,
        timestamp: latest.timestamp.toISOString(),
        humidity: latest.humidity || 0,
        dryerId: latest.dryerId,
      },
    });
  } catch (error) {
    console.error("❌ Error in /suhu endpoint:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// Historical data endpoint for Charts.jsx
router.get("/history/:date", async (req, res) => {
  try {
    const { date } = req.params;
    console.log(`📅 [/history/${date}] Historical data request`);

    const { db } = await import("../lib/database.mjs");

    // Parse date parameter
    const targetDate = new Date(date);
    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format",
        error: "Date must be in YYYY-MM-DD format",
      });
    }

    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    // Try to get aggregate data first
    const aggregateData = await db.temperatureAggregate.findMany({
      where: {
        date: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      orderBy: { timeSlot: "asc" },
    });

    if (aggregateData.length > 0) {
      console.log(
        `✅ Found ${aggregateData.length} aggregate records for ${date}`
      );

      return res.json({
        success: true,
        message: "Historical data from aggregates",
        data: {
          source: "aggregate",
          aggregates: aggregateData,
          date: date,
          count: aggregateData.length,
        },
        timestamp: new Date().toISOString(),
      });
    }

    // If no aggregate data, try raw data and calculate averages
    const rawData = await db.temperatureBuffer.findMany({
      where: {
        timestamp: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      orderBy: { timestamp: "asc" },
    });

    if (rawData.length > 0) {
      console.log(
        `✅ Found ${rawData.length} raw records for ${date}, calculating backup stats`
      );

      const temperatures = rawData.map((item) => item.suhu);
      const avgDailyTemp =
        temperatures.reduce((sum, temp) => sum + temp, 0) / temperatures.length;
      const minDailyTemp = Math.min(...temperatures);
      const maxDailyTemp = Math.max(...temperatures);

      return res.json({
        success: true,
        message: "Historical data from raw buffer",
        data: {
          source: "backup",
          backup: {
            avgDailyTemp: Math.round(avgDailyTemp * 100) / 100,
            minDailyTemp,
            maxDailyTemp,
            sampleCount: rawData.length,
          },
          date: date,
          count: rawData.length,
        },
        timestamp: new Date().toISOString(),
      });
    }

    // No data found
    console.log(`⚠️ No data found for ${date}`);
    res.json({
      success: true,
      message: "No data available for this date",
      data: {
        source: "none",
        date: date,
        count: 0,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Error in /history endpoint:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// System status endpoint
router.get("/status", async (req, res) => {
  try {
    console.log("🏥 [/status] System status check");

    const { db } = await import("../lib/database.mjs");

    // Get database status
    const bufferCount = await db.temperatureBuffer.count();
    const aggregateCount = await db.temperatureAggregate.count();

    // Get latest data
    const latestBuffer = await db.temperatureBuffer.findFirst({
      orderBy: { timestamp: "desc" },
    });

    const latestAggregate = await db.temperatureAggregate.findFirst({
      orderBy: { createdAt: "desc" },
    });

    const status = {
      database: {
        status: "connected",
        bufferRecords: bufferCount,
        aggregateRecords: aggregateCount,
        lastBufferData: latestBuffer?.timestamp || null,
        lastAggregateData: latestAggregate?.createdAt || null,
      },
      services: {
        mqtt: "connected", // Should check actual MQTT status
        dataProcessing: "active",
        aggregation: "active",
      },
      system: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString(),
      },
    };

    res.json({
      success: true,
      message: "System status retrieved",
      data: status,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Error in /status endpoint:", error);
    res.status(500).json({
      success: false,
      message: "System status check failed",
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;

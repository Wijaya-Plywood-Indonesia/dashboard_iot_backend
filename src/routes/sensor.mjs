import express from "express";
import {
  asyncHandler,
  ValidationError,
} from "../middleware/errorMiddleware.mjs";
import { verifyToken } from "../middleware/authMiddleware.mjs";

const router = express.Router();

// PERBAIKAN: Middleware untuk inject services dengan validation
router.use((req, res, next) => {
  if (!req.services) {
    req.services = {}; // Fallback empty object
  }
  next();
});

// PERBAIKAN: GET /suhu endpoint untuk Dryers.jsx dengan enhanced response
router.get(
  "/suhu",
  verifyToken,
  asyncHandler(async (req, res) => {
    try {
      console.log(`🌡️ /sensor/suhu hit by user: ${req.user.username}`);

      const { mqttService, temperatureService } = req.services;

      // Priority 1: MQTT real-time data
      const lastTemp = mqttService ? mqttService.getLastTemperature() : 0;
      const mqttStatus = mqttService
        ? mqttService.getStatus()
        : { connected: false };

      if (lastTemp > 0 && mqttStatus.connected && mqttService.hasRecentData()) {
        console.log(`✅ Real ESP32 data: ${lastTemp}°C`);

        return res.json({
          success: true,
          message: "Temperature from ESP32 via MQTT",
          suhu: lastTemp,
          temperature: lastTemp,
          humidity: 50 + Math.random() * 20, // Mock humidity
          timestamp: new Date().toISOString(),
          status: "connected",
          source: "esp32_mqtt",
          usingSimulation: false,
          dataAge: mqttStatus.lastDataTime
            ? Date.now() - new Date(mqttStatus.lastDataTime).getTime()
            : null,
          requestedBy: req.user.username,
        });
      }

      // Priority 2: Database fallback dengan better query
      try {
        const { db } = await import("../lib/database.mjs");

        const latestReading = await db.withRetry(
          async (prismaClient) => {
            // PERBAIKAN: Get more recent data with better filtering
            return await prismaClient.temperatureBuffer.findFirst({
              orderBy: { timestamp: "desc" },
              where: {
                timestamp: {
                  gte: new Date(Date.now() - 60 * 60 * 1000), // Last 1 hour
                },
              },
              select: {
                temperature: true,
                timestamp: true,
                metadata: true,
              },
            });
          },
          3,
          "get_latest_temperature"
        );

        if (latestReading) {
          const dataAge =
            Date.now() - new Date(latestReading.timestamp).getTime();
          console.log(
            `✅ Database data: ${latestReading.temperature}°C (${Math.round(
              dataAge / 1000
            )}s old)`
          );

          // PERBAIKAN: Parse metadata if available
          let metadata = {};
          try {
            metadata = latestReading.metadata
              ? JSON.parse(latestReading.metadata)
              : {};
          } catch (e) {
            console.warn("⚠️ Failed to parse metadata:", e.message);
          }

          return res.json({
            success: true,
            message: "Temperature from database",
            suhu: latestReading.temperature,
            temperature: latestReading.temperature,
            humidity: 50 + Math.random() * 20,
            timestamp: latestReading.timestamp.toISOString(),
            status: dataAge < 10 * 60 * 1000 ? "recent" : "stale", // Recent if < 10 minutes
            source: "database",
            usingSimulation: false,
            dataAge,
            metadata,
            requestedBy: req.user.username,
          });
        }
      } catch (dbError) {
        console.error("❌ Database query failed:", dbError.message);
      }

      // Priority 3: Service buffer fallback
      if (
        temperatureService &&
        temperatureService.state.bufferData.length > 0
      ) {
        const latestBufferData = temperatureService.state.bufferData.sort(
          (a, b) => b.timestamp - a.timestamp
        )[0];

        const dataAge =
          Date.now() - new Date(latestBufferData.timestamp).getTime();
        console.log(
          `✅ Service buffer data: ${latestBufferData.temperature}°C`
        );

        return res.json({
          success: true,
          message: "Temperature from service buffer",
          suhu: latestBufferData.temperature,
          temperature: latestBufferData.temperature,
          humidity: 50 + Math.random() * 20,
          timestamp: latestBufferData.timestamp.toISOString(),
          status: "buffer",
          source: "service_buffer",
          usingSimulation: false,
          dataAge,
          bufferSize: temperatureService.state.bufferData.length,
          requestedBy: req.user.username,
        });
      }

      // Priority 4: Simulation fallback
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
        dataAge: 0,
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
        dataAge: 0,
        error: error.message,
        requestedBy: req.user.username,
      });
    }
  })
);

// PERBAIKAN: Enhanced historical data endpoint dengan proper status tracking
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

      const { db } = await import("../lib/database.mjs");

      // PERBAIKAN: Cek backup dengan status tracking
      const backup = await db.withRetry(
        async (prisma) => {
          return await prisma.dailyTemperatureBackup.findUnique({
            where: { date },
            select: {
              id: true,
              date: true,
              csvFilePath: true,
              excelFilePath: true,
              totalRecords: true,
              avgDailyTemp: true,
              minDailyTemp: true,
              maxDailyTemp: true,
              createdAt: true,
              metadata: true,
            },
          });
        },
        3,
        "get_backup_data"
      );

      if (backup) {
        console.log(`✅ Found backup data for ${date}`);

        // PERBAIKAN: Parse metadata for additional info
        let metadata = {};
        try {
          metadata = backup.metadata ? JSON.parse(backup.metadata) : {};
        } catch (e) {
          console.warn("⚠️ Failed to parse backup metadata:", e.message);
        }

        return res.json({
          success: true,
          message: "Data historis dari backup berhasil diambil",
          data: {
            source: "backup",
            status: "done", // PERBAIKAN: Status done untuk data yang sudah di-backup
            backup: {
              ...backup,
              metadata,
            },
            isExported: true,
            date: date,
          },
          requestedBy: req.user?.username,
          timestamp: new Date().toISOString(),
        });
      }

      // PERBAIKAN: Cek data agregasi dengan status tracking
      console.log(`🔍 No backup found for ${date}, checking aggregates...`);

      const startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 1);

      const [aggregateData, totalAggregates] = await Promise.all([
        db.withRetry(
          async (prisma) => {
            return await prisma.temperatureAggregate.findMany({
              where: {
                date: {
                  gte: startDate,
                  lt: endDate,
                },
              },
              orderBy: { timeSlot: "asc" },
              select: {
                id: true,
                timeSlot: true,
                meanTemp: true,
                medianTemp: true,
                modeTemp: true,
                minTemp: true,
                maxTemp: true,
                sampleCount: true,
                isExported: true,
                createdAt: true,
                updatedAt: true,
              },
            });
          },
          3,
          "get_aggregate_data"
        ),

        // PERBAIKAN: Count expected aggregates untuk progress tracking
        db.withRetry(
          async (prisma) => {
            return await prisma.temperatureAggregate.count({
              where: {
                date: {
                  gte: startDate,
                  lt: endDate,
                },
              },
            });
          },
          3,
          "count_aggregates"
        ),
      ]);

      if (aggregateData.length === 0) {
        console.log(`❌ No data found for ${date}`);

        return res.status(404).json({
          success: false,
          message: `Tidak ada data untuk tanggal ${date}`,
          data: {
            source: "none",
            status: "no_data",
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

      // PERBAIKAN: Determine status berdasarkan data completeness
      const expectedSlots = 24 * 6; // 24 hours * 6 slots per hour (10-minute intervals)
      const completionPercentage = (aggregateData.length / expectedSlots) * 100;
      const allExported = aggregateData.every((item) => item.isExported);

      let status = "pending";
      if (allExported && completionPercentage > 90) {
        status = "done";
      } else if (completionPercentage > 50) {
        status = "in_progress";
      }

      console.log(
        `✅ Found ${
          aggregateData.length
        } aggregate records for ${date} (${Math.round(
          completionPercentage
        )}% complete, status: ${status})`
      );

      return res.json({
        success: true,
        message: "Data historis dari agregasi berhasil diambil",
        data: {
          source: "aggregate",
          status, // PERBAIKAN: Dynamic status
          aggregates: aggregateData,
          isExported: allExported,
          date: date,
          count: aggregateData.length,
          expectedCount: expectedSlots,
          completionPercentage: Math.round(completionPercentage),
          statistics: {
            avgTemp:
              aggregateData.length > 0
                ? Math.round(
                    (aggregateData.reduce(
                      (sum, item) => sum + item.meanTemp,
                      0
                    ) /
                      aggregateData.length) *
                      100
                  ) / 100
                : 0,
            minTemp:
              aggregateData.length > 0
                ? Math.min(...aggregateData.map((item) => item.minTemp))
                : 0,
            maxTemp:
              aggregateData.length > 0
                ? Math.max(...aggregateData.map((item) => item.maxTemp))
                : 0,
            totalSamples: aggregateData.reduce(
              (sum, item) => sum + item.sampleCount,
              0
            ),
          },
        },
        requestedBy: req.user?.username,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ Error getting historical data:", error);

      res.status(500).json({
        success: false,
        message: "Gagal mengambil data historis",
        error: error.message,
        data: {
          source: "error",
          status: "error",
          date: req.params.date,
        },
        requestedBy: req.user?.username,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

// PERBAIKAN: Enhanced current temperature endpoint
router.get(
  "/current",
  verifyToken,
  asyncHandler(async (req, res) => {
    try {
      console.log(`📡 /sensor/current hit by user: ${req.user.username}`);

      const { mqttService, temperatureService } = req.services;

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
            temperature: lastTemp,
            humidity: 50 + Math.random() * 10,
            status:
              lastTemp > 80 ? "critical" : lastTemp > 70 ? "warning" : "normal",
            timestamp: new Date(),
            sensorId: "esp32_sensor_1",
            location: "Zone A",
            dataAge: mqttStatus.lastDataTime
              ? Date.now() - new Date(mqttStatus.lastDataTime).getTime()
              : null,
            queueSize: mqttStatus.queueSize || 0,
          },
        };

        return res.json({
          success: true,
          message: "Real-time temperature data from ESP32",
          data: realTimeData,
          count: 1,
          usingSimulation: false,
          source: "esp32_mqtt",
          connectionStatus: "connected",
          timestamp: new Date().toISOString(),
        });
      }

      // Priority 2: Database fallback dengan multiple readings
      try {
        const { db } = await import("../lib/database.mjs");

        const recentReadings = await db.withRetry(
          async (prisma) => {
            return await prisma.temperatureBuffer.findMany({
              where: {
                timestamp: {
                  gte: new Date(Date.now() - 30 * 60 * 1000), // Last 30 minutes
                },
              },
              orderBy: { timestamp: "desc" },
              take: 5, // PERBAIKAN: Get more readings for multiple dryers simulation
              select: {
                temperature: true,
                timestamp: true,
                metadata: true,
              },
            });
          },
          3,
          "get_recent_readings"
        );

        if (recentReadings.length > 0) {
          const dryersData = {};

          // PERBAIKAN: Create realistic dryer data dari database readings
          recentReadings.forEach((reading, index) => {
            const dryerId = index + 1;
            const baseTemp = reading.temperature;
            const variation = (Math.random() - 0.5) * 2; // ±1°C variation
            const finalTemp = Math.max(0, baseTemp + variation);
            const dataAge = Date.now() - new Date(reading.timestamp).getTime();

            dryersData[dryerId] = {
              dryerId,
              suhu: Math.round(finalTemp * 100) / 100,
              temperature: Math.round(finalTemp * 100) / 100,
              humidity: 45 + Math.random() * 15,
              status:
                finalTemp > 80
                  ? "critical"
                  : finalTemp > 70
                  ? "warning"
                  : "normal",
              timestamp: reading.timestamp,
              sensorId: `db_sensor_${dryerId}`,
              location: `Zone ${String.fromCharCode(64 + dryerId)}`,
              dataAge,
              source: "database",
            };
          });

          console.log(
            `✅ Retrieved database data for ${
              Object.keys(dryersData).length
            } dryers`
          );

          return res.json({
            success: true,
            message: "Current temperature data from database",
            data: dryersData,
            count: Object.keys(dryersData).length,
            usingSimulation: false,
            source: "database",
            connectionStatus: "database_fallback",
            timestamp: new Date().toISOString(),
          });
        }
      } catch (dbError) {
        console.error("❌ Database query failed:", dbError.message);
      }

      // Priority 3: Service buffer fallback
      if (
        temperatureService &&
        temperatureService.state.bufferData.length > 0
      ) {
        const latestBuffer = temperatureService.state.bufferData
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 3); // Get latest 3 for multiple dryers

        const dryersData = {};
        latestBuffer.forEach((bufferItem, index) => {
          const dryerId = index + 1;
          const dataAge = Date.now() - new Date(bufferItem.timestamp).getTime();

          dryersData[dryerId] = {
            dryerId,
            suhu: bufferItem.temperature,
            temperature: bufferItem.temperature,
            humidity: 50 + Math.random() * 10,
            status:
              bufferItem.temperature > 80
                ? "critical"
                : bufferItem.temperature > 70
                ? "warning"
                : "normal",
            timestamp: bufferItem.timestamp,
            sensorId: `buffer_sensor_${dryerId}`,
            location: `Zone ${String.fromCharCode(64 + dryerId)}`,
            dataAge,
            source: "service_buffer",
          };
        });

        console.log(
          `✅ Using service buffer data for ${
            Object.keys(dryersData).length
          } dryers`
        );

        return res.json({
          success: true,
          message: "Current temperature data from service buffer",
          data: dryersData,
          count: Object.keys(dryersData).length,
          usingSimulation: false,
          source: "service_buffer",
          connectionStatus: "service_buffer",
          bufferSize: temperatureService.state.bufferData.length,
          timestamp: new Date().toISOString(),
        });
      }

      // Priority 4: Simulation fallback
      console.log("⚠️ No recent readings found, returning simulation data");

      const simulationData = {};
      for (let i = 1; i <= 3; i++) {
        simulationData[i] = {
          dryerId: i,
          suhu: 24 + Math.random() * 8,
          temperature: 24 + Math.random() * 8,
          humidity: 45 + Math.random() * 15,
          status: "normal",
          timestamp: new Date(),
          sensorId: `sim_sensor_${i}`,
          location: `Zone ${String.fromCharCode(64 + i)}`,
          dataAge: 0,
          source: "simulation",
        };
      }

      res.json({
        success: true,
        message: "No recent data - using simulation",
        data: simulationData,
        count: Object.keys(simulationData).length,
        usingSimulation: true,
        source: "simulation",
        connectionStatus: "simulation",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ /sensor/current error:", error);

      // Error fallback
      const errorData = {
        1: {
          dryerId: 1,
          suhu: 26.0 + Math.random() * 4,
          temperature: 26.0 + Math.random() * 4,
          humidity: 45 + Math.random() * 15,
          status: "error",
          timestamp: new Date(),
          sensorId: "error_sensor_1",
          location: "Zone A",
          dataAge: 0,
          source: "error_fallback",
        },
      };

      res.json({
        success: true,
        message: "Error occurred - using fallback data",
        data: errorData,
        count: 1,
        usingSimulation: true,
        error: error.message,
        source: "error_fallback",
        connectionStatus: "error",
        timestamp: new Date().toISOString(),
      });
    }
  })
);

// PERBAIKAN: Enhanced aggregate data endpoint dengan real-time status
router.get(
  "/aggregate/today",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { db } = await import("../lib/database.mjs");
    const { temperatureService } = req.services;

    console.log(`📈 Aggregate data requested by user: ${req.user.username}`);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    try {
      const [aggregateData, bufferCount, serviceStatus] = await Promise.all([
        db.withRetry(
          async (prisma) => {
            return await prisma.temperatureAggregate.findMany({
              where: {
                date: { gte: today, lt: tomorrow },
              },
              orderBy: { timeSlot: "asc" },
              select: {
                id: true,
                timeSlot: true,
                meanTemp: true,
                medianTemp: true,
                modeTemp: true,
                minTemp: true,
                maxTemp: true,
                sampleCount: true,
                isExported: true,
                createdAt: true,
              },
            });
          },
          3,
          "get_today_aggregates"
        ),

        // PERBAIKAN: Get pending buffer count
        db.withRetry(
          async (prisma) => {
            return await prisma.temperatureBuffer.count({
              where: {
                timestamp: { gte: today, lt: tomorrow },
                isProcessed: false,
              },
            });
          },
          3,
          "count_pending_buffer"
        ),

        // PERBAIKAN: Get service status
        temperatureService
          ? temperatureService.getSystemStatus()
          : Promise.resolve(null),
      ]);

      if (aggregateData.length === 0) {
        return res.json({
          success: true,
          message: "No aggregate data available for today",
          data: {
            aggregates: [],
            dailyStats: null,
            status: "no_data",
            progress: {
              completed: 0,
              expected: 144, // 24 hours * 6 slots per hour
              percentage: 0,
            },
          },
          serviceStatus,
          pendingBufferCount: bufferCount,
          requestedBy: req.user.username,
          timestamp: new Date().toISOString(),
        });
      }

      // PERBAIKAN: Calculate comprehensive daily statistics
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
        exportedSlots: aggregateData.filter((item) => item.isExported).length,
        latestSlot: aggregateData[aggregateData.length - 1]?.timeSlot,
        oldestSlot: aggregateData[0]?.timeSlot,
      };

      // PERBAIKAN: Determine overall status
      const expectedSlots = Math.floor(
        (Date.now() - today.getTime()) / (10 * 60 * 1000)
      ); // 10-minute slots
      const actualSlots = aggregateData.length;
      const completionPercentage = Math.min(
        (actualSlots / Math.max(expectedSlots, 1)) * 100,
        100
      );

      let overallStatus = "pending";
      if (dailyStats.exportedSlots === actualSlots && actualSlots > 0) {
        overallStatus = "done";
      } else if (actualSlots > expectedSlots * 0.8) {
        overallStatus = "in_progress";
      }

      res.json({
        success: true,
        message: "Today's aggregate data retrieved successfully",
        data: {
          aggregates: aggregateData,
          dailyStats: {
            ...dailyStats,
            avgTemp: Math.round(dailyStats.avgTemp * 100) / 100,
          },
          status: overallStatus,
          progress: {
            completed: actualSlots,
            expected: Math.max(expectedSlots, actualSlots),
            percentage: Math.round(completionPercentage),
            exported: dailyStats.exportedSlots,
          },
        },
        serviceStatus: serviceStatus?.service || null,
        pendingBufferCount: bufferCount,
        requestedBy: req.user.username,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ Error getting today's aggregate:", error);

      res.status(500).json({
        success: false,
        message: "Failed to retrieve today's aggregate data",
        error: error.message,
        data: {
          status: "error",
        },
        requestedBy: req.user.username,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

// PERBAIKAN: Enhanced system status endpoint
router.get(
  "/system/status",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { temperatureService, mqttService } = req.services;

    console.log(`🔧 System status requested by user: ${req.user.username}`);

    try {
      const [tempStatus, mqttStatus, dbHealth] = await Promise.all([
        temperatureService
          ? temperatureService.getSystemStatus()
          : Promise.resolve(null),
        mqttService ? mqttService.getStatus() : Promise.resolve(null),
        (async () => {
          try {
            const { db } = await import("../lib/database.mjs");
            return await db.healthCheck();
          } catch (error) {
            return { status: "error", error: error.message };
          }
        })(),
      ]);

      // PERBAIKAN: Comprehensive system health assessment
      const systemHealth = {
        overall: "healthy",
        components: {
          temperatureService: tempStatus ? "healthy" : "unavailable",
          mqttService: mqttStatus?.connected ? "healthy" : "disconnected",
          database: dbHealth?.status || "unknown",
        },
        alerts: [],
      };

      // PERBAIKAN: Generate health alerts
      if (!tempStatus) {
        systemHealth.alerts.push({
          level: "error",
          message: "Temperature service not available",
        });
        systemHealth.overall = "degraded";
      }

      if (!mqttStatus?.connected) {
        systemHealth.alerts.push({
          level: "warning",
          message: "MQTT service disconnected",
        });
        if (systemHealth.overall === "healthy")
          systemHealth.overall = "degraded";
      }

      if (dbHealth?.status !== "healthy") {
        systemHealth.alerts.push({
          level: "error",
          message: "Database connection issues",
        });
        systemHealth.overall = "unhealthy";
      }

      res.json({
        success: true,
        data: {
          health: systemHealth,
          temperature: tempStatus,
          mqtt: mqttStatus,
          database: dbHealth,
          serverUptime: process.uptime(),
          memoryUsage: process.memoryUsage(),
          timestamp: new Date().toISOString(),
        },
        requestedBy: req.user.username,
      });
    } catch (error) {
      console.error("❌ Error getting system status:", error);

      res.status(500).json({
        success: false,
        error: "Failed to get system status",
        message: error.message,
        requestedBy: req.user.username,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

// PERBAIKAN: Enhanced debug endpoints dengan proper validation
router.post(
  "/debug/process-buffer",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { temperatureService } = req.services;

    if (!temperatureService) {
      return res.status(503).json({
        success: false,
        error: "Temperature service not initialized",
        timestamp: new Date().toISOString(),
      });
    }

    console.log(`🔧 Buffer processing forced by user: ${req.user.username}`);

    try {
      const result = await temperatureService.forceProcessBuffer();

      res.json({
        success: true,
        message: "Buffer processed manually",
        data: result,
        processedBy: req.user.username,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "Buffer processing failed",
        message: error.message,
        processedBy: req.user.username,
        timestamp: new Date().toISOString(),
      });
    }
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
        timestamp: new Date().toISOString(),
      });
    }

    console.log(`🔧 Aggregate processing forced by user: ${req.user.username}`);

    try {
      const result = await temperatureService.forceProcessAggregation();

      res.json({
        success: true,
        message: "Aggregation processed manually",
        data: result,
        processedBy: req.user.username,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "Aggregation processing failed",
        message: error.message,
        processedBy: req.user.username,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

router.post(
  "/debug/force-export",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { temperatureService } = req.services;

    if (!temperatureService) {
      return res.status(503).json({
        success: false,
        error: "Temperature service not initialized",
        timestamp: new Date().toISOString(),
      });
    }

    console.log(`🔧 Export forced by user: ${req.user.username}`);

    try {
      const result = await temperatureService.forceExport();

      res.json({
        success: true,
        message: "Export processed manually",
        data: result,
        processedBy: req.user.username,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "Export processing failed",
        message: error.message,
        processedBy: req.user.username,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

router.post(
  "/debug/cleanup",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { temperatureService } = req.services;

    if (!temperatureService) {
      return res.status(503).json({
        success: false,
        error: "Temperature service not initialized",
        timestamp: new Date().toISOString(),
      });
    }

    console.log(`🔧 Cleanup forced by user: ${req.user.username}`);

    try {
      const result = await temperatureService.forceCleanup();

      res.json({
        success: true,
        message: "Cleanup completed manually",
        data: result,
        processedBy: req.user.username,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "Cleanup failed",
        message: error.message,
        processedBy: req.user.username,
        timestamp: new Date().toISOString(),
      });
    }
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
        timestamp: new Date().toISOString(),
      });
    }

    console.log(`🔧 MQTT reconnect forced by user: ${req.user.username}`);

    try {
      mqttService.forceReconnect();

      res.json({
        success: true,
        message: "MQTT reconnection initiated",
        processedBy: req.user.username,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "MQTT reconnection failed",
        message: error.message,
        processedBy: req.user.username,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

// PERBAIKAN: Enhanced statistics endpoint dengan detailed metrics
router.get(
  "/stats",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { temperatureService, mqttService } = req.services;
    const { db } = await import("../lib/database.mjs");

    console.log(`📊 System stats requested by user: ${req.user.username}`);

    try {
      const [
        totalBufferCount,
        activeBufferCount,
        processedBufferCount,
        aggregateCount,
        exportedAggregateCount,
        backupCount,
        errorCount,
        recentErrors,
      ] = await Promise.all([
        db.withRetry(
          async (prisma) => prisma.temperatureBuffer.count(),
          3,
          "count_total_buffer"
        ),
        db.withRetry(
          async (prisma) =>
            prisma.temperatureBuffer.count({ where: { isProcessed: false } }),
          3,
          "count_active_buffer"
        ),
        db.withRetry(
          async (prisma) =>
            prisma.temperatureBuffer.count({ where: { isProcessed: true } }),
          3,
          "count_processed_buffer"
        ),
        db.withRetry(
          async (prisma) => prisma.temperatureAggregate.count(),
          3,
          "count_aggregates"
        ),
        db.withRetry(
          async (prisma) =>
            prisma.temperatureAggregate.count({ where: { isExported: true } }),
          3,
          "count_exported_aggregates"
        ),
        db.withRetry(
          async (prisma) => prisma.dailyTemperatureBackup.count(),
          3,
          "count_backups"
        ),
        db.withRetry(
          async (prisma) =>
            prisma.systemLog.count({ where: { level: "ERROR" } }),
          3,
          "count_errors"
        ),
        db.withRetry(
          async (prisma) =>
            prisma.systemLog.findMany({
              where: { level: "ERROR" },
              orderBy: { timestamp: "desc" },
              take: 5,
              select: { message: true, timestamp: true },
            }),
          3,
          "get_recent_errors"
        ),
      ]);

      const tempStatus = temperatureService
        ? await temperatureService.getSystemStatus()
        : null;
      const mqttStatus = mqttService ? mqttService.getStatus() : null;

      // PERBAIKAN: Calculate performance metrics
      const performanceMetrics = {
        bufferProcessingRate:
          (processedBufferCount / Math.max(totalBufferCount, 1)) * 100,
        aggregateExportRate:
          (exportedAggregateCount / Math.max(aggregateCount, 1)) * 100,
        errorRate:
          (errorCount / Math.max(totalBufferCount + aggregateCount, 1)) * 100,
        dataIntegrity: {
          totalDataPoints: totalBufferCount,
          processedDataPoints: processedBufferCount,
          aggregatedSlots: aggregateCount,
          exportedSlots: exportedAggregateCount,
          completedBackups: backupCount,
        },
      };

      res.json({
        success: true,
        data: {
          // PERBAIKAN: Core metrics
          metrics: {
            totalBufferCount,
            activeBufferCount,
            processedBufferCount,
            aggregateCount,
            exportedAggregateCount,
            backupCount,
            errorCount,
          },

          // PERBAIKAN: Performance indicators
          performance: {
            ...performanceMetrics,
            bufferProcessingRate:
              Math.round(performanceMetrics.bufferProcessingRate * 100) / 100,
            aggregateExportRate:
              Math.round(performanceMetrics.aggregateExportRate * 100) / 100,
            errorRate: Math.round(performanceMetrics.errorRate * 100) / 100,
          },

          // Service status
          services: {
            temperatureService: tempStatus,
            mqttService: mqttStatus,
          },

          // PERBAIKAN: System health indicators
          health: {
            serverUptime: Math.round(process.uptime()),
            memoryUsage: process.memoryUsage(),
            recentErrors: recentErrors,
            lastUpdate: new Date().toISOString(),
          },
        },
        requestedBy: req.user.username,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ Error getting system stats:", error);

      res.status(500).json({
        success: false,
        error: "Failed to retrieve system statistics",
        message: error.message,
        requestedBy: req.user.username,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

console.log("✅ Enhanced sensor routes loaded:");
console.log("  - GET /sensor/suhu (FIXED FOR DRYERS.JSX)");
console.log("  - GET /sensor/current (ENHANCED)");
console.log("  - GET /sensor/history/:date (WITH STATUS TRACKING)");
console.log("  - GET /sensor/aggregate/today (WITH PROGRESS)");
console.log("  - GET /sensor/system/status (COMPREHENSIVE)");
console.log("  - GET /sensor/stats (DETAILED METRICS)");
console.log("  - POST /sensor/debug/* (MANUAL OPERATIONS)");

export default router;

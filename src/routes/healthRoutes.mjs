import express from "express";
import { asyncHandler } from "../middleware/errorMiddleware.mjs";

const router = express.Router();

// PERBAIKAN: Comprehensive health check
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { temperatureService, mqttService } = req.services;

    const healthStatus = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      version: "1.0.0",
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      services: {},
    };

    // Check Temperature Service
    try {
      if (temperatureService) {
        const tempStatus = await temperatureService.getSystemStatus();
        healthStatus.services.temperature = {
          status: tempStatus.status === "healthy" ? "healthy" : "degraded",
          details: tempStatus,
        };
      } else {
        healthStatus.services.temperature = {
          status: "unavailable",
          message: "Service not initialized",
        };
      }
    } catch (error) {
      healthStatus.services.temperature = {
        status: "error",
        message: error.message,
      };
    }

    // Check MQTT Service
    try {
      if (mqttService) {
        const mqttStatus = mqttService.getStatus();
        healthStatus.services.mqtt = {
          status: mqttStatus.connected ? "healthy" : "degraded",
          details: {
            connected: mqttStatus.connected,
            broker: mqttStatus.brokerUrl,
            topic: mqttStatus.topic,
            lastTemperature: mqttStatus.lastTemperature,
          },
        };
      } else {
        healthStatus.services.mqtt = {
          status: "unavailable",
          message: "Service not initialized",
        };
      }
    } catch (error) {
      healthStatus.services.mqtt = {
        status: "error",
        message: error.message,
      };
    }

    // Overall status
    const serviceStatuses = Object.values(healthStatus.services).map(
      (s) => s.status
    );
    if (serviceStatuses.includes("error")) {
      healthStatus.status = "unhealthy";
    } else if (serviceStatuses.includes("degraded")) {
      healthStatus.status = "degraded";
    }

    const statusCode = healthStatus.status === "healthy" ? 200 : 503;
    res.status(statusCode).json(healthStatus);
  })
);

// PERBAIKAN: Liveness probe (minimal check)
router.get("/live", (req, res) => {
  res.json({
    status: "alive",
    timestamp: new Date().toISOString(),
  });
});

// PERBAIKAN: Readiness probe (detailed check)
router.get(
  "/ready",
  asyncHandler(async (req, res) => {
    const { temperatureService, mqttService } = req.services;

    const checks = {
      database: false,
      temperature: false,
      mqtt: false,
    };

    // Database check
    try {
      const { db } = await import("../lib/database.mjs");
      await db.withRetry(async (prisma) => {
        await prisma.$queryRaw`SELECT 1`;
      });
      checks.database = true;
    } catch (error) {
      console.error("Database readiness check failed:", error.message);
    }

    // Temperature service check
    try {
      if (temperatureService) {
        const status = await temperatureService.getSystemStatus();
        checks.temperature = status.status === "healthy";
      }
    } catch (error) {
      console.error(
        "Temperature service readiness check failed:",
        error.message
      );
    }

    // MQTT service check
    try {
      if (mqttService) {
        const status = mqttService.getStatus();
        checks.mqtt = status.connected;
      }
    } catch (error) {
      console.error("MQTT service readiness check failed:", error.message);
    }

    const isReady = Object.values(checks).every((check) => check);

    res.status(isReady ? 200 : 503).json({
      ready: isReady,
      checks,
      timestamp: new Date().toISOString(),
    });
  })
);

export default router;

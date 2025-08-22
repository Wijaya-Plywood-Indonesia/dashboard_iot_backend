import express from "express";
import { asyncHandler } from "../middleware/errorMiddleware.mjs";
import { db } from "../lib/database.mjs";

const router = express.Router();

// PERBAIKAN: Comprehensive health check
router.get(
  "/",
  asyncHandler(async (req, res) => {
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

    // Check Database
    try {
      const dbHealth = await db.healthCheck();
      healthStatus.services.database = {
        status: dbHealth.connected ? "healthy" : "error",
        details: dbHealth,
      };
    } catch (error) {
      healthStatus.services.database = {
        status: "error",
        message: error.message,
      };
      healthStatus.status = "degraded";
    }

    // Simple response for now - services will be checked differently
    healthStatus.services.mqtt = {
      status: "unknown",
      message: "MQTT status check not implemented yet",
    };

    healthStatus.services.temperature = {
      status: "unknown",
      message: "Temperature service status check not implemented yet",
    };

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
    const checks = {
      database: false,
    };

    // Database check
    try {
      await db.withRetry(async (prisma) => {
        await prisma.$queryRaw`SELECT 1`;
      });
      checks.database = true;
    } catch (error) {
      console.error("Database readiness check failed:", error.message);
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

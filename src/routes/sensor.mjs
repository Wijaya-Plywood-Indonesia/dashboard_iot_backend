// src/routes/sensor.mjs
import express from "express";
import { SensorController } from "../controllers/dataControllers.mjs";

const router = express.Router();

// ====================================
// ROUTES UNTUK DATA SENSOR
// ====================================

// GET /api/sensor/current - Ambil suhu terkini
router.get("/current", SensorController.getCurrentTemperature);

// GET /api/sensor/aggregate/today - Ambil data agregasi hari ini
router.get("/aggregate/today", SensorController.getTodayAggregate);

// GET /api/sensor/buffer/status - Status buffer (PERBAIKAN: konsisten dengan controller)
router.get("/buffer/status", SensorController.getBufferStatus);

// GET /api/sensor/history/:date - Data historis berdasarkan tanggal
router.get("/history/:date", SensorController.getHistoricalData);

// GET /api/sensor/realtime/stats - Statistik real-time
router.get("/realtime/stats", SensorController.getRealtimeStats);

// ====================================
// ROUTES UNTUK TESTING & DEVELOPMENT
// ====================================

// POST /api/sensor/simulate - Simulasi data (development only)
router.post("/simulate", SensorController.simulateTemperatureData);

// DELETE /api/sensor/buffer/clear - Bersihkan buffer (development only)
router.delete("/buffer/clear", SensorController.clearBuffer);

// ====================================
// MIDDLEWARE UNTUK ERROR HANDLING
// ====================================

router.use((error, req, res, next) => {
  console.error("Sensor Route Error:", error);
  res.status(500).json({
    success: false,
    message: "Internal server error pada route sensor",
    error:
      process.env.NODE_ENV === "development" ? error.message : "Server error",
  });
});

export default router;

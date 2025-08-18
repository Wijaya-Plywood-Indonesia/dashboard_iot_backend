// src/controllers/sensor.mjs
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Controller untuk menangani request sensor
export class SensorController {
  // GET /api/sensor/current - Ambil data suhu terkini
  static async getCurrentTemperature(req, res) {
    try {
      // Ambil data terakhir dari buffer
      const latestBuffer = await prisma.temperatureBuffer.findFirst({
        orderBy: { timestamp: "desc" },
      });

      if (!latestBuffer) {
        return res.status(404).json({
          success: false,
          message: "Tidak ada data suhu tersedia",
          data: null,
        });
      }

      res.json({
        success: true,
        message: "Data suhu terkini berhasil diambil",
        data: {
          temperature: latestBuffer.temperature,
          timestamp: latestBuffer.timestamp,
          id: latestBuffer.id,
        },
      });
    } catch (error) {
      console.error("Error getting current temperature:", error);
      res.status(500).json({
        success: false,
        message: "Gagal mengambil data suhu terkini",
        error: error.message,
      });
    }
  }

  // GET /api/sensor/aggregate/today - Ambil data agregasi hari ini
  static async getTodayAggregate(req, res) {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const aggregateData = await prisma.temperatureAggregate.findMany({
        where: {
          date: {
            gte: today,
            lt: tomorrow,
          },
        },
        orderBy: { timeSlot: "asc" },
      });

      if (aggregateData.length === 0) {
        return res.json({
          success: true,
          message: "Belum ada data agregasi untuk hari ini",
          data: [],
        });
      }

      // Hitung statistik harian
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
      });
    } catch (error) {
      console.error("Error getting today aggregate:", error);
      res.status(500).json({
        success: false,
        message: "Gagal mengambil data agregasi hari ini",
        error: error.message,
      });
    }
  }

  // GET /api/sensor/buffer/count - Ambil jumlah data di buffer
  static async getBufferStatus(req, res) {
    try {
      const bufferCount = await prisma.temperatureBuffer.count({
        where: { isProcessed: false },
      });

      const processedCount = await prisma.temperatureBuffer.count({
        where: { isProcessed: true },
      });

      // Ambil timestamp buffer terlama dan terbaru
      const oldestBuffer = await prisma.temperatureBuffer.findFirst({
        where: { isProcessed: false },
        orderBy: { timestamp: "asc" },
      });

      const newestBuffer = await prisma.temperatureBuffer.findFirst({
        where: { isProcessed: false },
        orderBy: { timestamp: "desc" },
      });

      res.json({
        success: true,
        message: "Status buffer berhasil diambil",
        data: {
          activeBufferCount: bufferCount,
          processedBufferCount: processedCount,
          totalBufferCount: bufferCount + processedCount,
          oldestTimestamp: oldestBuffer?.timestamp || null,
          newestTimestamp: newestBuffer?.timestamp || null,
          bufferDuration:
            oldestBuffer && newestBuffer
              ? Math.round(
                  (newestBuffer.timestamp - oldestBuffer.timestamp) / 60000
                ) // dalam menit
              : 0,
        },
      });
    } catch (error) {
      console.error("Error getting buffer status:", error);
      res.status(500).json({
        success: false,
        message: "Gagal mengambil status buffer",
        error: error.message,
      });
    }
  }

  // GET /api/sensor/history/:date - Ambil data historis berdasarkan tanggal
  static async getHistoricalData(req, res) {
    try {
      const { date } = req.params;

      // Validasi format tanggal
      const targetDate = new Date(date);
      if (isNaN(targetDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: "Format tanggal tidak valid. Gunakan format YYYY-MM-DD",
        });
      }

      // Cek apakah data sudah dibackup
      const backup = await prisma.dailyTemperatureBackup.findUnique({
        where: { date },
      });

      if (backup) {
        // Data sudah dibackup, ambil dari backup
        res.json({
          success: true,
          message: "Data historis dari backup berhasil diambil",
          data: {
            source: "backup",
            backup: backup,
            isExported: true,
          },
        });
      } else {
        // Data belum dibackup, coba ambil dari agregasi
        const startDate = new Date(date);
        startDate.setHours(0, 0, 0, 0);

        const endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + 1);

        const aggregateData = await prisma.temperatureAggregate.findMany({
          where: {
            date: {
              gte: startDate,
              lt: endDate,
            },
          },
          orderBy: { timeSlot: "asc" },
        });

        if (aggregateData.length === 0) {
          return res.status(404).json({
            success: false,
            message: `Tidak ada data untuk tanggal ${date}`,
          });
        }

        res.json({
          success: true,
          message: "Data historis dari agregasi berhasil diambil",
          data: {
            source: "aggregate",
            aggregates: aggregateData,
            isExported: false,
          },
        });
      }
    } catch (error) {
      console.error("Error getting historical data:", error);
      res.status(500).json({
        success: false,
        message: "Gagal mengambil data historis",
        error: error.message,
      });
    }
  }

  // GET /api/sensor/realtime/stats - Statistik real-time untuk dashboard
  static async getRealtimeStats(req, res) {
    try {
      // Ambil data buffer 10 menit terakhir
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

      const recentBuffer = await prisma.temperatureBuffer.findMany({
        where: {
          timestamp: { gte: tenMinutesAgo },
          isProcessed: false,
        },
        orderBy: { timestamp: "desc" },
      });

      let stats = {
        currentTemp: 0,
        avgTemp10Min: 0,
        minTemp10Min: 0,
        maxTemp10Min: 0,
        sampleCount10Min: 0,
        trend: "stable",
      };

      if (recentBuffer.length > 0) {
        const temperatures = recentBuffer.map((item) => item.temperature);

        stats.currentTemp = temperatures[0]; // Data terbaru
        stats.avgTemp10Min =
          temperatures.reduce((sum, temp) => sum + temp, 0) /
          temperatures.length;
        stats.minTemp10Min = Math.min(...temperatures);
        stats.maxTemp10Min = Math.max(...temperatures);
        stats.sampleCount10Min = temperatures.length;

        // Hitung trend (bandingkan 5 data terakhir dengan 5 data sebelumnya)
        if (temperatures.length >= 10) {
          const recent5 = temperatures.slice(0, 5);
          const previous5 = temperatures.slice(5, 10);

          const recentAvg = recent5.reduce((sum, temp) => sum + temp, 0) / 5;
          const previousAvg =
            previous5.reduce((sum, temp) => sum + temp, 0) / 5;

          const diff = recentAvg - previousAvg;
          if (diff > 0.5) stats.trend = "rising";
          else if (diff < -0.5) stats.trend = "falling";
          else stats.trend = "stable";
        }

        // Bulatkan angka
        stats.avgTemp10Min = Math.round(stats.avgTemp10Min * 100) / 100;
      }

      res.json({
        success: true,
        message: "Statistik real-time berhasil diambil",
        data: {
          ...stats,
          timestamp: new Date().toISOString(),
          dataPoints: recentBuffer.map((item) => ({
            temperature: item.temperature,
            timestamp: item.timestamp,
          })),
        },
      });
    } catch (error) {
      console.error("Error getting realtime stats:", error);
      res.status(500).json({
        success: false,
        message: "Gagal mengambil statistik real-time",
        error: error.message,
      });
    }
  }

  // POST /api/sensor/simulate - Simulasi data untuk testing
  static async simulateTemperatureData(req, res) {
    try {
      const { count = 10, baseTemp = 25, variation = 5 } = req.body;

      const simulatedData = [];

      for (let i = 0; i < count; i++) {
        // Generate random temperature dengan variasi
        const randomTemp = baseTemp + (Math.random() - 0.5) * variation * 2;
        const roundedTemp = Math.round(randomTemp * 10) / 10;

        const bufferData = await prisma.temperatureBuffer.create({
          data: {
            temperature: roundedTemp,
            timestamp: new Date(Date.now() - (count - i) * 60000), // Setiap menit mundur
            isProcessed: false,
          },
        });

        simulatedData.push(bufferData);
      }

      res.json({
        success: true,
        message: `Berhasil membuat ${count} data simulasi`,
        data: {
          simulatedCount: count,
          temperatureRange: {
            min: Math.min(...simulatedData.map((d) => d.temperature)),
            max: Math.max(...simulatedData.map((d) => d.temperature)),
            avg:
              Math.round(
                (simulatedData.reduce((sum, d) => sum + d.temperature, 0) /
                  count) *
                  100
              ) / 100,
          },
          samples: simulatedData,
        },
      });
    } catch (error) {
      console.error("Error simulating temperature data:", error);
      res.status(500).json({
        success: false,
        message: "Gagal membuat data simulasi",
        error: error.message,
      });
    }
  }

  // DELETE /api/sensor/buffer/clear - Bersihkan buffer (untuk testing)
  static async clearBuffer(req, res) {
    try {
      const { processedOnly = true } = req.query;

      let deletedCount;

      if (processedOnly === "true") {
        const result = await prisma.temperatureBuffer.deleteMany({
          where: { isProcessed: true },
        });
        deletedCount = result.count;
      } else {
        const result = await prisma.temperatureBuffer.deleteMany({});
        deletedCount = result.count;
      }

      res.json({
        success: true,
        message: `Berhasil menghapus ${deletedCount} data buffer`,
        data: {
          deletedCount,
          processedOnly: processedOnly === "true",
        },
      });
    } catch (error) {
      console.error("Error clearing buffer:", error);
      res.status(500).json({
        success: false,
        message: "Gagal menghapus data buffer",
        error: error.message,
      });
    }
  }
}

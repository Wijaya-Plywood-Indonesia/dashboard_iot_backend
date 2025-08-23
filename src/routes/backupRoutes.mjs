import express from "express";
import path from "path";
import { asyncHandler, NotFoundError } from "../middleware/errorMiddleware.mjs";

const router = express.Router();

// PERBAIKAN: Get daftar export 6 jam
router.get(
  "/six-hour",
  asyncHandler(async (req, res) => {
    const { db } = await import("../lib/database.mjs");

    const sixHourExports = await db.withRetry(async (prisma) => {
      return await prisma.sixHourExport.findMany({
        select: {
          id: true,
          batchId: true,
          startTime: true,
          endTime: true,
          totalRecords: true,
          avgTemp: true,
          minTemp: true,
          maxTemp: true,
          isReady: true,
          downloadNotified: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 50, // Last 50 exports
      });
    });

    res.json({
      success: true,
      message: "Daftar export 6 jam berhasil diambil",
      data: sixHourExports,
      count: sixHourExports.length,
      timestamp: new Date().toISOString(),
    });
  })
);

// PERBAIKAN: Download file export 6 jam
router.get(
  "/six-hour/:batchId/download/:format",
  asyncHandler(async (req, res) => {
    const { batchId, format } = req.params;

    if (!["csv", "excel"].includes(format)) {
      return res.status(400).json({
        success: false,
        message: "Format tidak valid. Gunakan 'csv' atau 'excel'",
      });
    }

    const { db } = await import("../lib/database.mjs");

    const exportRecord = await db.withRetry(async (prisma) => {
      return await prisma.sixHourExport.findUnique({
        where: { batchId },
      });
    });

    if (!exportRecord) {
      return res.status(404).json({
        success: false,
        message: `Export untuk batch ${batchId} tidak ditemukan`,
      });
    }

    const filePath =
      format === "csv" ? exportRecord.csvFilePath : exportRecord.excelFilePath;

    if (!filePath) {
      return res.status(404).json({
        success: false,
        message: `File ${format} untuk batch ${batchId} tidak tersedia`,
      });
    }

    // Cek apakah file exists
    const fs = await import("fs/promises");
    try {
      await fs.access(filePath);
    } catch (error) {
      return res.status(404).json({
        success: false,
        message: `File ${format} tidak ditemukan di server`,
      });
    }

    // Set appropriate headers
    const fileName = path.basename(filePath);
    const contentType =
      format === "csv"
        ? "text/csv"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", contentType);

    // Send file
    res.sendFile(path.resolve(filePath));
  })
);

// PERBAIKAN: Force export 6 jam (manual trigger)
router.post(
  "/six-hour/force-export",
  asyncHandler(async (req, res) => {
    const { temperatureService } = req.app.locals;

    if (!temperatureService) {
      return res.status(503).json({
        success: false,
        message: "Temperature service tidak tersedia",
      });
    }

    try {
      const result = await temperatureService.exportSixHourData();

      res.json({
        success: true,
        message: "Export 6 jam berhasil dipaksa",
        data: result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Gagal melakukan export 6 jam",
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

// PERBAIKAN: Get backup list
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { db } = await import("../lib/database.mjs");

    const backupList = await db.withRetry(async (prisma) => {
      return await prisma.dailyTemperatureBackup.findMany({
        select: {
          date: true,
          totalRecords: true,
          avgDailyTemp: true,
          minDailyTemp: true,
          maxDailyTemp: true,
          exportedAt: true,
        },
        orderBy: { date: "desc" },
        take: 30, // Last 30 days
      });
    });

    res.json({
      success: true,
      data: backupList,
      count: backupList.length,
      requestedBy: req.user.username,
    });
  })
);

// PERBAIKAN: Get backup by date
router.get(
  "/:date",
  asyncHandler(async (req, res) => {
    const { date } = req.params;
    const { temperatureService } = req.services;

    if (!temperatureService) {
      return res.status(503).json({
        error: "Temperature service not available",
      });
    }

    const backupData = await temperatureService.getBackupDataByDate(date);

    if (backupData.error) {
      throw new NotFoundError(backupData.error);
    }

    res.json({
      success: true,
      data: backupData,
      requestedBy: req.user.username,
    });
  })
);

// PERBAIKAN: Download backup file
router.get(
  "/download/:type/:date",
  asyncHandler(async (req, res) => {
    const { type, date } = req.params;
    const { temperatureService } = req.services;

    if (!temperatureService) {
      return res.status(503).json({
        error: "Temperature service not available",
      });
    }

    const backup = await temperatureService.getBackupDataByDate(date);

    if (backup.error) {
      throw new NotFoundError(backup.error);
    }

    const filePath = type === "csv" ? backup.csvFilePath : backup.excelFilePath;

    if (!filePath) {
      throw new NotFoundError("File not found");
    }

    const fileName = path.basename(filePath);

    // Log download
    console.log(`📥 File download: ${fileName} by ${req.user.username}`);

    res.download(filePath, fileName);
  })
);

// PERBAIKAN: Force export
router.post(
  "/export",
  asyncHandler(async (req, res) => {
    const { temperatureService } = req.services;

    if (!temperatureService) {
      return res.status(503).json({
        error: "Temperature service not available",
      });
    }

    console.log(`📤 Manual export triggered by user: ${req.user.username}`);

    const result = await temperatureService.forceExport();

    res.json({
      success: true,
      message: "Export completed successfully",
      data: result,
      exportedBy: req.user.username,
    });
  })
);

export default router;

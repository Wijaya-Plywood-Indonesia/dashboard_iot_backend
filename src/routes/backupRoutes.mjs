import express from "express";
import path from "path";
import { asyncHandler, NotFoundError } from "../middleware/errorMiddleware.mjs";

const router = express.Router();

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

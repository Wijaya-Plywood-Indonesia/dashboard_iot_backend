import fs from "fs/promises";
import path from "path";
import ExcelJS from "exceljs";
import { db } from "../lib/database.mjs";

export class TemperatureService {
  constructor() {
    this.config = {
      maxBufferSize: parseInt(process.env.MAX_BUFFER_SIZE) || 1000,
      bufferThreshold: parseInt(process.env.BUFFER_CLEANUP_THRESHOLD) || 800,
      aggregateIntervalMinutes: 10,
      bufferIntervalMinutes: 1,
      // PERBAIKAN: Add export configuration
      exportHour: 1, // Export at 1 AM
      retentionDays: 7, // Keep exports for 7 days
      cleanupIntervalHours: 1, // Check for cleanup every hour
    };

    this.state = {
      bufferData: [],
      lastSavedMinute: null,
      lastProcessedSlot: null,
      isProcessing: false,
      // PERBAIKAN: Add tracking untuk export status
      isExporting: false,
      lastExportDate: null,
      exportStatus: "idle", // idle, running, completed, failed
    };

    this.timers = {
      buffer: null,
      aggregate: null,
      export: null,
      // PERBAIKAN: Add cleanup timer
      cleanup: null,
    };

    this.startSchedulers();
    console.log(
      "✅ TemperatureService initialized with enhanced configuration"
    );
  }

  startSchedulers() {
    console.log("🔄 Starting enhanced schedulers...");

    // PERBAIKAN: More precise buffer processing (every 30 seconds untuk real-time)
    this.timers.buffer = setInterval(() => {
      this.processBuffer().catch((error) =>
        this.handleError(error, { context: "buffer_scheduler" })
      );
    }, 30 * 1000); // 30 seconds

    // PERBAIKAN: Aggregate processing setiap 5 menit untuk responsivitas
    this.timers.aggregate = setInterval(() => {
      this.processAggregation().catch((error) =>
        this.handleError(error, { context: "aggregate_scheduler" })
      );
    }, 5 * 60 * 1000); // 5 minutes

    // PERBAIKAN: Enhanced daily export scheduling
    this.scheduleDailyExport();

    // PERBAIKAN: Add periodic cleanup
    this.scheduleCleanup();

    console.log("✅ All enhanced schedulers started");
  }

  async receiveTemperatureData(temperature) {
    try {
      const temp = parseFloat(temperature);
      if (isNaN(temp) || temp < -50 || temp > 150) {
        throw new Error(`Invalid temperature: ${temperature}`);
      }

      const now = new Date();
      const dataPoint = {
        temperature: temp,
        timestamp: now,
        minute: this.formatMinute(now),
        // PERBAIKAN: Add metadata untuk tracking
        source: "mqtt",
        processed: false,
      };

      // PERBAIKAN: Check for buffer overflow dengan early processing
      if (this.state.bufferData.length >= this.config.maxBufferSize) {
        console.warn("⚠️ Buffer full, performing emergency cleanup...");
        await this.emergencyCleanup();
      }

      this.state.bufferData.push(dataPoint);

      // PERBAIKAN: Dynamic threshold processing
      const threshold = Math.max(
        this.config.bufferThreshold,
        Math.floor(this.config.maxBufferSize * 0.8)
      );

      if (this.state.bufferData.length >= threshold) {
        console.log(
          `🔄 Buffer threshold reached (${this.state.bufferData.length}/${threshold}), processing...`
        );
        await this.processBuffer();
      }

      this.logInfo(
        `📊 Data received: ${temp}°C (Buffer: ${this.state.bufferData.length}/${this.config.maxBufferSize})`
      );

      return {
        success: true,
        temperature: temp,
        bufferSize: this.state.bufferData.length,
        threshold: threshold,
        timestamp: now.toISOString(),
      };
    } catch (error) {
      this.handleError(error, {
        context: "receiveTemperatureData",
        temperature,
      });
      throw error;
    }
  }

  async processBuffer() {
    if (this.state.isProcessing || this.state.bufferData.length === 0) {
      return { success: false, reason: "no_data_or_processing" };
    }

    this.state.isProcessing = true;

    try {
      const currentMinute = this.formatMinute(new Date());

      // PERBAIKAN: Allow processing even if minute is same untuk real-time updates
      const unprocessedData = this.state.bufferData.filter(
        (item) => !item.processed
      );

      if (unprocessedData.length === 0) {
        this.logInfo("⏭️ No unprocessed data in buffer");
        return { success: false, reason: "no_unprocessed_data" };
      }

      // PERBAIKAN: Calculate statistics dari unprocessed data
      const temperatures = unprocessedData.map((item) => item.temperature);
      const stats = this.calculateStats(temperatures);

      const savedData = await db.withRetry(
        async (prisma) => {
          return await prisma.temperatureBuffer.create({
            data: {
              temperature: stats.mean,
              timestamp: new Date(),
              isProcessed: false,
              // PERBAIKAN: Store additional metadata as JSON string
              metadata: JSON.stringify({
                sampleCount: temperatures.length,
                minTemp: stats.min,
                maxTemp: stats.max,
                median: stats.median,
                mode: stats.mode,
                source: "aggregated_buffer",
              }),
            },
          });
        },
        3,
        "processBuffer"
      );

      // PERBAIKAN: Mark processed data
      unprocessedData.forEach((item) => (item.processed = true));

      // PERBAIKAN: Keep only recent processed data
      const cutoffTime = new Date(Date.now() - 5 * 60 * 1000); // Keep 5 minutes
      this.state.bufferData = this.state.bufferData.filter(
        (item) => item.timestamp > cutoffTime || !item.processed
      );

      this.state.lastSavedMinute = currentMinute;

      this.logInfo(
        `✅ Buffer processed: ${stats.mean}°C from ${temperatures.length} samples saved (ID: ${savedData.id})`
      );

      return {
        success: true,
        savedId: savedData.id,
        avgTemperature: stats.mean,
        sampleCount: temperatures.length,
        stats: stats,
        bufferRemaining: this.state.bufferData.length,
      };
    } catch (error) {
      this.handleError(error, { context: "processBuffer" });
      throw error;
    } finally {
      this.state.isProcessing = false;
    }
  }

  async processAggregation() {
    try {
      const now = new Date();
      const timeSlot = this.generateTimeSlot(now);

      // PERBAIKAN: Check if this slot should be processed (allow reprocessing for real-time updates)
      const existingAggregate = await db.withRetry(
        async (prisma) => {
          return await prisma.temperatureAggregate.findFirst({
            where: {
              timeSlot: timeSlot,
              date: {
                gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
                lt: new Date(
                  now.getFullYear(),
                  now.getMonth(),
                  now.getDate() + 1
                ),
              },
            },
          });
        },
        3,
        "check_existing_aggregate"
      );

      if (existingAggregate && existingAggregate.isExported) {
        this.logInfo(`⏭️ Slot ${timeSlot} already exported, skipping...`);
        return { success: false, reason: "already_exported" };
      }

      const { startTime, endTime } = this.getSlotTimeRange(now);

      const bufferData = await db.withRetry(
        async (prisma) => {
          return await prisma.temperatureBuffer.findMany({
            where: {
              timestamp: { gte: startTime, lt: endTime },
              isProcessed: false,
            },
            orderBy: { timestamp: "asc" },
          });
        },
        3,
        "get_buffer_data"
      );

      if (bufferData.length === 0) {
        this.logWarn(`No data found for slot ${timeSlot}`, {
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
        });
        return { success: false, reason: "no_data" };
      }

      const temperatures = bufferData.map((item) => item.temperature);
      const stats = this.calculateStats(temperatures);

      const result = await db.withRetry(
        async (prisma) => {
          return await prisma.$transaction(async (tx) => {
            // PERBAIKAN: Upsert instead of create untuk handle duplicate
            const aggregate = await tx.temperatureAggregate.upsert({
              where: {
                date_timeSlot: {
                  date: new Date(
                    now.getFullYear(),
                    now.getMonth(),
                    now.getDate()
                  ),
                  timeSlot: timeSlot,
                },
              },
              update: {
                meanTemp: stats.mean,
                medianTemp: stats.median,
                modeTemp: stats.mode,
                minTemp: stats.min,
                maxTemp: stats.max,
                sampleCount: bufferData.length,
                isExported: false,
                updatedAt: new Date(),
              },
              create: {
                date: new Date(
                  now.getFullYear(),
                  now.getMonth(),
                  now.getDate()
                ),
                timeSlot,
                meanTemp: stats.mean,
                medianTemp: stats.median,
                modeTemp: stats.mode,
                minTemp: stats.min,
                maxTemp: stats.max,
                sampleCount: bufferData.length,
                isExported: false,
              },
            });

            // PERBAIKAN: Mark buffer data as processed
            await tx.temperatureBuffer.updateMany({
              where: { id: { in: bufferData.map((item) => item.id) } },
              data: {
                isProcessed: true,
                processedAt: new Date(),
              },
            });

            return aggregate;
          });
        },
        3,
        "process_aggregation"
      );

      this.state.lastProcessedSlot = timeSlot;

      this.logInfo(
        `✅ Aggregation completed for ${timeSlot}: ${bufferData.length} samples`,
        {
          aggregateId: result.id,
          stats,
        }
      );

      return {
        success: true,
        aggregateId: result.id,
        timeSlot,
        sampleCount: bufferData.length,
        stats,
        isUpdate: !!existingAggregate,
      };
    } catch (error) {
      this.handleError(error, { context: "processAggregation" });
      throw error;
    }
  }

  // PERBAIKAN: Enhanced statistics calculation dengan validation
  calculateStats(temperatures) {
    if (!temperatures || temperatures.length === 0) {
      return { mean: 0, median: 0, mode: 0, min: 0, max: 0, count: 0 };
    }

    const validTemps = temperatures.filter(
      (temp) =>
        typeof temp === "number" && !isNaN(temp) && temp > -100 && temp < 200
    );

    if (validTemps.length === 0) {
      return { mean: 0, median: 0, mode: 0, min: 0, max: 0, count: 0 };
    }

    const mean =
      validTemps.reduce((sum, temp) => sum + temp, 0) / validTemps.length;

    const sorted = [...validTemps].sort((a, b) => a - b);
    const median =
      sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];

    // PERBAIKAN: More robust mode calculation
    const frequency = {};
    validTemps.forEach((temp) => {
      const rounded = Math.round(temp * 10) / 10;
      frequency[rounded] = (frequency[rounded] || 0) + 1;
    });

    const maxFreq = Math.max(...Object.values(frequency));
    const modes = Object.keys(frequency).filter(
      (temp) => frequency[temp] === maxFreq
    );
    const mode = parseFloat(modes[0]); // Take first mode if multiple

    return {
      mean: Math.round(mean * 100) / 100,
      median: Math.round(median * 100) / 100,
      mode: mode || 0,
      min: Math.min(...validTemps),
      max: Math.max(...validTemps),
      count: validTemps.length,
      // PERBAIKAN: Add standard deviation untuk monitoring
      stdDev: this.calculateStandardDeviation(validTemps, mean),
    };
  }

  // PERBAIKAN: Add standard deviation calculation
  calculateStandardDeviation(values, mean) {
    if (values.length <= 1) return 0;

    const variance =
      values.reduce((sum, value) => {
        return sum + Math.pow(value - mean, 2);
      }, 0) /
      (values.length - 1);

    return Math.round(Math.sqrt(variance) * 100) / 100;
  }

  // PERBAIKAN: Enhanced daily export dengan proper scheduling
  scheduleDailyExport() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(this.config.exportHour, 0, 0, 0);

    const timeUntilExport = tomorrow.getTime() - now.getTime();

    setTimeout(() => {
      this.exportDailyData().catch((error) =>
        this.handleError(error, { context: "scheduled_daily_export" })
      );

      // PERBAIKAN: Set recurring daily export
      this.timers.export = setInterval(() => {
        this.exportDailyData().catch((error) =>
          this.handleError(error, { context: "recurring_daily_export" })
        );
      }, 24 * 60 * 60 * 1000);
    }, timeUntilExport);

    this.logInfo(
      `📅 Daily export scheduled in ${Math.round(
        timeUntilExport / 1000 / 60
      )} minutes (at ${this.config.exportHour}:00 AM)`
    );
  }

  // PERBAIKAN: Add cleanup scheduler
  scheduleCleanup() {
    // Run cleanup every hour
    this.timers.cleanup = setInterval(() => {
      this.performCleanup().catch((error) =>
        this.handleError(error, { context: "scheduled_cleanup" })
      );
    }, this.config.cleanupIntervalHours * 60 * 60 * 1000);

    this.logInfo("🧹 Cleanup scheduler initialized (every hour)");
  }

  // PERBAIKAN: Add comprehensive cleanup process
  async performCleanup() {
    try {
      this.logInfo("🧹 Starting periodic cleanup...");

      const stats = {
        deletedBufferRecords: 0,
        deletedAggregates: 0,
        deletedExports: 0,
        cleanedFiles: 0,
      };

      // PERBAIKAN: Cleanup old buffer records (older than 24 hours and processed)
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const deletedBuffer = await db.withRetry(
        async (prisma) => {
          return await prisma.temperatureBuffer.deleteMany({
            where: {
              timestamp: { lt: oneDayAgo },
              isProcessed: true,
            },
          });
        },
        3,
        "cleanup_buffer"
      );

      stats.deletedBufferRecords = deletedBuffer.count;

      // PERBAIKAN: Cleanup old exported aggregates (older than retention period)
      const retentionDate = new Date(
        Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000
      );

      const deletedAggregates = await db.withRetry(
        async (prisma) => {
          return await prisma.temperatureAggregate.deleteMany({
            where: {
              date: { lt: retentionDate },
              isExported: true,
            },
          });
        },
        3,
        "cleanup_aggregates"
      );

      stats.deletedAggregates = deletedAggregates.count;

      // PERBAIKAN: Cleanup old export files
      const exportDir = path.join(process.cwd(), "exports");
      try {
        const files = await fs.readdir(exportDir);
        for (const file of files) {
          const filePath = path.join(exportDir, file);
          const stat = await fs.stat(filePath);

          if (stat.mtime < retentionDate) {
            await fs.unlink(filePath);
            stats.cleanedFiles++;
          }
        }
      } catch (dirError) {
        this.logWarn("Export directory cleanup failed", {
          error: dirError.message,
        });
      }

      this.logInfo("✅ Periodic cleanup completed", stats);
      return stats;
    } catch (error) {
      this.handleError(error, { context: "performCleanup" });
      throw error;
    }
  }

  async exportDailyData() {
    if (this.state.isExporting) {
      this.logWarn("Export already in progress, skipping...");
      return { success: false, reason: "already_exporting" };
    }

    this.state.isExporting = true;
    this.state.exportStatus = "running";

    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);

      const dateString = yesterday.toISOString().split("T")[0];

      this.logInfo(`📤 Starting daily export for ${dateString}`);

      // PERBAIKAN: Check if export already exists
      const existingBackup = await db.withRetry(
        async (prisma) => {
          return await prisma.dailyTemperatureBackup.findUnique({
            where: { date: dateString },
          });
        },
        3,
        "check_existing_backup"
      );

      if (existingBackup) {
        this.logInfo(
          `✅ Export for ${dateString} already exists, updating if needed...`
        );
        this.state.exportStatus = "completed";
        return {
          success: true,
          reason: "already_exists",
          backup: existingBackup,
        };
      }

      const aggregateData = await db.withRetry(
        async (prisma) => {
          return await prisma.temperatureAggregate.findMany({
            where: {
              date: {
                gte: yesterday,
                lt: new Date(yesterday.getTime() + 24 * 60 * 60 * 1000),
              },
              isExported: false,
            },
            orderBy: { timeSlot: "asc" },
          });
        },
        3,
        "get_export_data"
      );

      if (aggregateData.length === 0) {
        this.logWarn(`No data to export for ${dateString}`);
        this.state.exportStatus = "completed";
        return { success: false, reason: "no_data" };
      }

      const exportDir = path.join(process.cwd(), "exports");
      await fs.mkdir(exportDir, { recursive: true });

      const [csvPath, excelPath] = await Promise.all([
        this.exportToCSV(aggregateData, dateString, exportDir),
        this.exportToExcel(aggregateData, dateString, exportDir),
      ]);

      const dailyStats = this.calculateDailyStats(aggregateData);

      const backup = await db.withRetry(
        async (prisma) => {
          return await prisma.$transaction(async (tx) => {
            const backup = await tx.dailyTemperatureBackup.create({
              data: {
                date: dateString,
                csvFilePath: csvPath,
                excelFilePath: excelPath,
                totalRecords: aggregateData.length,
                avgDailyTemp: dailyStats.avgTemp,
                minDailyTemp: dailyStats.minTemp,
                maxDailyTemp: dailyStats.maxTemp,
                metadata: JSON.stringify({
                  exportedAt: new Date().toISOString(),
                  dataRange: {
                    start: yesterday.toISOString(),
                    end: new Date(
                      yesterday.getTime() + 24 * 60 * 60 * 1000
                    ).toISOString(),
                  },
                  stats: dailyStats,
                }),
              },
            });

            // PERBAIKAN: Mark aggregates as exported
            await tx.temperatureAggregate.updateMany({
              where: { id: { in: aggregateData.map((item) => item.id) } },
              data: {
                isExported: true,
                exportedAt: new Date(),
              },
            });

            return backup;
          });
        },
        3,
        "create_backup"
      );

      this.state.lastExportDate = dateString;
      this.state.exportStatus = "completed";

      this.logInfo(
        `✅ Daily export completed: ${aggregateData.length} records for ${dateString}`,
        {
          backupId: backup.id,
          csvPath,
          excelPath,
          dailyStats,
        }
      );

      return {
        success: true,
        date: dateString,
        recordCount: aggregateData.length,
        csvPath,
        excelPath,
        backup,
        dailyStats,
      };
    } catch (error) {
      this.state.exportStatus = "failed";
      this.handleError(error, { context: "exportDailyData" });
      throw error;
    } finally {
      this.state.isExporting = false;
    }
  }

  async exportToCSV(data, dateString, exportDir) {
    const csvPath = path.join(exportDir, `temperature_${dateString}.csv`);
    const csvHeader =
      "Date,TimeSlot,MeanTemp,MedianTemp,ModeTemp,MinTemp,MaxTemp,SampleCount,StdDev\n";

    const csvData = data
      .map((row) => {
        // PERBAIKAN: Add standard deviation if available
        const metadata = row.metadata ? JSON.parse(row.metadata) : {};
        const stdDev = metadata.stdDev || 0;

        return `${dateString},${row.timeSlot},${row.meanTemp},${row.medianTemp},${row.modeTemp},${row.minTemp},${row.maxTemp},${row.sampleCount},${stdDev}`;
      })
      .join("\n");

    await fs.writeFile(csvPath, csvHeader + csvData, "utf8");
    this.logInfo(`📝 CSV export created: ${csvPath}`);
    return csvPath;
  }

  async exportToExcel(data, dateString, exportDir) {
    const excelPath = path.join(exportDir, `temperature_${dateString}.xlsx`);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(`Temperature Data ${dateString}`);

    // PERBAIKAN: Enhanced Excel formatting
    worksheet.columns = [
      { header: "Date", key: "date", width: 12 },
      { header: "Time Slot", key: "timeSlot", width: 15 },
      { header: "Mean Temp (°C)", key: "meanTemp", width: 15 },
      { header: "Median Temp (°C)", key: "medianTemp", width: 15 },
      { header: "Mode Temp (°C)", key: "modeTemp", width: 15 },
      { header: "Min Temp (°C)", key: "minTemp", width: 15 },
      { header: "Max Temp (°C)", key: "maxTemp", width: 15 },
      { header: "Sample Count", key: "sampleCount", width: 15 },
      { header: "Std Deviation", key: "stdDev", width: 15 },
      { header: "Status", key: "status", width: 12 },
    ];

    data.forEach((row) => {
      const metadata = row.metadata ? JSON.parse(row.metadata) : {};
      const status = row.isExported ? "Exported" : "Pending";

      worksheet.addRow({
        date: dateString,
        timeSlot: row.timeSlot,
        meanTemp: row.meanTemp,
        medianTemp: row.medianTemp,
        modeTemp: row.modeTemp,
        minTemp: row.minTemp,
        maxTemp: row.maxTemp,
        sampleCount: row.sampleCount,
        stdDev: metadata.stdDev || 0,
        status: status,
      });
    });

    // PERBAIKAN: Enhanced styling
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FFFFFF" } };
    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF4472C4" },
    };

    // PERBAIKAN: Add summary row
    const summaryRow = worksheet.addRow({
      date: "SUMMARY",
      timeSlot: `${data.length} records`,
      meanTemp: this.calculateDailyStats(data).avgTemp,
      medianTemp: "",
      modeTemp: "",
      minTemp: this.calculateDailyStats(data).minTemp,
      maxTemp: this.calculateDailyStats(data).maxTemp,
      sampleCount: data.reduce((sum, row) => sum + row.sampleCount, 0),
      stdDev: "",
      status: "TOTAL",
    });

    summaryRow.font = { bold: true };
    summaryRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE6F3FF" },
    };

    await workbook.xlsx.writeFile(excelPath);
    this.logInfo(`📊 Excel export created: ${excelPath}`);
    return excelPath;
  }

  calculateDailyStats(data) {
    if (data.length === 0)
      return { avgTemp: 0, minTemp: 0, maxTemp: 0, totalSamples: 0 };

    const allMeans = data.map((item) => item.meanTemp);
    const allMins = data.map((item) => item.minTemp);
    const allMaxs = data.map((item) => item.maxTemp);
    const totalSamples = data.reduce((sum, item) => sum + item.sampleCount, 0);

    return {
      avgTemp:
        Math.round(
          (allMeans.reduce((sum, temp) => sum + temp, 0) / allMeans.length) *
            100
        ) / 100,
      minTemp: Math.min(...allMins),
      maxTemp: Math.max(...allMaxs),
      totalSamples,
      recordCount: data.length,
    };
  }

  // PERBAIKAN: Enhanced emergency cleanup
  async emergencyCleanup() {
    try {
      this.logWarn("🚨 Starting emergency cleanup...");

      // Process current buffer first
      if (this.state.bufferData.length > 0) {
        await this.processBuffer();
      }

      // Keep only most recent data
      const keepCount = Math.floor(this.config.maxBufferSize * 0.1); // Keep 10%
      const latestData = this.state.bufferData
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, keepCount);

      this.state.bufferData = latestData;

      this.logWarn(
        `🚨 Emergency cleanup completed, buffer reduced to ${latestData.length} items`
      );

      return {
        success: true,
        itemsRemoved: this.state.bufferData.length - keepCount,
        itemsKept: keepCount,
      };
    } catch (error) {
      this.handleError(error, { context: "emergencyCleanup" });
      this.state.bufferData = [];
      return { success: false, error: error.message };
    }
  }

  // PERBAIKAN: Enhanced system status with more details
  async getSystemStatus() {
    try {
      const [bufferCount, processedCount, aggregateCount, pendingExports] =
        await Promise.all([
          db.withRetry(async (prisma) =>
            prisma.temperatureBuffer.count({ where: { isProcessed: false } })
          ),
          db.withRetry(async (prisma) =>
            prisma.temperatureBuffer.count({ where: { isProcessed: true } })
          ),
          db.withRetry(async (prisma) =>
            prisma.temperatureAggregate.count({ where: { isExported: false } })
          ),
          db.withRetry(async (prisma) => prisma.dailyTemperatureBackup.count()),
        ]);

      // PERBAIKAN: Add health metrics
      const dbHealth = await db.healthCheck();

      return {
        status: "healthy",
        service: {
          memoryBuffer: this.state.bufferData.length,
          databaseBuffer: bufferCount,
          processedBuffer: processedCount,
          pendingAggregates: aggregateCount,
          completedExports: pendingExports,
          lastSavedMinute: this.state.lastSavedMinute,
          lastProcessedSlot: this.state.lastProcessedSlot,
          isProcessing: this.state.isProcessing,
          isExporting: this.state.isExporting,
          exportStatus: this.state.exportStatus,
          lastExportDate: this.state.lastExportDate,
        },
        database: dbHealth,
        config: this.config,
        timers: {
          buffer: !!this.timers.buffer,
          aggregate: !!this.timers.aggregate,
          export: !!this.timers.export,
          cleanup: !!this.timers.cleanup,
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.handleError(error, { context: "getSystemStatus" });
      return {
        status: "error",
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // PERBAIKAN: Add method untuk manual operations
  async forceProcessBuffer() {
    this.logInfo("🔧 Manual buffer processing triggered...");
    return await this.processBuffer();
  }

  async forceProcessAggregation() {
    this.logInfo("🔧 Manual aggregation processing triggered...");
    return await this.processAggregation();
  }

  async forceExport() {
    this.logInfo("🔧 Manual export triggered...");
    return await this.exportDailyData();
  }

  async forceCleanup() {
    this.logInfo("🔧 Manual cleanup triggered...");
    return await this.performCleanup();
  }

  // PERBAIKAN: Enhanced logging methods dengan structured logging
  logInfo(message, metadata = {}) {
    const timestamp = new Date().toISOString();
    console.log(`ℹ️ [${timestamp}] ${message}`, metadata);
    this.saveLog("INFO", message, { ...metadata, timestamp }).catch(() => {});
  }

  logWarn(message, metadata = {}) {
    const timestamp = new Date().toISOString();
    console.warn(`⚠️ [${timestamp}] ${message}`, metadata);
    this.saveLog("WARNING", message, { ...metadata, timestamp }).catch(
      () => {}
    );
  }

  logError(message, metadata = {}) {
    const timestamp = new Date().toISOString();
    console.error(`❌ [${timestamp}] ${message}`, metadata);
    this.saveLog("ERROR", message, { ...metadata, timestamp }).catch(() => {});
  }

  async saveLog(level, message, metadata = {}) {
    try {
      await db.withRetry(
        async (prisma) => {
          return await prisma.systemLog.create({
            data: {
              level,
              message,
              metadata: JSON.stringify(metadata),
              timestamp: new Date(),
            },
          });
        },
        2,
        "save_log"
      ); // Reduced retries for logging
    } catch (error) {
      // Fallback to console if database logging fails
      console.log(`${level} [FALLBACK]: ${message}`, metadata);
    }
  }

  handleError(error, context = {}) {
    const errorMessage = `Error in ${context.context || "unknown"}: ${
      error.message
    }`;
    const errorContext = {
      ...context,
      stack: error.stack?.split("\n").slice(0, 10), // Limit stack trace
      timestamp: new Date().toISOString(),
    };

    this.logError(errorMessage, errorContext);
  }

  // PERBAIKAN: Utility methods
  formatMinute(date) {
    return date.toISOString().slice(0, 16).replace("T", " ");
  }

  generateTimeSlot(date) {
    const minutes = date.getMinutes();
    const slotStart = Math.floor(minutes / 10) * 10;
    const slotEnd = slotStart + 10;
    const hour = date.getHours();

    const startTime = `${hour.toString().padStart(2, "0")}:${slotStart
      .toString()
      .padStart(2, "0")}`;
    const endTime =
      slotEnd === 60
        ? `${(hour + 1).toString().padStart(2, "0")}:00`
        : `${hour.toString().padStart(2, "0")}:${slotEnd
            .toString()
            .padStart(2, "0")}`;

    return `${startTime}-${endTime}`;
  }

  getSlotTimeRange(date) {
    const endTime = new Date(date);
    endTime.setSeconds(0, 0);

    const startTime = new Date(endTime);
    startTime.setMinutes(startTime.getMinutes() - 10);

    return { startTime, endTime };
  }

  // PERBAIKAN: Enhanced cleanup method
  async cleanup() {
    this.logInfo("🔄 Starting TemperatureService cleanup...");

    try {
      // Clear all timers
      Object.entries(this.timers).forEach(([name, timer]) => {
        if (timer) {
          clearInterval(timer);
          this.logInfo(`✅ Timer ${name} cleared`);
        }
      });

      // Process any remaining buffer data
      if (this.state.bufferData.length > 0) {
        this.logInfo(
          `🔄 Processing ${this.state.bufferData.length} remaining buffer items...`
        );
        await this.processBuffer();
      }

      // Process any pending aggregation
      if (this.state.lastProcessedSlot !== this.generateTimeSlot(new Date())) {
        this.logInfo("🔄 Processing final aggregation...");
        await this.processAggregation();
      }

      this.logInfo("✅ TemperatureService cleanup completed successfully");
    } catch (error) {
      this.handleError(error, { context: "cleanup" });
      throw error;
    }
  }
}

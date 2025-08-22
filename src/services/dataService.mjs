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
    };

    this.state = {
      bufferData: [],
      lastSavedMinute: null,
      lastProcessedSlot: null,
      isProcessing: false,
    };

    this.timers = {
      buffer: null,
      aggregate: null,
      export: null,
    };

    this.startSchedulers();
    console.log("✅ TemperatureService initialized");
  }

  startSchedulers() {
    console.log("🔄 Starting schedulers...");

    // Process buffer every minute
    this.timers.buffer = setInterval(() => {
      this.processBuffer().catch(this.handleError.bind(this));
    }, this.config.bufferIntervalMinutes * 60 * 1000);

    // Process aggregation every 10 minutes
    this.timers.aggregate = setInterval(() => {
      this.processAggregation().catch(this.handleError.bind(this));
    }, this.config.aggregateIntervalMinutes * 60 * 1000);

    this.scheduleDailyExport();
    console.log("✅ All schedulers started");
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
      };

      if (this.state.bufferData.length >= this.config.maxBufferSize) {
        console.warn("⚠️ Buffer full, performing emergency cleanup...");
        await this.emergencyCleanup();
      }

      this.state.bufferData.push(dataPoint);

      if (this.state.bufferData.length >= this.config.bufferThreshold) {
        await this.processBuffer();
      }

      this.logInfo(
        `📊 Data received: ${temp}°C (Buffer: ${this.state.bufferData.length}/${this.config.maxBufferSize})`
      );

      return {
        success: true,
        temperature: temp,
        bufferSize: this.state.bufferData.length,
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
      return;
    }

    this.state.isProcessing = true;

    try {
      const currentMinute = this.formatMinute(new Date());

      if (this.state.lastSavedMinute === currentMinute) {
        this.logInfo(
          `⏭️ Minute ${currentMinute} already processed, skipping...`
        );
        return;
      }

      const temperatures = this.state.bufferData.map(
        (item) => item.temperature
      );
      const avgTemp =
        temperatures.reduce((sum, temp) => sum + temp, 0) / temperatures.length;
      const roundedAvg = Math.round(avgTemp * 100) / 100;

      const savedData = await db.withRetry(async (prisma) => {
        return await prisma.temperatureBuffer.create({
          data: {
            temperature: roundedAvg,
            timestamp: new Date(),
            isProcessed: false,
          },
        });
      });

      this.state.lastSavedMinute = currentMinute;
      const bufferCount = this.state.bufferData.length;
      this.state.bufferData = [];

      this.logInfo(
        `✅ Buffer processed: ${roundedAvg}°C from ${bufferCount} samples saved (ID: ${savedData.id})`
      );

      return {
        success: true,
        savedId: savedData.id,
        avgTemperature: roundedAvg,
        sampleCount: bufferCount,
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

      if (this.state.lastProcessedSlot === timeSlot) {
        this.logInfo(`⏭️ Slot ${timeSlot} already processed, skipping...`);
        return;
      }

      const { startTime, endTime } = this.getSlotTimeRange(now);

      const bufferData = await db.withRetry(async (prisma) => {
        return await prisma.temperatureBuffer.findMany({
          where: {
            timestamp: { gte: startTime, lt: endTime },
            isProcessed: false,
          },
          orderBy: { timestamp: "asc" },
        });
      });

      if (bufferData.length === 0) {
        this.logWarn(`No data found for slot ${timeSlot}`, {
          startTime,
          endTime,
        });
        return;
      }

      const temperatures = bufferData.map((item) => item.temperature);
      const stats = this.calculateStats(temperatures);

      const result = await db.withRetry(async (prisma) => {
        return await prisma.$transaction(async (tx) => {
          const aggregate = await tx.temperatureAggregate.create({
            data: {
              date: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
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

          await tx.temperatureBuffer.updateMany({
            where: { id: { in: bufferData.map((item) => item.id) } },
            data: { isProcessed: true },
          });

          return aggregate;
        });
      });

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
      };
    } catch (error) {
      this.handleError(error, { context: "processAggregation" });
      throw error;
    }
  }

  // Utility methods
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

  calculateStats(temperatures) {
    if (temperatures.length === 0) {
      return { mean: 0, median: 0, mode: 0, min: 0, max: 0 };
    }

    const mean =
      temperatures.reduce((sum, temp) => sum + temp, 0) / temperatures.length;

    const sorted = [...temperatures].sort((a, b) => a - b);
    const median =
      sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];

    const frequency = {};
    temperatures.forEach((temp) => {
      const rounded = Math.round(temp * 10) / 10;
      frequency[rounded] = (frequency[rounded] || 0) + 1;
    });
    const mode = parseFloat(
      Object.keys(frequency).reduce((a, b) =>
        frequency[a] > frequency[b] ? a : b
      )
    );

    return {
      mean: Math.round(mean * 100) / 100,
      median: Math.round(median * 100) / 100,
      mode,
      min: Math.min(...temperatures),
      max: Math.max(...temperatures),
    };
  }

  async emergencyCleanup() {
    try {
      const keepCount = 50;
      const latestData = this.state.bufferData.slice(-keepCount);

      if (this.state.bufferData.length > 0) {
        await this.processBuffer();
      }

      this.state.bufferData = latestData;

      this.logWarn(
        `Emergency cleanup completed, buffer reduced to ${latestData.length} items`
      );
    } catch (error) {
      this.handleError(error, { context: "emergencyCleanup" });
      this.state.bufferData = [];
    }
  }

  scheduleDailyExport() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    const timeUntilMidnight = tomorrow.getTime() - now.getTime();

    setTimeout(() => {
      this.exportDailyData().catch(this.handleError.bind(this));

      this.timers.export = setInterval(() => {
        this.exportDailyData().catch(this.handleError.bind(this));
      }, 24 * 60 * 60 * 1000);
    }, timeUntilMidnight);

    this.logInfo(
      `📅 Daily export scheduled in ${Math.round(
        timeUntilMidnight / 1000 / 60
      )} minutes`
    );
  }

  async exportDailyData() {
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);

      const dateString = yesterday.toISOString().split("T")[0];

      this.logInfo(`📤 Starting daily export for ${dateString}`);

      const aggregateData = await db.withRetry(async (prisma) => {
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
      });

      if (aggregateData.length === 0) {
        this.logWarn(`No data to export for ${dateString}`);
        return;
      }

      const exportDir = path.join(process.cwd(), "exports");
      await fs.mkdir(exportDir, { recursive: true });

      const csvPath = await this.exportToCSV(
        aggregateData,
        dateString,
        exportDir
      );
      const excelPath = await this.exportToExcel(
        aggregateData,
        dateString,
        exportDir
      );

      await db.withRetry(async (prisma) => {
        return await prisma.$transaction(async (tx) => {
          await tx.dailyTemperatureBackup.create({
            data: {
              date: dateString,
              csvFilePath: csvPath,
              excelFilePath: excelPath,
              totalRecords: aggregateData.length,
              avgDailyTemp: this.calculateDailyStats(aggregateData).avgTemp,
              minDailyTemp: this.calculateDailyStats(aggregateData).minTemp,
              maxDailyTemp: this.calculateDailyStats(aggregateData).maxTemp,
            },
          });

          await tx.temperatureAggregate.updateMany({
            where: { id: { in: aggregateData.map((item) => item.id) } },
            data: { isExported: true },
          });
        });
      });

      this.logInfo(
        `✅ Daily export completed: ${aggregateData.length} records for ${dateString}`
      );

      return {
        success: true,
        date: dateString,
        recordCount: aggregateData.length,
        csvPath,
        excelPath,
      };
    } catch (error) {
      this.handleError(error, { context: "exportDailyData" });
      throw error;
    }
  }

  async exportToCSV(data, dateString, exportDir) {
    const csvPath = path.join(exportDir, `temperature_${dateString}.csv`);
    const csvHeader =
      "Date,TimeSlot,MeanTemp,MedianTemp,ModeTemp,MinTemp,MaxTemp,SampleCount\n";
    const csvData = data
      .map(
        (row) =>
          `${dateString},${row.timeSlot},${row.meanTemp},${row.medianTemp},${row.modeTemp},${row.minTemp},${row.maxTemp},${row.sampleCount}`
      )
      .join("\n");

    await fs.writeFile(csvPath, csvHeader + csvData, "utf8");
    return csvPath;
  }

  async exportToExcel(data, dateString, exportDir) {
    const excelPath = path.join(exportDir, `temperature_${dateString}.xlsx`);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(`Temperature Data ${dateString}`);

    worksheet.columns = [
      { header: "Date", key: "date", width: 12 },
      { header: "Time Slot", key: "timeSlot", width: 15 },
      { header: "Mean Temp", key: "meanTemp", width: 12 },
      { header: "Median Temp", key: "medianTemp", width: 12 },
      { header: "Mode Temp", key: "modeTemp", width: 12 },
      { header: "Min Temp", key: "minTemp", width: 12 },
      { header: "Max Temp", key: "maxTemp", width: 12 },
      { header: "Sample Count", key: "sampleCount", width: 12 },
    ];

    data.forEach((row) => {
      worksheet.addRow({
        date: dateString,
        timeSlot: row.timeSlot,
        meanTemp: row.meanTemp,
        medianTemp: row.medianTemp,
        modeTemp: row.modeTemp,
        minTemp: row.minTemp,
        maxTemp: row.maxTemp,
        sampleCount: row.sampleCount,
      });
    });

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE6F3FF" },
    };

    await workbook.xlsx.writeFile(excelPath);
    return excelPath;
  }

  calculateDailyStats(data) {
    if (data.length === 0) return { avgTemp: 0, minTemp: 0, maxTemp: 0 };

    const allMeans = data.map((item) => item.meanTemp);
    const allMins = data.map((item) => item.minTemp);
    const allMaxs = data.map((item) => item.maxTemp);

    return {
      avgTemp:
        Math.round(
          (allMeans.reduce((sum, temp) => sum + temp, 0) / allMeans.length) *
            100
        ) / 100,
      minTemp: Math.min(...allMins),
      maxTemp: Math.max(...allMaxs),
    };
  }

  logInfo(message, metadata = {}) {
    console.log(`ℹ️ ${message}`);
    this.saveLog("INFO", message, metadata).catch(() => {});
  }

  logWarn(message, metadata = {}) {
    console.warn(`⚠️ ${message}`);
    this.saveLog("WARNING", message, metadata).catch(() => {});
  }

  logError(message, metadata = {}) {
    console.error(`❌ ${message}`);
    this.saveLog("ERROR", message, metadata).catch(() => {});
  }

  async saveLog(level, message, metadata = {}) {
    try {
      await db.withRetry(async (prisma) => {
        return await prisma.systemLog.create({
          data: {
            level,
            message,
            metadata: JSON.stringify(metadata),
            timestamp: new Date(),
          },
        });
      });
    } catch (error) {
      console.log(`${level}: ${message}`, metadata);
    }
  }

  handleError(error, context = {}) {
    const errorMessage = `Error in ${context.context || "unknown"}: ${
      error.message
    }`;
    this.logError(errorMessage, {
      ...context,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    });
  }

  async getSystemStatus() {
    try {
      const [bufferCount, processedCount, aggregateCount] = await Promise.all([
        db.withRetry(async (prisma) =>
          prisma.temperatureBuffer.count({ where: { isProcessed: false } })
        ),
        db.withRetry(async (prisma) =>
          prisma.temperatureBuffer.count({ where: { isProcessed: true } })
        ),
        db.withRetry(async (prisma) =>
          prisma.temperatureAggregate.count({ where: { isExported: false } })
        ),
      ]);

      return {
        status: "healthy",
        memoryBuffer: this.state.bufferData.length,
        databaseBuffer: bufferCount,
        processedBuffer: processedCount,
        pendingAggregates: aggregateCount,
        lastSavedMinute: this.state.lastSavedMinute,
        lastProcessedSlot: this.state.lastProcessedSlot,
        isProcessing: this.state.isProcessing,
        config: this.config,
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

  async forceProcessBuffer() {
    this.logInfo("🔧 Manual buffer processing...");
    return await this.processBuffer();
  }

  async forceProcessAggregation() {
    this.logInfo("🔧 Manual aggregation processing...");
    return await this.processAggregation();
  }

  async forceExport() {
    this.logInfo("🔧 Manual export...");
    return await this.exportDailyData();
  }

  async cleanup() {
    this.logInfo("🔄 Cleaning up TemperatureService...");

    Object.values(this.timers).forEach((timer) => {
      if (timer) clearInterval(timer);
    });

    if (this.state.bufferData.length > 0) {
      await this.processBuffer();
    }

    this.logInfo("✅ TemperatureService cleanup completed");
  }
}

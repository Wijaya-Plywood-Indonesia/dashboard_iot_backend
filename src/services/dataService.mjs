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
      requiredAggregateCount: 10, // PERBAIKAN: Tepat 10 data untuk agregasi
    };

    this.state = {
      bufferData: [], // Data real-time dalam 1 menit
      lastSavedMinute: null,
      lastProcessedSlot: null,
      isProcessing: false,
      minuteDataCount: 0, // PERBAIKAN: Counter untuk data per menit
      currentMinuteStartTime: null, // PERBAIKAN: Track waktu mulai menit
    };

    this.timers = {
      buffer: null,
      aggregate: null,
      export: null,
      sixHourExport: null, // PERBAIKAN: Timer untuk export 6 jam
      cleanup: null, // PERBAIKAN: Timer untuk cleanup data lama
    };

    this.exportConfig = {
      sixHourIntervalMs: 6 * 60 * 60 * 1000, // 6 jam dalam milliseconds
      lastSixHourExport: null,
    };

    this.startSchedulers();
    console.log("✅ TemperatureService initialized");
  }

  startSchedulers() {
    console.log("🔄 Starting schedulers...");

    // PERBAIKAN: Check untuk agregasi setiap menit (saat processCurrentMinuteBuffer dipanggil)
    // Timer buffer untuk memastikan data menit yang tidak sempurna tetap diproses
    this.timers.buffer = setInterval(() => {
      this.processMinuteBufferIfNeeded().catch(this.handleError.bind(this));
    }, this.config.bufferIntervalMinutes * 60 * 1000);

    // PERBAIKAN: Check untuk 6-hour export setiap 30 menit
    this.timers.sixHourExport = setInterval(() => {
      this.checkForSixHourExport().catch(this.handleError.bind(this));
    }, 30 * 60 * 1000); // Check every 30 minutes

    // PERBAIKAN: Cleanup data 24 jam yang sudah di-backup
    this.timers.cleanup = setInterval(() => {
      this.cleanupOldData().catch(this.handleError.bind(this));
    }, 24 * 60 * 60 * 1000); // Setiap 24 jam

    this.scheduleDailyExport();
    console.log("✅ All schedulers started");
  }

  // PERBAIKAN: Process buffer minute jika diperlukan (fallback)
  async processMinuteBufferIfNeeded() {
    const now = new Date();
    const currentMinute = this.formatMinute(now);

    // Jika menit sudah berganti dan masih ada data di buffer
    if (
      this.state.currentMinuteStartTime &&
      currentMinute !== this.formatMinute(this.state.currentMinuteStartTime) &&
      this.state.bufferData.length > 0
    ) {
      this.logInfo("⏰ Processing minute buffer due to time change");
      await this.processCurrentMinuteBuffer();

      // Reset untuk menit baru
      this.state.bufferData = [];
      this.state.minuteDataCount = 0;
      this.state.currentMinuteStartTime = new Date(now);
      this.state.currentMinuteStartTime.setSeconds(0, 0);
    }
  }

  async receiveTemperatureData(temperature) {
    try {
      const temp = parseFloat(temperature);
      if (isNaN(temp) || temp < -50 || temp > 500) {
        throw new Error(`Invalid temperature: ${temperature}`);
      }

      const now = new Date();

      // PERBAIKAN: Track menit saat ini
      const currentMinute = this.formatMinute(now);

      // PERBAIKAN: Reset buffer jika menit baru
      if (
        !this.state.currentMinuteStartTime ||
        currentMinute !== this.formatMinute(this.state.currentMinuteStartTime)
      ) {
        this.state.currentMinuteStartTime = new Date(now);
        this.state.currentMinuteStartTime.setSeconds(0, 0); // Set ke awal menit

        // Jika ada data di buffer menit sebelumnya, proses dulu
        if (this.state.bufferData.length > 0) {
          await this.processCurrentMinuteBuffer();
        }

        // Reset buffer untuk menit baru
        this.state.bufferData = [];
        this.state.minuteDataCount = 0;
      }

      const dataPoint = {
        temperature: temp,
        timestamp: now,
        minute: currentMinute,
      };

      // PERBAIKAN: Tambah data ke buffer menit ini
      this.state.bufferData.push(dataPoint);
      this.state.minuteDataCount++;

      this.logInfo(
        `📊 Data received: ${temp}°C (Minute: ${currentMinute}, Count: ${this.state.minuteDataCount})`
      );

      return {
        success: true,
        temperature: temp,
        bufferSize: this.state.bufferData.length,
        minuteCount: this.state.minuteDataCount,
        currentMinute: currentMinute,
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

  // PERBAIKAN: Proses buffer data menit saat ini ke database
  async processCurrentMinuteBuffer() {
    if (this.state.bufferData.length === 0) {
      return;
    }

    try {
      // Hitung rata-rata untuk menit ini
      const temperatures = this.state.bufferData.map(
        (item) => item.temperature
      );
      const avgTemp =
        temperatures.reduce((sum, temp) => sum + temp, 0) / temperatures.length;
      const roundedAvg = Math.round(avgTemp * 100) / 100;

      // Simpan ke TemperatureBuffer
      const savedData = await db.withRetry(async (prisma) => {
        return await prisma.temperatureBuffer.create({
          data: {
            temperature: roundedAvg,
            timestamp: this.state.currentMinuteStartTime,
            isProcessed: false,
          },
        });
      });

      this.state.lastSavedMinute = this.formatMinute(
        this.state.currentMinuteStartTime
      );

      this.logInfo(
        `✅ Minute buffer processed: ${roundedAvg}°C from ${temperatures.length} samples (ID: ${savedData.id})`
      );

      // PERBAIKAN: Check apakah sudah ada 10 data untuk agregasi
      await this.checkForAggregation();

      return {
        success: true,
        savedId: savedData.id,
        avgTemperature: roundedAvg,
        sampleCount: temperatures.length,
      };
    } catch (error) {
      this.handleError(error, { context: "processCurrentMinuteBuffer" });
      throw error;
    }
  }

  // PERBAIKAN: Check dan lakukan agregasi jika sudah 10 data
  async checkForAggregation() {
    try {
      // Ambil data buffer yang belum diproses
      const unprocessedData = await db.withRetry(async (prisma) => {
        return await prisma.temperatureBuffer.findMany({
          where: { isProcessed: false },
          orderBy: { timestamp: "asc" },
        });
      });

      this.logInfo(
        `🔍 Checking aggregation: ${unprocessedData.length} unprocessed buffer data`
      );

      // Jika sudah ada 10 data atau lebih, lakukan agregasi
      if (unprocessedData.length >= this.config.requiredAggregateCount) {
        // Ambil 10 data pertama
        const dataToAggregate = unprocessedData.slice(
          0,
          this.config.requiredAggregateCount
        );

        // PERBAIKAN: Check dulu apakah time slot sudah ada sebelum agregasi
        const firstTimestamp = dataToAggregate[0].timestamp;
        const timeSlot = this.generateTimeSlot(firstTimestamp);
        const dateOnly = new Date(
          firstTimestamp.getFullYear(),
          firstTimestamp.getMonth(),
          firstTimestamp.getDate()
        );

        const existingAggregate = await db.withRetry(async (prisma) => {
          return await prisma.temperatureAggregate.findFirst({
            where: {
              date: dateOnly,
              timeSlot: timeSlot,
            },
          });
        });

        if (existingAggregate) {
          this.logInfo(
            `ℹ️ Skipping aggregation - slot ${timeSlot} on ${
              dateOnly.toISOString().split("T")[0]
            } already exists (ID: ${existingAggregate.id})`
          );

          // Tandai data sebagai sudah diproses dan hapus
          await db.withRetry(async (prisma) => {
            await prisma.temperatureBuffer.deleteMany({
              where: { id: { in: dataToAggregate.map((item) => item.id) } },
            });
          });

          return;
        }

        this.logInfo(
          `📊 Starting aggregation for ${dataToAggregate.length} data points`
        );
        this.logInfo(
          `📅 Time range: ${dataToAggregate[0].timestamp.toISOString()} to ${dataToAggregate[
            dataToAggregate.length - 1
          ].timestamp.toISOString()}`
        );

        await this.performAggregation(dataToAggregate);
      } else {
        this.logInfo(
          `⏳ Not enough data for aggregation: ${unprocessedData.length}/${this.config.requiredAggregateCount}`
        );
      }
    } catch (error) {
      this.handleError(error, { context: "checkForAggregation" });
    }
  }

  // PERBAIKAN: Lakukan agregasi untuk 10 data
  async performAggregation(bufferData) {
    try {
      const temperatures = bufferData.map((item) => item.temperature);
      const stats = this.calculateStats(temperatures);

      // Generate time slot berdasarkan data pertama
      const firstTimestamp = bufferData[0].timestamp;
      const timeSlot = this.generateTimeSlot(firstTimestamp);
      const dateOnly = new Date(
        firstTimestamp.getFullYear(),
        firstTimestamp.getMonth(),
        firstTimestamp.getDate()
      );

      this.logInfo(
        `🎯 Attempting aggregation for date: ${
          dateOnly.toISOString().split("T")[0]
        }, timeSlot: ${timeSlot}`
      );

      // PERBAIKAN: Check apakah sudah ada agregasi untuk slot ini
      const existingAggregate = await db.withRetry(async (prisma) => {
        return await prisma.temperatureAggregate.findFirst({
          where: {
            date: dateOnly,
            timeSlot: timeSlot,
          },
        });
      });

      if (existingAggregate) {
        this.logInfo(
          `ℹ️ Aggregate already exists for ${timeSlot} on ${
            dateOnly.toISOString().split("T")[0]
          } (ID: ${existingAggregate.id}), skipping creation...`
        );

        // Tetap hapus buffer data yang sudah diproses
        await db.withRetry(async (prisma) => {
          await prisma.temperatureBuffer.deleteMany({
            where: { id: { in: bufferData.map((item) => item.id) } },
          });
        });

        this.logInfo(
          `🗑️ Cleaned up ${bufferData.length} processed buffer records`
        );
        return existingAggregate;
      }

      this.logInfo(
        `✨ Creating new aggregate for ${timeSlot} with stats:`,
        stats
      );

      const result = await db.withRetry(async (prisma) => {
        return await prisma.$transaction(async (tx) => {
          // Buat agregasi baru
          const aggregate = await tx.temperatureAggregate.create({
            data: {
              date: dateOnly,
              timeSlot,
              meanTemp: stats.mean,
              medianTemp: stats.median,
              modeTemp: stats.mode,
              minTemp: stats.min,
              maxTemp: stats.max,
              sampleCount: bufferData.length,
              isExported: false,
              isSixHourExported: false,
              sixHourBatch: this.generateSixHourBatch(firstTimestamp),
            },
          });

          // PERBAIKAN: Mark buffer data as processed dan HAPUS
          await tx.temperatureBuffer.deleteMany({
            where: { id: { in: bufferData.map((item) => item.id) } },
          });

          return aggregate;
        });
      });

      this.state.lastProcessedSlot = timeSlot;

      this.logInfo(
        `✅ Aggregation completed for ${timeSlot}: ${bufferData.length} samples aggregated and buffer data deleted (Aggregate ID: ${result.id})`
      );

      // PERBAIKAN: Check apakah sudah siap untuk 6-hour export
      await this.checkForSixHourExport();

      return result;
    } catch (error) {
      this.handleError(error, {
        context: "performAggregation",
        bufferDataCount: bufferData?.length,
        firstTimestamp: bufferData?.[0]?.timestamp?.toISOString(),
      });
      throw error;
    }
  }

  // PERBAIKAN: Check apakah sudah siap untuk export 6 jam
  async checkForSixHourExport() {
    try {
      const now = new Date();
      const currentBatch = this.generateSixHourBatch(now);

      // Cek berapa banyak data agregasi untuk batch ini
      const aggregateCount = await db.withRetry(async (prisma) => {
        return await prisma.temperatureAggregate.count({
          where: {
            sixHourBatch: currentBatch,
            isSixHourExported: false,
          },
        });
      });

      // Jika sudah 6 jam (36 agregasi @ 10 menit), lakukan export
      if (aggregateCount >= 36) {
        await this.exportSixHourData();
      }
    } catch (error) {
      this.handleError(error, { context: "checkForSixHourExport" });
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
              isSixHourExported: false, // PERBAIKAN: Field baru untuk 6-hour export tracking
              sixHourBatch: this.generateSixHourBatch(now), // PERBAIKAN: Batch ID untuk 6 jam
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

    // PERBAIKAN: Handle ketika slotEnd = 60 (harus jadi jam berikutnya)
    let endTime;
    if (slotEnd === 60) {
      const nextHour = (hour + 1) % 24; // Handle overflow 24 jam
      endTime = `${nextHour.toString().padStart(2, "0")}:00`;
    } else {
      endTime = `${hour.toString().padStart(2, "0")}:${slotEnd
        .toString()
        .padStart(2, "0")}`;
    }

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

  // PERBAIKAN: Fungsi untuk generate batch ID 6 jam
  generateSixHourBatch(date) {
    const hours = date.getHours();
    const dateStr = date.toISOString().split("T")[0];

    if (hours >= 0 && hours < 6) {
      return `${dateStr}_00-06`;
    } else if (hours >= 6 && hours < 12) {
      return `${dateStr}_06-12`;
    } else if (hours >= 12 && hours < 18) {
      return `${dateStr}_12-18`;
    } else {
      return `${dateStr}_18-24`;
    }
  }

  // PERBAIKAN: Export data setiap 6 jam
  // PERBAIKAN: Export data setiap 6 jam
  async exportSixHourData() {
    try {
      const now = new Date();
      const currentBatch = this.generateSixHourBatch(now);

      this.logInfo(`🕕 Starting 6-hour export for batch: ${currentBatch}`);

      // Cek apakah batch ini sudah di-export
      const existingExport = await db.withRetry(async (prisma) => {
        return await prisma.sixHourExport.findUnique({
          where: { batchId: currentBatch },
        });
      });

      if (existingExport) {
        this.logInfo(`⏭️ Batch ${currentBatch} already exported, skipping...`);
        return;
      }

      // PERBAIKAN: Ambil semua data agregasi untuk batch ini (6 jam = 36 slot @ 10 menit)
      const aggregateData = await db.withRetry(async (prisma) => {
        return await prisma.temperatureAggregate.findMany({
          where: {
            sixHourBatch: currentBatch,
            isSixHourExported: false,
          },
          orderBy: { timeSlot: "asc" },
        });
      });

      // PERBAIKAN: Minimum harus ada data untuk di-export
      if (aggregateData.length === 0) {
        this.logWarn(`No data to export for batch ${currentBatch}`);
        return;
      }

      // PERBAIKAN: Hanya export jika batch sudah lengkap (waktu sudah lewat)
      const { endTime } = this.getSixHourTimeRange(currentBatch);
      if (now < endTime) {
        this.logInfo(
          `Batch ${currentBatch} not yet complete. Waiting until ${endTime.toISOString()}`
        );
        return;
      }

      // Buat direktori export jika belum ada
      const exportDir = path.join(process.cwd(), "exports", "six-hour");
      await fs.mkdir(exportDir, { recursive: true });

      // Export ke CSV dan Excel
      const csvPath = await this.exportSixHourToCSV(
        aggregateData,
        currentBatch,
        exportDir
      );
      const excelPath = await this.exportSixHourToExcel(
        aggregateData,
        currentBatch,
        exportDir
      );

      // Hitung statistik
      const stats = this.calculateSixHourStats(aggregateData);
      const { startTime } = this.getSixHourTimeRange(currentBatch);

      // Simpan record export dan update status
      await db.withRetry(async (prisma) => {
        return await prisma.$transaction(async (tx) => {
          // Buat record export
          const exportRecord = await tx.sixHourExport.create({
            data: {
              batchId: currentBatch,
              startTime,
              endTime,
              csvFilePath: csvPath,
              excelFilePath: excelPath,
              totalRecords: aggregateData.length,
              avgTemp: stats.avgTemp,
              minTemp: stats.minTemp,
              maxTemp: stats.maxTemp,
              isReady: true,
              downloadNotified: false,
            },
          });

          // Update status agregasi
          await tx.temperatureAggregate.updateMany({
            where: { id: { in: aggregateData.map((item) => item.id) } },
            data: { isSixHourExported: true },
          });

          return exportRecord;
        });
      });

      this.logInfo(
        `✅ 6-hour export completed: ${aggregateData.length} records for batch ${currentBatch}`
      );

      // PERBAIKAN: Emit notifikasi ke frontend via Socket.IO
      this.emitSixHourExportNotification(currentBatch, {
        csvPath,
        excelPath,
        recordCount: aggregateData.length,
        stats,
      });

      return {
        success: true,
        batchId: currentBatch,
        recordCount: aggregateData.length,
        csvPath,
        excelPath,
        stats,
      };
    } catch (error) {
      this.handleError(error, { context: "exportSixHourData" });
      throw error;
    }
  }

  // PERBAIKAN: Export ke CSV untuk 6 jam
  async exportSixHourToCSV(data, batchId, exportDir) {
    const csvPath = path.join(exportDir, `temperature_6h_${batchId}.csv`);
    const csvHeader =
      "Date,TimeSlot,MeanTemp,MedianTemp,ModeTemp,MinTemp,MaxTemp,SampleCount\n";
    const csvData = data
      .map(
        (row) =>
          `${batchId.split("_")[0]},${row.timeSlot},${row.meanTemp},${
            row.medianTemp
          },${row.modeTemp},${row.minTemp},${row.maxTemp},${row.sampleCount}`
      )
      .join("\n");

    await fs.writeFile(csvPath, csvHeader + csvData, "utf8");
    return csvPath;
  }

  // PERBAIKAN: Export ke Excel untuk 6 jam
  async exportSixHourToExcel(data, batchId, exportDir) {
    const excelPath = path.join(exportDir, `temperature_6h_${batchId}.xlsx`);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(`6-Hour Data ${batchId}`);

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
        date: batchId.split("_")[0],
        timeSlot: row.timeSlot,
        meanTemp: row.meanTemp,
        medianTemp: row.medianTemp,
        modeTemp: row.modeTemp,
        minTemp: row.minTemp,
        maxTemp: row.maxTemp,
        sampleCount: row.sampleCount,
      });
    });

    // Style header
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE6F3FF" },
    };

    await workbook.xlsx.writeFile(excelPath);
    return excelPath;
  }

  // PERBAIKAN: Hitung statistik untuk 6 jam
  calculateSixHourStats(data) {
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

  // PERBAIKAN: Get time range untuk batch 6 jam
  getSixHourTimeRange(batchId) {
    const [dateStr, timeRange] = batchId.split("_");
    const [startHour, endHour] = timeRange.split("-").map((h) => parseInt(h));

    const startTime = new Date(dateStr);
    startTime.setHours(startHour, 0, 0, 0);

    const endTime = new Date(dateStr);
    endTime.setHours(endHour, 0, 0, 0);

    return { startTime, endTime };
  }

  // PERBAIKAN: Emit notifikasi export 6 jam ke frontend
  emitSixHourExportNotification(batchId, exportData) {
    // Jika ada Socket.IO connection, kirim notifikasi
    if (global.io) {
      global.io.emit("sixHourExportReady", {
        batchId,
        message: `Data 6 jam untuk batch ${batchId} siap untuk di-download!`,
        exportData,
        timestamp: new Date().toISOString(),
      });
    }

    this.logInfo(`📢 6-hour export notification sent for batch: ${batchId}`);
  }

  // PERBAIKAN: Cleanup data yang sudah lebih dari 24 jam dan sudah di-backup
  async cleanupOldData() {
    try {
      this.logInfo("🧹 Starting cleanup of old data...");

      const twentyFourHoursAgo = new Date();
      twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

      // Cleanup buffer data yang sudah processed dan lebih dari 24 jam
      const deletedBuffers = await db.withRetry(async (prisma) => {
        return await prisma.temperatureBuffer.deleteMany({
          where: {
            timestamp: { lt: twentyFourHoursAgo },
            isProcessed: true,
          },
        });
      });

      // Cleanup agregasi data yang sudah di-export dan lebih dari 7 hari
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const deletedAggregates = await db.withRetry(async (prisma) => {
        return await prisma.temperatureAggregate.deleteMany({
          where: {
            date: { lt: sevenDaysAgo },
            isExported: true,
            isSixHourExported: true,
          },
        });
      });

      // Cleanup export records yang lebih dari 30 hari
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const deletedExports = await db.withRetry(async (prisma) => {
        return await prisma.sixHourExport.deleteMany({
          where: {
            createdAt: { lt: thirtyDaysAgo },
          },
        });
      });

      this.logInfo(
        `✅ Cleanup completed: ${deletedBuffers.count} buffers, ${deletedAggregates.count} aggregates, ${deletedExports.count} exports deleted`
      );

      return {
        success: true,
        deletedBuffers: deletedBuffers.count,
        deletedAggregates: deletedAggregates.count,
        deletedExports: deletedExports.count,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.handleError(error, { context: "cleanupOldData" });
      throw error;
    }
  }

  async exportDailyData() {
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);

      const dateString = yesterday.toISOString().split("T")[0];

      this.logInfo(`📤 Starting daily export for ${dateString}`);

      // PERBAIKAN: Ambil semua data agregasi untuk hari kemarin
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

          // PERBAIKAN: HAPUS data agregasi yang sudah di-backup (requirement 24 jam)
          await tx.temperatureAggregate.deleteMany({
            where: {
              date: {
                gte: yesterday,
                lt: new Date(yesterday.getTime() + 24 * 60 * 60 * 1000),
              },
              isExported: true,
              isSixHourExported: true,
            },
          });
        });
      });

      this.logInfo(
        `✅ Daily export completed: ${aggregateData.length} records for ${dateString} and old data cleaned up`
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

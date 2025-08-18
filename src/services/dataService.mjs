// src/services/temperatureService.mjs
import { PrismaClient } from "@prisma/client";
import fs from "fs/promises";
import path from "path";
import ExcelJS from "exceljs";

const prisma = new PrismaClient();

export class TemperatureService {
  constructor() {
    this.lastSavedMinute = null;
    this.lastProcessedSlot = null;
    this.bufferData = []; // Buffer sementara untuk data dalam 1 menit
    this.bufferInterval = null;
    this.aggregateInterval = null;
    this.exportInterval = null;

    this.initializeSchedulers();
  }

  // Inisialisasi scheduler otomatis
  initializeSchedulers() {
    console.log("🔄 Menginisialisasi schedulers...");

    // Cek dan simpan buffer setiap 1 menit
    this.bufferInterval = setInterval(() => {
      this.processMinuteBuffer();
    }, 60 * 1000); // 1 menit

    // Proses agregasi setiap 10 menit
    this.aggregateInterval = setInterval(() => {
      this.processBufferToAggregate();
    }, 10 * 60 * 1000); // 10 menit

    // Jalankan pemeriksaan agregasi setiap menit untuk memastikan tidak terlewat
    setInterval(() => {
      this.checkMissedAggregation();
    }, 60 * 1000);

    // Export data setiap 24 jam (pada jam 00:00)
    this.scheduleDaily24HourExport();

    console.log("✅ Schedulers berhasil diinisialisasi");
  }

  // Terima data suhu dari MQTT (tidak langsung simpan ke DB)
  async receiveTemperatureData(temperature) {
    try {
      const now = new Date();
      const currentMinute = `${now.getFullYear()}-${(now.getMonth() + 1)
        .toString()
        .padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")} ${now
        .getHours()
        .toString()
        .padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;

      // Tambahkan ke buffer sementara
      this.bufferData.push({
        temperature: parseFloat(temperature),
        timestamp: now,
        minute: currentMinute,
      });

      // Log untuk monitoring
      console.log(
        `📊 Data diterima: ${temperature}°C pada ${currentMinute} (Buffer: ${this.bufferData.length})`
      );

      return { success: true, bufferSize: this.bufferData.length };
    } catch (error) {
      await this.logSystem("ERROR", "Gagal menerima data suhu", {
        temperature,
        error: error.message,
      });
      throw error;
    }
  }

  // Proses buffer per menit (ambil data terbaru dalam 1 menit)
  async processMinuteBuffer() {
    try {
      if (this.bufferData.length === 0) {
        console.log("⚠️  Buffer kosong, tidak ada data untuk diproses");
        return;
      }

      const now = new Date();
      const currentMinute = `${now.getFullYear()}-${(now.getMonth() + 1)
        .toString()
        .padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")} ${now
        .getHours()
        .toString()
        .padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;

      // Ambil data terbaru dari buffer (data terakhir yang diterima)
      const latestData = this.bufferData[this.bufferData.length - 1];

      if (!latestData) {
        console.log("⚠️  Tidak ada data terbaru di buffer");
        return;
      }

      // Cek apakah sudah menyimpan data untuk menit ini
      if (this.lastSavedMinute === currentMinute) {
        console.log(
          `⏭️  Data untuk menit ${currentMinute} sudah disimpan, skip...`
        );
        return;
      }

      // Simpan data terbaru ke database
      const saved = await prisma.temperatureBuffer.create({
        data: {
          temperature: latestData.temperature,
          timestamp: latestData.timestamp,
          isProcessed: false,
        },
      });

      this.lastSavedMinute = currentMinute;

      // Clear buffer setelah menyimpan
      this.bufferData = [];

      await this.logSystem(
        "INFO",
        `Data 1 menit berhasil disimpan: ${latestData.temperature}°C`,
        {
          bufferId: saved.id,
          minute: currentMinute,
          savedAt: saved.timestamp,
        }
      );

      console.log(
        `✅ Data terbaru disimpan: ${latestData.temperature}°C untuk menit ${currentMinute}`
      );
    } catch (error) {
      console.error("❌ Error processing minute buffer:", error);
      await this.logSystem("ERROR", "Gagal memproses buffer per menit", {
        error: error.message,
        bufferSize: this.bufferData.length,
      });
    }
  }

  // Cek agregasi yang terlewat
  async checkMissedAggregation() {
    try {
      const now = new Date();
      const currentMinute = now.getMinutes();

      // Cek apakah ini adalah menit ke-0 dari slot 10 menit baru
      if (currentMinute % 10 === 0) {
        const currentSlot = this.generateTimeSlot(now);

        if (this.lastProcessedSlot !== currentSlot) {
          console.log(`🔍 Memulai agregasi untuk slot: ${currentSlot}`);
          await this.processBufferToAggregate();
        }
      }
    } catch (error) {
      console.error("❌ Error checking missed aggregation:", error);
    }
  }

  // Proses buffer menjadi data agregasi (setiap 10 menit)
  async processBufferToAggregate() {
    try {
      const now = new Date();
      const currentSlot = this.generateTimeSlot(now);

      // Cek apakah slot ini sudah diproses
      if (this.lastProcessedSlot === currentSlot) {
        console.log(`⏭️  Slot ${currentSlot} sudah diproses, skip...`);
        return;
      }

      // Tentukan rentang waktu untuk agregasi (10 menit terakhir)
      const endTime = new Date(now);
      endTime.setSeconds(0, 0); // Set ke awal menit

      const startTime = new Date(endTime);
      startTime.setMinutes(startTime.getMinutes() - 10);

      console.log(
        `📊 Memproses agregasi dari ${startTime.toLocaleString()} sampai ${endTime.toLocaleString()}`
      );

      // Ambil data buffer dalam rentang waktu 10 menit terakhir
      const bufferData = await prisma.temperatureBuffer.findMany({
        where: {
          timestamp: {
            gte: startTime,
            lt: endTime,
          },
          isProcessed: false,
        },
        orderBy: { timestamp: "asc" },
      });

      console.log(
        `📈 Ditemukan ${bufferData.length} data untuk agregasi slot ${currentSlot}`
      );

      if (bufferData.length === 0) {
        await this.logSystem(
          "WARNING",
          `Tidak ada data buffer untuk slot ${currentSlot}`,
          {
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            currentSlot,
          }
        );
        return;
      }

      // Hitung statistik
      const temperatures = bufferData.map((item) => item.temperature);
      const stats = this.calculateStatistics(temperatures);

      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      // Cek apakah agregasi untuk slot ini sudah ada
      const existingAggregate = await prisma.temperatureAggregate.findFirst({
        where: {
          date: date,
          timeSlot: currentSlot,
        },
      });

      if (existingAggregate) {
        console.log(
          `⚠️  Agregasi untuk slot ${currentSlot} sudah ada, skip...`
        );
        return;
      }

      // Simpan ke tabel agregasi
      const aggregate = await prisma.temperatureAggregate.create({
        data: {
          date: date,
          timeSlot: currentSlot,
          meanTemp: stats.mean,
          medianTemp: stats.median,
          modeTemp: stats.mode,
          minTemp: stats.min,
          maxTemp: stats.max,
          sampleCount: bufferData.length,
          isExported: false,
        },
      });

      // Tandai buffer data sebagai sudah diproses
      const bufferIds = bufferData.map((item) => item.id);
      await prisma.temperatureBuffer.updateMany({
        where: {
          id: { in: bufferIds },
        },
        data: { isProcessed: true },
      });

      this.lastProcessedSlot = currentSlot;

      await this.logSystem(
        "INFO",
        `Agregasi berhasil untuk slot ${currentSlot}`,
        {
          aggregateId: aggregate.id,
          sampleCount: bufferData.length,
          stats: stats,
          timeSlot: currentSlot,
        }
      );

      console.log(
        `✅ Agregasi berhasil: ${currentSlot} dengan ${bufferData.length} sample`
      );
      console.log(
        `📊 Stats: Mean=${stats.mean}°C, Min=${stats.min}°C, Max=${stats.max}°C`
      );

      // Cleanup buffer yang sudah diproses (opsional, bisa dijalankan terpisah)
      setTimeout(() => this.cleanupProcessedBuffer(), 5000);
    } catch (error) {
      console.error("❌ Error processing buffer to aggregate:", error);
      await this.logSystem("ERROR", "Gagal memproses buffer ke agregasi", {
        error: error.message,
        stack: error.stack,
      });
    }
  }

  // Cleanup buffer yang sudah diproses
  async cleanupProcessedBuffer() {
    try {
      const result = await prisma.temperatureBuffer.deleteMany({
        where: { isProcessed: true },
      });

      if (result.count > 0) {
        console.log(`🧹 Cleanup: ${result.count} buffer data telah dihapus`);
        await this.logSystem(
          "INFO",
          `Cleanup buffer berhasil, ${result.count} data dihapus`
        );
      }
    } catch (error) {
      console.error("❌ Error cleaning up buffer:", error);
    }
  }

  // Generate time slot string yang lebih akurat
  generateTimeSlot(date) {
    const currentMinute = date.getMinutes();
    const slotStart = Math.floor(currentMinute / 10) * 10;
    const slotEnd = slotStart + 10;

    const hour = date.getHours();

    let startTime, endTime;

    if (slotEnd === 60) {
      startTime = `${hour.toString().padStart(2, "0")}:${slotStart
        .toString()
        .padStart(2, "0")}`;
      endTime = `${(hour + 1).toString().padStart(2, "0")}:00`;
    } else {
      startTime = `${hour.toString().padStart(2, "0")}:${slotStart
        .toString()
        .padStart(2, "0")}`;
      endTime = `${hour.toString().padStart(2, "0")}:${slotEnd
        .toString()
        .padStart(2, "0")}`;
    }

    return `${startTime}-${endTime}`;
  }

  // Kalkulasi statistik (mean, median, modus) - diperbaiki
  calculateStatistics(temperatures) {
    if (temperatures.length === 0) {
      return {
        mean: 0,
        median: 0,
        mode: 0,
        min: 0,
        max: 0,
        count: 0,
      };
    }

    // Mean (rata-rata)
    const mean =
      temperatures.reduce((sum, temp) => sum + temp, 0) / temperatures.length;

    // Median (nilai tengah)
    const sorted = [...temperatures].sort((a, b) => a - b);
    const median =
      sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];

    // Modus (nilai yang paling sering muncul)
    const frequency = {};
    temperatures.forEach((temp) => {
      const rounded = Math.round(temp * 10) / 10; // Pembulatan 1 desimal
      frequency[rounded] = (frequency[rounded] || 0) + 1;
    });

    const mode = Object.keys(frequency).reduce((a, b) =>
      frequency[a] > frequency[b] ? parseFloat(a) : parseFloat(b)
    );

    return {
      mean: Math.round(mean * 100) / 100,
      median: Math.round(median * 100) / 100,
      mode: parseFloat(mode),
      min: Math.min(...temperatures),
      max: Math.max(...temperatures),
      count: temperatures.length,
    };
  }

  // Schedule export harian yang lebih reliable
  scheduleDaily24HourExport() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0); // Set ke jam 00:00:00

    const timeUntilMidnight = tomorrow.getTime() - now.getTime();

    console.log(
      `⏰ Export harian dijadwalkan dalam ${Math.round(
        timeUntilMidnight / 1000 / 60
      )} menit`
    );

    setTimeout(() => {
      console.log("🌙 Memulai export harian (tengah malam)...");
      this.exportDailyData();

      // Set interval untuk export setiap 24 jam setelahnya
      this.exportInterval = setInterval(() => {
        console.log("🌙 Memulai export harian (tengah malam)...");
        this.exportDailyData();
      }, 24 * 60 * 60 * 1000); // 24 jam
    }, timeUntilMidnight);
  }

  // Export data harian ke CSV dan Excel
  async exportDailyData() {
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);

      const dateString = yesterday.toISOString().split("T")[0]; // Format: 2024-01-15

      console.log(`📤 Memulai export data untuk tanggal: ${dateString}`);

      // Ambil semua data agregasi kemarin yang belum diexport
      const aggregateData = await prisma.temperatureAggregate.findMany({
        where: {
          date: {
            gte: yesterday,
            lt: new Date(yesterday.getTime() + 24 * 60 * 60 * 1000),
          },
          isExported: false,
        },
        orderBy: { timeSlot: "asc" },
      });

      console.log(
        `📊 Ditemukan ${aggregateData.length} data agregasi untuk diexport`
      );

      if (aggregateData.length === 0) {
        await this.logSystem(
          "WARNING",
          `Tidak ada data untuk diexport pada tanggal ${dateString}`
        );
        console.log(
          `⚠️  Tidak ada data untuk diexport pada tanggal ${dateString}`
        );
        return;
      }

      // Buat direktori export jika belum ada
      const exportDir = path.join(process.cwd(), "exports");
      await fs.mkdir(exportDir, { recursive: true });

      // Export ke CSV
      const csvPath = await this.exportToCSV(
        aggregateData,
        dateString,
        exportDir
      );

      // Export ke Excel
      const excelPath = await this.exportToExcel(
        aggregateData,
        dateString,
        exportDir
      );

      // Hitung statistik harian
      const dailyStats = this.calculateDailyStats(aggregateData);

      // Simpan backup info ke database
      await prisma.dailyTemperatureBackup.create({
        data: {
          date: dateString,
          csvFilePath: csvPath,
          excelFilePath: excelPath,
          totalRecords: aggregateData.length,
          avgDailyTemp: dailyStats.avgTemp,
          minDailyTemp: dailyStats.minTemp,
          maxDailyTemp: dailyStats.maxTemp,
        },
      });

      // Tandai data sebagai sudah diexport
      const aggregateIds = aggregateData.map((item) => item.id);
      await prisma.temperatureAggregate.updateMany({
        where: {
          id: { in: aggregateIds },
        },
        data: { isExported: true },
      });

      await this.logSystem(
        "INFO",
        `Export berhasil untuk tanggal ${dateString}`,
        {
          csvPath,
          excelPath,
          totalRecords: aggregateData.length,
          dailyStats,
        }
      );

      console.log(
        `✅ Export berhasil: ${aggregateData.length} records untuk ${dateString}`
      );
      console.log(
        `📁 Files: ${path.basename(csvPath)}, ${path.basename(excelPath)}`
      );

      // Cleanup data agregasi yang sudah diexport setelah beberapa waktu
      setTimeout(() => {
        this.cleanupExportedAggregates();
      }, 10000);
    } catch (error) {
      console.error("❌ Error exporting daily data:", error);
      await this.logSystem("ERROR", "Gagal melakukan export harian", {
        error: error.message,
        stack: error.stack,
      });
    }
  }

  // Cleanup agregasi yang sudah diexport
  async cleanupExportedAggregates() {
    try {
      const result = await prisma.temperatureAggregate.deleteMany({
        where: { isExported: true },
      });

      if (result.count > 0) {
        console.log(
          `🧹 Cleanup: ${result.count} agregasi data telah dihapus setelah export`
        );
        await this.logSystem(
          "INFO",
          `Cleanup agregasi berhasil, ${result.count} data dihapus`
        );
      }
    } catch (error) {
      console.error("❌ Error cleaning up exported aggregates:", error);
    }
  }

  // Export ke CSV (tanpa perubahan)
  async exportToCSV(data, dateString, exportDir) {
    const csvPath = path.join(exportDir, `suhu_${dateString}.csv`);

    const csvHeader =
      "Tanggal,Slot_Waktu,Suhu_Rata,Suhu_Median,Suhu_Modus,Suhu_Min,Suhu_Max,Jumlah_Sample\n";
    const csvData = data
      .map(
        (row) =>
          `${dateString},${row.timeSlot},${row.meanTemp},${row.medianTemp},${row.modeTemp},${row.minTemp},${row.maxTemp},${row.sampleCount}`
      )
      .join("\n");

    await fs.writeFile(csvPath, csvHeader + csvData, "utf8");
    return csvPath;
  }

  // Export ke Excel (tanpa perubahan)
  async exportToExcel(data, dateString, exportDir) {
    const excelPath = path.join(exportDir, `suhu_${dateString}.xlsx`);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(`Data Suhu ${dateString}`);

    worksheet.columns = [
      { header: "Tanggal", key: "date", width: 12 },
      { header: "Slot Waktu", key: "timeSlot", width: 15 },
      { header: "Suhu Rata-rata", key: "meanTemp", width: 15 },
      { header: "Suhu Median", key: "medianTemp", width: 15 },
      { header: "Suhu Modus", key: "modeTemp", width: 15 },
      { header: "Suhu Minimum", key: "minTemp", width: 15 },
      { header: "Suhu Maksimum", key: "maxTemp", width: 15 },
      { header: "Jumlah Sample", key: "sampleCount", width: 15 },
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
      fgColor: { argb: "FFE6E6FA" },
    };

    await workbook.xlsx.writeFile(excelPath);
    return excelPath;
  }

  // Kalkulasi statistik harian (tanpa perubahan)
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

  // Method untuk debugging - melihat status sistem
  async getSystemStatus() {
    const bufferCount = await prisma.temperatureBuffer.count({
      where: { isProcessed: false },
    });
    const processedCount = await prisma.temperatureBuffer.count({
      where: { isProcessed: true },
    });
    const aggregateCount = await prisma.temperatureAggregate.count({
      where: { isExported: false },
    });

    return {
      inMemoryBuffer: this.bufferData.length,
      databaseBuffer: bufferCount,
      processedBuffer: processedCount,
      pendingAggregates: aggregateCount,
      lastSavedMinute: this.lastSavedMinute,
      lastProcessedSlot: this.lastProcessedSlot,
    };
  }

  // Method untuk testing manual
  async forceProcessBuffer() {
    console.log("🔧 Manual: Memproses buffer...");
    await this.processMinuteBuffer();
  }

  async forceProcessAggregate() {
    console.log("🔧 Manual: Memproses agregasi...");
    await this.processBufferToAggregate();
  }

  // Ambil data backup berdasarkan tanggal (tanpa perubahan)
  async getBackupDataByDate(date) {
    try {
      const backup = await prisma.dailyTemperatureBackup.findUnique({
        where: { date },
      });

      if (!backup) {
        return { error: "Data tidak ditemukan untuk tanggal tersebut" };
      }

      let csvData = null;
      if (backup.csvFilePath) {
        try {
          csvData = await fs.readFile(backup.csvFilePath, "utf8");
        } catch (error) {
          await this.logSystem(
            "WARNING",
            `File CSV tidak dapat dibaca: ${backup.csvFilePath}`
          );
        }
      }

      return { ...backup, csvData };
    } catch (error) {
      await this.logSystem("ERROR", "Gagal mengambil data backup", {
        date,
        error: error.message,
      });
      throw error;
    }
  }

  // Log sistem (tanpa perubahan)
  async logSystem(level, message, metadata = null) {
    try {
      await prisma.systemLog.create({
        data: {
          level,
          message,
          metadata: metadata ? JSON.stringify(metadata) : null,
        },
      });
    } catch (error) {
      console.error("❌ Gagal menyimpan log sistem:", error);
    }
  }

  // Cleanup - tutup koneksi
  async cleanup() {
    console.log("🔄 Membersihkan resources...");

    if (this.bufferInterval) {
      clearInterval(this.bufferInterval);
    }
    if (this.aggregateInterval) {
      clearInterval(this.aggregateInterval);
    }
    if (this.exportInterval) {
      clearInterval(this.exportInterval);
    }

    await prisma.$disconnect();
    console.log("✅ Cleanup selesai");
  }
}

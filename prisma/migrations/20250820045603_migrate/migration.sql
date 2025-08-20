/*
  Warnings:

  - You are about to drop the `Device` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TemperatureLog` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Device";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "TemperatureLog";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "buffer_suhu" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "suhu" REAL NOT NULL,
    "waktu_catat" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sudah_diproses" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "agregasi_suhu" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tanggal" DATETIME NOT NULL,
    "slot_waktu" TEXT NOT NULL,
    "suhu_rata" REAL NOT NULL,
    "suhu_median" REAL NOT NULL,
    "suhu_modus" REAL NOT NULL,
    "suhu_minimum" REAL NOT NULL,
    "suhu_maksimum" REAL NOT NULL,
    "jumlah_sample" INTEGER NOT NULL,
    "dibuat_pada" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sudah_dieksport" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "backup_harian" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tanggal" TEXT NOT NULL,
    "file_csv" TEXT,
    "file_excel" TEXT,
    "total_record" INTEGER NOT NULL,
    "rata_suhu_harian" REAL NOT NULL,
    "min_suhu_harian" REAL NOT NULL,
    "max_suhu_harian" REAL NOT NULL,
    "dieksport_pada" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "log_sistem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tingkat" TEXT NOT NULL,
    "pesan" TEXT NOT NULL,
    "data_tambahan" TEXT,
    "waktu" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "User" (
    "user_id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "agregasi_suhu_tanggal_slot_waktu_key" ON "agregasi_suhu"("tanggal", "slot_waktu");

-- CreateIndex
CREATE UNIQUE INDEX "backup_harian_tanggal_key" ON "backup_harian"("tanggal");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

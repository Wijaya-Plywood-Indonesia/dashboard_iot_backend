-- CreateTable
CREATE TABLE "Device" (
    "device_id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "device_name" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "create_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TemperatureLog" (
    "log_id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "device_id" INTEGER NOT NULL,
    "temperatur" REAL NOT NULL,
    "recorded_at" DATETIME NOT NULL,
    "create_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TemperatureLog_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "Device" ("device_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

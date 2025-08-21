import mqtt from "mqtt";

export class MQTTService {
  constructor(temperatureService, socketIO = null) {
    this.temperatureService = temperatureService;
    this.io = socketIO;
    this.client = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.lastTemperature = 0;
    this.lastDataTime = null;
    this.saveQueue = []; // Queue untuk batch saving
    this.isProcessingQueue = false;

    this.config = {
      brokerUrl: process.env.MQTT_BROKER_URL || "mqtt://broker.hivemq.com:1883",
      topic: process.env.MQTT_TOPIC || "esp32/suhu",
      keepAlive: 60,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
    };

    console.log(
      `🔧 MQTT Service initialized with broker: ${this.config.brokerUrl}`
    );
    this.connect();

    // Start queue processor
    this.startQueueProcessor();
  }

  setSocketIO(io) {
    this.io = io;
    console.log("✅ Socket.IO instance set for MQTT Service");
  }

  connect() {
    try {
      console.log(`🔌 Connecting to MQTT broker: ${this.config.brokerUrl}`);

      this.client = mqtt.connect(this.config.brokerUrl, {
        keepalive: this.config.keepAlive,
        reconnectPeriod: this.config.reconnectPeriod,
        connectTimeout: this.config.connectTimeout,
        clean: true,
      });

      this.setupEventHandlers();
    } catch (error) {
      console.error("❌ MQTT connection failed:", error);
      this.scheduleReconnect();
    }
  }

  setupEventHandlers() {
    this.client.on("connect", () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      console.log("✅ MQTT connected successfully");

      if (this.io) {
        this.io.emit("mqttStatus", {
          status: "connected",
          topic: this.config.topic,
          brokerUrl: this.config.brokerUrl,
        });
      }

      this.subscribe();
    });

    this.client.on("message", async (topic, message) => {
      try {
        const temperature = parseFloat(message.toString().trim());

        if (isNaN(temperature) || temperature < -50 || temperature > 150) {
          console.warn(`⚠️ Invalid temperature data: ${temperature}°C`);
          return;
        }

        this.lastTemperature = temperature;
        this.lastDataTime = new Date();
        console.log(`🌡️ MQTT received: ${temperature}°C from topic ${topic}`);

        // Add to queue instead of immediate save
        this.addToSaveQueue(temperature);

        // Continue with other processing
        await this.processTemperatureData(temperature);
      } catch (error) {
        console.error("❌ Error processing MQTT message:", error.message);
        this.emitError(error);
      }
    });

    this.client.on("error", (error) => {
      console.error("❌ MQTT client error:", error.message);
      this.isConnected = false;
      this.emitStatus("disconnected", error.message);
    });

    this.client.on("close", () => {
      console.warn("⚠️ MQTT connection closed");
      this.isConnected = false;
      this.emitStatus("disconnected");
      this.scheduleReconnect();
    });

    this.client.on("offline", () => {
      console.warn("⚠️ MQTT client offline");
      this.isConnected = false;
      this.emitStatus("offline");
    });

    this.client.on("reconnect", () => {
      this.reconnectAttempts++;
      console.log(
        `🔄 MQTT reconnecting... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
      );
      this.emitStatus("reconnecting", null, this.reconnectAttempts);
    });
  }

  // PERBAIKAN: Queue-based saving system (tambahkan pengecekan duplikasi sederhana)
  addToSaveQueue(temperature) {
    const timestamp = new Date();
    const temperatureData = {
      temperature,
      timestamp,
    };

    // PERBAIKAN: Cek duplikasi berdasarkan timestamp (opsional, jika diperlukan)
    const lastEntry = this.saveQueue[this.saveQueue.length - 1];
    if (
      lastEntry &&
      Math.abs(timestamp - lastEntry.timestamp) < 1000 && // Dalam 1 detik
      lastEntry.temperature === temperature
    ) {
      console.warn(
        `⚠️ Duplicate temperature data detected: ${temperature}°C at ${timestamp.toISOString()}`
      );
      return; // Skip data duplikat
    }

    console.log(
      "⚠️ Field ekstra (dryerId, humidity, dll.) diabaikan karena tidak match model TemperatureBuffer"
    );

    this.saveQueue.push(temperatureData);

    // Limit queue size to prevent memory issues
    if (this.saveQueue.length > 100) {
      this.saveQueue.shift(); // Remove oldest entry
      console.warn("⚠️ Save queue is full, removing oldest entry");
    }
  }

  // PERBAIKAN: Batch processor for database saves
  async startQueueProcessor() {
    setInterval(async () => {
      if (this.isProcessingQueue || this.saveQueue.length === 0) {
        return;
      }

      this.isProcessingQueue = true;

      try {
        // Process up to 10 items at once
        const batch = this.saveQueue.splice(0, 10);
        await this.processBatch(batch);
      } catch (error) {
        console.error("❌ Batch processing failed:", error.message);
      } finally {
        this.isProcessingQueue = false;
      }
    }, 2000); // Process every 2 seconds
  }

  // PERBAIKAN: Optimized batch database save tanpa skipDuplicates
  async processBatch(batch) {
    if (batch.length === 0) return;

    try {
      // Dynamic import with better error handling
      const { db } = await import("../lib/database.mjs");

      if (!db) {
        throw new Error("Database module not available");
      }

      console.log(
        `📝 Processing batch of ${batch.length} temperature readings...`
      );

      // Use batch insert for better performance, tapi cek model dulu
      const saved = await db.withRetry(async (prismaClient) => {
        // Validate client and method
        if (!prismaClient) {
          throw new Error("Prisma client is null");
        }

        if (!prismaClient.temperatureBuffer) {
          console.warn(
            "⚠️ Model temperatureBuffer not found, skipping save. Run 'npx prisma generate'."
          );
          this.emitError(new Error("Model not found - check Prisma schema"));
          return { count: 0 }; // Skip tanpa error fatal
        }

        if (typeof prismaClient.temperatureBuffer.createMany !== "function") {
          throw new Error("temperatureBuffer.createMany method not available");
        }

        // Format data untuk batch insert (hanya field yang ada di TemperatureBuffer)
        const formattedData = batch.map((item) => ({
          temperature: item.temperature,
          timestamp: item.timestamp,
          // isProcessed default false
        }));

        // PERBAIKAN: Hapus skipDuplicates karena tidak didukung di SQLite
        return await prismaClient.temperatureBuffer.createMany({
          data: formattedData,
        });
      });

      console.log(`✅ Batch saved: ${saved.count} temperature readings`);
      return saved;
    } catch (error) {
      console.error("❌ Batch save failed:", error.message);

      // More detailed error analysis
      if (error.message.includes("temperatureBuffer")) {
        console.error("💡 Database schema issue detected");
        console.error("💡 Run: npx prisma db push && npx prisma generate");
      } else if (error.message.includes("connection")) {
        console.error("💡 Database connection issue");
        console.error("💡 Check if database server is running");
      } else if (error.message.includes("skipDuplicates")) {
        console.error("💡 SQLite does not support skipDuplicates option");
      }

      // Fallback to individual saves if batch fails
      console.log("🔄 Attempting individual saves as fallback...");
      for (const item of batch) {
        try {
          await this.saveIndividual(item);
        } catch (individualError) {
          console.error(
            `❌ Individual save failed for temp ${item.temperature}:`,
            individualError.message
          );
        }
      }
    }
  }

  // PERBAIKAN: Fallback individual save method
  async saveIndividual(temperatureData) {
    try {
      const { db } = await import("../lib/database.mjs");

      const saved = await db.withRetry(async (prismaClient) => {
        if (!prismaClient?.temperatureBuffer?.create) {
          console.warn(
            "⚠️ Model temperatureBuffer not found for individual save. Skipping."
          );
          return null; // Skip tanpa throw
        }

        return await prismaClient.temperatureBuffer.create({
          data: {
            temperature: temperatureData.temperature,
            timestamp: temperatureData.timestamp,
            // isProcessed default false
          },
        });
      });

      if (saved) {
        console.log(
          `✅ Individual save: ID ${saved.id}, Temp ${temperatureData.temperature}°C`
        );
      }
      return saved;
    } catch (error) {
      console.error("❌ Individual save failed:", error.message);
      throw error;
    }
  }

  // Separate temperature processing
  async processTemperatureData(temperature) {
    try {
      if (this.temperatureService) {
        const result = await this.temperatureService.receiveTemperatureData(
          temperature
        );

        if (result?.success) {
          console.log(
            `📊 Buffer size: ${result.bufferSize}/${
              this.temperatureService.config?.maxBufferSize || "N/A"
            }`
          );
        }

        this.emitTemperatureData(temperature, "connected", result?.bufferSize);
      } else {
        console.warn("⚠️ Temperature service not available");
        this.emitTemperatureData(temperature, "no_service");
      }
    } catch (error) {
      console.error("❌ Temperature service error:", error.message);
      this.emitTemperatureData(temperature, "service_error", 0, error.message);
    }
  }

  // Helper methods for Socket.IO emissions
  emitTemperatureData(temperature, status, bufferSize = 0, error = null) {
    if (!this.io) return;

    const data = {
      temperature,
      timestamp: new Date().toISOString(),
      status,
      bufferSize,
    };

    if (error) {
      data.error = error;
    }

    this.io.emit("suhu", data);
    this.io.emit("temperatureData", {
      value: temperature,
      time: Date.now(),
      bufferSize,
    });
  }

  emitStatus(status, error = null, attempt = null) {
    if (!this.io) return;

    const statusData = { status };
    if (error) statusData.error = error;
    if (attempt) statusData.attempt = attempt;
    if (status === "connected") {
      statusData.topic = this.config.topic;
      statusData.brokerUrl = this.config.brokerUrl;
    }

    this.io.emit("mqttStatus", statusData);
  }

  emitError(error) {
    if (!this.io) return;

    this.io.emit("suhu", {
      temperature: this.lastTemperature,
      timestamp: new Date().toISOString(),
      status: "error",
      error: error.message,
    });
  }

  determineStatus(temperature) {
    if (temperature < 20) return "low";
    if (temperature > 80) return "critical";
    if (temperature > 70) return "warning";
    return "normal";
  }

  subscribe() {
    this.client.subscribe(this.config.topic, (error) => {
      if (error) {
        console.error(
          `❌ MQTT subscription failed for topic ${this.config.topic}:`,
          error
        );
        this.emitStatus("subscription_failed", error.message);
      } else {
        console.log(`✅ MQTT subscribed to topic: ${this.config.topic}`);
        this.emitStatus("subscribed");
      }
    });
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(
        `❌ MQTT max reconnection attempts (${this.maxReconnectAttempts}) reached`
      );
      this.emitStatus("max_retries_reached");
      return;
    }

    setTimeout(() => {
      if (!this.isConnected && this.client) {
        console.log("🔄 Attempting MQTT reconnection...");
        this.connect();
      }
    }, this.config.reconnectPeriod);
  }

  getStatus() {
    return {
      connected: this.isConnected,
      brokerUrl: this.config.brokerUrl,
      topic: this.config.topic,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      clientState: this.client?.connected || false,
      lastTemperature: this.lastTemperature,
      lastDataTime: this.lastDataTime,
      queueSize: this.saveQueue.length,
      isProcessingQueue: this.isProcessingQueue,
      config: this.config,
      timestamp: new Date().toISOString(),
    };
  }

  getLastTemperature() {
    return this.lastTemperature;
  }

  hasRecentData() {
    if (!this.lastDataTime) return false;
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    return this.lastDataTime > fiveMinutesAgo;
  }

  publish(topic, message) {
    if (this.client && this.isConnected) {
      this.client.publish(topic, message);
      console.log(`📤 Published to ${topic}: ${message}`);
      return true;
    } else {
      console.warn("⚠️ Cannot publish: MQTT not connected");
      return false;
    }
  }

  forceReconnect() {
    console.log("🔄 Force reconnecting MQTT...");
    this.reconnectAttempts = 0;
    this.disconnect();
    setTimeout(() => this.connect(), 1000);
  }

  async disconnect() {
    if (this.client) {
      console.log("🔌 Disconnecting MQTT client...");

      try {
        // Process remaining queue before disconnect
        if (this.saveQueue.length > 0) {
          console.log(
            `🔄 Processing ${this.saveQueue.length} remaining items before disconnect...`
          );
          await this.processBatch(this.saveQueue.splice(0));
        }

        this.client.end(true);
        this.isConnected = false;
        console.log("✅ MQTT disconnected gracefully");
        this.emitStatus("disconnected");
      } catch (error) {
        console.error("❌ Error disconnecting MQTT:", error);
      }
    }
  }
}

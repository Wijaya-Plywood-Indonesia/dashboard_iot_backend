import mqtt from "mqtt";

export class MQTTService {
  constructor(temperatureService, socketIO = null) {
    this.temperatureService = temperatureService;
    this.io = socketIO; // Socket.IO instance untuk real-time updates
    this.client = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.lastTemperature = 0;

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
  }

  // Set Socket.IO instance after initialization
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

      // Emit status via Socket.IO
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
        console.log(`🌡️ MQTT received: ${temperature}°C from topic ${topic}`);

        // PERBAIKAN: Check if temperatureService exists before calling
        if (this.temperatureService) {
          try {
            const result = await this.temperatureService.receiveTemperatureData(
              temperature
            );

            if (result && result.success) {
              console.log(
                `📊 Buffer size: ${result.bufferSize}/${
                  this.temperatureService.config?.maxBufferSize || "N/A"
                }`
              );
            }

            // Broadcast via Socket.IO
            if (this.io) {
              this.io.emit("suhu", {
                temperature: temperature,
                timestamp: new Date().toISOString(),
                status: "connected",
                bufferSize: result?.bufferSize || 0,
              });

              this.io.emit("temperatureData", {
                value: temperature,
                time: Date.now(),
                bufferSize: result?.bufferSize || 0,
              });
            }
          } catch (tempServiceError) {
            console.error(
              "❌ Temperature service error:",
              tempServiceError.message
            );

            // Still broadcast the temperature even if service fails
            if (this.io) {
              this.io.emit("suhu", {
                temperature: temperature,
                timestamp: new Date().toISOString(),
                status: "service_error",
                error: tempServiceError.message,
              });
            }
          }
        } else {
          console.warn("⚠️ Temperature service not available");

          // Still broadcast the temperature
          if (this.io) {
            this.io.emit("suhu", {
              temperature: temperature,
              timestamp: new Date().toISOString(),
              status: "no_service",
            });
          }
        }
      } catch (error) {
        console.error("❌ Error processing MQTT message:", error.message);

        if (this.io) {
          this.io.emit("suhu", {
            temperature: this.lastTemperature,
            timestamp: new Date().toISOString(),
            status: "error",
            error: error.message,
          });
        }
      }
    });

    this.client.on("error", (error) => {
      console.error("❌ MQTT client error:", error.message);
      this.isConnected = false;

      if (this.io) {
        this.io.emit("mqttStatus", {
          status: "disconnected",
          error: error.message,
        });
      }
    });

    this.client.on("close", () => {
      console.warn("⚠️ MQTT connection closed");
      this.isConnected = false;

      if (this.io) {
        this.io.emit("mqttStatus", { status: "disconnected" });
      }

      this.scheduleReconnect();
    });

    this.client.on("offline", () => {
      console.warn("⚠️ MQTT client offline");
      this.isConnected = false;

      if (this.io) {
        this.io.emit("mqttStatus", { status: "offline" });
      }
    });

    this.client.on("reconnect", () => {
      this.reconnectAttempts++;
      console.log(
        `🔄 MQTT reconnecting... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
      );

      if (this.io) {
        this.io.emit("mqttStatus", {
          status: "reconnecting",
          attempt: this.reconnectAttempts,
        });
      }
    });
  }

  subscribe() {
    this.client.subscribe(this.config.topic, (error) => {
      if (error) {
        console.error(
          `❌ MQTT subscription failed for topic ${this.config.topic}:`,
          error
        );

        if (this.io) {
          this.io.emit("mqttStatus", {
            status: "subscription_failed",
            error: error.message,
          });
        }
      } else {
        console.log(`✅ MQTT subscribed to topic: ${this.config.topic}`);

        if (this.io) {
          this.io.emit("mqttStatus", {
            status: "subscribed",
            topic: this.config.topic,
          });
        }
      }
    });
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(
        `❌ MQTT max reconnection attempts (${this.maxReconnectAttempts}) reached`
      );

      if (this.io) {
        this.io.emit("mqttStatus", {
          status: "max_retries_reached",
          maxAttempts: this.maxReconnectAttempts,
        });
      }
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
      config: this.config,
      timestamp: new Date().toISOString(),
    };
  }

  getLastTemperature() {
    return this.lastTemperature;
  }

  // Publish message (untuk testing atau control)
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

  // Force reconnect
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
        this.client.end(true); // Force close
        this.isConnected = false;
        console.log("✅ MQTT disconnected gracefully");

        if (this.io) {
          this.io.emit("mqttStatus", { status: "disconnected" });
        }
      } catch (error) {
        console.error("❌ Error disconnecting MQTT:", error);
      }
    }
  }
}

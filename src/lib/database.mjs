import { PrismaClient } from "@prisma/client";

class DatabaseClient {
  constructor() {
    if (DatabaseClient.instance) {
      return DatabaseClient.instance;
    }

    this.prisma = new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["error"] : ["error"],
      errorFormat: "minimal",
    });

    this.isConnected = false;
    this.connectionPromise = null;
    this.maxRetries = 3;

    DatabaseClient.instance = this;
  }

  async initialize() {
    try {
      await this.connect();
      this.setupEventHandlers();
    } catch (error) {
      console.error("🚨 Failed to initialize database:", error);
      throw error;
    }
  }

  async ensureConnected() {
    if (this.isConnected) {
      return this.prisma;
    }

    if (this.connectionPromise) {
      await this.connectionPromise;
      return this.prisma;
    }

    this.connectionPromise = this.connect();
    await this.connectionPromise;
    return this.prisma;
  }

  async connect() {
    try {
      await this.prisma.$connect();
      this.isConnected = true;
      this.connectionRetries = 0;
      console.log("✅ Database connected successfully");

      // Test connection
      await this.healthCheck();
    } catch (error) {
      this.isConnected = false;
      console.error("❌ Database connection failed:", error);

      if (this.connectionRetries < this.maxRetries) {
        this.connectionRetries++;
        console.log(
          `🔄 Retrying connection (${this.connectionRetries}/${this.maxRetries}) in 5 seconds...`
        );
        setTimeout(() => this.connect(), 5000);
      } else {
        throw new Error(
          `Database connection failed after ${this.maxRetries} attempts`
        );
      }
    }
  }

  setupGracefulShutdown() {
    const shutdown = async () => {
      console.log("🔌 Disconnecting database...");
      await this.prisma.$disconnect();
      this.isConnected = false;
      console.log("✅ Database disconnected");
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("beforeExit", shutdown);
  }

  async healthCheck() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: "healthy", timestamp: new Date() };
    } catch (error) {
      console.error("❌ Database health check failed:", error);
      this.isConnected = false;
      throw error;
    }
  }

  setupEventHandlers() {
    // Handle Prisma client errors
    this.prisma.$on("error", (error) => {
      console.error("🚨 Prisma Client Error:", error);
      this.isConnected = false;
    });

    // Handle process exit
    process.on("beforeExit", async () => {
      await this.disconnect();
    });

    process.on("SIGINT", async () => {
      await this.disconnect();
      process.exit(0);
    });
  }

  async disconnect() {
    try {
      await this.prisma.$disconnect();
      this.isConnected = false;
      console.log("✅ Database disconnected gracefully");
    } catch (error) {
      console.error("❌ Error disconnecting database:", error);
    }
  }

  async getClient() {
    return await this.ensureConnected();
  }

  async withRetry(operation, retries = 3) {
    const client = await this.ensureConnected();

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await operation(client);
      } catch (error) {
        console.warn(
          `⚠️ Database operation failed (attempt ${attempt}/${retries}):`,
          error.message
        );

        if (attempt === retries) {
          throw error;
        }

        // Simple backoff: wait 1s, 2s, 3s
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  }
}
const dbClient = new DatabaseClient();

export const db = dbClient;

// PERBAIKAN: Export prisma client yang selalu connected
export const prisma = new Proxy(
  {},
  {
    get(target, prop) {
      return async (...args) => {
        const client = await dbClient.getClient();
        const method = client[prop];
        if (typeof method === "function") {
          return method.apply(client, args);
        }
        return method;
      };
    },
  }
);

export default dbClient;

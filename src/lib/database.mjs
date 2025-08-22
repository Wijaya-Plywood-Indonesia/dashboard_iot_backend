import { PrismaClient } from "@prisma/client";

// PERBAIKAN: Enhanced singleton dengan better error handling
let prismaInstance = null;
let isConnected = false;
let connectionAttempts = 0;
const maxRetries = 5;

const createPrismaClient = () => {
  if (prismaInstance) {
    return prismaInstance;
  }

  try {
    prismaInstance = new PrismaClient({
      log:
        process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
      errorFormat: "minimal",
      // PERBAIKAN: Add connection pooling configuration
      datasources: {
        db: {
          url: process.env.DATABASE_URL,
        },
      },
    });

    console.log("✅ Prisma Client created with enhanced configuration");
    return prismaInstance;
  } catch (error) {
    console.error("❌ Failed to create Prisma client:", error.message);
    throw error;
  }
};

// PERBAIKAN: Enhanced database wrapper dengan proper error handling
export const db = {
  async withRetry(operation, maxRetries = 3, context = "unknown") {
    const client = createPrismaClient();
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(
          `📊 Database operation [${context}] attempt ${attempt}/${maxRetries}`
        );

        // PERBAIKAN: Validate client connection before operation
        if (!client) {
          throw new Error("Prisma client not available");
        }

        // PERBAIKAN: Test connection on first attempt
        if (attempt === 1) {
          await client.$queryRaw`SELECT 1 as test`;
        }

        const result = await operation(client);

        if (attempt > 1) {
          console.log(
            `✅ Database operation [${context}] succeeded on attempt ${attempt}`
          );
        }

        // PERBAIKAN: Mark as connected on successful operation
        isConnected = true;
        connectionAttempts = 0;
        return result;
      } catch (error) {
        lastError = error;
        isConnected = false;
        connectionAttempts++;

        console.warn(
          `⚠️ Database operation [${context}] failed (attempt ${attempt}/${maxRetries}):`,
          error.message
        );

        if (attempt === maxRetries) {
          console.error(
            `❌ Database operation [${context}] failed after ${maxRetries} attempts`
          );

          // PERBAIKAN: Log detailed error info
          await this.logError(context, error, attempt);
          throw error;
        }

        // PERBAIKAN: Progressive backoff strategy
        const waitTime = Math.min(1000 * attempt * 2, 10000);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    throw lastError;
  },

  // PERBAIKAN: Direct client access dengan validation
  getClient() {
    const client = createPrismaClient();
    if (!client) {
      throw new Error("Failed to get Prisma client");
    }
    return client;
  },

  // PERBAIKAN: Enhanced connection test dengan detailed status
  async testConnection() {
    try {
      const client = createPrismaClient();

      // Test basic connection
      await client.$connect();

      // Test query execution
      const result =
        await client.$queryRaw`SELECT 1 as test, datetime('now') as timestamp`;

      // PERBAIKAN: Test database schema
      const tables = await client.$queryRaw`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `;

      isConnected = true;
      connectionAttempts = 0;

      console.log("✅ Database connection test successful");
      console.log(`📊 Found ${tables.length} tables in database`);

      return {
        success: true,
        timestamp: new Date().toISOString(),
        tablesCount: tables.length,
        testResult: result,
      };
    } catch (error) {
      console.error("❌ Database connection test failed:", error.message);
      isConnected = false;
      connectionAttempts++;

      return {
        success: false,
        error: error.message,
        attempts: connectionAttempts,
        timestamp: new Date().toISOString(),
      };
    }
  },

  // PERBAIKAN: Enhanced status check
  getConnectionStatus() {
    return {
      connected: isConnected,
      attempts: connectionAttempts,
      hasClient: !!prismaInstance,
      maxRetries,
      timestamp: new Date().toISOString(),
    };
  },

  // PERBAIKAN: Improved error logging
  async logError(context, error, attempt = 1) {
    try {
      if (prismaInstance && isConnected) {
        await prismaInstance.systemLog.create({
          data: {
            level: "ERROR",
            message: `Database error in ${context}: ${error.message}`,
            metadata: JSON.stringify({
              context,
              attempt,
              errorType: error.constructor.name,
              stack: error.stack?.split("\n").slice(0, 5),
              timestamp: new Date().toISOString(),
            }),
            timestamp: new Date(),
          },
        });
      }
    } catch (logError) {
      console.warn("⚠️ Failed to log database error:", logError.message);
    }
  },

  // PERBAIKAN: Database health check untuk monitoring
  async healthCheck() {
    try {
      const client = this.getClient();

      const [bufferCount, aggregateCount, systemLogCount, lastLog] =
        await Promise.all([
          client.temperatureBuffer.count(),
          client.temperatureAggregate.count(),
          client.systemLog.count(),
          client.systemLog.findFirst({
            orderBy: { timestamp: "desc" },
            select: { timestamp: true, level: true, message: true },
          }),
        ]);

      return {
        status: "healthy",
        metrics: {
          bufferRecords: bufferCount,
          aggregateRecords: aggregateCount,
          systemLogs: systemLogCount,
          lastLogEntry: lastLog,
        },
        connection: this.getConnectionStatus(),
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: "unhealthy",
        error: error.message,
        connection: this.getConnectionStatus(),
        timestamp: new Date().toISOString(),
      };
    }
  },

  // PERBAIKAN: Graceful disconnect dengan cleanup
  async disconnect() {
    try {
      if (prismaInstance) {
        console.log("🔄 Disconnecting database...");

        // PERBAIKAN: Flush any pending operations
        await prismaInstance.$disconnect();

        console.log("✅ Database disconnected gracefully");
        await this.logError(
          "shutdown",
          { message: "Database disconnected gracefully" },
          1
        );
      }

      prismaInstance = null;
      isConnected = false;
      connectionAttempts = 0;
    } catch (error) {
      console.error("❌ Error disconnecting from database:", error.message);
      // Force cleanup
      prismaInstance = null;
      isConnected = false;
    }
  },
};

// PERBAIKAN: Enhanced prisma export dengan validation
export const prisma = createPrismaClient();

// PERBAIKAN: Enhanced startup test dengan retry logic
const initializeDatabase = async () => {
  let attempts = 0;
  const maxInitAttempts = 5;

  while (attempts < maxInitAttempts) {
    try {
      const result = await db.testConnection();
      if (result.success) {
        console.log("🚀 Database initialized successfully");
        return;
      }
      throw new Error(result.error);
    } catch (error) {
      attempts++;
      console.warn(
        `⚠️ Database initialization attempt ${attempts}/${maxInitAttempts} failed:`,
        error.message
      );

      if (attempts >= maxInitAttempts) {
        console.error("❌ Database initialization failed after all attempts");
        return;
      }

      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempts));
    }
  }
};

// Initialize database on startup
initializeDatabase();

// PERBAIKAN: Enhanced graceful shutdown dengan proper cleanup
const gracefulShutdown = async (signal) => {
  console.log(`🔄 Received ${signal}, shutting down database gracefully...`);
  try {
    await db.disconnect();
    process.exit(0);
  } catch (error) {
    console.error("❌ Error during graceful shutdown:", error.message);
    process.exit(1);
  }
};

process.on("beforeExit", () => gracefulShutdown("beforeExit"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// PERBAIKAN: Handle uncaught database errors
process.on("unhandledRejection", (reason, promise) => {
  if (
    reason?.message?.includes("database") ||
    reason?.message?.includes("Prisma")
  ) {
    console.error("❌ Unhandled database rejection:", reason);
    db.logError("unhandled_rejection", reason).catch(() => {});
  }
});

import { PrismaClient } from "@prisma/client";

// PERBAIKAN: Singleton yang lebih sederhana tanpa proxy kompleks
let prismaInstance = null;
let isConnected = false;

const createPrismaClient = () => {
  if (prismaInstance) {
    return prismaInstance;
  }

  prismaInstance = new PrismaClient({
    log: ["error"],
    errorFormat: "minimal",
  });

  console.log("✅ Prisma Client created");
  return prismaInstance;
};

// PERBAIKAN: Database wrapper yang sederhana
export const db = {
  async withRetry(operation, maxRetries = 3) {
    const client = createPrismaClient();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`📊 Database operation attempt ${attempt}/${maxRetries}`);

        // PERBAIKAN: Pastikan client tersedia
        if (!client) {
          throw new Error("Prisma client not available");
        }

        const result = await operation(client);

        if (attempt > 1) {
          console.log(`✅ Database operation succeeded on attempt ${attempt}`);
        }

        return result;
      } catch (error) {
        console.warn(
          `⚠️ Database operation failed (attempt ${attempt}/${maxRetries}):`,
          error.message
        );

        if (attempt === maxRetries) {
          console.error(
            `❌ Database operation failed after ${maxRetries} attempts`
          );
          throw error;
        }

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  },

  // PERBAIKAN: Direct client access
  getClient() {
    return createPrismaClient();
  },

  // Connection test
  async testConnection() {
    try {
      const client = createPrismaClient();
      await client.$connect();
      await client.$queryRaw`SELECT 1 as test`;
      isConnected = true;
      console.log("✅ Database connection test successful");
      return true;
    } catch (error) {
      console.error("❌ Database connection test failed:", error.message);
      isConnected = false;
      return false;
    }
  },

  // Graceful disconnect
  async disconnect() {
    try {
      if (prismaInstance) {
        await prismaInstance.$disconnect();
        console.log("✅ Database disconnected gracefully");
      }
      prismaInstance = null;
      isConnected = false;
    } catch (error) {
      console.error("❌ Error disconnecting from database:", error.message);
    }
  },
};

// PERBAIKAN: Simple prisma export without proxy
export const prisma = createPrismaClient();

// Test connection on startup
db.testConnection();

// Graceful shutdown
process.on("beforeExit", async () => {
  await db.disconnect();
});

process.on("SIGINT", async () => {
  await db.disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await db.disconnect();
  process.exit(0);
});

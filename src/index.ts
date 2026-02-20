import { createBot } from "./bot/commands.js";
import { initializeOpenCodeClientsWithAutoStart, getOpenCodeClient, cleanupSpawnedProcesses } from "./opencode/client.js";
import { SessionManager } from "./services/session-manager.js";
import { MessageService } from "./services/message-service.js";
import { RedisStorage } from "./storage/redis.js";
import { MemoryStorage } from "./storage/memory.js";
import { logger } from "./utils/logger.js";
import { config } from "./config/index.js";

async function main() {
  logger.info("🚀 Starting OpenCode Telegram Bot...");

  let storage: RedisStorage | MemoryStorage;
  try {
    storage = new RedisStorage();
    await storage.get("test");
    logger.info("✅ Connected to Redis");
  } catch (error) {
    logger.warn("⚠️ Redis not available, using in-memory storage");
    storage = new MemoryStorage();
  }

  await initializeOpenCodeClientsWithAutoStart(config.opencode.instances);
  logger.info(`✅ Initialized ${config.opencode.instances.length} OpenCode instance(s)`);

  const sessionManager = new SessionManager(storage);

  const messageService = new MessageService(
    null as never,
    storage,
    sessionManager
  );

  const { bot, setEventHandler } = createBot(
    storage,
    sessionManager,
    (userId, text) => messageService.handleIncomingMessage(userId, text)
  );

  messageService.setBot(bot);

  setEventHandler((event, instanceId) => {
    messageService.routeEventToUser({ ...event, instanceId });
  });

  bot.command("stop", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const state = await sessionManager.getOrCreateUserState(userId, 0);
    if (!state.currentSessionId || !state.currentInstanceId) {
      await ctx.reply("📭 No active session to stop.");
      return;
    }
    try {
      const client = getOpenCodeClient(state.currentInstanceId);
      const success = await client.abortSession(state.currentSessionId);
      await ctx.reply(success ? "✅ Session stopped." : "❌ Failed to stop session.");
    } catch (error) {
      await ctx.reply(`❌ Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  bot.catch((err) => {
    logger.error("Bot error:", err);
  });

  const unsubscribers: Array<() => void> = [];

  for (const instance of config.opencode.instances) {
    try {
      const client = getOpenCodeClient(instance.id);
      const unsubscribe = await client.subscribeToEvents((event) => {
        const eventWithInstance = { ...event, instanceId: instance.id };
        messageService.routeEventToUser(eventWithInstance);
      });
      unsubscribers.push(unsubscribe);
      logger.info(`✅ Subscribed to events from instance: ${instance.id}`);
    } catch (error) {
      logger.error(`Failed to subscribe to instance ${instance.id}:`, error);
    }
  }

  setInterval(async () => {
    try {
      await sessionManager.cleanupOldSessions();
    } catch (error) {
      logger.error("Error cleaning up sessions:", error);
    }
  }, 60000);

  const cleanup = async () => {
    logger.info("🛑 Shutting down...");
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    cleanupSpawnedProcesses();
    await bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    logger.info("📡 Starting long polling...");
    await bot.start({
      drop_pending_updates: true,
      onStart: () => {
        logger.info("✅ Bot started successfully!");
      },
    });
  } catch (error) {
    logger.error("Failed to start bot:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error("Fatal error:", error);
  process.exit(1);
});

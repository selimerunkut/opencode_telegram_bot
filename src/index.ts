import { createBot } from "./bot/commands.js";
import { initializeOpenCodeClients, getOpenCodeClient } from "./opencode/client.js";
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

  initializeOpenCodeClients(config.opencode.instances);
  logger.info(`✅ Initialized ${config.opencode.instances.length} OpenCode instance(s)`);

  const sessionManager = new SessionManager(storage);
  const { bot, getPendingAction } = createBot(storage, sessionManager);
  const messageService = new MessageService(bot, storage, sessionManager);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const pendingAction = getPendingAction(userId);
    if (pendingAction) {
      try {
        switch (pendingAction.action) {
          case "create": {
            const session = await sessionManager.createSession(userId, pendingAction.title, pendingAction.instanceId);
            await ctx.reply(`✅ Session created: "${session.title}"\nID: \`${session.id}\``, {
              parse_mode: "MarkdownV2",
            });
            break;
          }
          case "message": {
            if (pendingAction.text) {
              await messageService.handleIncomingMessage(userId, pendingAction.text);
            }
            break;
          }
          case "stop": {
            if (pendingAction.sessionId) {
              const state = await sessionManager.getOrCreateUserState(userId, 0);
              if (state.currentInstanceId) {
                const client = getOpenCodeClient(state.currentInstanceId);
                const success = await client.abortSession(pendingAction.sessionId);
                if (success) {
                  await ctx.reply("✅ Session stopped successfully.");
                } else {
                  await ctx.reply("❌ Failed to stop session.");
                }
              }
            }
            break;
          }
        }
      } catch (error) {
        logger.error("Error handling action:", error);
        await ctx.reply(`❌ Error: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }

    await next();
  });

  bot.catch((err) => {
    logger.error("Bot error:", err);
  });

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

  const cleanup = async () => {
    logger.info("🛑 Shutting down...");
    await bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  setInterval(async () => {
    try {
      await sessionManager.cleanupOldSessions();
    } catch (error) {
      logger.error("Error cleaning up sessions:", error);
    }
  }, 60000);

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

  process.on("SIGINT", async () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  });
}

main().catch((error) => {
  logger.error("Fatal error:", error);
  process.exit(1);
});

import { Bot, InlineKeyboard } from "grammy";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import type { Storage, UserSessionState } from "../storage/index.js";
import type { SessionManager } from "../services/session-manager.js";

interface PendingAction {
  action: "create" | "message" | "stop";
  title?: string;
  text?: string;
  sessionId?: string;
  instanceId?: string;
}

const pendingActions = new Map<number, PendingAction>();

export function createBot(storage: Storage, sessionManager: SessionManager) {
  const bot = new Bot(config.telegram.botToken);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) {
      logger.warn("Received update without user ID");
      return;
    }

    if (!config.telegram.allowedUserIds.includes(userId)) {
      logger.warn(`Unauthorized access attempt from user ${userId}`);
      await ctx.reply("⛔ You are not authorized to use this bot.");
      return;
    }

    if (ctx.chat?.type !== "private") {
      return;
    }

    await next();
  });

  const userMessageCounts = new Map<number, { count: number; resetTime: number }>();
  
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const now = Date.now();
    const userLimit = userMessageCounts.get(userId);

    if (!userLimit || now > userLimit.resetTime) {
      userMessageCounts.set(userId, {
        count: 1,
        resetTime: now + 60000,
      });
    } else if (userLimit.count >= config.bot.rateLimitMessages) {
      await ctx.reply("⚠️ Rate limit exceeded. Please wait a moment before sending more messages.");
      return;
    } else {
      userLimit.count++;
    }

    await next();
  });

  bot.command("start", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    
    if (!userId || !chatId) return;

    const welcomeText = `
🤖 Welcome to OpenCode Bot!

I can help you interact with OpenCode AI directly from Telegram.

Available commands:
/new [title] - Create a new session
/sessions - List all your sessions
/switch <id> - Switch to a different session
/status - Show current session status
/stop - Stop the current session
/help - Show this help message

Simply send me a message to start chatting with OpenCode!
    `.trim();

    await ctx.reply(welcomeText);

    const existingState = await storage.get<UserSessionState>(`user:${userId}`);
    if (!existingState) {
      await storage.set(`user:${userId}`, {
        userId,
        chatId,
        currentSessionId: null,
        sessions: [],
        lastActivity: new Date(),
      });
    }
  });
  bot.command("start", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    
    if (!userId || !chatId) return;

    const welcomeText = `
🤖 Welcome to OpenCode Bot!

I can help you interact with OpenCode AI directly from Telegram.

Available commands:
/new [title] - Create a new session
/sessions - List all your sessions
/switch <id> - Switch to a different session
/status - Show current session status
/stop - Stop the current session
/help - Show this help message

Simply send me a message to start chatting with OpenCode!
    `.trim();

    await ctx.reply(welcomeText);

    const existingState = await storage.get<UserSessionState>(`user:${userId}`);
    if (!existingState) {
      await storage.set(`user:${userId}`, {
        userId,
        chatId,
        currentSessionId: null,
        sessions: [],
        lastActivity: new Date(),
      });
    }
  });

  bot.command("help", async (ctx) => {
    const helpText = `
🤖 OpenCode Bot Help

Commands:
/start - Start the bot and show welcome message
/instances - List and select OpenCode instances
/new [title] - Create a new OpenCode session (optional title)
/sessions - List all your active sessions
/switch <id> - Switch to a different session by ID
/status - Check the status of your current session
/stop - Stop/abort the current session
/help - Show this help message

Tips:
• First use /instances to select an OpenCode server
• Use /new to start a fresh conversation
• Sessions are persistent across chats
• You can have multiple sessions active
    `.trim();

    await ctx.reply(helpText);
  });

  bot.command("instances", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const instances = config.opencode.instances;
    const state = await storage.get<UserSessionState>(`user:${userId}`);

    let text = "🖥️ Available OpenCode Instances:\n\n";
    const keyboard = new InlineKeyboard();

    for (const instance of instances) {
      const isCurrent = state?.currentInstanceId === instance.id;
      const marker = isCurrent ? "✅ " : "";
      text += `${marker}*${instance.name}* (\`${instance.id}\`)\n`;
      text += `   URL: ${instance.apiUrl}\n\n`;

      if (!isCurrent) {
        keyboard.text(`Switch to ${instance.name}`, `instance:${instance.id}`);
        keyboard.row();
      }
    }

    await ctx.reply(text, {
      parse_mode: "MarkdownV2",
      reply_markup: keyboard,
    });
  });

  bot.command("new", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = await storage.get<UserSessionState>(`user:${userId}`);
    if (!state?.currentInstanceId) {
      await ctx.reply(
        "❗ Please select an OpenCode instance first.\nUse /instances to choose one.",
        {
          reply_markup: new InlineKeyboard()
            .text("🖥️ Select Instance", "show_instances")
        }
      );
      return;
    }

    const title = ctx.match?.toString().trim() || `Session ${new Date().toLocaleString()}`;

    await ctx.reply(`🔄 Creating new session on ${state.currentInstanceId}: "${title}"...`);
    pendingActions.set(userId, { action: "create", title, instanceId: state.currentInstanceId });
  });

  bot.command("sessions", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = await storage.get<UserSessionState>(`user:${userId}`);
    if (!state || state.sessions.length === 0) {
      await ctx.reply("📭 You have no active sessions. Use /new to create one.");
      return;
    }

    const keyboard = new InlineKeyboard();
    let text = "📋 Your sessions:\n\n";

    for (const session of state.sessions) {
      const isCurrent = session.id === state.currentSessionId;
      const marker = isCurrent ? "✅ " : "";
      text += `${marker}${session.title}\n`;
      text += `   ID: \`${session.id}\`\n`;
      text += `   Instance: ${session.instanceId}\n`;
      text += `   Created: ${new Date(session.createdAt).toLocaleDateString()}\n\n`;

      if (!isCurrent) {
        keyboard.text(`Switch to ${session.title.substring(0, 20)}`, `switch:${session.id}`);
        keyboard.row();
      }
    }

    await ctx.reply(text, {
      parse_mode: "MarkdownV2",
      reply_markup: keyboard,
    });
  });

  bot.command("switch", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const sessionId = ctx.match?.toString().trim();
    if (!sessionId) {
      await ctx.reply("❌ Please provide a session ID. Usage: /switch <session_id>");
      return;
    }

    const state = await storage.get<UserSessionState>(`user:${userId}`);
    if (!state) {
      await ctx.reply("❌ No sessions found. Use /new to create a session first.");
      return;
    }

    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) {
      await ctx.reply("❌ Session not found. Use /sessions to see your active sessions.");
      return;
    }

    state.currentSessionId = sessionId;
    state.lastActivity = new Date();
    await storage.set(`user:${userId}`, state);

    await ctx.reply(`✅ Switched to session: "${session.title}"`);
  });

  bot.command("status", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = await storage.get<UserSessionState>(`user:${userId}`);
    if (!state || !state.currentSessionId) {
      await ctx.reply("📭 No active session. Use /new to create one or /switch to select an existing session.");
      return;
    }

    const session = state.sessions.find((s) => s.id === state.currentSessionId);
    if (!session) {
      await ctx.reply("⚠️ Current session not found. Use /sessions to see available sessions.");
      return;
    }

    const statusText = `
📊 Session Status

Title: ${session.title}
ID: \`${session.id}\`
Created: ${new Date(session.createdAt).toLocaleString()}
Last accessed: ${new Date(session.lastAccessed).toLocaleString()}

Status: 🟢 Active
    `.trim();

    await ctx.reply(statusText, { parse_mode: "MarkdownV2" });
  });

  bot.command("stop", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = await storage.get<UserSessionState>(`user:${userId}`);
    if (!state || !state.currentSessionId) {
      await ctx.reply("📭 No active session to stop.");
      return;
    }

    await ctx.reply("🛑 Stopping current session...");
    pendingActions.set(userId, { action: "stop", sessionId: state.currentSessionId });
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from?.id;
    if (!userId) return;

    if (data.startsWith("instance:")) {
      const instanceId = data.replace("instance:", "");
      await sessionManager.setCurrentInstance(userId, instanceId);
      await ctx.answerCallbackQuery(`Switched to instance: ${instanceId}`);
      await ctx.editMessageText(`✅ Switched to instance: "${instanceId}"\n\nYou can now create sessions with /new`);
    } else if (data.startsWith("switch:")) {
      const sessionId = data.replace("switch:", "");

      const state = await storage.get<UserSessionState>(`user:${userId}`);
      if (state) {
        const session = state.sessions.find((s) => s.id === sessionId);
        if (session) {
          state.currentSessionId = sessionId;
          state.currentInstanceId = session.instanceId;
          state.lastActivity = new Date();
          await storage.set(`user:${userId}`, state);
          await ctx.answerCallbackQuery(`Switched to: ${session.title}`);
          await ctx.editMessageText(`✅ Switched to session: "${session.title}"`);
        }
      }
    }
  });

  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    const text = ctx.message.text;
    
    if (!userId || !text) return;

    const state = await storage.get<UserSessionState>(`user:${userId}`);
    
    if (!state || !state.currentSessionId) {
      await ctx.reply(
        "📭 No active session. Would you like to create one?",
        {
          reply_markup: new InlineKeyboard()
            .text("✅ Yes, create new session", "create_session")
            .row()
            .text("❌ Cancel", "cancel"),
        }
      );
      return;
    }

    await ctx.replyWithChatAction("typing");
    pendingActions.set(userId, {
      action: "message",
      sessionId: state.currentSessionId,
      text
    });
  });

  return { bot, getPendingAction: (userId: number) => {
    const action = pendingActions.get(userId);
    pendingActions.delete(userId);
    return action;
  }};
}

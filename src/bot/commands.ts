import { Bot, InlineKeyboard } from "grammy";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import type { Storage, UserSessionState } from "../storage/index.js";
import type { SessionManager } from "../services/session-manager.js";
import { listProjects, createProject, launchOnProject, findExistingOpenCodeForPath, getOpenCodeClient } from "../opencode/client.js";
import type { OpenCodeEvent } from "../opencode/client.js";


async function ensureUserState(storage: Storage, userId: number, chatId: number): Promise<UserSessionState> {
  const key = `user:${userId}`;
  const existing = await storage.get<UserSessionState>(key);
  if (existing) return existing;
  const state: UserSessionState = {
    userId,
    chatId,
    currentSessionId: null,
    currentInstanceId: config.opencode.defaultInstanceId,
    sessions: [],
    lastActivity: new Date(),
  };
  await storage.set(key, state);
  return state;
}

function projectsKeyboard(projects: Array<{ name: string; path: string }>): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of projects) {
    kb.text(`📂 ${p.name}`, `open_project:${p.path}`).row();
  }
  kb.text("➕ Create new project", "create_project_prompt");
  return kb;
}

export function createBot(
  storage: Storage,
  sessionManager: SessionManager,
  onMessage?: (userId: number, text: string) => Promise<void>
) {
  const bot = new Bot(config.telegram.botToken);

  const sessionSelections = new Map<number, Array<{ instanceId: string; sessionId: string }>>();
  
  let eventHandler: ((event: OpenCodeEvent, instanceId: string) => void) | undefined;
  
  const setEventHandler = (handler: (event: OpenCodeEvent, instanceId: string) => void) => {
    eventHandler = handler;
  };
  
  const handleEvent = (event: OpenCodeEvent, instanceId: string) => {
    if (eventHandler) {
      eventHandler(event, instanceId);
    }
  };

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (!config.telegram.allowedUserIds.includes(userId)) {
      logger.warn(`Unauthorized access attempt from user ${userId}`);
      await ctx.reply("⛔ You are not authorized to use this bot.");
      return;
    }
    if (ctx.chat?.type !== "private") return;
    await next();
  });

  const userMessageCounts = new Map<number, { count: number; resetTime: number }>();

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const now = Date.now();
    const userLimit = userMessageCounts.get(userId);
    if (!userLimit || now > userLimit.resetTime) {
      userMessageCounts.set(userId, { count: 1, resetTime: now + 60000 });
    } else if (userLimit.count >= config.bot.rateLimitMessages) {
      await ctx.reply("⚠️ Rate limit exceeded. Please wait a moment.");
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

    await ensureUserState(storage, userId, chatId);
    const projects = listProjects();

    if (projects.length === 0) {
      await ctx.reply(
        "👋 Welcome to OpenCode Bot!\n\nNo projects found yet. Create your first one:",
        { reply_markup: new InlineKeyboard().text("➕ Create new project", "create_project_prompt") }
      );
      return;
    }

    await ctx.reply(
      "👋 Welcome! Pick a project to work on:",
      { reply_markup: projectsKeyboard(projects) }
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "🤖 OpenCode Bot\n\n" +
        "/projects — list and open projects\n" +
        "/new_project <name> — create project and start coding\n" +
        "/new [title] — new session in current project\n" +
        "/sessions — list sessions\n" +
        "/status — current session status\n" +
        "/stop — stop current session\n" +
        "/help — this message\n" +
        "/providers — list available AI models\n" +
        "/switch_provider <model_id> — change AI model"
    );
  });

  bot.command("providers", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const messageId = ctx.message?.message_id;
    if (!userId || !chatId || !messageId) return;

    const state = await storage.get<UserSessionState>(`user:${userId}`);
    if (!state?.currentInstanceId) {
      await ctx.reply("No active project. Use /projects first.");
      return;
    }

    await ctx.reply("Loading providers...");

    try {
      const client = getOpenCodeClient(state.currentInstanceId);
      const providers = await client.getProviders();

      const available = providers.filter((p) => p.status === "active" && p.models.some((m) => m.status === "active"));
      if (available.length === 0) {
        await ctx.api.editMessageText(chatId, messageId, "No active providers found.");
        return;
      }

      let text = "🤖 Available AI Models\n\n";
      const keyboard = new InlineKeyboard();

      for (const provider of available) {
        const activeModels = provider.models.filter((m) => m.status === "active");
        if (activeModels.length > 0) {
          text += `${provider.name}:\n`;
          for (const model of activeModels.slice(0, 5)) {
            const label = model.name.substring(0, 30);
            text += `• ${label}\n`;
            keyboard.text(label, `set_model:${model.id}`).row();
          }
          if (activeModels.length > 5) {
            text += `  ... and ${activeModels.length - 5} more\n`;
          }
          text += "\n";
        }
      }

      keyboard.text("🔄 Refresh", "refresh_providers");

      await ctx.api.editMessageText(chatId, messageId, text, { reply_markup: keyboard });
    } catch (error) {
      await ctx.api.editMessageText(chatId, messageId, `Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  bot.command("switch_provider", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const modelId = ctx.match?.toString().trim();
    if (!modelId) {
      await ctx.reply("Usage: /switch_provider <model_id>\nUse /providers to see available models.");
      return;
    }

    const state = await storage.get<UserSessionState>(`user:${userId}`);
    if (!state?.currentInstanceId) {
      await ctx.reply("No active project. Use /projects first.");
      return;
    }

    try {
      const client = getOpenCodeClient(state.currentInstanceId);
      const success = await client.setProvider(modelId);

      if (success) {
        await ctx.reply(`✅ Model changed to: ${modelId}`);
      } else {
        await ctx.reply(`❌ Failed to set model: ${modelId}`);
      }
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  bot.command("projects", async (ctx) => {
    const projects = listProjects();
    if (projects.length === 0) {
      await ctx.reply(
        "📭 No projects found. Create one:",
        { reply_markup: new InlineKeyboard().text("➕ Create new project", "create_project_prompt") }
      );
      return;
    }
    await ctx.reply(
      `📁 ${projects.length} project(s). Tap one to open:`,
      { reply_markup: projectsKeyboard(projects) }
    );
  });

  bot.command("new_project", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;

    const name = ctx.match?.toString().trim();
    if (!name) {
      await ctx.reply("Usage: /new_project <name>\nExample: /new_project my-app");
      return;
    }

    const msg = await ctx.reply(`⚙️ Creating project "${name}"...`);

    const { path, error } = createProject(name);
    if (error) {
      await ctx.api.editMessageText(chatId, msg.message_id, `❌ ${error}`);
      return;
    }

    await ctx.api.editMessageText(chatId, msg.message_id, `⚙️ Starting OpenCode on "${name}"...`);

    const { instanceId, error: launchError } = await launchOnProject(path, handleEvent);
    if (launchError) {
      await ctx.api.editMessageText(chatId, msg.message_id, `❌ Could not start OpenCode: ${launchError}`);
      return;
    }

    const state = await ensureUserState(storage, userId, chatId);
    state.currentInstanceId = instanceId;
    await storage.set(`user:${userId}`, state);

    await ctx.api.editMessageText(chatId, msg.message_id, "⚙️ Creating session...");

    const session = await sessionManager.createSession(userId, `${name} — session 1`, instanceId);

    await ctx.api.editMessageText(
      chatId,
      msg.message_id,
      `✅ Ready!\nProject: ${name}\nSession: "${session.title}"\n\nJust send a message to start coding!`
    );
  });

  bot.command("new", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;

    const state = await ensureUserState(storage, userId, chatId);

    if (!state.currentInstanceId) {
      const projects = listProjects();
      if (projects.length === 0) {
        await ctx.reply(
          "No projects yet. Create one first:",
          { reply_markup: new InlineKeyboard().text("➕ Create new project", "create_project_prompt") }
        );
        return;
      }
      await ctx.reply("Select a project:", { reply_markup: projectsKeyboard(projects) });
      return;
    }

    const title = ctx.match?.toString().trim() || `Session ${new Date().toLocaleString()}`;
    const session = await sessionManager.createSession(userId, title, state.currentInstanceId);
    await ctx.reply(`✅ Session "${session.title}" created. Start chatting!`);
  });

  bot.command("sessions", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = await storage.get<UserSessionState>(`user:${userId}`);
    if (!state || state.sessions.length === 0) {
      await ctx.reply("📭 No sessions yet. Use /projects to start one.");
      return;
    }

    const keyboard = new InlineKeyboard();
    let text = "📋 Your sessions:\n\n";
    for (const session of state.sessions) {
      const isCurrent = session.id === state.currentSessionId;
      text += `${isCurrent ? "✅ " : ""}${session.title} (${session.instanceId})\n`;
      text += `   ${new Date(session.createdAt).toLocaleDateString()}\n\n`;
      if (!isCurrent) {
        keyboard.text(`▶️ ${session.title.substring(0, 25)}`, `switch:${session.id}`).row();
      }
    }
    await ctx.reply(text, { reply_markup: keyboard });
  });

  bot.command("status", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = await storage.get<UserSessionState>(`user:${userId}`);
    if (!state?.currentSessionId) {
      await ctx.reply("📭 No active session. Use /projects to start one.");
      return;
    }

    const session = state.sessions.find((s) => s.id === state.currentSessionId);
    if (!session) {
      await ctx.reply("⚠️ Session not found. Use /sessions.");
      return;
    }

    await ctx.reply(
      `📊 Active Session\n\nTitle: ${session.title}\nProject: ${session.instanceId}\nCreated: ${new Date(session.createdAt).toLocaleString()}\nLast used: ${new Date(session.lastAccessed).toLocaleString()}`
    );
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;

    if (data === "create_project_prompt") {
      await ctx.answerCallbackQuery();
      await ctx.reply("Send me the project name:\n\n/new_project <name>\n\nExample: /new_project my-app");
      return;
    }

    if (data.startsWith("open_project:")) {
      const projectPath = data.replace("open_project:", "");
      await ctx.answerCallbackQuery("Opening project…");
      await ctx.editMessageText(`⚙️ Checking OpenCode on "${projectPath}"...`);

      const existing = await findExistingOpenCodeForPath(projectPath);
      let instanceId: string;

      if (existing) {
        instanceId = existing.instanceId;
        const client = getOpenCodeClient(instanceId);
        const sessions = await client.listSessions();

        if (sessions.length > 0) {
          const keyboard = new InlineKeyboard();
          const selection = sessions.map((session) => ({ instanceId, sessionId: session.id }));
          sessionSelections.set(userId, selection);
          let text = `📂 Attached to existing OpenCode (${sessions.length} session(s)):\n\n`;
          for (let i = 0; i < sessions.length; i += 1) {
            const session = sessions[i];
            text += `• ${session.title}\n`;
            keyboard.text(`▶️ ${session.title.substring(0, 25)}`, `attach_session:${i}`).row();
          }
          keyboard.text("➕ New session", `new_session:${instanceId}`);

          const state = await ensureUserState(storage, userId, chatId);
          state.currentInstanceId = instanceId;
          await storage.set(`user:${userId}`, state);

          await ctx.editMessageText(text, { reply_markup: keyboard });
          return;
        }

        await ctx.editMessageText("✅ Attached to existing OpenCode (no sessions).\n\nUse /new to create a session, or just send a message!");
        const state = await ensureUserState(storage, userId, chatId);
        state.currentInstanceId = instanceId;
        await storage.set(`user:${userId}`, state);
        return;
      }

      await ctx.editMessageText(`⚙️ Starting OpenCode on "${projectPath}"...`);
      const { instanceId: newInstanceId, error: launchError } = await launchOnProject(projectPath, handleEvent);
      if (launchError) {
        await ctx.editMessageText(`❌ Could not start OpenCode: ${launchError}`);
        return;
      }

      instanceId = newInstanceId;
      const state = await ensureUserState(storage, userId, chatId);
      state.currentInstanceId = instanceId;
      await storage.set(`user:${userId}`, state);
      await ctx.editMessageText("✅ OpenCode is running.\n\nUse /new to create a session, or just send a message!");
      return;
    }

    if (data.startsWith("attach_session:")) {
      const indexValue = data.replace("attach_session:", "");
      const index = Number.parseInt(indexValue, 10);
      if (Number.isNaN(index)) {
        await ctx.answerCallbackQuery("Invalid selection");
        return;
      }

      const selection = sessionSelections.get(userId);
      const selected = selection?.[index];
      if (!selected) {
        await ctx.answerCallbackQuery("Selection expired. Please open the project again.");
        return;
      }

      const { instanceId, sessionId } = selected;

      const state = await ensureUserState(storage, userId, chatId);
      const existingSession = state.sessions.find((s) => s.id === sessionId);
      if (!existingSession) {
        const client = getOpenCodeClient(instanceId);
        const session = await client.getSession(sessionId);
        if (session) {
          state.sessions.push({
            id: session.id,
            title: session.title,
            instanceId,
            createdAt: session.createdAt,
            lastAccessed: new Date(),
          });
        }
      }

      state.currentSessionId = sessionId;
      state.currentInstanceId = instanceId;
      state.lastActivity = new Date();
      await storage.set(`user:${userId}`, state);

      await ctx.answerCallbackQuery("Session attached");
      await ctx.editMessageText("✅ Attached to existing session. Start chatting!");
      return;
    }

    if (data.startsWith("new_session:")) {
      const instanceId = data.replace("new_session:", "");
      const title = `Session ${new Date().toLocaleString()}`;
      const session = await sessionManager.createSession(userId, title, instanceId);
      await ctx.answerCallbackQuery("Session created");
      await ctx.editMessageText(`✅ Session "${session.title}" created. Start chatting!`);
      return;
    }

    if (data.startsWith("switch:")) {
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
          await ctx.editMessageText(`✅ Switched to: "${session.title}"`);
        }
      }
      return;
    }

    if (data.startsWith("set_model:")) {
      const modelId = data.replace("set_model:", "");
      const state = await storage.get<UserSessionState>(`user:${userId}`);
      if (!state?.currentInstanceId) {
        await ctx.answerCallbackQuery("No active project");
        return;
      }

      try {
        const client = getOpenCodeClient(state.currentInstanceId);
        const success = await client.setProvider(modelId);
        if (success) {
          await ctx.answerCallbackQuery("Model changed!");
          await ctx.editMessageText(`✅ Model set to: ${modelId}\n\nYou can now send messages.`);
        } else {
          await ctx.answerCallbackQuery("Failed to set model");
        }
      } catch (error) {
        await ctx.answerCallbackQuery("Error setting model");
      }
      return;
    }

    if (data === "refresh_providers") {
      const state = await storage.get<UserSessionState>(`user:${userId}`);
      if (!state?.currentInstanceId) {
        await ctx.answerCallbackQuery("No active project");
        return;
      }

      await ctx.answerCallbackQuery("Refreshing...");
      const client = getOpenCodeClient(state.currentInstanceId);
      const providers = await client.getProviders();

      const available = providers.filter((p) => p.status === "active" && p.models.some((m) => m.status === "active"));
      if (available.length === 0) {
        await ctx.editMessageText("No active providers found.");
        return;
      }

      let text = "🤖 Available AI Models\n\n";
      const keyboard = new InlineKeyboard();

      for (const provider of available) {
        const activeModels = provider.models.filter((m) => m.status === "active");
        if (activeModels.length > 0) {
          text += `${provider.name}:\n`;
          for (const model of activeModels.slice(0, 5)) {
            const label = model.name.substring(0, 30);
            text += `• ${label}\n`;
            keyboard.text(label, `set_model:${model.id}`).row();
          }
          if (activeModels.length > 5) {
            text += `  ... and ${activeModels.length - 5} more\n`;
          }
          text += "\n";
        }
      }

      keyboard.text("🔄 Refresh", "refresh_providers");

      await ctx.editMessageText(text, { reply_markup: keyboard });
      return;
    }

    await ctx.answerCallbackQuery();
  });

  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const text = ctx.message.text;
    if (!userId || !chatId || !text || text.startsWith("/")) return;

    let state = await ensureUserState(storage, userId, chatId);

    if (!state.currentInstanceId) {
      const projects = listProjects();
      if (projects.length === 0) {
        await ctx.reply(
          "No projects yet. Create one to start coding:",
          { reply_markup: new InlineKeyboard().text("➕ Create new project", "create_project_prompt") }
        );
        return;
      }
      await ctx.reply("No active project. Pick one:", { reply_markup: projectsKeyboard(projects) });
      return;
    }

    if (!state.currentSessionId) {
      const title = `Session ${new Date().toLocaleString()}`;
      const session = await sessionManager.createSession(userId, title, state.currentInstanceId);
      state = await storage.get<UserSessionState>(`user:${userId}`) ?? state;
      await ctx.reply(`✅ Session "${session.title}" created. Start chatting!`);
    }

    await ctx.replyWithChatAction("typing");
    if (onMessage) {
      await onMessage(userId, text);
    }
  });

  return {
    bot,
    setEventHandler,
  };
}

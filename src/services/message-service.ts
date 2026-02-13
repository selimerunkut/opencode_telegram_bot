import { Bot } from "grammy";
import type { Storage, UserSessionState } from "../storage/index.js";
import { SessionManager } from "../services/session-manager.js";
import type { OpenCodeEvent, OpenCodeEventWithInstance } from "../opencode/client.js";
import { chunkMessage } from "../utils/chunk.js";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";

export class MessageService {
  private bot: Bot;
  private storage: Storage;
  private sessionManager: SessionManager;
  private messageBuffers: Map<string, string> = new Map();

  constructor(
    bot: Bot,
    storage: Storage,
    sessionManager: SessionManager
  ) {
    this.bot = bot;
    this.storage = storage;
    this.sessionManager = sessionManager;
  }

  async handleIncomingMessage(userId: number, text: string): Promise<void> {
    const result = await this.sessionManager.sendMessage(userId, text);
    
    if (!result.success) {
      await this.sendMessageToUser(userId, `❌ Error: ${result.error}`);
      return;
    }

    await this.sendMessageToUser(userId, "🤔 Processing your request...");
  }

  async handleOpenCodeEvent(event: OpenCodeEvent, userId: number, instanceId: string): Promise<void> {
    try {
      switch (event.type) {
        case "message.part.updated":
          await this.handleMessagePart(event.payload, userId, instanceId);
          break;
        case "message.updated":
          await this.handleMessageComplete(event.payload.message, userId, instanceId);
          break;
        case "session.status":
          await this.handleSessionStatus(event.payload, userId);
          break;
        case "permission.updated":
          await this.handlePermissionRequest(event.payload, userId);
          break;
        case "todo.updated":
          await this.handleTodoUpdate(event.payload, userId);
          break;
        default:
          logger.debug(`Unhandled event type: ${(event as any).type}`);
      }
    } catch (error) {
      logger.error("Error handling OpenCode event:", error);
    }
  }

  private getBufferKey(userId: number, instanceId: string): string {
    return `buffer:${instanceId}:${userId}`;
  }

  private async handleMessagePart(
    payload: { part: { type: string; text?: string }; delta?: string },
    userId: number,
    instanceId: string
  ): Promise<void> {
    const { part, delta } = payload;

    if (part.type === "text" && delta) {
      const bufferKey = this.getBufferKey(userId, instanceId);
      let buffer = this.messageBuffers.get(bufferKey) || "";
      buffer += delta;
      this.messageBuffers.set(bufferKey, buffer);

      if (buffer.length >= config.bot.messageChunkSize) {
        await this.sendMessageToUser(userId, buffer);
        this.messageBuffers.set(bufferKey, "");
      }
    }
  }

  private async handleMessageComplete(
    message: { role: string; content: string },
    userId: number,
    instanceId: string
  ): Promise<void> {
    const bufferKey = this.getBufferKey(userId, instanceId);
    const buffer = this.messageBuffers.get(bufferKey) || "";

    if (buffer) {
      await this.sendMessageToUser(userId, buffer);
      this.messageBuffers.delete(bufferKey);
    }

    if (message.role === "assistant" && message.content) {
      await this.sendMessageToUser(userId, message.content);
    }
  }

  async routeEventToUser(event: OpenCodeEventWithInstance): Promise<void> {
    const sessionId = this.extractSessionIdFromEvent(event);
    if (!sessionId) {
      logger.debug("Could not extract session ID from event");
      return;
    }

    const userId = await this.findUserBySession(sessionId, event.instanceId);
    if (userId) {
      await this.handleOpenCodeEvent(event, userId, event.instanceId);
    } else {
      logger.debug(`No user found for session ${sessionId} on instance ${event.instanceId}`);
    }
  }

  private extractSessionIdFromEvent(event: OpenCodeEventWithInstance): string | null {
    if ("payload" in event && event.payload && typeof event.payload === "object") {
      const payload = event.payload as any;
      if (payload.sessionId) return payload.sessionId;
      if (payload.message?.sessionId) return payload.message.sessionId;
      if (payload.sessionID) return payload.sessionID;
    }
    return null;
  }

  private async findUserBySession(sessionId: string, instanceId: string): Promise<number | null> {
    const allKeys = await this.storage.keys("user:*");
    for (const key of allKeys) {
      const state = await this.storage.get<UserSessionState>(key);
      if (!state) continue;
      const session = state.sessions.find((s) =>
        s.id === sessionId && s.instanceId === instanceId
      );
      if (session) return state.userId;
    }
    return null;
  }

  private async handleSessionStatus(
    payload: { sessionId: string; status: { type: string } },
    userId: number
  ): Promise<void> {
    const { status } = payload;

    if (status.type === "busy") {
      await this.bot.api.sendChatAction(userId, "typing");
    }
  }

  private async handlePermissionRequest(
    permission: { id: string; type: string; title: string },
    userId: number
  ): Promise<void> {
    const text = `🔒 Permission Request\n\nType: ${permission.type}\nTitle: ${permission.title}\n\nPlease respond with:\n/allow ${permission.id} or /deny ${permission.id}`;
    
    await this.sendMessageToUser(userId, text);
  }

  private async handleTodoUpdate(
    payload: { sessionId: string; todos: Array<{ content: string; status: string }> },
    userId: number
  ): Promise<void> {
    const { todos } = payload;
    
    if (todos.length === 0) return;

    const pending = todos.filter((t) => t.status === "pending" || t.status === "in_progress");
    const completed = todos.filter((t) => t.status === "completed");

    let text = "📋 Task Update\n\n";
    
    if (pending.length > 0) {
      text += "In Progress:\n";
      for (const todo of pending) {
        const icon = todo.status === "in_progress" ? "🔵" : "⚪";
        text += `${icon} ${todo.content}\n`;
      }
      text += "\n";
    }

    if (completed.length > 0) {
      text += `✅ Completed: ${completed.length} tasks\n`;
    }

    await this.sendMessageToUser(userId, text);
  }

  private async sendMessageToUser(userId: number, text: string): Promise<void> {
    const chunks = chunkMessage(text, config.bot.maxMessageLength);

    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(userId, chunk, {
          parse_mode: "Markdown",
        });
      } catch (error) {
        logger.error(`Failed to send message to user ${userId}:`, error);
        
        try {
          await this.bot.api.sendMessage(userId, chunk);
        } catch (retryError) {
          logger.error(`Retry failed for user ${userId}:`, retryError);
        }
      }
    }
  }
}

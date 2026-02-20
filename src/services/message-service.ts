import type { Bot } from "grammy";
import type { Storage, UserSessionState } from "../storage/index.js";
import type { SessionManager } from "../services/session-manager.js";
import type { OpenCodeEvent, OpenCodeEventWithInstance } from "../opencode/client.js";
import { chunkMessage } from "../utils/chunk.js";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";

export class MessageService {
  private bot: Bot | null = null;
  private storage: Storage;
  private sessionManager: SessionManager;
  private messageBuffers: Map<string, string> = new Map();

  constructor(
    _bot: Bot | null,
    storage: Storage,
    sessionManager: SessionManager
  ) {
    this.storage = storage;
    this.sessionManager = sessionManager;
  }

  setBot(bot: Bot): void {
    this.bot = bot;
  }

  async handleIncomingMessage(userId: number, text: string): Promise<void> {
    logger.info(`Sending message from user ${userId}: "${text.substring(0, 50)}"`);
    const result = await this.sessionManager.sendMessage(userId, text);
    
    if (!result.success) {
      logger.error(`sendMessage failed for user ${userId}: ${result.error}`);
      await this.sendMessageToUser(userId, `❌ Error: ${result.error}`);
      return;
    }

    logger.info(`Message sent to OpenCode for user ${userId}`);
    await this.sendMessageToUser(userId, "🤔 Processing your request...");
  }

  async handleOpenCodeEvent(event: OpenCodeEvent, userId: number, instanceId: string): Promise<void> {
    try {
      switch (event.type) {
        case "message.part.updated":
          await this.handleMessagePart(event.properties, userId, instanceId);
          break;
        case "message.updated":
          if ("finish" in event.properties.info) {
            await this.handleMessageComplete(event.properties.info, userId, instanceId);
          }
          break;
        case "session.status":
          await this.handleSessionStatus(event.properties, userId);
          break;
        case "permission.updated":
          await this.handlePermissionRequest(event.properties, userId);
          break;
        case "todo.updated":
          await this.handleTodoUpdate(event.properties, userId);
          break;
        case "session.error":
          await this.handleSessionError(event.properties, userId);
          break;
        default:
          logger.debug(`Unhandled event type: ${(event as { type: string }).type}`);
      }
    } catch (error) {
      logger.error("Error handling OpenCode event:", error);
    }
  }

  private getBufferKey(userId: number, instanceId: string): string {
    return `buffer:${instanceId}:${userId}`;
  }

  private async handleMessagePart(
    properties: { part: { type: string; text?: string }; delta?: string },
    userId: number,
    instanceId: string
  ): Promise<void> {
    const { part, delta } = properties;

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
    info: { role: string; sessionID: string },
    userId: number,
    instanceId: string
  ): Promise<void> {
    if (info.role !== "assistant") return;

    const bufferKey = this.getBufferKey(userId, instanceId);
    const buffer = this.messageBuffers.get(bufferKey) || "";

    if (buffer) {
      await this.sendMessageToUser(userId, buffer);
      this.messageBuffers.delete(bufferKey);
    }
  }

  async routeEventToUser(event: OpenCodeEventWithInstance): Promise<void> {
    const sessionId = this.extractSessionIdFromEvent(event);
    if (!sessionId) {
      logger.debug(`Event ${event.type} missing sessionID on ${event.instanceId}`);
      return;
    }

    logger.debug(`Event ${event.type} for session ${sessionId} on ${event.instanceId}`);
    const userId = await this.findUserBySession(sessionId, event.instanceId);
    if (userId) {
      logger.debug(`Routing ${event.type} to user ${userId}`);
      await this.handleOpenCodeEvent(event, userId, event.instanceId);
    } else {
      logger.warn(`No user found for session ${sessionId} on instance ${event.instanceId}`);
    }
  }

  private extractSessionIdFromEvent(event: OpenCodeEventWithInstance): string | null {
    if (!("properties" in event) || !event.properties || typeof event.properties !== "object") {
      return null;
    }
    const props = event.properties as Record<string, unknown>;
    const directId = props.sessionID;
    if (typeof directId === "string") return directId;
    const info = props.info;
    if (info && typeof info === "object" && "sessionID" in info && typeof (info as Record<string, unknown>).sessionID === "string") {
      return (info as Record<string, unknown>).sessionID as string;
    }
    const part = props.part;
    if (part && typeof part === "object" && "sessionID" in part && typeof (part as Record<string, unknown>).sessionID === "string") {
      return (part as Record<string, unknown>).sessionID as string;
    }
    return null;
  }

  private async findUserBySession(sessionId: string, instanceId: string): Promise<number | null> {
    const allKeys = await this.storage.keys("user:*");
    logger.debug(`Looking for session ${sessionId} on ${instanceId} across ${allKeys.length} users`);
    for (const key of allKeys) {
      const state = await this.storage.get<UserSessionState>(key);
      if (!state) continue;
      const session = state.sessions.find((s) =>
        s.id === sessionId && s.instanceId === instanceId
      );
      if (session) {
        logger.debug(`Matched session ${sessionId} to user ${state.userId}`);
        return state.userId;
      }
    }
    return null;
  }

  private async handleSessionStatus(
    properties: { sessionID: string; status: { type: string } },
    userId: number
  ): Promise<void> {
    const { status } = properties;

    if (status.type === "busy") {
      await this.bot?.api.sendChatAction(userId, "typing");
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
    properties: { sessionID: string; todos: Array<{ content: string; status: string }> },
    userId: number
  ): Promise<void> {
    const { todos } = properties;
    
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

  private async handleSessionError(
    properties: { sessionID: string; error: string },
    userId: number
  ): Promise<void> {
    const { error } = properties;
    const text = `❌ OpenCode Error\n\n${error}\n\nUse /providers to see available models or /switch_provider to change.`;
    await this.sendMessageToUser(userId, text);
  }

  private async sendMessageToUser(userId: number, text: string): Promise<void> {
    if (!this.bot) {
      logger.error("Cannot send message: bot not initialized");
      return;
    }
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

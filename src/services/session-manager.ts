import type { Storage, UserSessionState, SessionInfo } from "../storage/index.js";
import type { Session } from "../opencode/client.js";
import { getOpenCodeClient } from "../opencode/client.js";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";

export class SessionManager {
  private storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  async getOrCreateUserState(userId: number, chatId: number): Promise<UserSessionState> {
    const key = `user:${userId}`;
    let state = await this.storage.get<UserSessionState>(key);

    if (!state) {
      state = {
        userId,
        chatId,
        currentSessionId: null,
        currentInstanceId: null,
        sessions: [],
        lastActivity: new Date(),
      };
      await this.storage.set(key, state);
      logger.info(`Created new user state for user ${userId}`);
    } else {
      await this.migrateOldSessions(state, key);
    }

    return state;
  }

  private async migrateOldSessions(state: UserSessionState, key: string): Promise<void> {
    let needsMigration = false;

    for (const session of state.sessions) {
      if (!session.instanceId) {
        session.instanceId = config.opencode.defaultInstanceId;
        needsMigration = true;
      }
    }

    if (!state.currentInstanceId && state.sessions.length > 0) {
      state.currentInstanceId = state.sessions[0].instanceId;
      needsMigration = true;
    }

    if (needsMigration) {
      await this.storage.set(key, state);
      logger.info(`Migrated old sessions for user ${state.userId}`);
    }
  }

  async setCurrentInstance(userId: number, instanceId: string): Promise<boolean> {
    const state = await this.getOrCreateUserState(userId, 0);
    state.currentInstanceId = instanceId;
    await this.storage.set(`user:${userId}`, state);
    logger.info(`User ${userId} switched to instance ${instanceId}`);
    return true;
  }

  async createSession(userId: number, title?: string, instanceId?: string): Promise<Session> {
    const state = await this.getOrCreateUserState(userId, 0);

    const targetInstanceId = instanceId || state.currentInstanceId || config.opencode.defaultInstanceId;
    const client = getOpenCodeClient(targetInstanceId);
    const opencodeSession = await client.createSession(title);

    const sessionInfo: SessionInfo = {
      id: opencodeSession.id,
      title: opencodeSession.title,
      instanceId: targetInstanceId,
      createdAt: new Date(),
      lastAccessed: new Date(),
    };

    state.sessions.push(sessionInfo);
    state.currentSessionId = opencodeSession.id;
    state.currentInstanceId = targetInstanceId;
    state.lastActivity = new Date();

    await this.storage.set(`user:${userId}`, state);

    logger.info(`Created session ${opencodeSession.id} on instance ${targetInstanceId} for user ${userId}`);
    return opencodeSession;
  }

  async switchSession(userId: number, sessionId: string): Promise<boolean> {
    const state = await this.getOrCreateUserState(userId, 0);

    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) {
      logger.warn(`Session ${sessionId} not found for user ${userId}`);
      return false;
    }

    state.currentSessionId = sessionId;
    state.currentInstanceId = session.instanceId;
    session.lastAccessed = new Date();
    state.lastActivity = new Date();

    await this.storage.set(`user:${userId}`, state);

    logger.info(`User ${userId} switched to session ${sessionId} on instance ${session.instanceId}`);
    return true;
  }

  async getCurrentSession(userId: number): Promise<SessionInfo | null> {
    const state = await this.getOrCreateUserState(userId, 0);
    if (!state.currentSessionId) return null;

    return state.sessions.find((s) => s.id === state.currentSessionId) || null;
  }

  async listSessions(userId: number): Promise<SessionInfo[]> {
    const state = await this.getOrCreateUserState(userId, 0);
    return state.sessions;
  }

  async deleteSession(userId: number, sessionId: string): Promise<boolean> {
    const state = await this.getOrCreateUserState(userId, 0);

    const sessionIndex = state.sessions.findIndex((s) => s.id === sessionId);
    if (sessionIndex === -1) return false;

    const session = state.sessions[sessionIndex];
    const client = getOpenCodeClient(session.instanceId);
    const success = await client.deleteSession(sessionId);
    if (!success) return false;

    state.sessions.splice(sessionIndex, 1);

    if (state.currentSessionId === sessionId) {
      state.currentSessionId = state.sessions.length > 0 ? state.sessions[0].id : null;
      state.currentInstanceId = state.sessions.length > 0 ? state.sessions[0].instanceId : null;
    }

    state.lastActivity = new Date();
    await this.storage.set(`user:${userId}`, state);

    logger.info(`Deleted session ${sessionId} for user ${userId}`);
    return true;
  }

  async sendMessage(userId: number, text: string): Promise<{ success: boolean; error?: string }> {
    const state = await this.getOrCreateUserState(userId, 0);

    if (!state.currentSessionId || !state.currentInstanceId) {
      return { success: false, error: "No active session" };
    }

    try {
      const client = getOpenCodeClient(state.currentInstanceId);
      await client.sendPrompt(state.currentSessionId, text);

      const session = state.sessions.find((s) => s.id === state.currentSessionId);
      if (session) {
        session.lastAccessed = new Date();
      }
      state.lastActivity = new Date();
      await this.storage.set(`user:${userId}`, state);

      return { success: true };
    } catch (error) {
      logger.error(`Failed to send message for user ${userId}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error"
      };
    }
  }

  async cleanupOldSessions(): Promise<void> {
    const allKeys = await this.storage.keys("user:*");
    const now = Date.now();
    const timeoutMs = config.bot.sessionTimeoutMs;

    for (const key of allKeys) {
      const state = await this.storage.get<UserSessionState>(key);
      if (!state) continue;

      const lastActivity = new Date(state.lastActivity).getTime();
      if (now - lastActivity > timeoutMs) {
        logger.info(`Cleaning up expired session state for user ${state.userId}`);

        for (const session of state.sessions) {
          try {
            const client = getOpenCodeClient(session.instanceId);
            await client.deleteSession(session.id);
          } catch (error) {
            logger.error(`Failed to delete session ${session.id} during cleanup:`, error);
          }
        }

        await this.storage.delete(key);
      }
    }
  }
}

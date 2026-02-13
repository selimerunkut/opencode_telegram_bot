import { logger } from "../utils/logger.js";
import type { OpenCodeInstanceConfig } from "../config/index.js";

export interface OpenCodeClient {
  instanceId: string;
  createSession: (title?: string, parentId?: string) => Promise<Session>;
  getSession: (sessionId: string) => Promise<Session | null>;
  listSessions: () => Promise<Session[]>;
  deleteSession: (sessionId: string) => Promise<boolean>;
  abortSession: (sessionId: string) => Promise<boolean>;
  sendPrompt: (sessionId: string, prompt: string) => Promise<void>;
  getMessages: (sessionId: string) => Promise<Message[]>;
  subscribeToEvents: (callback: (event: OpenCodeEvent) => void) => Promise<() => void>;
}

export interface Session {
  id: string;
  title: string;
  directory: string;
  parentId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

export type OpenCodeEvent =
  | { type: "message.updated"; payload: { message: Message } }
  | { type: "message.part.updated"; payload: { part: MessagePart; delta?: string } }
  | { type: "session.status"; payload: { sessionId: string; status: SessionStatus } }
  | { type: "permission.updated"; payload: Permission }
  | { type: "todo.updated"; payload: { sessionId: string; todos: Todo[] } };

export type OpenCodeEventWithInstance = OpenCodeEvent & { instanceId: string };

export interface MessagePart {
  id: string;
  type: "text" | "reasoning" | "file" | "tool" | "step-start" | "step-finish";
  content?: string;
}

export type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

export interface Permission {
  id: string;
  type: string;
  title: string;
  sessionId: string;
  messageId: string;
}

export interface Todo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "high" | "medium" | "low";
}

const clientInstances: Map<string, OpenCodeClient> = new Map();

export function getOpenCodeClient(instanceId: string): OpenCodeClient {
  const client = clientInstances.get(instanceId);
  if (!client) {
    throw new Error(`Unknown OpenCode instance: ${instanceId}`);
  }
  return client;
}

export function initializeOpenCodeClients(instances: OpenCodeInstanceConfig[]): void {
  for (const instance of instances) {
    const client = createOpenCodeClientForInstance(instance);
    clientInstances.set(instance.id, client);
    logger.info(`Initialized OpenCode client for instance: ${instance.id}`);
  }
}

function createOpenCodeClientForInstance(instanceConfig: OpenCodeInstanceConfig): OpenCodeClient {
  const baseUrl = instanceConfig.apiUrl;
  const directory = instanceConfig.projectPath;

  async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = new URL(path, baseUrl);
    url.searchParams.set("directory", directory);

    const response = await fetch(url.toString(), {
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      ...options,
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  return {
    instanceId: instanceConfig.id,

    async createSession(title?: string, parentId?: string): Promise<Session> {
      const data = await apiRequest<{ id: string; title: string; directory: string; parentID?: string; time: { created: number; updated: number } }>("/session", {
        method: "POST",
        body: JSON.stringify({ title, parentID: parentId }),
      });

      return {
        id: data.id,
        title: data.title,
        directory: data.directory,
        parentId: data.parentID,
        createdAt: new Date(data.time.created),
        updatedAt: new Date(data.time.updated),
      };
    },

    async getSession(sessionId: string): Promise<Session | null> {
      try {
        const data = await apiRequest<{ id: string; title: string; directory: string; parentID?: string; time: { created: number; updated: number } }>(`/session/${sessionId}`);
        return {
          id: data.id,
          title: data.title,
          directory: data.directory,
          parentId: data.parentID,
          createdAt: new Date(data.time.created),
          updatedAt: new Date(data.time.updated),
        };
      } catch (error) {
        logger.error("Failed to get session:", error);
        return null;
      }
    },

    async listSessions(): Promise<Session[]> {
      try {
        const data = await apiRequest<Array<{ id: string; title: string; directory: string; parentID?: string; time: { created: number; updated: number } }>>("/session");
        return data.map((session) => ({
          id: session.id,
          title: session.title,
          directory: session.directory,
          parentId: session.parentID,
          createdAt: new Date(session.time.created),
          updatedAt: new Date(session.time.updated),
        }));
      } catch (error) {
        logger.error("Failed to list sessions:", error);
        return [];
      }
    },

    async deleteSession(sessionId: string): Promise<boolean> {
      try {
        await apiRequest(`/session/${sessionId}`, { method: "DELETE" });
        return true;
      } catch (error) {
        logger.error("Failed to delete session:", error);
        return false;
      }
    },

    async abortSession(sessionId: string): Promise<boolean> {
      try {
        await apiRequest(`/session/${sessionId}/abort`, { method: "POST" });
        return true;
      } catch (error) {
        logger.error("Failed to abort session:", error);
        return false;
      }
    },

    async sendPrompt(sessionId: string, prompt: string): Promise<void> {
      await apiRequest(`/session/${sessionId}/prompt`, {
        method: "POST",
        body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
      });
    },

    async getMessages(sessionId: string): Promise<Message[]> {
      try {
        const data = await apiRequest<Array<{ id: string; sessionID: string; role: "user" | "assistant"; time: { created: number } }>>(`/session/${sessionId}/messages`);
        return data.map((msg) => ({
          id: msg.id,
          sessionId: msg.sessionID,
          role: msg.role,
          content: "",
          createdAt: new Date(msg.time.created),
        }));
      } catch (error) {
        logger.error("Failed to get messages:", error);
        return [];
      }
    },

    async subscribeToEvents(callback: (event: OpenCodeEvent) => void): Promise<() => void> {
      const abortController = new AbortController();

      const connect = async () => {
        try {
          const url = new URL("/event/subscribe", baseUrl);
          url.searchParams.set("directory", directory);

          const response = await fetch(url.toString(), {
            headers: { Accept: "text/event-stream" },
            signal: abortController.signal,
          });

          if (!response.body) return;

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (!abortController.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                try {
                  const eventData = JSON.parse(line.slice(6));
                  callback(eventData as OpenCodeEvent);
                } catch {}
              }
            }
          }
        } catch (error) {
          if ((error as Error).name !== "AbortError") {
            logger.error("Event stream error:", error);
          }
        }
      };

      connect();

      return () => {
        abortController.abort();
      };
    },
  };
}

import { logger } from "../utils/logger.js";
import type { OpenCodeInstanceConfig } from "../config/index.js";
import { config } from "../config/index.js";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { join, isAbsolute, normalize, sep, basename, resolve } from "node:path";
import { existsSync, statSync, mkdirSync, readdirSync } from "node:fs";

const spawnedProcesses: Map<string, ChildProcess> = new Map();

interface DiscoveredInstance {
  instanceId: string;
  apiUrl: string;
  projectPath: string;
  pid: number;
}

export function discoverRunningOpenCodeInstances(): DiscoveredInstance[] {
  const instances: DiscoveredInstance[] = [];
  
  try {
    const output = execSync(
      "ps aux | grep 'opencode serve' | grep -v grep",
      { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
    );
    
    const lines = output.trim().split("\n");
    
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;
      
      const pid = Number.parseInt(parts[1], 10);
      if (Number.isNaN(pid)) continue;
      
      const cmdMatch = line.match(/--port\s+(\d+)/);
      const port = cmdMatch ? cmdMatch[1] : "3000";
      
      try {
        const cwd = execSync(`readlink /proc/${pid}/cwd`, { encoding: "utf-8" }).trim();
        const normalizedCwd = normalize(cwd);
        const baseName = basename(normalizedCwd);
        const instanceId = `project-${baseName}`;
        
        instances.push({
          instanceId,
          apiUrl: `http://localhost:${port}`,
          projectPath: normalizedCwd,
          pid,
        });
      } catch {}
    }
  } catch {
    return instances;
  }
  
  return instances;
}

export async function findExistingOpenCodeForPath(
  projectPath: string
): Promise<{ instanceId: string; apiUrl: string } | null> {
  const normalizedTarget = normalize(resolve(projectPath));
  const runningInstances = discoverRunningOpenCodeInstances();
  
  for (const instance of runningInstances) {
    if (normalize(instance.projectPath) === normalizedTarget) {
      if (await isOpenCodeRunning(instance.apiUrl)) {
        logger.info(`Found existing OpenCode for ${projectPath} at ${instance.apiUrl} (PID: ${instance.pid})`);
        if (!clientInstances.has(instance.instanceId)) {
          const existingConfig: OpenCodeInstanceConfig = {
            id: instance.instanceId,
            name: basename(instance.projectPath),
            apiUrl: instance.apiUrl,
            projectPath: instance.projectPath,
            isDefault: false,
          };
          const client = createOpenCodeClientForInstance(existingConfig);
          clientInstances.set(instance.instanceId, client);
        }
        return { instanceId: instance.instanceId, apiUrl: instance.apiUrl };
      }
    }
  }
  
  return null;
}

const BLOCKED_PATHS = ['/root', '/home', '/etc', '/usr', '/bin', '/sbin', '/lib', '/var', '/tmp', '/boot'];

export function isPathAllowed(projectPath: string): { allowed: boolean; error?: string } {
  if (config.security.enableRootAccess) {
    return { allowed: true };
  }

  const normalized = normalize(projectPath);

  for (const allowed of config.security.allowedProjectPaths) {
    const normalizedAllowed = normalize(allowed);
    if (normalized === normalizedAllowed || normalized.startsWith(normalizedAllowed + sep)) {
      return { allowed: true };
    }
  }

  return { allowed: false, error: `Path not in allowed directories: ${projectPath}. Contact admin or use paths under: ${config.security.allowedProjectPaths.join(', ')}` };
}

export function validateProjectPath(projectPath: string): { valid: boolean; error?: string } {
  if (!projectPath || projectPath.trim() === '') {
    return { valid: false, error: 'Project path is required but not configured. Set OPENCODE_PROJECT_PATH in .env' };
  }

  if (!isAbsolute(projectPath)) {
    return { valid: false, error: `Project path must be absolute: ${projectPath}` };
  }

  const normalized = normalize(projectPath);
  if (normalized.includes('..') || normalized.includes('\0')) {
    return { valid: false, error: `Path traversal detected in: ${projectPath}` };
  }

  for (const blocked of BLOCKED_PATHS) {
    if (normalized === blocked || normalized.startsWith(blocked + sep)) {
      return { valid: false, error: `Cannot use system directory as project path: ${projectPath}` };
    }
  }

  const allowedCheck = isPathAllowed(projectPath);
  if (!allowedCheck.allowed) {
    return { valid: false, error: allowedCheck.error };
  }

  if (!existsSync(normalized)) {
    return { valid: false, error: `Project path does not exist: ${projectPath}` };
  }

  const stats = statSync(normalized);
  if (!stats.isDirectory()) {
    return { valid: false, error: `Project path is not a directory: ${projectPath}` };
  }

  const indicators = ['package.json', '.git', 'AGENTS.md', 'README.md', 'src', 'pyproject.toml', 'Cargo.toml'];
  const hasIndicator = indicators.some(ind => existsSync(join(normalized, ind)));
  if (!hasIndicator) {
    return { valid: false, error: `Directory does not appear to be a project (missing package.json, .git, etc.): ${projectPath}` };
  }

  return { valid: true };
}

export interface OpenCodeClient {
  instanceId: string;
  createSession: (title?: string, parentId?: string) => Promise<Session>;
  getSession: (sessionId: string) => Promise<Session | null>;
  listSessions: () => Promise<Session[]>;
  deleteSession: (sessionId: string) => Promise<boolean>;
  abortSession: (sessionId: string) => Promise<boolean>;
  sendPrompt: (sessionId: string, prompt: string) => Promise<void>;
  getMessages: (sessionId: string) => Promise<Message[]>;
  getProviders: () => Promise<ProviderInfo[]>;
  setProvider: (modelId: string) => Promise<boolean>;
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

export interface ProviderInfo {
  id: string;
  name: string;
  status: string;
  models: Array<{ id: string; name: string; status: string }>;
}

export type OpenCodeEvent =
  | { type: "message.updated"; properties: { info: MessageInfo } }
  | { type: "message.part.updated"; properties: { part: MessagePart; delta?: string } }
  | { type: "session.status"; properties: { sessionID: string; status: SessionStatus } }
  | { type: "permission.updated"; properties: Permission }
  | { type: "todo.updated"; properties: { sessionID: string; todos: Todo[] } }
  | { type: "session.error"; properties: { sessionID: string; error: string } };

export type OpenCodeEventWithInstance = OpenCodeEvent & { instanceId: string };

export interface MessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
}

export interface MessagePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text" | "reasoning" | "file" | "tool" | "step-start" | "step-finish";
  text?: string;
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

async function isOpenCodeRunning(apiUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${apiUrl}/session`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForOpenCode(apiUrl: string, maxRetries = 30, retryDelay = 1000): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    if (await isOpenCodeRunning(apiUrl)) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, retryDelay));
  }
  return false;
}

function spawnOpenCodeInstance(instanceConfig: OpenCodeInstanceConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    const { apiUrl, projectPath } = instanceConfig;

    const validation = validateProjectPath(projectPath);
    if (!validation.valid) {
      reject(new Error(`Cannot auto-start OpenCode: ${validation.error}`));
      return;
    }

    const portMatch = apiUrl.match(/:(\d+)/);
    const port = portMatch ? portMatch[1] : '3000';

    logger.info(`Starting OpenCode instance on port ${port} for project: ${projectPath}`);

    const opencodeProcess = spawn('opencode', ['serve', '--port', port, '--print-logs'], {
      cwd: projectPath,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    spawnedProcesses.set(instanceConfig.id, opencodeProcess);
    
    opencodeProcess.stdout?.on('data', (data) => {
      logger.debug(`OpenCode ${instanceConfig.id} stdout: ${data.toString().trim()}`);
    });
    
    opencodeProcess.stderr?.on('data', (data) => {
      logger.debug(`OpenCode ${instanceConfig.id} stderr: ${data.toString().trim()}`);
    });
    
    opencodeProcess.on('error', (error) => {
      logger.error(`Failed to start OpenCode ${instanceConfig.id}:`, error);
      spawnedProcesses.delete(instanceConfig.id);
      reject(error);
    });
    
    opencodeProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        logger.error(`OpenCode ${instanceConfig.id} exited with code ${code}`);
      }
      spawnedProcesses.delete(instanceConfig.id);
    });
    
    resolve();
  });
}

export function listProjects(): Array<{ name: string; path: string; exists: boolean }> {
  const seen = new Set<string>();
  const results: Array<{ name: string; path: string; exists: boolean }> = [];
  for (const base of config.security.allowedProjectPaths) {
    if (!existsSync(base)) continue;
    try {
      const entries = readdirSync(base, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = normalize(join(base, entry.name));
        if (seen.has(fullPath)) continue;
        seen.add(fullPath);
        results.push({ name: entry.name, path: fullPath, exists: true });
      }
    } catch {
      logger.warn(`Could not read directory: ${base}`);
    }
  }
  return results;
}

export function createProject(name: string): { path: string; error?: string } {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  if (!safeName) {
    return { path: '', error: 'Invalid project name' };
  }
  const base = config.security.allowedProjectPaths[0];
  const projectPath = join(base, safeName);

  if (existsSync(projectPath)) {
    return { path: projectPath, error: `Project "${safeName}" already exists` };
  }

  try {
    mkdirSync(projectPath, { recursive: true });
    execSync('git init', { cwd: projectPath, stdio: 'ignore' });
    logger.info(`Created project at ${projectPath}`);
    return { path: projectPath };
  } catch (err) {
    return { path: '', error: `Failed to create project: ${err instanceof Error ? err.message : err}` };
  }
}

async function findAvailablePort(startPort: number, maxAttempts = 100): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    try {
      const response = await fetch(`http://localhost:${port}/session`, { method: "HEAD", signal: AbortSignal.timeout(500) });
      if (!response.ok) return port;
    } catch {
      return port;
    }
  }
  throw new Error("No available ports found");
}

export async function launchOnProject(
  projectPath: string,
  onEvent?: (event: OpenCodeEvent, instanceId: string) => void
): Promise<{ instanceId: string; error?: string; unsubscribe?: () => void }> {
  const baseName = basename(projectPath);
  const instanceId = `project-${baseName}`;

  if (clientInstances.has(instanceId)) {
    return { instanceId };
  }

  const existing = await findExistingOpenCodeForPath(projectPath);
  if (existing) {
    return { instanceId: existing.instanceId };
  }

  let port: number;
  try {
    port = await findAvailablePort(3100);
  } catch {
    return { instanceId: "", error: "No available ports" };
  }

  const apiUrl = `http://localhost:${port}`;

  const fakeInstance: OpenCodeInstanceConfig = {
    id: instanceId,
    name: baseName,
    apiUrl,
    projectPath,
    isDefault: false,
  };

  logger.info(`Launching OpenCode on ${projectPath} at port ${port}`);

  try {
    await spawnOpenCodeInstance(fakeInstance);
    const started = await waitForOpenCode(apiUrl);
    if (!started) {
      return { instanceId: '', error: 'OpenCode did not start within timeout' };
    }
    const client = createOpenCodeClientForInstance(fakeInstance);
    clientInstances.set(instanceId, client);

    let unsubscribe: (() => void) | undefined;
    if (onEvent) {
      unsubscribe = await client.subscribeToEvents((event) => {
        onEvent(event, instanceId);
      });
    }

    return { instanceId, unsubscribe };
  } catch (err) {
    return { instanceId: '', error: err instanceof Error ? err.message : String(err) };
  }
}

export async function initializeOpenCodeClientsWithAutoStart(instances: OpenCodeInstanceConfig[]): Promise<void> {
  for (const instance of instances) {
    const isRunning = await isOpenCodeRunning(instance.apiUrl);

    if (!isRunning) {
      logger.info(`OpenCode instance ${instance.id} not running, auto-starting...`);
      try {
        await spawnOpenCodeInstance(instance);

        const started = await waitForOpenCode(instance.apiUrl);
        if (!started) {
          logger.error(`OpenCode instance ${instance.id} failed to start within timeout`);
          continue;
        }

        logger.info(`OpenCode instance ${instance.id} started successfully`);
      } catch (error) {
        logger.warn(`Could not auto-start OpenCode instance ${instance.id}: ${error instanceof Error ? error.message : error}`);
        logger.info("Please start OpenCode manually or add a valid project path");
      }
    } else {
      logger.info(`OpenCode instance ${instance.id} already running`);
    }

    const client = createOpenCodeClientForInstance(instance);
    clientInstances.set(instance.id, client);
  }
}

export function cleanupSpawnedProcesses(): void {
  for (const [id, process] of spawnedProcesses) {
    logger.info(`Terminating OpenCode process ${id}`);
    process.kill('SIGTERM');
  }
}

export function getOpenCodeClient(instanceId: string): OpenCodeClient {
  const client = clientInstances.get(instanceId);
  if (!client) {
    throw new Error(`Unknown OpenCode instance: ${instanceId}`);
  }
  return client;
}

export function createOpenCodeClientForInstance(instanceConfig: OpenCodeInstanceConfig): OpenCodeClient {
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

    const text = await response.text();
    
    if (!response.ok) {
      let errorMsg = `API request failed: ${response.status} ${response.statusText}`;
      if (text) {
        try {
          const json = JSON.parse(text);
          errorMsg += ` - ${json.message || json.error || text}`;
        } catch {
          errorMsg += ` - ${text.substring(0, 200)}`;
        }
      }
      throw new Error(errorMsg);
    }

    if (!text) {
      return {} as T;
    }

    return JSON.parse(text) as T;
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
      await apiRequest(`/session/${sessionId}/message`, {
        method: "POST",
        body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
      });
    },

    async getMessages(sessionId: string): Promise<Message[]> {
      try {
        const data = await apiRequest<Array<{ info: { id: string; sessionID: string; role: "user" | "assistant"; time: { created: number } }; parts: unknown[] }>>(`/session/${sessionId}/message`);
        return data.map((msg) => ({
          id: msg.info.id,
          sessionId: msg.info.sessionID,
          role: msg.info.role,
          content: "",
          createdAt: new Date(msg.info.time.created),
        }));
      } catch (error) {
        logger.error("Failed to get messages:", error);
        return [];
      }
    },

    async getProviders(): Promise<ProviderInfo[]> {
      try {
        const raw = await apiRequest<Record<string, unknown>>("/provider");
        const data = Array.isArray(raw) ? raw : (raw.all as Array<{ id: string; name: string; status: string; models: Record<string, unknown> }>) || [];
        return data.map((provider) => ({
          id: provider.id,
          name: provider.name,
          status: provider.status,
          models: Object.entries(provider.models || {}).map(([id, model]) => ({
            id,
            name: (model as { name?: string }).name || id,
            status: (model as { status?: string }).status || "unknown",
          })),
        }));
      } catch (error) {
        logger.error("Failed to get providers:", error);
        return [];
      }
    },

    async setProvider(modelId: string): Promise<boolean> {
      try {
        await apiRequest("/provider", {
          method: "POST",
          body: JSON.stringify({ modelId }),
        });
        return true;
      } catch (error) {
        logger.error("Failed to set provider:", error);
        return false;
      }
    },

    async subscribeToEvents(callback: (event: OpenCodeEvent) => void): Promise<() => void> {
      const abortController = new AbortController();

      const connect = async () => {
        try {
          const url = new URL("/event", baseUrl);
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
                  const raw = JSON.parse(line.slice(6));
                  const eventData: OpenCodeEvent = raw.payload ?? raw;
                  if (eventData.type) {
                    callback(eventData);
                  }
                } catch {}
              }
            }
          }
        } catch (error) {
          if ((error as Error).name !== "AbortError") {
            logger.error("Event stream error:", error);
          }
        }

        if (!abortController.signal.aborted) {
          logger.info("Event stream disconnected, reconnecting in 2s...");
          await new Promise(resolve => setTimeout(resolve, 2000));
          connect();
        }
      };

      connect();

      return () => {
        abortController.abort();
      };
    },
  };
}

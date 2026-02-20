export interface Storage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  keys(pattern?: string): Promise<string[]>;
}

export interface UserSessionState {
  userId: number;
  chatId: number;
  currentSessionId: string | null;
  currentInstanceId: string | null;
  sessions: SessionInfo[];
  lastActivity: Date;
}

export interface SessionInfo {
  id: string;
  title: string;
  instanceId: string;
  createdAt: Date;
  lastAccessed: Date;
}

export interface UserAddedProject {
  path: string;
  addedAt: Date;
  addedBy: number;
}

import type { Storage } from "./index.js";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";

export class RedisStorage implements Storage {
  private client: import("ioredis").Redis;

  constructor() {
    const Redis = require("ioredis");
    this.client = new Redis(config.storage.redisUrl);

    this.client.on("error", (err: Error) => {
      logger.error("Redis error:", err);
    });

    this.client.on("connect", () => {
      logger.info("Connected to Redis");
    });
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.client.get(key);
      if (!value) return null;
      return JSON.parse(value) as T;
    } catch (error) {
      logger.error(`Failed to get key ${key}:`, error);
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value));
    } catch (error) {
      logger.error(`Failed to set key ${key}:`, error);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (error) {
      logger.error(`Failed to delete key ${key}:`, error);
      throw error;
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      logger.error(`Failed to check key ${key}:`, error);
      return false;
    }
  }

  async keys(pattern = "*"): Promise<string[]> {
    try {
      return await this.client.keys(pattern);
    } catch (error) {
      logger.error(`Failed to get keys with pattern ${pattern}:`, error);
      return [];
    }
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}

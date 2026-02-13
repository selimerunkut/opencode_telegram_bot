import { z } from "zod";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), ".env") });

const instanceSchema = z.object({
  id: z.string().min(1, "Instance ID is required"),
  name: z.string().min(1, "Instance name is required"),
  apiUrl: z.string().url(),
  projectPath: z.string().min(1, "Project path is required"),
  isDefault: z.boolean().default(false),
});

const configSchema = z.object({
  telegram: z.object({
    botToken: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
    allowedUserIds: z.array(z.number()).min(1, "At least one allowed user ID required"),
  }),
  opencode: z.object({
    instances: z.array(instanceSchema).min(1, "At least one OpenCode instance required"),
    defaultInstanceId: z.string(),
  }),
  storage: z.object({
    redisUrl: z.string().default("redis://localhost:6379"),
    databaseUrl: z.string().default("sqlite://./data/bot.db"),
  }),
  bot: z.object({
    maxMessageLength: z.number().default(4000),
    messageChunkSize: z.number().default(3500),
    rateLimitMessages: z.number().default(30),
    sessionTimeoutMs: z.number().default(3600000),
    enableFileUploads: z.boolean().default(true),
    debugMode: z.boolean().default(false),
  }),
  webhook: z.object({
    url: z.string().optional(),
    port: z.number().default(3001),
  }),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    file: z.string().default("./logs/bot.log"),
  }),
});

export type Config = z.infer<typeof configSchema>;
export type OpenCodeInstanceConfig = z.infer<typeof instanceSchema>;

function parseUserIds(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .map((id) => parseInt(id, 10))
    .filter((id) => !isNaN(id));
}

function parseInstances(value: string | undefined): Array<{
  id: string;
  name: string;
  apiUrl: string;
  projectPath: string;
  isDefault: boolean;
}> {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    throw new Error("OPENCODE_INSTANCES must be a valid JSON array");
  }
  return [];
}

function getDefaultInstanceId(instances: Array<{ id: string; isDefault: boolean }>): string {
  const defaultInstance = instances.find((i) => i.isDefault);
  if (defaultInstance) {
    return defaultInstance.id;
  }
  if (instances.length > 0) {
    return instances[0].id;
  }
  throw new Error("No OpenCode instances configured");
}

function createConfig(): Config {
  const instances = parseInstances(process.env.OPENCODE_INSTANCES);

  if (instances.length === 0) {
    const singleInstance = {
      id: "default",
      name: "Default",
      apiUrl: process.env.OPENCODE_API_URL || "http://localhost:3000",
      projectPath: process.env.OPENCODE_PROJECT_PATH || "",
      isDefault: true,
    };
    instances.push(singleInstance);
  }

  const rawConfig = {
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      allowedUserIds: parseUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS),
    },
    opencode: {
      instances,
      defaultInstanceId: getDefaultInstanceId(instances),
    },
    storage: {
      redisUrl: process.env.REDIS_URL,
      databaseUrl: process.env.DATABASE_URL,
    },
    bot: {
      maxMessageLength: process.env.MAX_MESSAGE_LENGTH ? parseInt(process.env.MAX_MESSAGE_LENGTH, 10) : undefined,
      messageChunkSize: process.env.MESSAGE_CHUNK_SIZE ? parseInt(process.env.MESSAGE_CHUNK_SIZE, 10) : undefined,
      rateLimitMessages: process.env.RATE_LIMIT_MESSAGES ? parseInt(process.env.RATE_LIMIT_MESSAGES, 10) : undefined,
      sessionTimeoutMs: process.env.SESSION_TIMEOUT_MS ? parseInt(process.env.SESSION_TIMEOUT_MS, 10) : undefined,
      enableFileUploads: process.env.ENABLE_FILE_UPLOADS === "true",
      debugMode: process.env.DEBUG_MODE === "true",
    },
    webhook: {
      url: process.env.WEBHOOK_URL,
      port: process.env.WEBHOOK_PORT ? parseInt(process.env.WEBHOOK_PORT, 10) : undefined,
    },
    logging: {
      level: process.env.LOG_LEVEL as Config["logging"]["level"],
      file: process.env.LOG_FILE,
    },
  };

  const result = configSchema.safeParse(rawConfig);

  if (!result.success) {
    console.error("Configuration validation failed:");
    for (const error of result.error.errors) {
      console.error(`  - ${error.path.join(".")}: ${error.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

export const config = createConfig();

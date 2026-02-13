import winston from "winston";
import { config } from "../config/index.js";

const { combine, timestamp, printf, colorize, errors } = winston.format;

const consoleFormat = printf(({ level, message, timestamp, stack }) => {
  const ts = timestamp as string;
  const msg = message as string;
  const stk = stack as string | undefined;
  return `${ts} [${level}]: ${msg}${stk ? `\n${stk}` : ""}`;
});

export const logger = winston.createLogger({
  level: config.logging.level,
  defaultMeta: { service: "opencode-telegram-bot" },
  format: combine(
    timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    errors({ stack: true })
  ),
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize(),
        consoleFormat
      ),
    }),
    new winston.transports.File({
      filename: config.logging.file,
      format: consoleFormat,
    }),
  ],
});

export const logStream = {
  write: (message: string) => {
    logger.info(message.trim());
  },
};

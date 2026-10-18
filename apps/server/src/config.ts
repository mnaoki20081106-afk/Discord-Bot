import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  API_PUBLIC_URL: z.string().url().default("http://localhost:8787"),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  WEB_PUBLIC_URL: z.string().url().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_CLIENT_SECRET: z.string().min(1),
  DISCORD_TOKEN: z.string().min(1),
  SESSION_ENCRYPTION_KEY: z.string().min(1)
});

export const env = schema.parse(process.env);

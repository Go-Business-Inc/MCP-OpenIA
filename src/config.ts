import dotenv from "dotenv";
import { mkdirSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve, isAbsolute } from "path";

// Raíz del proyecto (dist/ → ..). El .env se lee desde aquí y no desde el cwd,
// porque Claude Desktop lanza el proceso con un cwd arbitrario.
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: join(PROJECT_ROOT, ".env"), quiet: true });

function projectPath(value: string | undefined, fallback: string): string {
  const p = value?.trim() || fallback;
  return isAbsolute(p) ? p : join(PROJECT_ROOT, p);
}

export const config = {
  defaultModel: process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2",
  outputDir: projectPath(process.env.OUTPUT_DIR, "output"),
  logFile: projectPath(process.env.LOG_FILE, "logs/uso.jsonl"),
  fontsDir: projectPath(process.env.FONTS_DIR, "fonts"),
};

// El fontconfig embebido en sharp no trae config propia ("Cannot load default config file").
// Se genera una mínima con rutas absolutas: las fuentes se registran por archivo al componer texto.
if (!process.env.FONTCONFIG_FILE) {
  const cacheDir = join(PROJECT_ROOT, ".cache");
  const confPath = join(cacheDir, "fonts.conf");
  try {
    mkdirSync(join(cacheDir, "fontconfig"), { recursive: true });
    writeFileSync(
      confPath,
      `<?xml version="1.0"?>\n<fontconfig>\n  <dir>${config.fontsDir}</dir>\n  <cachedir>${join(cacheDir, "fontconfig")}</cachedir>\n</fontconfig>\n`
    );
    process.env.FONTCONFIG_FILE = confPath;
  } catch (err) {
    console.error(`[mcp-openia] No se pudo preparar fontconfig: ${(err as Error).message}`);
  }
}

export function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      `OPENAI_API_KEY no está configurada. Agrégala en ${join(PROJECT_ROOT, ".env")} ` +
        `o en el bloque "env" de la config del MCP. Nunca la pegues en el chat.`
    );
  }
  return key;
}

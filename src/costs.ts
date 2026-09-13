import { appendFile, mkdir, readFile } from "fs/promises";
import { dirname } from "path";
import { config } from "./config.js";

// Precios estándar (no batch) en USD por 1M de tokens.
// Fuente: https://developers.openai.com/api/docs/pricing — revisado 2026-09-13.
// Si OpenAI cambia precios, actualizar esta tabla.
interface Pricing {
  textIn: number;
  imageIn: number;
  imageOut: number;
}

const PRICING: Record<string, Pricing> = {
  "gpt-image-2.5-sunburst": { textIn: 5, imageIn: 8, imageOut: 30 },
  "gpt-image-2.5-flare": { textIn: 5, imageIn: 8, imageOut: 30 },
  "gpt-image-2": { textIn: 5, imageIn: 8, imageOut: 30 },
  "gpt-image-1.5": { textIn: 5, imageIn: 8, imageOut: 32 },
  "chatgpt-image-latest": { textIn: 5, imageIn: 8, imageOut: 32 },
  "gpt-image-1-mini": { textIn: 2, imageIn: 2.5, imageOut: 8 },
  "gpt-image-1": { textIn: 5, imageIn: 10, imageOut: 40 },
};

function pricingFor(model: string): Pricing | undefined {
  if (PRICING[model]) return PRICING[model];
  // Snapshots con fecha (ej. gpt-image-2-2026-04-21) → modelo base más largo que coincida.
  const base = Object.keys(PRICING)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return base ? PRICING[base] : undefined;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { image_tokens?: number; text_tokens?: number };
  output_tokens_details?: { image_tokens?: number; text_tokens?: number };
}

/** Costo estimado en USD a partir del `usage` que devuelve OpenAI. null si no se puede calcular. */
export function estimateCost(model: string, usage: Usage | undefined): number | null {
  const p = pricingFor(model);
  if (!p || !usage) return null;
  const textIn = usage.input_tokens_details?.text_tokens ?? 0;
  const imageIn = usage.input_tokens_details?.image_tokens ?? 0;
  // Los tokens de salida de los modelos GPT Image son de imagen.
  const out = usage.output_tokens ?? 0;
  const cost = (textIn * p.textIn + imageIn * p.imageIn + out * p.imageOut) / 1_000_000;
  return Math.round(cost * 10_000) / 10_000;
}

export interface LogEntry {
  timestamp: string;
  tool: string;
  status: "ok" | "error";
  model: string;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: string;
  n?: number;
  reference_images?: number;
  mask?: boolean;
  duration_ms: number;
  usage?: Usage;
  estimated_cost_usd?: number | null;
  files?: string[];
  prompt_preview?: string;
  error?: string;
}

/** Agrega una línea JSON al log. Nunca escribe a stdout (stdio es el canal del protocolo MCP). */
export async function logCall(entry: LogEntry): Promise<void> {
  try {
    await mkdir(dirname(config.logFile), { recursive: true });
    await appendFile(config.logFile, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.error(`[mcp-openia] No se pudo escribir el log: ${(err as Error).message}`);
  }
  const cost = entry.estimated_cost_usd != null ? ` ~$${entry.estimated_cost_usd}` : "";
  console.error(
    `[mcp-openia] ${entry.tool} ${entry.status} model=${entry.model} size=${entry.size} ` +
      `quality=${entry.quality} n=${entry.n}${cost} ${entry.duration_ms}ms`
  );
}

export async function summarizeLog(days: number): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(config.logFile, "utf-8");
  } catch {
    return `Aún no hay llamadas registradas (${config.logFile}).`;
  }
  const since = Date.now() - days * 86_400_000;
  const entries = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as LogEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is LogEntry => !!e && Date.parse(e.timestamp) >= since);

  if (entries.length === 0) return `Sin llamadas en los últimos ${days} días.`;

  const byModel = new Map<string, { calls: number; errors: number; images: number; cost: number; noCost: number }>();
  for (const e of entries) {
    const m = byModel.get(e.model) ?? { calls: 0, errors: 0, images: 0, cost: 0, noCost: 0 };
    m.calls++;
    if (e.status === "error") m.errors++;
    m.images += e.files?.length ?? 0;
    if (e.estimated_cost_usd != null) m.cost += e.estimated_cost_usd;
    else if (e.status === "ok") m.noCost++;
    byModel.set(e.model, m);
  }

  const lines = [`Gasto estimado — últimos ${days} días (${entries.length} llamadas)`, ""];
  let total = 0;
  for (const [model, m] of byModel) {
    total += m.cost;
    lines.push(
      `• ${model}: ${m.calls} llamadas (${m.errors} con error), ${m.images} imágenes, ~$${m.cost.toFixed(4)}` +
        (m.noCost ? ` (+${m.noCost} sin datos de uso)` : "")
    );
  }
  lines.push("", `Total estimado: ~$${total.toFixed(4)} USD`, `Log: ${config.logFile}`);
  return lines.join("\n");
}

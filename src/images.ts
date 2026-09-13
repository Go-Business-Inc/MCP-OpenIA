import OpenAI, { toFile } from "openai";
import { mkdir, writeFile } from "fs/promises";
import { basename, dirname, join } from "path";
import sharp from "sharp";
import { config, getApiKey } from "./config.js";
import { estimateCost, logCall, type LogEntry, type Usage } from "./costs.js";
import { loadImage, loadMask } from "./inputs.js";
import { assertFonts, cropTo, encode, overlayText, preview, type CropTo, type OutputFormat, type TextOverlay } from "./postprocess.js";

let client: OpenAI | null = null;
function getClient(): OpenAI {
  client ??= new OpenAI({ apiKey: getApiKey(), organization: process.env.OPENAI_ORG_ID || undefined });
  return client;
}

export type Quality = "low" | "medium" | "high" | "xhigh" | "max" | "auto";

export interface CommonParams {
  prompt: string;
  model?: string;
  size?: string;
  quality?: Quality;
  background?: "opaque" | "transparent" | "auto";
  n?: number;
  output_format?: OutputFormat;
  output_compression?: number;
  crop_to?: CropTo;
  overlay_text?: TextOverlay[];
  nombre_archivo?: string;
  incluir_base64?: boolean;
  incluir_preview?: boolean;
}

export interface EditParams extends CommonParams {
  reference_images: string[];
  mask?: string;
  input_fidelity?: "high" | "low";
}

const SIZE_ALIASES: Record<string, string> = {
  cuadrada: "1024x1024",
  square: "1024x1024",
  apaisada: "1536x1024",
  horizontal: "1536x1024",
  landscape: "1536x1024",
  vertical: "1024x1536",
  portrait: "1024x1536",
};
const STANDARD_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536", "auto"]);

/** Error de validación local (antes de gastar una llamada a OpenAI). */
class ValidationError extends Error {}

function resolveSize(size: string | undefined, model: string): string {
  const s = SIZE_ALIASES[(size ?? "cuadrada").toLowerCase()] ?? (size ?? "").toLowerCase();
  if (STANDARD_SIZES.has(s)) return s;

  const m = s.match(/^(\d+)x(\d+)$/);
  if (!m) throw new ValidationError(`size "${size}" inválido. Usa cuadrada, apaisada, vertical, auto o ANCHOxALTO.`);
  if (!model.startsWith("gpt-image-2")) {
    throw new ValidationError(
      `El modelo ${model} solo soporta 1024x1024, 1536x1024, 1024x1536 o auto. ` +
        `Los tamaños libres (${s}) requieren gpt-image-2 o posterior; o usa crop_to para recortar.`
    );
  }
  const w = Number(m[1]);
  const h = Number(m[2]);
  const problems: string[] = [];
  if (w % 16 || h % 16) problems.push("ancho y alto deben ser múltiplos de 16");
  if (Math.max(w, h) / Math.min(w, h) > 3) problems.push("la proporción debe estar entre 1:3 y 3:1");
  if (Math.max(w, h) > 3840) problems.push("ningún lado puede superar 3840px");
  if (w * h < 655_360 || w * h > 8_294_400) problems.push("el total de píxeles debe estar entre 655,360 y 8,294,400");
  if (problems.length) throw new ValidationError(`size ${s} inválido para ${model}: ${problems.join("; ")}.`);
  return s;
}

function slug(text: string): string {
  return (
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "imagen"
  );
}

function stamp(d = new Date()): { day: string; time: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
  };
}

/** Convierte cualquier error (OpenAI, red, validación, sharp) en un objeto explícito para el agente. */
function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof OpenAI.APIError) {
    const msg = err.message ?? "";
    const policy =
      err.code === "moderation_blocked" ||
      err.code === "content_policy_violation" ||
      /safety system|content policy|moderation/i.test(msg);
    // OpenAI usa 429 tanto para rate limit (reintentable) como para falta de saldo (no reintentable).
    const noCredit =
      err.code === "insufficient_quota" ||
      err.code === "credit_balance_exhausted" ||
      err.type === "insufficient_quota" ||
      err.code === "billing_hard_limit_reached";
    if (noCredit) {
      return {
        tipo_error: "sin_saldo",
        http_status: err.status ?? null,
        codigo: err.code ?? null,
        mensaje: msg,
        request_id: err.requestID ?? null,
        reintentable: "no: la cuenta de OpenAI no tiene saldo o llegó a su límite de gasto; requiere acción humana en Billing.",
      };
    }
    return {
      tipo_error: policy ? "politica_contenido" : "api_openai",
      http_status: err.status ?? null,
      codigo: err.code ?? null,
      tipo: err.type ?? null,
      parametro: err.param ?? null,
      mensaje: msg,
      request_id: err.requestID ?? null,
      reintentable: policy ? "sí, con un prompt ajustado" : err.status === 429 || (err.status ?? 0) >= 500 ? "sí" : "no",
    };
  }
  if (err instanceof ValidationError) return { tipo_error: "validacion", mensaje: err.message, reintentable: "sí, corrigiendo parámetros" };
  if (err instanceof PostprocessError) {
    return {
      tipo_error: "postproceso",
      mensaje: err.message,
      imagenes_originales: err.originals,
      reintentable:
        "sí, SIN volver a generar: la imagen ya se pagó y está guardada en imagenes_originales; " +
        "usa componer_imagen con source = esa ruta y crop_to/overlay_text corregidos.",
    };
  }
  return { tipo_error: "local", mensaje: err instanceof Error ? err.message : String(err) };
}

type ToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

/** Falla del post-proceso cuando la imagen ya se generó (y se pagó): conserva las rutas de los originales. */
class PostprocessError extends Error {
  constructor(message: string, readonly originals: string[]) {
    super(message);
  }
}

interface FinishOptions {
  crop_to?: CropTo;
  overlay_text?: TextOverlay[];
  output_format: OutputFormat;
  output_compression?: number;
}

const needsPostprocess = (o: { crop_to?: CropTo; overlay_text?: TextOverlay[] }) => !!(o.crop_to || o.overlay_text?.length);

/** crop_to → overlay_text → codificación final. Si no hay post-proceso, devuelve el buffer tal cual. */
async function finish(buffer: Buffer, o: FinishOptions): Promise<Buffer> {
  if (!needsPostprocess(o)) return buffer;
  let out = buffer;
  if (o.crop_to) out = await cropTo(out, o.crop_to);
  if (o.overlay_text?.length) out = await overlayText(out, o.overlay_text);
  return encode(out, o.output_format, o.output_compression);
}

function outputTarget(nameHint: string): { dir: string; base: string } {
  const { day, time } = stamp();
  return { dir: join(config.outputDir, day), base: `${slug(nameHint)}-${time}` };
}

const extFor = (f: OutputFormat) => (f === "jpeg" ? "jpg" : f);

async function saveImage(
  buffer: Buffer,
  filePath: string,
  format: OutputFormat,
  includeBase64?: boolean
): Promise<Record<string, unknown>> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, buffer);
  const meta = await sharp(buffer).metadata();
  return {
    file_path: filePath,
    file_name: basename(filePath),
    mime_type: `image/${format}`,
    width: meta.width,
    height: meta.height,
    bytes: buffer.length,
    ...(includeBase64 ? { file_base64: buffer.toString("base64") } : {}),
  };
}

function successResult(summary: Record<string, unknown>, previews: string[], includeBase64?: boolean): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: true,
            ...summary,
            siguiente_paso:
              "Para adjuntar a una tarjeta de Pipefy usa upload_file_path con source_path = file_path (+ card_id y field_id)." +
              (includeBase64 ? " También puedes usar upload_file_base64 con file_name y file_base64." : ""),
          },
          null,
          2
        ),
      },
      ...previews.map((data) => ({ type: "image" as const, data, mimeType: "image/jpeg" })),
    ],
  };
}

export async function runImageJob(tool: "generar_imagen" | "generar_variacion", p: CommonParams | EditParams): Promise<ToolResult> {
  const started = Date.now();
  const model = p.model?.trim() || config.defaultModel;
  const n = p.n ?? 1;
  const quality = p.quality ?? "medium";
  const edit = tool === "generar_variacion" ? (p as EditParams) : null;

  const log: LogEntry = {
    timestamp: new Date().toISOString(),
    tool,
    status: "error",
    model,
    size: p.size,
    quality,
    background: p.background,
    n,
    reference_images: edit?.reference_images.length,
    mask: edit ? !!edit.mask : undefined,
    duration_ms: 0,
    prompt_preview: p.prompt.slice(0, 300),
  };

  try {
    // Validaciones locales primero, para no gastar una llamada que igual fallaría.
    const size = resolveSize(p.size, model);
    log.size = size;
    const outputFormat: OutputFormat = p.output_format ?? "png";
    if (p.background === "transparent" && outputFormat === "jpeg") {
      throw new ValidationError("background transparent requiere output_format png o webp (no jpeg).");
    }
    log.output_format = outputFormat;
    await assertFonts(p.overlay_text);

    const common = {
      model,
      prompt: p.prompt,
      size: size as "1024x1024",
      quality,
      n,
      output_format: outputFormat,
      ...(p.background ? { background: p.background } : {}),
      ...(p.output_compression != null && outputFormat !== "png" ? { output_compression: p.output_compression } : {}),
    };

    const openai = getClient();
    let response: OpenAI.ImagesResponse;

    if (edit) {
      const refs = await Promise.all(edit.reference_images.map((src, i) => loadImage(src, `reference_images[${i}]`)));
      const files = await Promise.all(refs.map((r) => toFile(r.buffer, r.name, { type: r.mime })));
      const mask = edit.mask ? await loadMask(edit.mask, refs[0].width, refs[0].height) : null;
      response = await openai.images.edit({
        ...common,
        image: files,
        ...(mask ? { mask: await toFile(mask.buffer, mask.name, { type: mask.mime }) } : {}),
        ...(edit.input_fidelity ? { input_fidelity: edit.input_fidelity } : {}),
      });
    } else {
      response = await openai.images.generate(common);
    }

    const usage = response.usage as Usage | undefined;
    log.usage = usage;
    log.estimated_cost_usd = estimateCost(model, usage);

    // Nunca devolver "éxito" sin imágenes reales.
    const items = response.data ?? [];
    if (items.length === 0) throw new Error("OpenAI respondió sin imágenes (data vacío). No se generó nada.");
    const raws = items.map((item, i) => {
      if (!item.b64_json) throw new Error(`OpenAI devolvió la imagen ${i + 1} sin contenido (b64_json vacío).`);
      return Buffer.from(item.b64_json, "base64");
    });
    for (const [i, raw] of raws.entries()) {
      await sharp(raw)
        .metadata()
        .catch(() => {
          throw new Error(`La imagen ${i + 1} devuelta por OpenAI no es un archivo de imagen válido.`);
        });
    }

    const { dir, base } = outputTarget(p.nombre_archivo || p.prompt.split(/\s+/).slice(0, 6).join(" "));
    const suffix = (i: number) => (raws.length > 1 ? `-${i + 1}` : "");
    const ext = extFor(outputFormat);

    // Si hay post-proceso, primero se guarda el original tal como vino de OpenAI: si el texto o el
    // recorte fallan, la imagen pagada no se pierde y se puede recomponer con componer_imagen.
    const originals: string[] = [];
    if (needsPostprocess(p)) {
      for (const [i, raw] of raws.entries()) {
        const path = join(dir, `${base}${suffix(i)}-original.${ext}`);
        await saveImage(raw, path, outputFormat);
        originals.push(path);
      }
    }

    const images: Array<Record<string, unknown>> = [];
    const previews: string[] = [];
    for (const [i, raw] of raws.entries()) {
      let final: Buffer;
      try {
        final = await finish(raw, { ...p, output_format: outputFormat });
      } catch (err) {
        throw new PostprocessError((err as Error).message, originals);
      }
      const saved = await saveImage(final, join(dir, `${base}${suffix(i)}.${ext}`), outputFormat, p.incluir_base64);
      if (originals[i]) saved.original_sin_postproceso = originals[i];
      if (items[i].revised_prompt) saved.revised_prompt = items[i].revised_prompt;
      images.push(saved);
      if (p.incluir_preview !== false) previews.push(await preview(final));
    }

    log.status = "ok";
    log.files = images.map((img) => img.file_path as string);
    log.duration_ms = Date.now() - started;
    await logCall(log);

    return successResult(
      {
        modelo: model,
        size,
        quality,
        output_format: outputFormat,
        ...(p.crop_to ? { crop_to: p.crop_to } : {}),
        costo_estimado_usd: log.estimated_cost_usd,
        usage: usage ?? null,
        duracion_ms: log.duration_ms,
        imagenes: images,
      },
      previews,
      p.incluir_base64
    );
  } catch (err) {
    const detail = describeError(err);
    log.error = String(detail.mensaje);
    log.duration_ms = Date.now() - started;
    if (err instanceof PostprocessError) log.files = err.originals;
    await logCall(log);
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ ok: false, herramienta: tool, modelo: model, ...detail }, null, 2) }],
    };
  }
}

export interface ComposeParams {
  source: string;
  crop_to?: CropTo;
  overlay_text?: TextOverlay[];
  output_format?: OutputFormat;
  output_compression?: number;
  nombre_archivo?: string;
  incluir_base64?: boolean;
  incluir_preview?: boolean;
}

/** Recorte + texto sobre una imagen ya existente. No llama a OpenAI (costo cero). */
export async function runCompose(p: ComposeParams): Promise<ToolResult> {
  try {
    if (!needsPostprocess(p)) throw new ValidationError("Indica crop_to y/o overlay_text.");
    await assertFonts(p.overlay_text);
    const img = await loadImage(p.source, "source");
    const format: OutputFormat = p.output_format ?? (img.mime === "image/jpeg" ? "jpeg" : img.mime === "image/webp" ? "webp" : "png");
    const final = await finish(img.buffer, { ...p, output_format: format });
    const { dir, base } = outputTarget(p.nombre_archivo || img.name.replace(/\.[^.]+$/, "") + "-compuesta");
    const saved = await saveImage(final, join(dir, `${base}.${extFor(format)}`), format, p.incluir_base64);
    const previews = p.incluir_preview !== false ? [await preview(final)] : [];
    return successResult({ costo_estimado_usd: 0, imagenes: [saved] }, previews, p.incluir_base64);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ ok: false, herramienta: "componer_imagen", ...describeError(err) }, null, 2) }],
    };
  }
}

export async function listImageModels(): Promise<string[]> {
  const models = await getClient().models.list();
  const ids: string[] = [];
  for await (const m of models) if (/image/i.test(m.id)) ids.push(m.id);
  return ids.sort();
}

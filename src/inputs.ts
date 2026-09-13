import { readFile, stat } from "fs/promises";
import { homedir } from "os";
import { basename, extname } from "path";
import sharp, { type Metadata } from "sharp";

const MAX_IMAGE_BYTES = 50 * 1024 * 1024; // límite de OpenAI por imagen de referencia
const MAX_MASK_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

export interface LoadedImage {
  buffer: Buffer;
  name: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}

/** Oculta la query string (firmas de URLs de Pipefy/S3) al reportar errores. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return url.slice(0, 80);
  }
}

function describe(source: string): string {
  if (/^https?:\/\//i.test(source)) return redactUrl(source);
  if (source.startsWith("data:")) return "data URL";
  if (source.length > 200) return `base64 (${source.length} caracteres)`;
  return source;
}

async function fetchImage(url: string): Promise<{ buffer: Buffer; name: string }> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`No se pudo descargar ${redactUrl(url)}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 401 ? " (¿URL firmada expirada? Pide una nueva a Pipefy)" : "";
    throw new Error(`Descarga de ${redactUrl(url)} falló con HTTP ${res.status} ${res.statusText}${hint}`);
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES) throw new Error(`${redactUrl(url)} pesa ${declared} bytes (máx. 50MB)`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const name = decodeURIComponent(basename(new URL(url).pathname)) || "referencia";
  return { buffer, name };
}

async function readRaw(source: string): Promise<{ buffer: Buffer; name: string }> {
  const s = source.trim();

  if (/^https?:\/\//i.test(s)) return fetchImage(s);

  const dataUrl = s.match(/^data:[^;,]+;base64,(.*)$/s);
  if (dataUrl) return { buffer: Buffer.from(dataUrl[1], "base64"), name: "referencia" };

  // Un base64 de JPEG empieza con "/9j/", así que las cadenas largas se tratan como base64, no como ruta.
  const clean = s.replace(/\s+/g, "");
  const looksLikeBase64 = clean.length > 1024 && /^[A-Za-z0-9+/_-]+=*$/.test(clean);
  const looksLikePath = !looksLikeBase64 && (/^(\/|~\/|\.\.?\/)/.test(s) || /\.(png|jpe?g|webp|gif|heic|avif|tiff?)$/i.test(s));
  if (looksLikePath) {
    const path = s.startsWith("~/") ? homedir() + s.slice(1) : s;
    try {
      await stat(path);
    } catch {
      throw new Error(`Archivo no encontrado: ${path}`);
    }
    return { buffer: await readFile(path), name: basename(path) };
  }

  // Base64 "pelado".
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(clean)) {
    throw new Error(`No se reconoce la fuente de imagen "${describe(s)}": no es URL, ruta local, data URL ni base64 válido`);
  }
  return { buffer: Buffer.from(clean, "base64"), name: "referencia" };
}

/**
 * Carga una imagen desde URL (incluidas URLs firmadas de Pipefy), ruta local, data URL o base64.
 * Formatos que OpenAI no acepta (gif, heic, avif, tiff…) se convierten a PNG.
 */
export async function loadImage(source: string, label: string): Promise<LoadedImage> {
  const { buffer, name } = await readRaw(source);
  if (buffer.length === 0) throw new Error(`${label}: la imagen está vacía (${describe(source)})`);
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`${label}: pesa ${buffer.length} bytes (máx. 50MB)`);

  let meta: Metadata;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    throw new Error(`${label}: el contenido no es una imagen válida (${describe(source)})`);
  }

  const stem = basename(name, extname(name)) || "referencia";
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  if (meta.format === "png") return { buffer, name: `${stem}.png`, mime: "image/png", width, height };
  if (meta.format === "jpeg") return { buffer, name: `${stem}.jpg`, mime: "image/jpeg", width, height };
  if (meta.format === "webp") return { buffer, name: `${stem}.webp`, mime: "image/webp", width, height };

  const png = await sharp(buffer).png().toBuffer();
  return { buffer: png, name: `${stem}.png`, mime: "image/png", width, height };
}

/**
 * Prepara la máscara para OpenAI: PNG con canal alfa, mismas dimensiones que la primera referencia.
 * Las zonas transparentes (alfa 0) son las que el modelo edita. Si la máscara no tiene alfa
 * (máscara blanco/negro), se interpreta BLANCO = zona a editar y se convierte a alfa.
 */
export async function loadMask(source: string, width: number, height: number): Promise<LoadedImage> {
  const { buffer } = await readRaw(source);
  const img = sharp(buffer);
  const meta = await img.metadata().catch(() => {
    throw new Error(`mask: el contenido no es una imagen válida (${describe(source)})`);
  });

  let rgba: Buffer;
  if (meta.hasAlpha) {
    rgba = await img.resize(width, height, { fit: "fill" }).ensureAlpha().png().toBuffer();
  } else {
    // Blanco → transparente (editar), negro → opaco (conservar).
    const alpha = await sharp(buffer).resize(width, height, { fit: "fill" }).greyscale().negate().raw().toBuffer();
    rgba = await sharp({ create: { width, height, channels: 3, background: "#000000" } })
      .joinChannel(alpha, { raw: { width, height, channels: 1 } })
      .png()
      .toBuffer();
  }

  if (rgba.length > MAX_MASK_BYTES) {
    rgba = await sharp(rgba).png({ compressionLevel: 9, palette: true }).toBuffer();
    if (rgba.length > MAX_MASK_BYTES) throw new Error(`mask: pesa ${rgba.length} bytes tras convertirla (máx. 4MB)`);
  }
  return { buffer: rgba, name: "mask.png", mime: "image/png", width, height };
}

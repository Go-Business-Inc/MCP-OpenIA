import { readdir } from "fs/promises";
import { homedir } from "os";
import { basename, extname, join } from "path";
import sharp, { type OverlayOptions } from "sharp";
import { config } from "./config.js";

export type OutputFormat = "png" | "jpeg" | "webp";

export interface CropTo {
  width: number;
  height: number;
  position?: "centre" | "top" | "bottom" | "left" | "right" | "attention" | "entropy";
}

export interface TextOverlay {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  fontFamily: string;
  color: string;
  fontWeight?: string | number;
  maxWidth?: number;
  align?: "left" | "center" | "right";
}

// ─── Fuentes ──────────────────────────────────────────────────────────────────

const WEIGHT_NAMES: Record<number, string[]> = {
  100: ["thin", "hairline"],
  200: ["extralight", "ultralight"],
  300: ["light"],
  400: ["regular", "normal", "book", ""],
  500: ["medium"],
  600: ["semibold", "demibold"],
  700: ["bold"],
  800: ["extrabold", "ultrabold"],
  900: ["black", "heavy"],
};

function normalizeWeight(w: string | number | undefined): number {
  if (w === undefined || w === "") return 400;
  const n = Number(w);
  if (Number.isFinite(n)) return Math.min(900, Math.max(100, Math.round(n / 100) * 100));
  const key = String(w).toLowerCase().replace(/[^a-z]/g, "");
  for (const [num, names] of Object.entries(WEIGHT_NAMES)) if (names.includes(key)) return Number(num);
  throw new Error(`fontWeight "${w}" no reconocido. Usa 100-900 o un nombre (Regular, Medium, SemiBold, Bold, ExtraBold…)`);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

let fontIndex: string[] | null = null;

async function listFonts(): Promise<string[]> {
  if (fontIndex) return fontIndex;
  const dirs = [
    config.fontsDir,
    join(homedir(), "Library/Fonts"),
    "/Library/Fonts",
    "/System/Library/Fonts",
    "/System/Library/Fonts/Supplemental",
  ];
  const files: string[] = [];
  for (const dir of dirs) {
    try {
      for (const f of await readdir(dir)) if (/\.(ttf|otf|ttc)$/i.test(f)) files.push(join(dir, f));
    } catch {
      // carpeta inexistente
    }
  }
  fontIndex = files;
  return files;
}

/**
 * Busca el archivo de la fuente pedida. Prioriza el archivo estático del peso exacto
 * (ej. Manrope-ExtraBold.ttf, Inter_24pt-Bold.ttf) y si no, la fuente variable de la familia.
 * Si no existe, lanza error: nunca se cae a otra fuente en silencio.
 */
async function resolveFont(family: string, weight: number): Promise<string> {
  const fam = norm(family);
  const weightNames = WEIGHT_NAMES[weight];
  let variable: string | undefined;

  for (const file of await listFonts()) {
    const stem = norm(basename(file, extname(file)));
    if (!stem.startsWith(fam)) continue;
    const rest = stem.slice(fam.length).replace(/^\d+pt/, ""); // Inter_18pt-Bold → "bold"
    if (weightNames.includes(rest)) return file;
    if (!variable && (rest.startsWith("variablefont") || rest.startsWith("wght") || rest === "")) variable = file;
  }
  if (variable) return variable;

  throw new Error(
    `Fuente "${family}" (peso ${weight}) no encontrada. Copia los .ttf de la familia en ${config.fontsDir} ` +
      `(o instálala en ~/Library/Fonts) y reintenta.`
  );
}

/** Verifica que existan todas las fuentes antes de gastar una llamada a OpenAI. */
export async function assertFonts(overlays: TextOverlay[] | undefined): Promise<void> {
  for (const o of overlays ?? []) await resolveFont(o.fontFamily, normalizeWeight(o.fontWeight));
}

// ─── Operaciones ──────────────────────────────────────────────────────────────

export async function cropTo(buffer: Buffer, crop: CropTo): Promise<Buffer> {
  return sharp(buffer)
    .resize(crop.width, crop.height, { fit: "cover", position: crop.position ?? "centre" })
    .png() // intermedio sin pérdida; el formato final se aplica en encode()
    .toBuffer();
}

const escapeMarkup = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function renderText(o: TextOverlay): Promise<{ png: Buffer; width: number; height: number }> {
  const weight = normalizeWeight(o.fontWeight);
  const fontfile = await resolveFont(o.fontFamily, weight);
  const markup =
    `<span foreground="${escapeMarkup(o.color)}" font_weight="${weight}">` + escapeMarkup(o.text) + `</span>`;

  // dpi 72 → 1pt = 1px, así fontSize se interpreta en píxeles.
  const img = sharp({
    text: {
      text: markup,
      font: `${o.fontFamily} ${o.fontSize}`,
      fontfile,
      rgba: true,
      dpi: 72,
      width: o.maxWidth,
      align: o.align === "center" ? "centre" : (o.align ?? "left"),
      wrap: "word",
    },
  });
  const png = await img.png().toBuffer();
  const meta = await sharp(png).metadata();
  return { png, width: meta.width ?? 0, height: meta.height ?? 0 };
}

export async function overlayText(buffer: Buffer, overlays: TextOverlay[]): Promise<Buffer> {
  const base = sharp(buffer);
  const { width: W = 0, height: H = 0 } = await base.metadata();
  const layers: OverlayOptions[] = [];

  for (const [i, o] of overlays.entries()) {
    const { png, width, height } = await renderText(o);
    // Con maxWidth + align, alineamos el bloque dentro de la caja [x, x+maxWidth].
    let left = o.x;
    if (o.maxWidth && o.align === "center") left = o.x + Math.round((o.maxWidth - width) / 2);
    if (o.maxWidth && o.align === "right") left = o.x + (o.maxWidth - width);
    const top = o.y;

    if (left < 0 || top < 0 || left + width > W || top + height > H) {
      throw new Error(
        `overlay_text[${i}] ("${o.text.slice(0, 40)}") se sale de la imagen: el bloque mide ${width}x${height}px ` +
          `en (${left}, ${top}) y la imagen es ${W}x${H}px. Reduce fontSize, usa maxWidth o ajusta x/y.`
      );
    }
    layers.push({ input: png, left, top });
  }
  return base.composite(layers).png().toBuffer();
}

export async function encode(buffer: Buffer, format: OutputFormat, compression?: number): Promise<Buffer> {
  const img = sharp(buffer);
  if (format === "jpeg") return img.jpeg({ quality: compression ?? 92, mozjpeg: true }).toBuffer();
  if (format === "webp") return img.webp({ quality: compression ?? 92 }).toBuffer();
  return img.png().toBuffer();
}

/** Miniatura JPEG liviana para que el agente pueda revisar visualmente el resultado. */
export async function preview(buffer: Buffer): Promise<string> {
  const out = await sharp(buffer)
    .resize(512, 512, { fit: "inside" })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 70 })
    .toBuffer();
  return out.toString("base64");
}

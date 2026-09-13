import { readdir } from "fs/promises";
import { homedir } from "os";
import { basename, extname, join } from "path";
import sharp, { type OverlayOptions } from "sharp";
import * as fontkit from "fontkit";
import type { Font } from "fontkit";
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

/** Fuerza a releer las carpetas de fuentes en la próxima búsqueda (ej. tras instalar una). */
export function invalidateFontIndex(): void {
  fontIndex = null;
}

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
  const found = findFont(await listFonts(), family, weight);
  if (found) return found;

  // Puede que la fuente se haya agregado después de arrancar: se vuelve a leer la carpeta una vez.
  fontIndex = null;
  const rescanned = findFont(await listFonts(), family, weight);
  if (rescanned) return rescanned;

  throw new Error(
    `Fuente "${family}" (peso ${weight}) no encontrada. Copia los .ttf de la familia en ${config.fontsDir} ` +
      `(o instálala en ~/Library/Fonts) y reintenta.`
  );
}

function findFont(files: string[], family: string, weight: number): string | undefined {
  const fam = norm(family);
  const weightNames = WEIGHT_NAMES[weight];
  let variable: string | undefined;
  let collection: string | undefined;

  for (const file of files) {
    const stem = norm(basename(file, extname(file)));
    if (!stem.startsWith(fam)) continue;
    const rest = stem.slice(fam.length).replace(/^\d+pt/, ""); // Inter_18pt-Bold → "bold"
    if (weightNames.includes(rest)) return file;
    // Variables: Manrope[wght].ttf, Inter[opsz,wght].ttf, Manrope-VariableFont_wght.ttf
    if (!variable && /^(variablefont)?(opsz|wght|ital|wdth|slnt)*$/.test(rest)) variable = file;
    // Colecciones del sistema (Helvetica.ttc) traen varios pesos en un archivo.
    if (!collection && rest === "" && extname(file).toLowerCase() === ".ttc") collection = file;
  }
  return variable ?? collection;
}

const fontCache = new Map<string, Font>();

/** Abre la fuente con fontkit y fija el peso (y el tamaño óptico, si la fuente variable lo tiene). */
async function loadFont(family: string, weight: number, fontSize: number): Promise<Font> {
  const file = await resolveFont(family, weight);
  const key = `${file}|${weight}|${Math.round(fontSize)}`;
  const cached = fontCache.get(key);
  if (cached) return cached;

  const opened = fontkit.openSync(file);
  let font: Font;
  if ("fonts" in opened) {
    const fam = norm(family);
    const members = opened.fonts.filter((f) => norm(f.familyName) === fam);
    const names = WEIGHT_NAMES[weight];
    font =
      members.find((f) => names.includes(norm(f.subfamilyName))) ??
      members.find((f) => ["regular", "roman"].includes(norm(f.subfamilyName))) ??
      members[0] ??
      opened.fonts[0];
  } else {
    font = opened;
  }

  const axes = font.variationAxes ?? {};
  const settings: Record<string, number> = {};
  const clamp = (v: number, a: { min: number; max: number }) => Math.min(a.max, Math.max(a.min, v));
  if (axes.wght) settings.wght = clamp(weight, axes.wght);
  if (axes.opsz) settings.opsz = clamp(fontSize, axes.opsz);
  if (Object.keys(settings).length) font = font.getVariation(settings);

  fontCache.set(key, font);
  return font;
}

/** Verifica que existan todas las fuentes antes de gastar una llamada a OpenAI. */
export async function assertFonts(overlays: TextOverlay[] | undefined): Promise<void> {
  for (const o of overlays ?? []) await loadFont(o.fontFamily, normalizeWeight(o.fontWeight), o.fontSize);
}

// ─── Operaciones ──────────────────────────────────────────────────────────────

export async function cropTo(buffer: Buffer, crop: CropTo): Promise<Buffer> {
  return sharp(buffer)
    .resize(crop.width, crop.height, { fit: "cover", position: crop.position ?? "centre" })
    .png() // intermedio sin pérdida; el formato final se aplica en encode()
    .toBuffer();
}

/** Corta el texto en líneas que quepan en maxWidth (por palabras). Respeta los \n explícitos. */
function wrapLines(font: Font, text: string, scale: number, maxWidth?: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!maxWidth) {
      lines.push(paragraph);
      continue;
    }
    let current = "";
    for (const word of paragraph.split(/ +/)) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && font.layout(candidate).advanceWidth * scale > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

/**
 * Dibuja el texto convirtiendo cada glifo del archivo de fuente en un contorno vectorial (fontkit → SVG).
 * No depende de las fuentes instaladas en el sistema: el render de texto de sharp en macOS usa CoreText
 * e ignora el archivo indicado, cayendo en silencio a Helvetica.
 */
async function renderText(o: TextOverlay): Promise<{ png: Buffer; width: number; height: number }> {
  if (!/^(#[0-9a-f]{3,8}|[a-z]+)$/i.test(o.color)) throw new Error(`color "${o.color}" inválido. Usa hex (#FF7200) o un nombre CSS.`);

  const weight = normalizeWeight(o.fontWeight);
  const font = await loadFont(o.fontFamily, weight, o.fontSize);
  const scale = o.fontSize / font.unitsPerEm;

  const missing = [...new Set([...o.text.replace(/\s/g, "")].filter((ch) => !font.hasGlyphForCodePoint(ch.codePointAt(0)!)))];
  if (missing.length) {
    throw new Error(`La fuente ${o.fontFamily} no tiene estos caracteres: ${missing.join(" ")}. Quítalos o usa otra fuente.`);
  }

  const ascent = font.ascent * scale;
  const lineHeight = (font.ascent - font.descent + font.lineGap) * scale;
  const lines = wrapLines(font, o.text, scale, o.maxWidth).map((text) => {
    const run = font.layout(text);
    return { run, width: run.advanceWidth * scale };
  });
  const boxWidth = o.maxWidth ?? Math.max(...lines.map((l) => l.width));

  const paths: string[] = [];
  for (const [i, { run, width }] of lines.entries()) {
    const x0 = o.align === "center" ? (boxWidth - width) / 2 : o.align === "right" ? boxWidth - width : 0;
    const baseline = ascent + i * lineHeight;
    let cursor = 0;
    for (const [j, glyph] of run.glyphs.entries()) {
      const pos = run.positions[j];
      const d = glyph.path.toSVG();
      if (d) {
        const gx = x0 + (cursor + pos.xOffset) * scale;
        const gy = baseline - pos.yOffset * scale;
        paths.push(`<path transform="translate(${gx.toFixed(2)} ${gy.toFixed(2)}) scale(${scale} ${-scale})" d="${d}"/>`);
      }
      cursor += pos.xAdvance;
    }
  }

  const width = Math.ceil(boxWidth);
  const height = Math.ceil(lines.length * lineHeight);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<g fill="${o.color}">${paths.join("")}</g></svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return { png, width, height };
}

export async function overlayText(buffer: Buffer, overlays: TextOverlay[]): Promise<Buffer> {
  const base = sharp(buffer);
  const { width: W = 0, height: H = 0 } = await base.metadata();
  const layers: OverlayOptions[] = [];

  for (const [i, o] of overlays.entries()) {
    const { png, width, height } = await renderText(o);
    const left = o.x;
    const top = o.y;
    if (left + width > W || top + height > H) {
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

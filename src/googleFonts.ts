import { mkdir, readdir, writeFile } from "fs/promises";
import { join } from "path";
import * as fontkit from "fontkit";
import { config } from "./config.js";
import { invalidateFontIndex } from "./postprocess.js";

// Repositorio oficial de Google Fonts. Es la única fuente de descarga permitida.
const REPO_API = "https://api.github.com/repos/google/fonts/contents";
const LICENSE_DIRS = ["ofl", "apache", "ufl"];
const MAX_FONT_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

interface RepoEntry {
  name: string;
  type: "file" | "dir";
  size: number;
  download_url: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function listFamilyDir(slug: string): Promise<{ dir: string; entries: RepoEntry[] } | null> {
  for (const dir of LICENSE_DIRS) {
    const res = await fetch(`${REPO_API}/${dir}/${slug}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "mcp-openia" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) continue;
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0);
      const when = reset ? ` Se libera a las ${new Date(reset * 1000).toLocaleTimeString()}.` : "";
      throw new Error(`GitHub limitó las consultas (HTTP ${res.status}).${when}`);
    }
    if (!res.ok) throw new Error(`GitHub respondió HTTP ${res.status} al buscar ${dir}/${slug}`);
    const entries = (await res.json()) as RepoEntry[];
    if (Array.isArray(entries)) return { dir, entries };
  }
  return null;
}

async function download(entry: RepoEntry): Promise<Buffer> {
  const url = new URL(entry.download_url ?? "");
  // Solo archivos del repo google/fonts servidos por GitHub.
  if (url.hostname !== "raw.githubusercontent.com" || !url.pathname.startsWith("/google/fonts/")) {
    throw new Error(`URL de descarga inesperada para ${entry.name}; se cancela por seguridad.`);
  }
  if (entry.size > MAX_FONT_BYTES) throw new Error(`${entry.name} pesa ${entry.size} bytes (máx. 20MB).`);
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Descarga de ${entry.name} falló con HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function describeWeights(buffer: Buffer): { familyName: string; weights: string } {
  const font = fontkit.create(buffer);
  const f = "fonts" in font ? font.fonts[0] : font;
  const wght = f.variationAxes?.wght;
  return {
    familyName: f.familyName,
    weights: wght ? `${wght.min}–${wght.max} (variable)` : f.subfamilyName,
  };
}

export interface InstallResult {
  familia: string;
  ya_instalada: boolean;
  archivos: string[];
  pesos: string[];
  licencia: string | null;
}

/**
 * Descarga una familia de Google Fonts (repo oficial google/fonts) a la carpeta de fuentes.
 * Prefiere la fuente variable sin itálica; si no hay, baja los archivos estáticos sin itálica.
 */
export async function installGoogleFont(family: string): Promise<InstallResult> {
  const slug = norm(family);
  if (!slug) throw new Error("Indica el nombre de la familia, ej. 'Playfair Display'.");

  await mkdir(config.fontsDir, { recursive: true });
  const existing = (await readdir(config.fontsDir)).filter(
    (f) => /\.(ttf|otf)$/i.test(f) && norm(f.replace(/\.[^.]+$/, "")).startsWith(slug)
  );
  if (existing.length) {
    return { familia: family, ya_instalada: true, archivos: existing.map((f) => join(config.fontsDir, f)), pesos: [], licencia: null };
  }

  const found = await listFamilyDir(slug);
  if (!found) {
    throw new Error(
      `"${family}" no existe en Google Fonts (se buscó ${LICENSE_DIRS.map((d) => `${d}/${slug}`).join(", ")}). ` +
        `Revisa el nombre exacto en fonts.google.com. Las fuentes comerciales hay que comprarlas e instalarlas a mano.`
    );
  }

  const ttfs = found.entries.filter((e) => e.type === "file" && /\.ttf$/i.test(e.name) && !/italic/i.test(e.name));
  const variable = ttfs.filter((e) => e.name.includes("["));
  const selected = variable.length ? variable : ttfs;
  if (selected.length === 0) throw new Error(`La familia "${family}" no tiene archivos .ttf sin itálica en Google Fonts.`);

  // Se descarga y valida todo antes de escribir, para no dejar instalaciones a medias.
  const files: Array<{ name: string; buffer: Buffer }> = [];
  const weights: string[] = [];
  let familyName = family;
  for (const entry of selected) {
    const buffer = await download(entry);
    let info: { familyName: string; weights: string };
    try {
      info = describeWeights(buffer);
    } catch {
      throw new Error(`${entry.name} no es un archivo de fuente válido; no se instaló nada.`);
    }
    familyName = info.familyName;
    weights.push(info.weights);
    files.push({ name: entry.name, buffer });
  }

  const licenseEntry = found.entries.find((e) => e.type === "file" && /^(OFL|LICENSE|UFL)\.txt$/i.test(e.name));
  let licensePath: string | null = null;
  if (licenseEntry) {
    const base = licenseEntry.name.replace(/\.txt$/i, "");
    licensePath = join(config.fontsDir, `${base}-${familyName.replace(/[^A-Za-z0-9]/g, "")}.txt`);
    await writeFile(licensePath, await download(licenseEntry));
  }

  const paths: string[] = [];
  for (const f of files) {
    const path = join(config.fontsDir, f.name);
    await writeFile(path, f.buffer);
    paths.push(path);
  }
  invalidateFontIndex();

  return { familia: familyName, ya_instalada: false, archivos: paths, pesos: weights, licencia: licensePath ? `${found.dir.toUpperCase()} (${licensePath})` : null };
}

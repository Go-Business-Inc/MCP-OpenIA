#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "./config.js";
import { summarizeLog } from "./costs.js";
import { listImageModels, runCompose, runImageJob } from "./images.js";

const server = new McpServer({ name: "openai-images", version: "1.0.0" });

// ─── Esquemas compartidos ────────────────────────────────────────────────────

const commonShape = {
  prompt: z
    .string()
    .min(1)
    .describe("Prompt en inglés. Se envía tal cual a OpenAI (incluye aquí colores/estilo de marca)."),
  size: z
    .string()
    .optional()
    .describe(
      "cuadrada (1024x1024, default) | apaisada (1536x1024, 3:2) | vertical (1024x1536, 2:3) | auto. " +
        "Con gpt-image-2+ también ANCHOxALTO libre (múltiplos de 16, proporción 1:3–3:1, ej. 1280x720 o 1536x864)."
    ),
  quality: z
    .enum(["low", "medium", "high", "xhigh", "max", "auto"])
    .optional()
    .describe("low | medium (default) | high. xhigh/max solo en gpt-image-2.5-*. Recomendado high para la imagen maestra del Tema."),
  background: z.enum(["opaque", "transparent", "auto"]).optional().describe("Fondo. transparent requiere output_format png o webp."),
  n: z.number().int().min(1).max(10).optional().describe("Cantidad de variantes (1-10). Default 1."),
  model: z
    .string()
    .optional()
    .describe(`Modelo de OpenAI. Default: ${config.defaultModel}. Ej: gpt-image-2, gpt-image-2.5-flare, gpt-image-1.5, gpt-image-1-mini.`),
  output_format: z.enum(["png", "jpeg", "webp"]).optional().describe("Formato del archivo final. Default png."),
  output_compression: z.number().int().min(0).max(100).optional().describe("Calidad 0-100 para jpeg/webp."),
  crop_to: z
    .object({
      width: z.number().int().min(16).max(8000),
      height: z.number().int().min(16).max(8000),
      position: z
        .enum(["centre", "top", "bottom", "left", "right", "attention", "entropy"])
        .optional()
        .describe("Qué zona conservar al recortar. centre (default); attention = zona más llamativa."),
    })
    .optional()
    .describe("Recorta/redimensiona el resultado a estas dimensiones exactas (ej. 1280x720 para thumbnail de YouTube)."),
  overlay_text: z
    .array(
      z.object({
        text: z.string().min(1).describe("Texto. Usa \\n para saltos de línea."),
        x: z.number().int().min(0).describe("Px desde la izquierda (esquina superior izquierda del bloque, o de la caja si hay maxWidth)."),
        y: z.number().int().min(0).describe("Px desde arriba."),
        fontSize: z.number().min(4).max(1000).describe("Tamaño en px."),
        fontFamily: z.string().describe("Familia real, ej. Manrope o Inter. Debe estar en fonts/ o instalada; si no, error."),
        color: z.string().describe("Color hex, ej. #FF7200 o #35393E."),
        fontWeight: z.union([z.string(), z.number()]).optional().describe("100-900 o nombre (Regular, SemiBold, Bold, ExtraBold). Default 400."),
        maxWidth: z.number().int().min(1).optional().describe("Ancho máximo en px; el texto se ajusta en varias líneas."),
        align: z.enum(["left", "center", "right"]).optional().describe("Alineación dentro de maxWidth."),
      })
    )
    .optional()
    .describe(
      "Texto compuesto con las fuentes reales de marca (no generado por la IA). Se aplica DESPUÉS de crop_to, " +
        "así que las coordenadas son sobre la imagen final."
    ),
  nombre_archivo: z.string().optional().describe("Prefijo para el nombre del archivo (ej. 'tema-123-linkedin'). Default: primeras palabras del prompt."),
  incluir_base64: z
    .boolean()
    .optional()
    .describe(
      "Default false. Si true, agrega file_name + file_base64 (compatible con upload_file_base64 de Pipefy). " +
        "Ojo: una imagen en base64 pesa millones de caracteres y puede truncarse o llenar el contexto; " +
        "lo recomendado es upload_file_path con el file_path devuelto."
    ),
  incluir_preview: z.boolean().optional().describe("Default true. Devuelve una miniatura (512px) para revisar el resultado visualmente."),
};

// ─── Tools ────────────────────────────────────────────────────────────────────

server.registerTool(
  "generar_imagen",
  {
    title: "Generar imagen (OpenAI GPT Image)",
    description:
      "Genera una imagen desde cero a partir de un prompt en inglés con la API de OpenAI. Guarda el archivo en disco " +
      "y devuelve su ruta (file_path) para adjuntarla a Pipefy con upload_file_path. Si OpenAI rechaza el prompt o " +
      "la llamada falla, devuelve error explícito (tipo_error, código, mensaje) — nunca una imagen vacía.",
    inputSchema: commonShape,
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async (args) => runImageJob("generar_imagen", args)
);

server.registerTool(
  "generar_variacion",
  {
    title: "Generar variación desde referencias (OpenAI GPT Image)",
    description:
      "Genera una imagen nueva a partir de 1 a 16 imágenes de referencia (endpoint de edición de OpenAI). Úsalo para " +
      "derivar las piezas (Blog, LinkedIn, Instagram, YouTube, Newsletter) desde la imagen maestra del Tema y mantener " +
      "consistencia visual. Acepta URLs (incluidas URLs firmadas de Pipefy), rutas locales, data URLs o base64. " +
      "Con mask hace inpainting de una zona. Devuelve file_path igual que generar_imagen.",
    inputSchema: {
      ...commonShape,
      reference_images: z
        .array(z.string().min(1))
        .min(1)
        .max(16)
        .describe("1-16 imágenes: URL pública/firmada, ruta local absoluta, data URL o base64. Máx. 50MB c/u."),
      mask: z
        .string()
        .optional()
        .describe(
          "Máscara para inpainting (URL/ruta/base64), se aplica a la primera referencia. PNG con alfa: zonas transparentes " +
            "= se editan. Si no tiene alfa, el BLANCO se interpreta como zona a editar. Se redimensiona sola."
        ),
      input_fidelity: z
        .enum(["high", "low"])
        .optional()
        .describe("Qué tanto preservar detalles de las referencias (gpt-image-1/1.5; no aplica a 1-mini). gpt-image-2 usa alta fidelidad automáticamente."),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async (args) => runImageJob("generar_variacion", args)
);

server.registerTool(
  "componer_imagen",
  {
    title: "Recortar / poner texto de marca sobre una imagen existente",
    description:
      "Aplica crop_to y/o overlay_text (fuentes reales de marca) sobre una imagen que ya existe — URL, ruta local o " +
      "base64 — sin llamar a OpenAI (costo cero). Úsalo para ajustar el texto de un thumbnail sin regenerar, o para " +
      "recomponer cuando generar_imagen/generar_variacion devolvió tipo_error 'postproceso' (usa imagenes_originales).",
    inputSchema: {
      source: z.string().min(1).describe("Imagen de origen: ruta local, URL (incluidas URLs firmadas de Pipefy), data URL o base64."),
      crop_to: commonShape.crop_to,
      overlay_text: commonShape.overlay_text,
      output_format: z.enum(["png", "jpeg", "webp"]).optional().describe("Default: el formato de la imagen de origen."),
      output_compression: commonShape.output_compression,
      nombre_archivo: commonShape.nombre_archivo,
      incluir_base64: commonShape.incluir_base64,
      incluir_preview: commonShape.incluir_preview,
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async (args) => runCompose(args)
);

server.registerTool(
  "listar_modelos_imagen",
  {
    title: "Listar modelos de imagen disponibles",
    description: "Lista los modelos de imagen de OpenAI a los que tiene acceso la API key configurada. Sirve también como prueba de conexión.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const ids = await listImageModels();
      const text = ids.length
        ? `Modelos de imagen disponibles:\n${ids.map((id) => `• ${id}`).join("\n")}\n\nModelo por defecto: ${config.defaultModel}`
        : "La key funciona, pero no tiene acceso a ningún modelo de imagen.";
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Error consultando modelos: ${(err as Error).message}` }] };
    }
  }
);

server.registerTool(
  "resumen_gasto",
  {
    title: "Resumen de gasto en OpenAI",
    description: "Resume las llamadas y el costo estimado registrados en el log local, agrupado por modelo.",
    inputSchema: { dias: z.number().int().min(1).max(3650).optional().describe("Ventana en días. Default 30.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ dias }) => ({ content: [{ type: "text", text: await summarizeLog(dias ?? 30) }] })
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[mcp-openia] listo (modelo por defecto: ${config.defaultModel}, salida: ${config.outputDir})`);

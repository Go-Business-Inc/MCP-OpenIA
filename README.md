<p align="center">
  <a href="https://gobusinessinc.com">
    <img src="https://gobusinessinc.com/assets/media/GBlogo250x250.png" alt="GoBusiness" width="120">
  </a>
</p>

# MCP OpenAI Images

A local [MCP](https://modelcontextprotocol.io) server (stdio) that lets Claude (or any MCP client) generate and edit images with the OpenAI Images API (GPT Image models) — from scratch, from up to 16 reference images, or with inpainting masks — and then crop them to exact sizes and overlay text using your real brand fonts.

Built for marketing pipelines: generate a master image for a topic, then derive per-channel pieces (blog, LinkedIn, Instagram, YouTube thumbnail, newsletter) from it so they stay visually consistent.

It runs locally on your Mac on purpose: cloud sandboxes (such as Cowork's) block egress to `api.openai.com`, while a local MCP server is reachable from Claude Code, Claude Desktop, and Cowork sessions through the remote-devices bridge.

## Tools

| Tool | What it does | Cost |
|---|---|---|
| `generar_imagen` | Generates an image from a text prompt | OpenAI |
| `generar_variacion` | Generates a new image from 1–16 reference images (URL — including signed URLs —, local path, data URL, or base64), with an optional `mask` for inpainting | OpenAI |
| `componer_imagen` | Applies `crop_to` / `overlay_text` to an existing image without regenerating it | Free |
| `listar_modelos_imagen` | Lists the image models your API key can use (also a connection test) | Free |
| `resumen_gasto` | Summarizes estimated spend per model from the local log | Free |

Tool names and responses are in Spanish, since the server is used by Spanish-speaking agents.

### Common parameters

| Parameter | Description |
|---|---|
| `prompt` | Prompt sent verbatim to OpenAI (English recommended) |
| `size` | `cuadrada` (1024x1024, default) · `apaisada` (1536x1024, 3:2) · `vertical` (1024x1536, 2:3) · `auto` · or any `WIDTHxHEIGHT` on `gpt-image-2`+ (multiples of 16, aspect ratio 1:3–3:1) |
| `quality` | `low` · `medium` (default) · `high` (`xhigh` / `max` on `gpt-image-2.5-*`) |
| `background` | `opaque` · `transparent` · `auto` |
| `n` | Number of variants (1–10) |
| `model` | Overrides the default model for this call |
| `output_format` / `output_compression` | `png` (default) · `jpeg` · `webp`, and quality 0–100 |
| `crop_to` | `{ width, height, position? }` — resize/crop the result to exact pixels (e.g. 1280x720 for YouTube) |
| `overlay_text` | Array of `{ text, x, y, fontSize, fontFamily, color, fontWeight?, maxWidth?, align? }` rendered with real font files instead of AI-generated lettering |
| `nombre_archivo` | Filename prefix |
| `incluir_base64` | Also return `file_name` + `file_base64` (default `false`, see below) |
| `incluir_preview` | Return a 512px thumbnail so the agent can review the result (default `true`) |

Post-processing order: OpenAI image → `crop_to` → `overlay_text` (coordinates refer to the final image).

## Requirements

- macOS (other platforms should work, but font lookup is tuned for macOS)
- Node.js 20 or later
- An OpenAI API key with access to GPT Image models

## Installation

```bash
git clone https://github.com/Go-Business-Inc/MCP-OpenIA.git
cd MCP-OpenIA
npm install
npm run build
cp .env.example .env
chmod 600 .env
```

Put your key in `.env` as `OPENAI_API_KEY=...`. Never hardcode it, paste it into a chat, or store it in shared documents.

### Brand fonts

`overlay_text` looks for font files in `fonts/`, `~/Library/Fonts`, and `/Library/Fonts`. Drop the `.ttf` files of your brand typefaces into `fonts/` (see [fonts/README.md](fonts/README.md)). If a font can't be found, the tool returns an error instead of silently substituting another typeface — and it checks this *before* calling OpenAI, so no money is spent.

### Claude Code

```bash
claude mcp add --scope user openai-images -- node /absolute/path/to/MCP-OpenIA/dist/index.js
```

### Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json` and restart Claude:

```json
{
  "mcpServers": {
    "openai-images": {
      "command": "/usr/local/bin/node",
      "args": ["/absolute/path/to/MCP-OpenIA/dist/index.js"]
    }
  }
}
```

Use the output of `which node` as `command` — Claude Desktop doesn't load your shell's `PATH`.

## Output

Every image is saved to `output/YYYY-MM-DD/`, and the response includes its `file_path`, dimensions, estimated cost, and a preview thumbnail.

To attach an image to another system, pass the `file_path` to a tool that uploads local files (for example, an `upload_file_path` tool in a Pipefy MCP server running on the same machine).

`incluir_base64: true` adds `file_name` + `file_base64` to each image, but a base64-encoded image is millions of characters: MCP clients truncate large tool outputs (Claude Code's `MAX_MCP_OUTPUT_TOKENS`) and it fills the agent's context. Passing the file path is the recommended route.

## Errors

The server never reports success without a real image. Failures return `isError: true` and a JSON payload with a `tipo_error` field:

| `tipo_error` | Meaning |
|---|---|
| `politica_contenido` | OpenAI's safety system rejected the prompt (`codigo`, `mensaje`, `request_id` included). Retry with an adjusted prompt. |
| `api_openai` | Any other API error (HTTP status, code, offending parameter) |
| `validacion` | Invalid parameters caught locally before calling OpenAI — nothing was spent |
| `postproceso` | The image was generated (and billed) but cropping/text failed. `imagenes_originales` holds the saved original so you can fix it with `componer_imagen` without paying again. |
| `local` | Reference download failed (e.g. expired signed URL), missing file, missing font, etc. |

## Cost log

Each call appends one JSON line to `logs/uso.jsonl`: model, size, quality, `n`, token usage, estimated cost in USD, duration, and output files. Prices live in [`src/costs.ts`](src/costs.ts) (checked 2026-09-13 against [OpenAI's pricing page](https://developers.openai.com/api/docs/pricing)) — update them if OpenAI changes its rates.

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — | **Required.** Your OpenAI API key |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` | Default model (`gpt-image-2`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gpt-image-1.5`, `gpt-image-1-mini`, …) |
| `OPENAI_ORG_ID` | — | OpenAI organization, if your key belongs to several |
| `OUTPUT_DIR` | `./output` | Where images are saved |
| `LOG_FILE` | `./logs/uso.jsonl` | Cost/usage log |
| `FONTS_DIR` | `./fonts` | Font files for `overlay_text` |

Variables can go in `.env` (read from the project folder, not the working directory) or in the `env` block of your MCP client config.

## Credits

Built by **[Go Business Inc.](https://gobusinessinc.com/)**

Go Business Inc. helps companies transform their operations through digital automation: process-based CRM and sales pipelines, AI chatbots and agents, automated marketing journeys, customer self-service portals, business intelligence dashboards, hardware automation, and remote-work management.

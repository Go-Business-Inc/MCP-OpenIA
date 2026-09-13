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
| `instalar_fuente_google` | Downloads a font family from the official Google Fonts repository into `fonts/` — only when the user explicitly asks for a font | Free |
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

`overlay_text` looks for font files in `fonts/`, `~/Library/Fonts`, and `/Library/Fonts`. Drop the `.ttf` files of your brand typefaces into `fonts/` (see [fonts/README.md](fonts/README.md)). If a font can't be found — or lacks a character in your text — the tool returns an error instead of silently substituting another typeface, and it checks the font *before* calling OpenAI, so no money is spent.

To add a font later, drop its files into `fonts/` (or install it on the Mac) — no restart needed. For Google Fonts families, the agent can also call `instalar_fuente_google` with the family name (e.g. `"Playfair Display"`): it downloads the variable (or non-italic static) `.ttf` files and the license only from the official [google/fonts](https://github.com/google/fonts) repository, validates them, and makes them available immediately. The tool is described to the agent as usable **only when the user explicitly requests a font**, so it won't swap your brand typography on its own. Commercial fonts must be installed manually.

Text is drawn from the font file's glyph outlines (via [fontkit](https://github.com/foliojs/fontkit)), not through the system text renderer, so the result doesn't depend on which fonts are installed. Variable fonts are supported: `fontWeight` sets the `wght` axis and `fontSize` the `opsz` axis when present.

## Registering the server

The server has to be registered in each Claude app that should use it. Claude Code and Claude Desktop keep **separate** configurations, so registering it in one doesn't make it available in the other.

### Claude Code

```bash
claude mcp add --scope user openai-images -- node /absolute/path/to/MCP-OpenIA/dist/index.js
```

Then restart your Claude Code session and check that the tools are listed with `/mcp`.

### Claude Desktop (and Cowork)

Claude Desktop reads its MCP servers from `~/Library/Application Support/Claude/claude_desktop_config.json`. Cowork sessions reach local servers through Claude Desktop's `remote-devices` bridge, so registering the server here is what makes it available in Cowork too.

> [!IMPORTANT]
> **Don't edit `claude_desktop_config.json` while Claude Desktop is running.** The app keeps that file in memory and rewrites it on its own while it runs (for example, when a Cowork session connects), so an entry added with the app open is silently removed minutes later — often before you restart. The app doesn't write the file when it quits, so edits made while it's closed are safe.

#### Option A — registration script (recommended)

1. Open **Terminal.app** (or iTerm). Don't use Claude Desktop's built-in terminal or ask Claude inside the app to run it: the script would be stopped when the app quits.
2. Run:

   ```bash
   cd /absolute/path/to/MCP-OpenIA
   ./scripts/register-claude-desktop.sh
   ```

3. Quit Claude Desktop with **Cmd+Q** (closing the window isn't enough).

The script waits for the app to quit, backs up the config (`claude_desktop_config.json.bak-<timestamp>`), adds the `openai-images` entry pointing at your `node` and `dist/index.js`, and reopens Claude Desktop. If the app isn't running, it registers right away. It gives up without changing anything if the app isn't quit within 30 minutes.

Optional environment variables: `NODE_BIN` (node binary to register, default: the `node` on your `PATH`), `MCP_NAME` (default `openai-images`), `TIMEOUT_SECONDS` (default `1800`).

#### Option B — manual

1. Quit Claude Desktop completely (**Cmd+Q**).
2. Add the entry to `~/Library/Application Support/Claude/claude_desktop_config.json`, keeping everything else in the file:

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

   Use the output of `which node` as `command` — Claude Desktop doesn't load your shell's `PATH`, so a bare `node` may not be found.
3. Open Claude Desktop again.

#### Verify

1. The entry is still in the config after the app has been open for a few minutes:

   ```bash
   grep -A3 '"openai-images"' ~/Library/Application\ Support/Claude/claude_desktop_config.json
   ```

2. The app launched the server — this log file exists and shows no startup errors:

   ```bash
   tail -n 20 ~/Library/Logs/Claude/mcp-server-openai-images.log
   ```

3. In a **new** Cowork or chat session, ask Claude to run `listar_modelos_imagen`. It should list the image models your OpenAI key can use. Sessions that were already open when the server was registered won't see it.

## Output

Every image is saved to `output/YYYY-MM-DD/`, and the response includes its `file_path`, dimensions, estimated cost, and a preview thumbnail.

To attach an image to another system, pass the `file_path` to a tool that uploads local files (for example, an `upload_file_path` tool in a Pipefy MCP server running on the same machine).

`incluir_base64: true` adds `file_name` + `file_base64` to each image, but a base64-encoded image is millions of characters: MCP clients truncate large tool outputs (Claude Code's `MAX_MCP_OUTPUT_TOKENS`) and it fills the agent's context. Passing the file path is the recommended route.

## Errors

The server never reports success without a real image. Failures return `isError: true` and a JSON payload with a `tipo_error` field:

| `tipo_error` | Meaning |
|---|---|
| `politica_contenido` | OpenAI's safety system rejected the prompt (`codigo`, `mensaje`, `request_id` included). Retry with an adjusted prompt. |
| `sin_saldo` | The OpenAI account is out of credits or hit its spend limit. Not retryable — needs a human to top up billing. |
| `api_openai` | Any other API error (HTTP status, code, offending parameter) |
| `validacion` | Invalid parameters caught locally before calling OpenAI — nothing was spent |
| `postproceso` | The image was generated (and billed) but cropping/text failed. `imagenes_originales` holds the saved original so you can fix it with `componer_imagen` without paying again. |
| `local` | Reference download failed (e.g. expired signed URL), missing file, missing font, etc. |

## Cost log

Each call appends one JSON line to `logs/uso.jsonl`: model, size, quality, `n`, token usage, estimated cost in USD, duration, and output files. Prices live in [`src/costs.ts`](src/costs.ts) (checked 2026-09-13 against [OpenAI's pricing page](https://developers.openai.com/api/docs/pricing)) — update them if OpenAI changes its rates.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Cowork / Claude Desktop says the tools don't exist | The entry isn't in `claude_desktop_config.json` (most often it was added with the app open and got overwritten). Check with the `grep` above and re-register with the script. Then open a new session. |
| The entry disappears from the config | Claude Desktop rewrote the file while running. Register again with the app quit (Option A does this for you). |
| Works in Claude Code but not in Claude Desktop (or vice versa) | They use separate configs — register the server in both. |
| `mcp-server-openai-images.log` shows `node: not found` or `ENOENT` | `command` must be an absolute path to `node` (`which node`), and `args` an absolute path to `dist/index.js`. Run `npm run build` if `dist/` is missing. |
| Tools respond with "OPENAI_API_KEY no está configurada" | Create `.env` in the project folder with your key (see Installation), then restart the app. |
| `tipo_error: "sin_saldo"` | The OpenAI account has no credits or hit its spend limit — top up in OpenAI's billing settings. |
| Text overlay fails with "Fuente … no encontrada" | Add the font files to `fonts/` (see [Brand fonts](#brand-fonts)). |
| Changes to the code don't show up | Run `npm run build` and restart the Claude app (or open a new Claude Code session) so the server process is relaunched. |

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

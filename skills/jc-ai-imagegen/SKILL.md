---
name: "jc-ai-imagegen"
description: "Generate or edit images through the JC AI relay instead of Codex's built-in image_generation tool. Use when the user wants image generation that still reflects the current conversation context, wants faster observable timing, or wants to compare Codex native image generation latency with JC AI's relay chain."
---

# JC AI Imagegen

Use this skill when the user asks to generate or edit an image through the JC AI relay, especially when they want Codex conversation context but do not want to rely on Codex's built-in `image_generation` tool.

## Workflow

1. Read the current conversation context yourself and synthesize the actual image prompt.
   - Preserve the user's latest request, style, subject, constraints, brand/domain context, and any corrections from earlier turns.
   - If the user says "like before", "use the previous image", or asks for an edit, identify the relevant local image path from the conversation when available.
   - Do not ask the script to infer context; the script only sends the final prompt and optional reference images.
2. Prefer concise, explicit image prompts. Include visual details, composition, style, aspect ratio, text requirements, and avoid irrelevant chat history.
3. Run `scripts/generate` with the synthesized prompt.
   - The wrapper uses system `node` when available and falls back to Codex bundled Node.js runtimes under `~/.cache/codex-runtimes/`.
   - If no Node.js runtime is available, tell the user to install Node.js LTS from https://nodejs.org/ and restart Codex.
   - The script defaults to the local Codex GPT provider in `~/.codex/config.toml`.
   - It reads the API key from local Codex auth at `~/.codex/auth.json` and does not print the key.
   - `JC_AI_API_KEY` or `OPENAI_API_KEY` can still override only if Codex auth is unavailable.
   - Default fallback endpoint is `https://ai.jc-ai.co/v1/responses`.
   - Default fallback model is `gpt-5.5`.
   - It saves image files under `~/.codex/generated_images/jc-ai-imagegen/`.
4. Report the saved image path, elapsed time, and whether the API returned a revised prompt. For latency checks, use `timings.fetch_headers_ms`, `timings.body_read_ms`, `timings.json_parse_ms`, `timings.image_save_ms`, and `total_wall_ms` from the script output. Embed the local image with Markdown when useful.

## Commands

Generate from stdin:

```bash
scripts/generate --stdin --size 1024x1024 --quality medium
```

Generate with a reference image:

```bash
scripts/generate --stdin --image /absolute/path/reference.png --action edit
```

Dry-run the request shape without calling the API:

```bash
scripts/generate --stdin --dry-run
```

## Output Rules

- Never print base64 image data into the conversation.
- Do not store API keys in this skill or in prompts.
- If the script fails because no key is configured, check that the local Codex GPT key exists in `~/.codex/auth.json`; otherwise tell the user to set `JC_AI_API_KEY` in the environment used by Codex.
- If the request is only a test, use `--quality low` and a square size first.

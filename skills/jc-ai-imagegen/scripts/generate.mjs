#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { homedir } from "node:os";

const FALLBACK_ENDPOINT = "https://ai.jc-ai.co/v1/responses";
const FALLBACK_MODEL = "gpt-5.5";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function usage() {
  return `Usage:
  generate.mjs --stdin [--image /path/ref.png] [--size 1024x1024] [--quality medium]
  generate.mjs --prompt "draw ..." [options]
  generate.mjs --prompt-file prompt.txt [options]

Options:
  --endpoint URL        Responses endpoint (default: Codex config base_url + /responses)
  --model MODEL         Mainline model for Responses API (default: Codex config model)
  --codex-home PATH     Codex home directory (default: CODEX_HOME or ~/.codex)
  --config-file PATH    Codex config file (default: <codex-home>/config.toml)
  --auth-file PATH      Codex auth file (default: <codex-home>/auth.json)
  --size VALUE          Image size, such as auto, 1024x1024, 1536x1024
  --quality VALUE       auto, low, medium, or high
  --background VALUE    auto or opaque
  --format VALUE        Optional output format: png, jpeg, or webp
  --compression VALUE   Optional output compression 0-100 for jpeg/webp
  --action VALUE        auto, generate, or edit
  --image PATH          Optional reference image; repeat for multiple images
  --out-dir PATH        Output directory
  --timeout-ms NUM      Request timeout in milliseconds
  --tool-choice VALUE   image_generation or auto (default: image_generation)
  --save-response       Save full API JSON response beside the output image
  --dry-run             Print request metadata without calling the API
  --help                Show this help
`;
}

function parseArgs(argv) {
  const opts = {
    endpoint: process.env.JC_AI_IMAGEGEN_ENDPOINT || process.env.JC_AI_RESPONSES_ENDPOINT || "",
    model: process.env.JC_AI_IMAGEGEN_MODEL || "",
    codexHome: process.env.CODEX_HOME || "",
    configFile: "",
    authFile: "",
    size: process.env.JC_AI_IMAGEGEN_SIZE || "",
    quality: process.env.JC_AI_IMAGEGEN_QUALITY || "",
    background: process.env.JC_AI_IMAGEGEN_BACKGROUND || "",
    format: process.env.JC_AI_IMAGEGEN_FORMAT || "",
    compression: process.env.JC_AI_IMAGEGEN_COMPRESSION || "",
    action: process.env.JC_AI_IMAGEGEN_ACTION || "generate",
    images: [],
    outDir: "",
    timeoutMs: Number(process.env.JC_AI_IMAGEGEN_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    toolChoice: "image_generation",
    saveResponse: false,
    dryRun: false,
    stdin: false,
    prompt: "",
    promptFile: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return argv[i];
    };

    switch (arg) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--stdin":
        opts.stdin = true;
        break;
      case "--prompt":
        opts.prompt = next();
        break;
      case "--prompt-file":
        opts.promptFile = next();
        break;
      case "--endpoint":
        opts.endpoint = next();
        break;
      case "--model":
        opts.model = next();
        break;
      case "--codex-home":
        opts.codexHome = next();
        break;
      case "--config-file":
        opts.configFile = next();
        break;
      case "--auth-file":
        opts.authFile = next();
        break;
      case "--size":
        opts.size = next();
        break;
      case "--quality":
        opts.quality = next();
        break;
      case "--background":
        opts.background = next();
        break;
      case "--format":
        opts.format = next();
        break;
      case "--compression":
        opts.compression = next();
        break;
      case "--action":
        opts.action = next();
        break;
      case "--image":
        opts.images.push(next());
        break;
      case "--out-dir":
        opts.outDir = next();
        break;
      case "--timeout-ms":
        opts.timeoutMs = Number(next());
        break;
      case "--tool-choice":
        opts.toolChoice = next();
        break;
      case "--save-response":
        opts.saveResponse = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function loadPrompt(opts) {
  if (opts.prompt) return opts.prompt;
  if (opts.promptFile) return readFile(opts.promptFile, "utf8");
  if (opts.stdin) return readStdin();
  throw new Error("Provide --stdin, --prompt, or --prompt-file.");
}

function mimeFromPath(path) {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function extFromBytes(bytes, fallback = "png") {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.toString("ascii", 1, 4) === "PNG") return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  return fallback;
}

function normalizeEndpoint(endpoint) {
  if (endpoint.endsWith("/responses")) return endpoint;
  return `${endpoint.replace(/\/$/, "")}/responses`;
}

function stripTomlComment(line) {
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if ((char === "\"" || char === "'") && (!inString || char === quote)) {
      inString = !inString;
      quote = inString ? char : "";
      continue;
    }
    if (char === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

function parseTomlScalar(raw) {
  const value = raw.trim();
  if (!value) return "";
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    if (value.startsWith("\"")) {
      try {
        return JSON.parse(value);
      } catch {
        return value.slice(1, -1);
      }
    }
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseTomlKey(key) {
  const trimmed = key.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function setNested(root, path, value) {
  let cursor = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[path[path.length - 1]] = value;
}

function parseToml(text) {
  const root = {};
  let table = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const tableMatch = line.match(/^\[([^\]]+)]$/);
    if (tableMatch) {
      table = tableMatch[1].split(".").map(parseTomlKey);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = parseTomlKey(line.slice(0, eq));
    const value = parseTomlScalar(line.slice(eq + 1));
    setNested(root, [...table, key], value);
  }
  return root;
}

async function loadCodexSettings(opts) {
  const codexHome = resolve(opts.codexHome || join(homedir(), ".codex"));
  const configFile = resolve(opts.configFile || join(codexHome, "config.toml"));
  const authFile = resolve(opts.authFile || join(codexHome, "auth.json"));
  let config = {};

  if (existsSync(configFile)) {
    config = parseToml(await readFile(configFile, "utf8"));
  }

  const modelProvider = typeof config.model_provider === "string" ? config.model_provider : "";
  const provider = modelProvider && config.model_providers?.[modelProvider]
    ? config.model_providers[modelProvider]
    : {};

  return {
    codexHome,
    configFile,
    authFile,
    modelProvider,
    model: typeof config.model === "string" ? config.model : "",
    baseUrl: typeof provider.base_url === "string" ? provider.base_url : "",
    authEnvKey: typeof provider.env_key === "string" ? provider.env_key : "OPENAI_API_KEY",
  };
}

async function resolveApiKey(settings) {
  const authKeys = [...new Set([settings.authEnvKey, "OPENAI_API_KEY"].filter(Boolean))];

  if (existsSync(settings.authFile)) {
    try {
      const auth = JSON.parse(await readFile(settings.authFile, "utf8"));
      for (const keyName of authKeys) {
        if (typeof auth[keyName] === "string" && auth[keyName]) {
          return { key: auth[keyName], source: `codex-auth:${keyName}` };
        }
      }
    } catch (error) {
      return { key: "", source: "", warning: `failed to read Codex auth file: ${error.message}` };
    }
  }

  const envKeys = [...new Set(["JC_AI_API_KEY", settings.authEnvKey, "OPENAI_API_KEY"].filter(Boolean))];
  for (const keyName of envKeys) {
    if (process.env[keyName]) return { key: process.env[keyName], source: `env:${keyName}` };
  }

  return { key: "", source: "" };
}

function buildTool(opts) {
  const tool = { type: "image_generation" };
  if (opts.size) tool.size = opts.size;
  if (opts.quality) tool.quality = opts.quality;
  if (opts.background) tool.background = opts.background;
  if (opts.format) tool.output_format = opts.format;
  if (opts.compression !== "") tool.output_compression = Number(opts.compression);
  if (opts.action) tool.action = opts.action;
  return tool;
}

async function buildInput(prompt, imagePaths) {
  if (!imagePaths.length) return prompt;

  const content = [{ type: "input_text", text: prompt }];
  for (const imagePath of imagePaths) {
    const abs = resolve(imagePath);
    if (!existsSync(abs)) throw new Error(`Reference image not found: ${abs}`);
    const bytes = await readFile(abs);
    content.push({
      type: "input_image",
      image_url: `data:${mimeFromPath(abs)};base64,${bytes.toString("base64")}`,
    });
  }
  return [{ role: "user", content }];
}

function findImageCalls(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  return output.filter((item) => item?.type === "image_generation_call" && item?.result);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function saveImageResult(result, outDir, index, preferredExt) {
  const saveStarted = Date.now();
  if (typeof result !== "string" || !result) {
    throw new Error(`Image result ${index} is empty or not a string.`);
  }

  if (/^https?:\/\//i.test(result)) {
    const downloadStarted = Date.now();
    const response = await fetchWithTimeout(result, {}, DEFAULT_TIMEOUT_MS);
    if (!response.ok) throw new Error(`Failed to download image URL ${response.status}`);
    const readStarted = Date.now();
    const bytes = Buffer.from(await response.arrayBuffer());
    const readMs = Date.now() - readStarted;
    const ext = extFromBytes(bytes, preferredExt || "png");
    const path = join(outDir, `image_${index}.${ext}`);
    const writeStarted = Date.now();
    await writeFile(path, bytes);
    const writeMs = Date.now() - writeStarted;
    return {
      path,
      bytes: bytes.length,
      download_ms: Date.now() - downloadStarted,
      read_ms: readMs,
      write_ms: writeMs,
      save_ms: Date.now() - saveStarted,
      source: "url",
    };
  }

  const decodeStarted = Date.now();
  const base64 = result.startsWith("data:") ? result.slice(result.indexOf(",") + 1) : result;
  const bytes = Buffer.from(base64, "base64");
  const decodeMs = Date.now() - decodeStarted;
  const ext = extFromBytes(bytes, preferredExt || "png");
  const path = join(outDir, `image_${index}.${ext}`);
  const writeStarted = Date.now();
  await writeFile(path, bytes);
  const writeMs = Date.now() - writeStarted;
  return {
    path,
    bytes: bytes.length,
    decode_ms: decodeMs,
    write_ms: writeMs,
    save_ms: Date.now() - saveStarted,
    source: "base64",
  };
}

async function main() {
  const wallStarted = Date.now();
  const startedAt = new Date(wallStarted).toISOString();
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(usage());
    return;
  }

  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number.");
  }

  const promptLoadStarted = Date.now();
  const prompt = (await loadPrompt(opts)).trim();
  const promptLoadMs = Date.now() - promptLoadStarted;
  if (!prompt) throw new Error("Prompt is empty.");

  const prepareStarted = Date.now();
  const codexSettings = await loadCodexSettings(opts);
  const endpoint = normalizeEndpoint(opts.endpoint || codexSettings.baseUrl || FALLBACK_ENDPOINT);
  const model = opts.model || codexSettings.model || FALLBACK_MODEL;

  const outDir = opts.outDir
    ? resolve(opts.outDir)
    : join(homedir(), ".codex", "generated_images", "jc-ai-imagegen", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(outDir, { recursive: true });

  const body = {
    model,
    input: await buildInput(prompt, opts.images),
    tools: [buildTool(opts)],
    metadata: { source: "jc-ai-imagegen" },
  };
  const prepareMs = Date.now() - prepareStarted;

  if (opts.toolChoice === "image_generation") {
    body.tool_choice = { type: "image_generation" };
  } else if (opts.toolChoice !== "auto") {
    throw new Error("--tool-choice must be image_generation or auto.");
  }

  if (opts.dryRun) {
    const keyInfo = await resolveApiKey(codexSettings);
    process.stdout.write(JSON.stringify({
      dry_run: true,
      endpoint,
      model,
      codex_model_provider: codexSettings.modelProvider || "",
      codex_config_file: codexSettings.configFile,
      codex_auth_file: codexSettings.authFile,
      api_key_source: keyInfo.source || "missing",
      api_key_available: Boolean(keyInfo.key),
      warning: keyInfo.warning || "",
      prompt_chars: prompt.length,
      reference_images: opts.images.map((p) => resolve(p)),
      tool: body.tools[0],
      out_dir: outDir,
    }, null, 2) + "\n");
    return;
  }

  const authStarted = Date.now();
  const keyInfo = await resolveApiKey(codexSettings);
  const authMs = Date.now() - authStarted;
  if (!keyInfo.key) {
    const hint = keyInfo.warning ? `${keyInfo.warning}. ` : "";
    throw new Error(`${hint}Missing API key. Expected Codex auth at ${codexSettings.authFile} with ${codexSettings.authEnvKey || "OPENAI_API_KEY"}, or set JC_AI_API_KEY / OPENAI_API_KEY in the environment.`);
  }

  const requestStarted = Date.now();
  const requestStartedAt = new Date(requestStarted).toISOString();
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${keyInfo.key}`,
      "Content-Type": "application/json",
      "User-Agent": "jc-ai-imagegen/1.0",
      "X-JC-AI-Client": "jc-ai-imagegen",
    },
    body: JSON.stringify(body),
  }, opts.timeoutMs);
  const responseHeadersAtMs = Date.now();
  const elapsedMs = responseHeadersAtMs - requestStarted;
  const requestId = response.headers.get("x-request-id") || response.headers.get("cf-ray") || "";
  const bodyReadStarted = Date.now();
  const text = await response.text();
  const bodyReadMs = Date.now() - bodyReadStarted;
  const responseBodyBytes = Buffer.byteLength(text, "utf8");

  if (!response.ok) {
    const errorPath = join(outDir, "error-response.txt");
    await writeFile(errorPath, text);
    throw new Error(`API request failed: HTTP ${response.status}. Body saved to ${errorPath}`);
  }

  let json;
  const jsonParseStarted = Date.now();
  try {
    json = JSON.parse(text);
  } catch (error) {
    const rawPath = join(outDir, "raw-response.txt");
    await writeFile(rawPath, text);
    throw new Error(`API returned non-JSON response. Saved to ${rawPath}: ${error.message}`);
  }
  const jsonParseMs = Date.now() - jsonParseStarted;

  let saveResponseMs = 0;
  if (opts.saveResponse) {
    const saveResponseStarted = Date.now();
    await writeFile(join(outDir, "response.json"), JSON.stringify(json, null, 2));
    saveResponseMs = Date.now() - saveResponseStarted;
  }

  const imageCalls = findImageCalls(json);
  if (!imageCalls.length) {
    const noImagePath = join(outDir, "response-without-image.json");
    await writeFile(noImagePath, JSON.stringify(json, null, 2));
    throw new Error(`No image_generation_call result found. Response saved to ${noImagePath}`);
  }

  const preferredExt = opts.format && opts.format !== "jpeg" ? opts.format : (opts.format === "jpeg" ? "jpg" : "");
  const images = [];
  const imageSaveStarted = Date.now();
  for (let i = 0; i < imageCalls.length; i += 1) {
    images.push(await saveImageResult(imageCalls[i].result, outDir, i, preferredExt));
  }
  const imageSaveMs = Date.now() - imageSaveStarted;
  const completedAtMs = Date.now();

  const metadata = {
    ok: true,
    endpoint,
    model,
    elapsed_ms: elapsedMs,
    total_wall_ms: completedAtMs - wallStarted,
    timings: {
      started_at: startedAt,
      request_started_at: requestStartedAt,
      response_headers_at: new Date(responseHeadersAtMs).toISOString(),
      completed_at: new Date(completedAtMs).toISOString(),
      prompt_load_ms: promptLoadMs,
      prepare_ms: prepareMs,
      auth_ms: authMs,
      fetch_headers_ms: elapsedMs,
      body_read_ms: bodyReadMs,
      json_parse_ms: jsonParseMs,
      save_response_ms: saveResponseMs,
      image_save_ms: imageSaveMs,
      total_wall_ms: completedAtMs - wallStarted,
    },
    response_body_bytes: responseBodyBytes,
    request_id: requestId,
    response_id: json.id || "",
    api_key_source: keyInfo.source,
    output_count: Array.isArray(json.output) ? json.output.length : 0,
    image_count: images.length,
    images,
    revised_prompts: imageCalls.map((call) => call.revised_prompt).filter(Boolean),
    out_dir: outDir,
  };
  await writeFile(join(outDir, "metadata.json"), JSON.stringify(metadata, null, 2));
  process.stdout.write(JSON.stringify(metadata, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});

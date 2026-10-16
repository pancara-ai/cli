#!/usr/bin/env node

// src/main.ts
import { parseArgs } from "node:util";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { join as join2 } from "node:path";
import { spawn } from "node:child_process";
import QRCode2 from "qrcode";

// src/credentials.ts
import { mkdir, readFile, writeFile, rename, rm, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { Entry } from "@napi-rs/keyring";

class CliError extends Error {
  code;
  exit;
  constructor(code, message, exit = 1) {
    super(message);
    this.code = code;
    this.exit = exit;
  }
}

class CredentialsStore {
  environment;
  directory;
  file;
  fileMode = process.env.NUTRIQ_CREDENTIAL_STORE === "file";
  constructor(environment) {
    this.environment = environment;
    this.directory = join(process.env.NUTRIQ_CONFIG_DIR || join(homedir(), ".config", "nutriq"), environment);
    this.file = join(this.directory, "credentials.json");
  }
  async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 448 });
    const info = await lstat(this.directory);
    if (info.isSymbolicLink() || process.platform !== "win32" && ((info.mode & 63) !== 0 || info.uid !== process.getuid?.())) {
      throw new CliError("CREDENTIAL_STORE_UNSAFE", "Nutriq credential directory must be owned by you with permissions 0700.");
    }
  }
  async locked(fn) {
    await this.prepare();
    const release = await lockfile.lock(this.directory, { retries: { retries: 30, minTimeout: 100, maxTimeout: 500 }, stale: 30000 });
    try {
      return await fn();
    } finally {
      await release();
    }
  }
  keyring() {
    return new Entry("pancara.nutriq.cli", this.environment);
  }
  async read() {
    try {
      if (this.fileMode) {
        const info = await lstat(this.file).catch((error) => {
          if (error.code === "ENOENT")
            return null;
          throw error;
        });
        if (!info)
          return {};
        if (info.isSymbolicLink() || process.platform !== "win32" && info.mode & 63)
          throw new CliError("CREDENTIAL_STORE_UNSAFE", "Credential file must have permissions 0600.");
        return JSON.parse(await readFile(this.file, "utf8"));
      }
      const value = this.keyring().getPassword();
      return value ? JSON.parse(value) : {};
    } catch (error) {
      if (error instanceof CliError)
        throw error;
      throw new CliError("CREDENTIAL_STORE_UNAVAILABLE", "Unable to read the system keychain. On a trusted headless machine, explicitly set NUTRIQ_CREDENTIAL_STORE=file.");
    }
  }
  async write(value) {
    try {
      if (!this.fileMode) {
        this.keyring().setPassword(JSON.stringify(value));
        return;
      }
      const temp = `${this.file}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(value), { mode: 384, flag: "wx" });
        await rename(temp, this.file);
      } finally {
        await rm(temp, { force: true });
      }
    } catch (error) {
      if (error instanceof CliError)
        throw error;
      throw new CliError("CREDENTIAL_STORE_UNAVAILABLE", "Could not save CLI credentials. Check your keychain, or explicitly use NUTRIQ_CREDENTIAL_STORE=file on a trusted machine.");
    }
  }
}

// src/client.ts
var delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Client {
  origin;
  store;
  constructor(origin, store) {
    this.origin = origin;
    this.store = store;
    const url = new URL(origin);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
      throw new CliError("INVALID_SERVER", "Nutriq requires HTTPS, except on localhost.");
    }
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new CliError("INVALID_SERVER", "Use a server origin without credentials or a path.");
  }
  async request(path, options = {}) {
    const method = options.method ?? "GET";
    const retry = options.retry ?? method === "GET";
    for (let attempt = 0;; attempt++) {
      let response;
      try {
        response = await fetch(`${this.origin}${path}`, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: {
            accept: "application/json",
            "user-agent": "NutriqCLI/0.1.1",
            ...options.token ? { authorization: `Bearer ${options.token}` } : {},
            ...options.body ? { "content-type": "application/json" } : {}
          },
          ...options.body ? { body: JSON.stringify(options.body) } : {}
        });
      } catch {
        if (retry && attempt < 2) {
          await delay(300 * 2 ** attempt);
          continue;
        }
        throw new CliError("NETWORK_ERROR", "Cannot reach Nutriq. Check your connection and try again.", 4);
      }
      if (retry && attempt < 2 && (response.status === 429 || response.status >= 500)) {
        const value = response.headers.get("retry-after");
        const retryMs = value ? /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now() : 300 * 2 ** attempt;
        if (Number.isFinite(retryMs) && retryMs >= 0 && retryMs <= 5000) {
          await response.body?.cancel();
          await delay(retryMs);
          continue;
        }
      }
      let body;
      try {
        body = await response.json();
      } catch {
        throw new CliError("INVALID_RESPONSE", "Nutriq returned an unreadable response.", 4);
      }
      if (!response.ok) {
        throw new CliError(body?.error?.code || "HTTP_ERROR", body?.error?.message || `Nutriq returned HTTP ${response.status}.`, response.status === 401 ? 3 : 4);
      }
      return body;
    }
  }
  async token(rejected) {
    return this.store.locked(async () => {
      const saved = await this.store.read();
      if (!saved.refresh_token)
        throw new CliError("AUTH_REQUIRED", "Run nutriq login to authorize this computer.", 3);
      if (saved.access_token && saved.access_token !== rejected && (saved.expires_at ?? 0) > Date.now() + 60000)
        return saved.access_token;
      const next = await this.request("/v1/cli/refresh", { method: "POST", body: { refresh_token: saved.refresh_token }, retry: true });
      await this.store.write({ ...saved, ...next, expires_at: Date.now() + next.expires_in * 1000 });
      return next.access_token;
    });
  }
  async api(path, method = "GET") {
    let token = await this.token();
    try {
      return await this.request(path, { method, token });
    } catch (error) {
      if (!(error instanceof CliError) || error.exit !== 3)
        throw error;
      token = await this.token(token);
      return this.request(path, { method, token });
    }
  }
}

// src/output.ts
import { stripVTControlCharacters } from "node:util";
import QRCode from "qrcode";
function authorizationText(info, options) {
  const lines = ["Connect your Nutriq account", "", "Scan in Nutriq → Me → Integrations → CLI."];
  const { modules } = QRCode.create(info.verification_url);
  const size = modules.size + 8;
  if (options.terminal && (options.columns ?? 80) >= size + 2) {
    const dark = (x, y) => x >= 4 && y >= 4 && x < size - 4 && y < size - 4 && modules.get(y - 4, x - 4);
    lines.push("");
    for (let y = 0;y < size; y += 2) {
      let row = "";
      for (let x = 0;x < size; x++)
        row += dark(x, y) ? dark(x, y + 1) ? "█" : "▀" : dark(x, y + 1) ? "▄" : " ";
      lines.push("  " + (options.color ? "\x1B[30;47m" + row + "\x1B[0m" : row));
    }
  } else if (options.terminal)
    lines.push("", "Terminal too narrow for the QR code; open the link or QR image below.");
  const code = plain(info.user_code).replace(/^(.{4})(.{4})$/, "$1 $2");
  lines.push("", `Code: ${code}`, "", `Open: ${plain(info.verification_url)}`, `QR image: ${plain(info.qr_path)}`, "", "Choose your data and confirm in the App or browser.", options.wait ? "Waiting for confirmation…" : `Then run: ${plain(info.next_command)}`);
  return lines.join(`
`);
}
var plain = (value) => value == null ? "—" : stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
var label = (key) => key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
var list = (value) => Array.isArray(value) ? value : [];
function table(headers, rows) {
  if (!rows.length)
    return "No records found.";
  const cells = [headers, ...rows].map((row) => row.map(plain));
  const width = (text) => [...text].reduce((n, c) => n + (/[^\u0000-\u00ff]/.test(c) ? 2 : 1), 0);
  const widths = headers.map((_, i) => Math.max(...cells.map((row) => width(row[i] ?? ""))));
  if (widths.reduce((a, b) => a + b, 0) + (headers.length - 1) * 3 > (process.stdout.columns || 100)) {
    return cells.slice(1).map((row) => row.map((cell, i) => `${headers[i]}: ${cell}`).join(`
`)).join(`

`);
  }
  return cells.map((row) => row.map((cell, i) => cell + " ".repeat(widths[i] - width(cell))).join("   ").trimEnd()).join(`
`);
}
function details(value, indent = "") {
  if (value == null)
    return `${indent}No data available.`;
  if (Array.isArray(value))
    return value.length ? value.map((item) => details(item, indent)).join(`

`) : `${indent}No records found.`;
  if (typeof value !== "object")
    return indent + plain(value);
  return Object.entries(value).map(([key, item]) => item && typeof item === "object" ? `${indent}${label(key)}
${details(item, indent + "  ")}` : `${indent}${label(key)}: ${plain(item)}`).join(`
`);
}
function render(command, data) {
  if (data == null)
    return "No data available.";
  switch (command) {
    case "--version":
      return `nutriq version ${plain(data.version)}`;
    case "login":
      return data.status === "authorized" ? `Connected to Nutriq.
Access: ${list(data.scopes).map(plain).join(", ")}

Try: nutriq today` : `Connect your Nutriq account

Open: ${plain(data.verification_url)}
Code: ${plain(data.user_code)}
QR image: ${plain(data.qr_path)}

Choose your data and confirm, then run:
  ${plain(data.next_command)}`;
    case "logout":
      return "Signed out of Nutriq on this computer.";
    case "whoami":
      return details({ name: data.display_name, email: data.email, timezone: data.timezone, member_id: data.member_id ?? data.claimed_member_id, household_id: data.household_id });
    case "today": {
      const meals = table(["Time", "Meal", "Foods", "Score", "ID"], list(data.events).map((m) => [m.time, m.tag, m.title, m.score, m.meal_id]));
      const targets = table(["Nutrient", "Intake / target", "Status"], list(data.rings).map((r) => [r.label, r.value_text, r.state]));
      return `${plain(data.date_label || "Today")} · ${plain(data.date)}
Score: ${plain(data.score?.value)}${data.score?.label ? " · " + plain(data.score.label) : ""}

Meals
${meals}

Nutrition
${targets}${data.agent?.text ? `

` + plain(data.agent.text) : ""}

Meal details: nutriq meal <ID>`;
    }
    case "meals":
      return table(["Date", "Meal", "Status", "Foods", "ID"], list(data.items).map((m) => [m.meal_date, m.meal_type, m.status, list(m.served_foods).map((f) => plain(f.name)).join(", ") || "—", m.id])) + (data.next_cursor ? `

More records available. Repeat this command with the same filters and --cursor ${plain(data.next_cursor)}` : "");
    case "meal":
      return `${plain(data.meal_type || "Meal")} · ${plain(data.meal_date)}
ID: ${plain(data.id)}
Status: ${plain(data.status)}
Started at: ${plain(data.occurred_at)}
Duration (minutes): ${plain(data.duration_minutes)}
Score: ${plain(data.score)}
` + list(data.participants).map((p) => `
${plain(p.display_name)}${p.is_partial ? " · partial estimate" : ""}
${table(["Food", "Grams", "kcal"], list(p.foods).map((f) => [f.name, f.grams, f.calories_kcal]))}`).join(`
`) + (list(data.participants).length ? "" : `
Served foods
` + table(["Food"], list(data.served_foods).map((f) => [f.name]))) + (data.note ? `

Note: ` + plain(data.note) : "");
    case "profile":
      return details({ user: data.user, goal: data.goal, body: data.body, focus_items: data.focus_items });
    case "family":
      return table(["Name", "Role", "Status", "ID"], list(data.members).map((m) => [m.display_name, m.role, m.status, m.id ?? m.member_id]));
    case "devices":
      return table(["Name", "Status", "ID"], list(data).map((d) => [d.name, d.status, d.device_id ?? d.id]));
    case "trends":
      return `${plain(data.title)} · ${plain(data.period_start)} – ${plain(data.period_end)}

${details(data.summary)}

Diet structure
${details(data.structure)}

Nutrient scorecard
${details(data.scorecard)}`;
    case "plans":
      return `${plain(data.title || "Meal plans")}

` + (data.learning ? details(data.learning) : list(data.timeline).length ? list(data.timeline).map((p) => details({ date: p.date, meal: p.label ?? p.slot, state: p.state, diners: p.diners, draft: p.draft })).join(`

`) : "No records found.");
    case "health":
      return `Health · ${plain(data.source)}

${details(data.days)}`;
    case "live":
      return data.meal ? `Live preview · not finalized intake

${details(data.meal)}` : "No meal is being recorded right now.";
    default:
      return details(data);
  }
}

// src/main.ts
var commands = {
  login: { description: "Authorize in the Nutriq App. --no-wait returns a link; --wait resumes.", options: { "no-wait": "boolean", wait: "boolean", name: "string" } },
  logout: { description: "Revoke this CLI authorization and remove its local credentials." },
  whoami: { description: "Read the authorized account, timezone and member ID.", path: "/v1/auth/me" },
  profile: { description: "Read your profile and nutrition goals.", path: "/v1/me" },
  health: { description: "Read synced health measurements.", path: "/v1/health/days" },
  today: { description: "Read a day overview; date defaults to the account timezone.", path: "/v1/today", options: { date: "string", member: "string" } },
  meals: { description: "List full meal records. Follow next_cursor for subsequent pages.", path: "/v1/meals", options: { date: "string", member: "string", cursor: "string", limit: "string" } },
  meal: { description: "Read one meal and its current observation: nutriq meal <id>.", path: "/v1/meals/" },
  trends: { description: "Read nutrition trends. Defaults to this week; --week takes precedence over --period.", path: "/v1/trends", options: { week: "string", period: "string", member: "string" } },
  family: { description: "Read the household and member IDs.", path: "/v1/household" },
  devices: { description: "Read household device status.", path: "/v1/devices" },
  plans: { description: "Read the current meal plans.", path: "/v1/plans" },
  live: { description: "Read the in-progress table preview; not finalized intake.", path: "/v1/meals/live" }
};
var argv = process.argv.slice(2);
var jsonFormat = argv.includes("--json") || argv.includes("--format=json") || argv.some((arg, i) => arg === "--format" && argv[i + 1] === "json");
var output = (data) => console.log(jsonFormat ? JSON.stringify({ ok: true, data }) : render(argv[0] || "", data));
var cleanText = (value) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
var optionHelp = {
  "no-wait": "Return the authorization link without waiting",
  wait: "Wait for an existing authorization to finish",
  name: "Name this computer in your connected devices",
  date: "Date (YYYY-MM-DD; defaults to your account’s today)",
  member: "Family member ID (defaults to you)",
  cursor: "Continue from the previous page’s next_cursor",
  limit: "Number of meals to return (1–100)",
  week: "Start date of the week (YYYY-MM-DD)",
  period: "week or recent_7_days (default: week)"
};
function help(command, json = false) {
  const publicCommands = Object.fromEntries(Object.entries(commands).map(([name, { path, ...definition }]) => [name, definition]));
  if (json) {
    jsonFormat = true;
    output(command ? { command, ...publicCommands[command] } : { name: "nutriq", version: "0.1.1", commands: publicCommands });
    return;
  }
  const lines = command ? [
    `nutriq ${command} — ${commands[command].description}`,
    "",
    `Usage: nutriq ${command}${command === "meal" ? " <id>" : ""} [options]`,
    "",
    "Options:",
    ...Object.entries(commands[command].options ?? {}).map(([name, type]) => `  ${`--${name}${type === "string" ? " <value>" : ""}`.padEnd(24)}${optionHelp[name]}`)
  ] : [
    "Nutriq — your meals and nutrition, from the terminal",
    "",
    "Usage: nutriq <command> [options]",
    "",
    "Get started:",
    "  nutriq login              Connect your Nutriq account",
    "  nutriq today              See what you ate today",
    "  nutriq meals              Browse your meal records",
    "",
    "Commands:",
    ...Object.entries(commands).map(([name, definition]) => `  ${name.padEnd(24)}${definition.description}`),
    "",
    "Options:"
  ];
  lines.push("  -h, --help              Show help", "  --env <prod|dev>         Environment (default: prod)", "  --json                  Output JSON for scripts and agents", "  --format <text|json>     Result format (default: text)", "", command ? `Example: nutriq ${command}${command === "meal" ? " <id>" : command === "meals" ? " --limit 10" : ""}` : "Run nutriq <command> --help for command options.", "For agents: use --json for results, or --help --json for the command schema.");
  console.log(lines.join(`
`));
}
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || ["--help", "-h", "help", "--format", "--json"].includes(command)) {
    const target = command === "help" && args[1] && !args[1].startsWith("-") ? args[1] : undefined;
    if (target && !commands[target])
      throw new CliError("INVALID_ARGUMENT", `Unknown command ${cleanText(target)}. Run nutriq --help.`, 2);
    let parsed2;
    try {
      parsed2 = parseArgs({ args: command === "help" ? args.slice(target ? 2 : 1) : args, options: { help: { type: "boolean", short: "h" }, json: { type: "boolean" }, format: { type: "string" } } });
    } catch {
      throw new CliError("INVALID_ARGUMENT", "Invalid arguments. Run nutriq --help.", 2);
    }
    if (parsed2.values.format && !["json", "text"].includes(parsed2.values.format))
      throw new CliError("INVALID_ARGUMENT", "--format must be json or text.", 2);
    if (parsed2.values.json && parsed2.values.format === "text")
      throw new CliError("INVALID_ARGUMENT", "Choose --json or --format text, not both.", 2);
    help(target, jsonFormat);
    return;
  }
  if (command === "--version") {
    output({ version: "0.1.1" });
    return;
  }
  const definition = commands[command];
  if (!definition)
    throw new CliError("INVALID_ARGUMENT", `Unknown command ${cleanText(command)}. Run nutriq --help.`, 2);
  let parsed;
  try {
    parsed = parseArgs({ args: args.slice(1), allowPositionals: true, strict: true, options: {
      env: { type: "string", default: "prod" },
      format: { type: "string", default: "text" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      ...Object.fromEntries(Object.entries(definition.options ?? {}).map(([key, type]) => [key, { type }]))
    } });
  } catch {
    throw new CliError("INVALID_ARGUMENT", `Invalid arguments. Run nutriq ${command} --help.`, 2);
  }
  const { values, positionals } = parsed;
  if (!["json", "text"].includes(String(values.format)))
    throw new CliError("INVALID_ARGUMENT", "--format must be json or text.", 2);
  if (values.json && (args.includes("--format=text") || args.some((arg, i) => arg === "--format" && args[i + 1] === "text")))
    throw new CliError("INVALID_ARGUMENT", "Choose --json or --format text, not both.", 2);
  if (values.help) {
    help(command, jsonFormat);
    return;
  }
  if (!["prod", "dev"].includes(String(values.env)))
    throw new CliError("INVALID_ARGUMENT", "--env must be prod or dev.", 2);
  if (positionals.length !== (command === "meal" ? 1 : 0))
    throw new CliError("INVALID_ARGUMENT", `Run nutriq ${command} --help for the expected arguments.`, 2);
  for (const key of ["date", "week"]) {
    if (!values[key])
      continue;
    const date = new Date(`${values[key]}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(values[key])) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== values[key]) {
      throw new CliError("INVALID_ARGUMENT", `--${key} must be a real YYYY-MM-DD date.`, 2);
    }
  }
  if (values.limit && (!/^\d+$/.test(String(values.limit)) || Number(values.limit) < 1 || Number(values.limit) > 100))
    throw new CliError("INVALID_ARGUMENT", "--limit must be 1–100.", 2);
  if (values.period && !["week", "recent_7_days"].includes(String(values.period)))
    throw new CliError("INVALID_ARGUMENT", "--period must be week or recent_7_days.", 2);
  const origin = process.env.NUTRIQ_BASE_URL || (values.env === "dev" ? "https://api-dev.pancara.ai" : "https://api.pancara.ai");
  const environment = process.env.NUTRIQ_BASE_URL ? `custom-${createHash("sha256").update(origin).digest("hex").slice(0, 16)}` : String(values.env);
  const store = new CredentialsStore(environment);
  const client = new Client(origin, store);
  await store.prepare();
  if (command === "login") {
    if (values.wait && values["no-wait"])
      throw new CliError("INVALID_ARGUMENT", "Choose --wait or --no-wait.", 2);
    let pending = await store.locked(async () => (await store.read()).pending);
    if (!values.wait) {
      pending = await store.locked(async () => {
        const saved = await store.read();
        if (saved.refresh_token)
          throw new CliError("ALREADY_AUTHORIZED", "Already authorized. Use nutriq whoami, or logout before switching accounts.");
        if (saved.pending && saved.pending.expires_at > Date.now())
          return saved.pending;
        const started = await client.request("/v1/cli/authorize", { method: "POST", body: { client_name: values.name || `${hostname()} · Nutriq CLI` } });
        const value = { ...started, expires_at: Date.now() + started.expires_in * 1000 };
        await store.write({ ...saved, pending: value });
        return value;
      });
    }
    if (!pending || pending.expires_at <= Date.now())
      throw new CliError("AUTH_EXPIRED", "Run nutriq login --no-wait for a new authorization link.", 3);
    const qrPath = join2(store.directory, "authorize.png");
    await QRCode2.toFile(qrPath, pending.verification_uri_complete, { margin: 2, width: 360 });
    const info = { status: "pending", verification_url: pending.verification_uri_complete, user_code: pending.user_code, qr_path: qrPath, expires_at: new Date(pending.expires_at).toISOString(), next_command: `nutriq login --wait${values.env === "dev" ? " --env dev" : ""}` };
    const wait = !values["no-wait"] && (values.wait || process.stdin.isTTY);
    if (!wait) {
      if (jsonFormat)
        output(info);
      else
        console.log(authorizationText(info, { terminal: !!process.stdout.isTTY, color: !!process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb", columns: process.stdout.columns, wait: false }));
      return;
    }
    if (!jsonFormat)
      console.error(authorizationText(info, { terminal: !!process.stderr.isTTY, color: !!process.stderr.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb", columns: process.stderr.columns, wait: true }));
    if (!values.wait && process.stdin.isTTY) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
      if (opener) {
        const child = spawn(opener, [pending.verification_uri_complete], { stdio: "ignore", detached: true });
        child.on("error", () => {});
        child.unref();
      }
    }
    while (Date.now() < pending.expires_at) {
      let result;
      try {
        result = await client.request("/v1/cli/token", { method: "POST", body: { device_code: pending.device_code }, retry: true });
      } catch (error) {
        if (!(error instanceof CliError) || error.code !== "NETWORK_ERROR")
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }
      if (result.access_token) {
        await store.locked(async () => {
          const saved = await store.read();
          if (saved.pending?.device_code !== pending.device_code)
            throw new CliError("AUTH_CHANGED", "Authorization changed in another process.");
          await store.write({ access_token: result.access_token, refresh_token: result.refresh_token, session_id: result.session_id, expires_at: Date.now() + result.expires_in * 1000 });
        });
        output({ status: "authorized", scopes: result.scopes });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(5, result.interval ?? 5) * 1000));
    }
    throw new CliError("AUTH_EXPIRED", "Authorization timed out. Run nutriq login again.", 3);
  }
  if (command === "logout") {
    try {
      await client.api("/v1/cli/logout", "POST");
    } catch (error) {
      if (!(error instanceof CliError) || error.exit !== 3)
        throw error;
    }
    await store.locked(() => store.write({}));
    output({ status: "signed_out" });
    return;
  }
  const query = new URLSearchParams;
  for (const [flag, key] of Object.entries({ date: "date", member: "member_id", week: "week_start", period: "period", cursor: "cursor", limit: "limit" }))
    if (values[flag])
      query.set(key, String(values[flag]));
  const path = definition.path + (command === "meal" ? encodeURIComponent(positionals[0]) : "") + (query.size ? `?${query}` : "");
  output(await client.api(path));
}
main().catch((error) => {
  const known = error instanceof CliError ? error : new CliError("CLI_ERROR", "Nutriq could not complete the command. Run nutriq --help or try again.");
  if (jsonFormat)
    console.log(JSON.stringify({ ok: false, error: { code: known.code, message: cleanText(known.message) } }));
  else
    console.error(`nutriq: ${plain(known.message)}`);
  process.exitCode = known.exit;
});

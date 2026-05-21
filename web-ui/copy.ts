import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Mirror the React Router build output into ../dist/web-ui/build/client so the compiled
// `rikkahub-pc.exe` (which looks for `executableDir/web-ui/build/client` first) always
// serves the latest frontend without an extra manual sync step.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = resolve(SCRIPT_DIR, "build/client");
const PC_DIST_TARGET_DIR = resolve(SCRIPT_DIR, "../dist/web-ui/build/client");
const STRICT_COPY = process.env.RIKKAHUB_STRICT_WEB_COPY === "1";

function sleep(milliseconds: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function ensureDirectory(path: string) {
  if (existsSync(path)) return;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      mkdirSync(path, { recursive: true });
      return;
    } catch (error) {
      lastError = error;
      sleep(50 * (attempt + 1));
      if (existsSync(path)) return;
    }
  }
  throw lastError;
}

function copyDirectory(src: string, dest: string) {
  ensureDirectory(dest);

  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      ensureDirectory(dirname(destPath));
      copyFileSync(srcPath, destPath);
    }
  }
}

function emptyDirectory(path: string) {
  ensureDirectory(path);
  const entries = readdirSync(path, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    rmSync(entryPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
}

function quotePowerShell(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function copyDirectoryWithPowerShell(src: string, dest: string) {
  const script = [
    `$src = ${quotePowerShell(src)}`,
    `$dest = ${quotePowerShell(dest)}`,
    "New-Item -ItemType Directory -Path $dest -Force | Out-Null",
    "Get-ChildItem -LiteralPath $dest -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue",
    "Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { stdio: STRICT_COPY ? "inherit" : "pipe" },
  );
  if (result.status !== 0) {
    throw new Error(`PowerShell copy fallback failed with status ${result.status ?? "unknown"}`);
  }
}

try {
  console.log("📦 Starting build output copy...");
  console.log(`   Source: ${SOURCE_DIR}`);
  console.log(`   Target: ${PC_DIST_TARGET_DIR}`);

  // Source directory must exist — the React Router build step is upstream of this script.
  try {
    statSync(SOURCE_DIR);
  } catch {
    console.error(`❌ Source directory not found: ${SOURCE_DIR}`);
    console.error("   Please run `react-router build` first.");
    process.exit(1);
  }

  // Clean target's children only (not the directory itself). On Windows the directory
  // is occasionally locked briefly by an IDE or running exe — deleting children avoids that.
  try {
    emptyDirectory(PC_DIST_TARGET_DIR);
    console.log("🧹 Cleaned target directory");
  } catch (err) {
    if (process.platform !== "win32") throw err;
    console.warn("⚠️ Bun fs clean failed, retrying with PowerShell fallback...");
    copyDirectoryWithPowerShell(SOURCE_DIR, PC_DIST_TARGET_DIR);
    console.log("✅ Build output copied successfully!");
    process.exit(0);
  }

  try {
    copyDirectory(SOURCE_DIR, PC_DIST_TARGET_DIR);
  } catch (copyError) {
    if (process.platform !== "win32") throw copyError;
    console.warn("⚠️ Bun fs copy failed, retrying with PowerShell fallback...");
    copyDirectoryWithPowerShell(SOURCE_DIR, PC_DIST_TARGET_DIR);
  }

  console.log("✅ Build output copied successfully!");
} catch (error) {
  console.error("❌ Copy failed:", error);
  process.exit(1);
}

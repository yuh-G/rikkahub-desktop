// updates/index.ts — 应用更新检查与下载
// 纪律：负责版本检查、下载源、缓存扫描，不依赖业务状态。

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fetchWithTimeout } from "../foundation/net";
import { join } from "node:path";
import { skipVersionPath, updatesCacheDir } from "../foundation/paths";
import type { GithubRelease } from "../foundation/types";

// 访问都快(GitHub Release 在国内常需代理)。Windows 走 R2(Rikkahub_<tag>_x64-setup.exe);
// Linux R2 无预编译包,仍走 GitHub Release 直链。
export const UPDATE_R2_BASE = "https://pub-d26eee7d911c4bab937ebe1729a4cefe.r2.dev";

export function readSkippedVersion(): string {
  try { return readFileSync(skipVersionPath, "utf-8").trim(); } catch { return ""; }
}
export function writeSkippedVersion(version: string) {
  try { writeFileSync(skipVersionPath, version.trim()); } catch { /* best-effort */ }
}

// 版本号唯一修改入口：`bun run version:bump <x.y.z>`（scripts/bump-version.ts），
// 一次同步本处 + tauri.conf.json + Cargo.toml 三处；请勿手改单处（CI 的
// check-version-sync.ts 会红灯）。更新检查用本值对比 GitHub release tag，
// 关于页也原样展示。
export const APP_VERSION = "2.0.0-preview-v4";

export async function fetchGithubLatestRelease(repo: string): Promise<GithubRelease> {
  const res = await fetchWithTimeout(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "RikkaHub-PC" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as GithubRelease;
}

// Anonymous fallback when api.github.com refuses. github.com/<repo>/releases/latest is a
// regular HTML page that 302-redirects to /releases/tag/v<latest>. We follow the redirect
// manually and pull the tag out of the Location header. No API, no rate limit, no token.
export async function fetchLatestReleaseFromHtmlRedirect(repo: string): Promise<{ tag: string; htmlUrl: string }> {
  const url = `https://github.com/${repo}/releases/latest`;
  const res = await fetchWithTimeout(url, {
    method: "HEAD",
    redirect: "manual",
    headers: { "User-Agent": "RikkaHub-PC" },
  });
  // GitHub returns 302 with Location: /<owner>/<repo>/releases/tag/v<tag> on success.
  const location = res.headers.get("location") ?? "";
  if (!location) {
    throw new Error(`No redirect from ${url} (status ${res.status})`);
  }
  const match = location.match(/\/releases\/tag\/v?([^/?#]+)/i);
  if (!match) {
    throw new Error(`Unrecognized release redirect target: ${location}`);
  }
  const tag = match[1].replace(/^v/i, "");
  const absoluteHtmlUrl = location.startsWith("http") ? location : `https://github.com${location}`;
  return { tag, htmlUrl: absoluteHtmlUrl };
}

// Look for a previously-downloaded installer for this exact version in the temp dir so the
// UI can offer "直接安装" without re-downloading. Matched first by canonical filename, then
// by any *.exe whose name embeds the version tag (tolerates users moving/renaming files).
// Returns null if isNewer is false (don't surface stale installers).
//
// 仅 Windows 调用(buildResponse 里按平台过滤):Linux 的更新是 tar.gz,需要解压后才能
// apply,缓存的 tar.gz 没法直接用,所以 Linux 走"每次重新下载解压"的路径,见 update/download。
export function probeCachedInstaller(fileName: string, tag: string, isNewer: boolean): string | null {
  if (!isNewer || !fileName) return null;
  try {
    const tmpDir = updatesCacheDir;
    if (!existsSync(tmpDir)) return null;
    const canonical = join(tmpDir, fileName);
    if (existsSync(canonical) && statSync(canonical).size > 0) {
      return canonical;
    }
    for (const entry of readdirSync(tmpDir)) {
      if (!/\.exe$/i.test(entry)) continue;
      if (tag && !entry.includes(tag)) continue;
      const candidate = join(tmpDir, entry);
      try {
        if (statSync(candidate).size > 0) return candidate;
      } catch { /* ignore */ }
    }
  } catch (cacheErr) {
    console.warn("[update/check] cache scan failed:", cacheErr);
  }
  return null;
}

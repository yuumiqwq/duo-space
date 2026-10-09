import { mkdir } from "node:fs/promises";
import path from "node:path";

// Runtime data is mounted separately and must not be traced into the bundle.
export const cloudRoot = path.join(/* turbopackIgnore: true */
  process.env.DATA_DIR || (process.env.NODE_ENV === "production" ? "/data" : path.join(process.cwd(), ".data")),
  "cloud-drive",
);

export const cloudStagingRoot = path.join(/* turbopackIgnore: true */ path.dirname(cloudRoot), "cloud-drive-staging");

export function sanitizeFileName(value: string, fallback = "file") {
  const cleaned = value
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .replace(/^\.+$/, "_")
    .trim()
    .slice(0, 180);
  return cleaned || fallback;
}

export function normalizeCloudPath(value: string | null | undefined) {
  if (!value) return "";
  const normalized = value.replace(/\\/g, "/").split("/")
    .filter(Boolean)
    .map((part) => sanitizeFileName(part, "_"))
    .join("/");
  return normalized.slice(0, 800);
}

export function resolveCloudPath(relativePath = "") {
  const normalized = normalizeCloudPath(relativePath);
  const resolved = path.resolve(cloudRoot, normalized);
  const rootPrefix = `${path.resolve(cloudRoot)}${path.sep}`;
  if (resolved !== path.resolve(cloudRoot) && !resolved.startsWith(rootPrefix)) throw new Error("Invalid cloud path");
  return { normalized, resolved };
}

export async function ensureCloudFolders() {
  // Content-specific folders are created when saving there, not when listing the drive.
  await mkdir(cloudRoot, { recursive: true, mode: 0o700 });
}


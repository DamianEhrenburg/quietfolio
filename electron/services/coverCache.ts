import { app, net, protocol } from "electron";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fetchResponse } from "./networkClient";

import {
  isLocalCoverUrl,
  QUIETFOLIO_COVER_SCHEME
} from "../../src/shared/coverScheme";
import { APP_USER_AGENT } from "../../src/shared/appMeta";

const COVER_SCHEME = QUIETFOLIO_COVER_SCHEME;
const MAX_COVER_SIZE = 12 * 1024 * 1024;
const MIN_COVER_SIZE = 400;

export function registerCoverScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: COVER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ]);
}

export function getCoversDirectory() {
  return path.join(app.getPath("userData"), "covers");
}

function sanitizeFilename(value: string) {
  const filename = path.basename(value);
  if (!/^[a-f0-9]{24,64}\.(?:jpg|jpeg|png|webp)$/i.test(filename)) {
    throw new Error("Некорректное имя файла обложки");
  }
  return filename;
}

export function registerCoverProtocol() {
  const serveCover = async (request: Request) => {
    try {
      const url = new URL(request.url);
      const filename = sanitizeFilename(decodeURIComponent(url.pathname.slice(1)));
      const target = path.join(getCoversDirectory(), filename);
      if (!fs.existsSync(target)) {
        return new Response("Cover not found", { status: 404 });
      }
      return net.fetch(pathToFileURL(target).toString());
    } catch {
      return new Response("Invalid cover URL", { status: 400 });
    }
  };

  protocol.handle(COVER_SCHEME, serveCover);
}

function extensionForContentType(contentType: string) {
  const normalized = contentType.toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  return "jpg";
}

function localCoverUrl(filename: string) {
  return `${COVER_SCHEME}://cover/${encodeURIComponent(filename)}`;
}

function isTrustedCoverHost(url: string) {
  return /fantlab\.ru\/images\//i.test(url);
}

export function isTrustedCoverHostUrl(url?: string) {
  const trimmed = url?.trim();
  return Boolean(trimmed && isTrustedCoverHost(trimmed));
}

export { isLocalCoverUrl } from "../../src/shared/coverScheme";

export async function cacheRemoteCover(
  remoteUrl: string | undefined,
  timeoutMs = 15_000
): Promise<string | undefined> {
  const normalizedUrl = remoteUrl?.trim();
  if (!normalizedUrl) return undefined;
  if (isLocalCoverUrl(normalizedUrl)) return normalizedUrl;
  if (!/^https?:\/\//i.test(normalizedUrl)) return normalizedUrl;

  const hash = createHash("sha256").update(normalizedUrl).digest("hex").slice(0, 40);
  const coversDir = getCoversDirectory();
  fs.mkdirSync(coversDir, { recursive: true });

  const existing = fs
    .readdirSync(coversDir)
    .find((filename) => filename.startsWith(`${hash}.`));
  if (existing) return localCoverUrl(existing);

  const response = await fetchResponse(normalizedUrl, {
    timeoutMs,
    retries: 2,
    preferNodeTransport: true,
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "User-Agent": APP_USER_AGENT
    }
  });

  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > MAX_COVER_SIZE) {
    throw new Error("Обложка слишком большая");
  }

  const isJpeg = data[0] === 0xff && data[1] === 0xd8;
  const isPng = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
  if (!isJpeg && !isPng && !isWebp) {
    throw new Error("Сервис вернул неподдерживаемый формат обложки");
  }
  if (data.length < MIN_COVER_SIZE) {
    throw new Error("Получено пустое или некорректное изображение обложки");
  }

  const contentType = response.headers.get("content-type") || "";
  const extension = extensionForContentType(
    contentType.toLowerCase().startsWith("image/") ? contentType : isPng ? "image/png" : isWebp ? "image/webp" : "image/jpeg"
  );
  const filename = `${hash}.${extension}`;
  const target = path.join(coversDir, filename);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, target);
  return localCoverUrl(filename);
}

/** Проверяет URL обложки скачиванием; возвращает remote URL при успехе. */
export async function verifyRemoteCoverUrl(
  remoteUrl: string | undefined,
  timeoutMs = 8_000
): Promise<string | undefined> {
  try {
    await cacheRemoteCover(remoteUrl, timeoutMs);
    return remoteUrl?.trim();
  } catch {
    return undefined;
  }
}

export async function warmRemoteCovers(
  remoteUrls: Array<string | undefined>,
  timeoutMs = 15_000,
  concurrency = 5
): Promise<Record<string, string>> {
  const unique = [
    ...new Set(
      remoteUrls.flatMap((url) => {
        const trimmed = url?.trim();
        return trimmed && /^https?:\/\//i.test(trimmed) ? [trimmed] : [];
      })
    )
  ];
  const mapped: Record<string, string> = {};

  for (let index = 0; index < unique.length; index += concurrency) {
    const batch = unique.slice(index, index + concurrency);
    const settled = await Promise.allSettled(
      batch.map((url) => cacheRemoteCover(url, timeoutMs))
    );
    batch.forEach((url, batchIndex) => {
      const result = settled[batchIndex];
      if (result.status === "fulfilled" && result.value) mapped[url] = result.value;
    });
  }

  return mapped;
}

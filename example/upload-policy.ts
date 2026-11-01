export const ALLOWED_CONTENT_TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
};

export const MAX_FILE_BYTES = 4_000 * 1024 * 1024 * 50_000;
export const ACCEPT_FILES = Object.entries(ALLOWED_CONTENT_TYPES)
  .flatMap(([type, extension]) => [type, `.${extension}`])
  .concat(".jpeg")
  .join(",");

export function normalizeFile(file: File): File {
  if (ALLOWED_CONTENT_TYPES[file.type]) return file;
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  const contentType = Object.entries(ALLOWED_CONTENT_TYPES).find(
    ([, value]) =>
      value === extension || (extension === "jpeg" && value === "jpg"),
  )?.[0];
  return contentType
    ? new File([file], file.name, {
        type: contentType,
        lastModified: file.lastModified,
      })
    : file;
}

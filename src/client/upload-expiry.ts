export function effectiveUploadExpiry(
  file: { createdAt: number; uploadExpiresAt?: number },
  fallbackTtlMs: number,
) {
  return (
    file.uploadExpiresAt ??
    file.createdAt + Math.max(fallbackTtlMs, 60 * 60 * 1000)
  );
}

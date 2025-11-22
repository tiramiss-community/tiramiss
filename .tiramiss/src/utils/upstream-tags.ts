export function normalizeUpstreamTagNamespace(
  upstreamRemote: string,
  override?: string,
) {
  const fallback = `refs/tags/${upstreamRemote}`;
  const trimmed = override?.trim();
  const raw = trimmed ? trimmed : fallback;
  const withPrefix = raw.startsWith("refs/") ? raw : `refs/tags/${raw}`;
  return withPrefix.replace(/\/+$/, "");
}

export function sanitizeUpstreamTagSuffix(input: string) {
  return input.trim().replace(/^\/+|\/+$/g, "");
}

export function buildUpstreamTagRef(suffix: string, namespace: string) {
  const base = namespace.replace(/\/+$/, "");
  const cleaned = sanitizeUpstreamTagSuffix(suffix);
  if (!cleaned) {
    throw new Error("Upstreamタグ名が空です。例: 2025.10.0");
  }
  return `${base}/${cleaned}`;
}

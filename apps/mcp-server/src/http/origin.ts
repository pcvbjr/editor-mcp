export function parseSerializedHttpOrigin(value: string): string | undefined {
  if (value.length === 0 || value !== value.trim() || value === 'null' || value.includes('*')) {
    return undefined;
  }

  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== '/' ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

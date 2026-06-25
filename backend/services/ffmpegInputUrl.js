function normalizeInputUrl(inputUrl) {
  const trimmed = String(inputUrl || "").trim();

  if (!trimmed.toLowerCase().startsWith("udp://")) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    parsed.searchParams.set("reuse", parsed.searchParams.get("reuse") || "1");
    parsed.searchParams.set("overrun_nonfatal", parsed.searchParams.get("overrun_nonfatal") || "1");
    parsed.searchParams.set("fifo_size", parsed.searchParams.get("fifo_size") || "50000000");
    return parsed.toString();
  } catch {
    const separator = trimmed.includes("?") ? "&" : "?";
    return `${trimmed}${separator}reuse=1&overrun_nonfatal=1&fifo_size=50000000`;
  }
}

module.exports = {
  normalizeInputUrl,
};

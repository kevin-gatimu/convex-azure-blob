export const MIN_BLOCK_SIZE = 8 * 1024 * 1024;
export const MAX_BLOCK_SIZE = 4000 * 1024 * 1024;
export const MAX_BLOCKS = 50_000;

/** Fixed-width base64 identifiers preserve deterministic block ordering. */
export function blockId(index: number) {
  return btoa(String(index).padStart(8, "0"));
}

export function blockSizeFor(size: number) {
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_BLOCK_SIZE * MAX_BLOCKS
  )
    throw new Error("Invalid block upload size");
  return Math.max(MIN_BLOCK_SIZE, Math.ceil(size / MAX_BLOCKS));
}

/** Parses Azure's bounded block list, rejecting anything outside its small XML grammar. */
export function parseBlockList(xml: string) {
  if (xml.length > 10 * 1024 * 1024) throw new Error("Invalid block list");
  const body = xml
    .replace(
      /^\s*<\?xml version="1\.0" encoding="utf-8"(?: standalone="yes")?\?>\s*/i,
      "",
    )
    .trim();
  const root = /^<BlockList>([\s\S]*)<\/BlockList>$/.exec(body);
  if (!root) throw new Error("Invalid block list");
  const result: { id: string; size: number; committed: boolean }[] = [];
  const seen = new Set<string>();
  let remaining = root[1]!.trim();
  for (const tag of ["CommittedBlocks", "UncommittedBlocks"]) {
    const empty = new RegExp(`^<${tag}\\s*/>`);
    const section = new RegExp(`^<${tag}>([\\s\\S]*?)</${tag}>`).exec(
      remaining,
    );
    if (empty.test(remaining)) {
      remaining = remaining.replace(empty, "").trim();
      continue;
    }
    if (!section) continue;
    remaining = remaining.slice(section[0].length).trim();
    let records = section[1]!.trim();
    while (records) {
      const record =
        /^<Block>\s*<Name>([A-Za-z0-9+/=]+)<\/Name>\s*<Size>([0-9]+)<\/Size>\s*<\/Block>/.exec(
          records,
        );
      if (!record) throw new Error("Invalid block list");
      const id = record[1]!;
      const size = Number(record[2]);
      const key = `${tag}:${id}`;
      if (
        seen.has(key) ||
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        size > MAX_BLOCK_SIZE ||
        result.length >= MAX_BLOCKS * 2
      )
        throw new Error("Invalid block list");
      seen.add(key);
      result.push({ id, size, committed: tag === "CommittedBlocks" });
      records = records.slice(record[0].length).trim();
    }
  }
  if (remaining) throw new Error("Invalid block list");
  return result;
}

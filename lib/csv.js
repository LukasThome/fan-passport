// Minimal CSV parser for issuer exports (header row, quoted cells, CRLF tolerant).
function parseLine(line) {
  const cells = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function parseCsv(text) {
  const lines = String(text).replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const header = parseLine(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = parseLine(l);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

module.exports = { parseCsv };

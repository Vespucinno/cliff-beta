import fs from "fs";
import path from "path";
import {
  extractExportedSymbols,
  extractCallSitesFromFile,
  CallSite,
} from "./ast";

export function analyzeDominoEffect(
  repoRoot: string,
  changedFilePath: string,
  changedFileContent: string,
): CallSite[] {
  const symbols = extractExportedSymbols(changedFileContent);
  if (symbols.length === 0) return [];

  const affectedCallSites: CallSite[] = [];
  function scanDirectory(dir: string) {
    if (affectedCallSites.length >= 10) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (["node_modules", ".git", "dist", "build"].includes(entry.name))
          continue;
        scanDirectory(fullPath);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))
      ) {
        if (path.resolve(fullPath) === path.resolve(changedFilePath)) continue;

        const content = fs.readFileSync(fullPath, "utf-8");

        for (const symbol of symbols) {
          if (content.includes(symbol.name) && content.includes("import")) {
            const callSites = extractCallSitesFromFile(
              content,
              fullPath,
              symbol.name,
            );
            affectedCallSites.push(...callSites);
          }
        }
      }
    }
  }

  if (fs.existsSync(repoRoot)) {
    scanDirectory(repoRoot);
  }

  return affectedCallSites.slice(0, 10);
}

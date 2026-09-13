import * as ts from "typescript";
export interface ChangedSymbol {
  name: string;
  kind: "function" | "interface" | "type" | "class";
}

export interface CallSite {
  callerFile: string;
  line: number;
  snippet: string;
}

export function extractExportedSymbols(fileContent: string): ChangedSymbol[] {
  const sourceFile = ts.createSourceFile(
    "temp.ts",
    fileContent,
    ts.ScriptTarget.Latest,
    true,
  );
  const symbols: ChangedSymbol[] = [];

  function visit(node: ts.Node) {
    const isExported =
      ts.canHaveModifiers(node) &&
      ts
        .getModifiers(node)
        ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (isExported) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        symbols.push({ name: node.name.text, kind: "function" });
      } else if (ts.isInterfaceDeclaration(node)) {
        symbols.push({ name: node.name.text, kind: "interface" });
      } else if (ts.isTypeAliasDeclaration(node)) {
        symbols.push({ name: node.name.text, kind: "type" });
      } else if (ts.isClassDeclaration(node) && node.name) {
        symbols.push({ name: node.name.text, kind: "class" });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return symbols;
}

export function extractCallSitesFromFile(
  fileContent: string,
  filePath: string,
  symbolName: string,
): CallSite[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    fileContent,
    ts.ScriptTarget.Latest,
    true,
  );
  const callSites: CallSite[] = [];

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const exprText = node.expression.getText(sourceFile);
      if (exprText === symbolName || exprText.endsWith(`.${symbolName}`)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(),
        );
        callSites.push({
          callerFile: filePath,
          line: line + 1,
          snippet: node.getText(sourceFile),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return callSites;
}

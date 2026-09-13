import dotenv from "dotenv";
import { analyzeDominoEffect } from "./services/domino";
import { runHermesAnalysis } from "./services/hermes";

dotenv.config();

async function main() {
  console.log("--- TESTING CLIFF PHASE 1: AST & DOMINO EFFECT ---");

  // Simulasi file auth.ts yang mengalami breaking change signature
  const sampleChangedFile = `
export function fetchUserData(userId: string, options: { includeRole: boolean }) {
  return { id: userId, options };
}
  `;

  // Analisis efek domino ke file lain di dalam folder src/
  const callSites = analyzeDominoEffect(
    "./src",
    "./src/services/auth.ts",
    sampleChangedFile,
  );

  console.log(`\nFound ${callSites.length} downstream call sites at risk.`);
  console.dir(callSites, { depth: null });

  const sampleDiff = `
--- a/src/services/auth.ts
+++ b/src/services/auth.ts
- export function fetchUserData(userId: string) {
+ export function fetchUserData(userId: string, options: { includeRole: boolean }) {
  `;

  console.log("\nSending Diff + Domino Context to Hermes AI...");
  const result = await runHermesAnalysis(
    sampleDiff,
    "Refactor fetchUserData signature",
    callSites,
  );

  console.log("\n[SUCCESS] Hermes AI Analysis Result:");
  console.dir(result, { depth: null });
}

main();

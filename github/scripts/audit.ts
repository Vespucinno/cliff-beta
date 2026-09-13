import fs from "fs";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PR_DIFF = process.env.PR_DIFF;

if (!GEMINI_API_KEY || !PR_DIFF) {
  console.error("⚠️ Variable GEMINI_API_KEY atau PR_DIFF tidak ditemukan.");
  process.exit(1);
}

const OWASP_LIGHT_PROMPT = `
You are CLIFF Lightweight Security Auditor. Analyze the provided PR code diff ONLY for these 10 OWASP categories:
1. Injection: SQLi, Command Injection, XSS in string manipulation/inputs.
2. Broken Access Control: Unprotected endpoints, missing auth/role checks.
3. Cryptographic Failures: Hardcoded API keys, passwords, or weak encryption.
4. Security Misconfiguration: Active debug mode, CORS wildcard (*), sensitive exposed configs.
5. Authentication Failures: Exposed tokens/sessions, bypassable login flows.
6. Vulnerable Components: Usage of deprecated/unsafe functions (eval, exec).
7. Insecure Design: Business logic without basic validation or rate-limiting.
8. Data Integrity Failures: Executing untrusted payloads/files without verification.
9. Security Logging Failures: Printing sensitive data (passwords, tokens) in console logs.
10. SSRF & Exception Mishandling: Raw external URL fetching, leak of stack traces.

Instructions:
- Ignore code style, formatting, variable names, or performance optimization.
- If no vulnerabilities exist, reply EXACTLY with: "✅ Code clean, no basic OWASP vulnerabilities found."
- If vulnerabilities exist, list them in Markdown bullet points:
  - **[OWASP Category]** (Line X): Description + 1-line remediation code suggestion.


  Wajib kembalikan HANYA array JSON murni tanpa pembungkus markdown/penjelasan:
[
  {
    "path": "src/services/auth.ts",
    "line": 15,
    "severity": "CRITICAL",
    "message": "SQL Injection terdeteksi pada query ini. Gunakan parameterized query."
  }
]
=== PR DIFF TO AUDIT ===
${PR_DIFF.slice(0, 30000)}
`;

async function runAudit() {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: OWASP_LIGHT_PROMPT }] }],
        }),
      },
    );

    const data = await response.json();
    const output =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Failed to parse Gemini response.";

    fs.writeFileSync("audit-result.md", output);
    console.log("✅ Audit completed successfully.");
  } catch (err) {
    console.error("❌ Audit failed:", err);
    process.exit(1);
  }
}

runAudit();

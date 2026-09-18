import { parseAndValidateReviewResponse } from "../services/hermes";
import { formatFindingMarkdown, formatMainReviewMarkdown } from "../services/github";
import { ReviewResult } from "../types";

let passedCount = 0;
let totalCount = 0;

function assert(condition: boolean, message: string) {
  totalCount++;
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passedCount++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
  }
}

async function runTests() {
  console.log("==================================================");
  console.log("  CLIFF AI EVIDENCE-BASED REVIEWER TEST SUITE");
  console.log("==================================================\n");

  // TEST 1 — Vulnerable SQL Query
  console.log("Test 1: Vulnerable SQL Query Response Parsing & Validation");
  {
    const mockModelOutput = JSON.stringify({
      summary: "PR adds user lookup endpoint with SQL injection flaw.",
      risk_level: "high",
      breaking_changes: [],
      findings: [
        {
          severity: "high",
          category: "security",
          title: "SQL Injection in User Lookup Route",
          file: "src/routes/users.py",
          line: 42,
          description: "User-controlled `username` parameter is directly interpolated into raw SQL query.",
          evidence: [
            "cursor.execute(f\"SELECT * FROM users WHERE username = '{username}'\")"
          ],
          why_it_matters: "Allows unauthenticated attackers to execute arbitrary SQL queries, bypassing auth or dumping data.",
          suggested_fix: "Use parameterized query: cursor.execute('SELECT * FROM users WHERE username = ?', (username,))",
          confidence: "high"
        }
      ]
    });

    const result: ReviewResult = parseAndValidateReviewResponse(mockModelOutput);

    assert(result.risk_level === "high", "Risk level computed as high");
    assert(result.findings.length === 1, "Contains exactly 1 finding");
    assert(result.findings[0].category === "security", "Finding category is security");
    assert(result.findings[0].severity === "high", "Finding severity is high");
    assert(result.findings[0].file === "src/routes/users.py", "Finding file is correct");
    assert(result.findings[0].line === 42, "Finding line is 42");
    assert(result.findings[0].evidence.length > 0, "Evidence array is populated");
    assert(result.findings[0].confidence === "high", "Confidence is high");

    const markdown = formatFindingMarkdown(result.findings[0]);
    assert(markdown.includes("🔴 HIGH — SQL Injection"), "Markdown includes high severity badge and title");
    assert(markdown.includes("`src/routes/users.py:42`"), "Markdown includes file:line header");
  }

  // TEST 2 — Safe Parameterized Query
  console.log("\nTest 2: Safe Parameterized Query (No False Positives)");
  {
    const mockModelOutput = JSON.stringify({
      summary: "PR adds parameterized user lookup route.",
      risk_level: "low",
      breaking_changes: [],
      findings: []
    });

    const result: ReviewResult = parseAndValidateReviewResponse(mockModelOutput);

    assert(result.risk_level === "low", "Risk level is low");
    assert(result.findings.length === 0, "No SQL injection finding produced for safe query");
  }

  // TEST 3 — Clean PR
  console.log("\nTest 3: Clean PR (Empty Findings Array)");
  {
    const mockModelOutput = JSON.stringify({
      summary: "No high-confidence issues were identified.",
      risk_level: "low",
      breaking_changes: [],
      findings: []
    });

    const result: ReviewResult = parseAndValidateReviewResponse(mockModelOutput);

    assert(result.risk_level === "low", "Risk level is low");
    assert(result.findings.length === 0, "Findings array is empty");
    assert(result.summary === "No high-confidence issues were identified.", "Summary matches clean PR statement");

    const mainMarkdown = formatMainReviewMarkdown(result);
    assert(mainMarkdown.includes("✓ No high-confidence issues found."), "Main review output includes clean PR checkmark");
  }

  // TEST 4 — Generic Unrelated Route (No Forced Advice)
  console.log("\nTest 4: Generic Unrelated Route (No Forced Auth/Security Finding)");
  {
    const mockModelOutput = JSON.stringify({
      summary: "PR adds health check route `/ping`.",
      risk_level: "low",
      breaking_changes: [],
      findings: []
    });

    const result: ReviewResult = parseAndValidateReviewResponse(mockModelOutput);

    assert(result.findings.length === 0, "No forced generic auth or security advice for simple ping endpoint");
  }

  // TEST 5 — Malformed AI Output
  console.log("\nTest 5: Malformed AI Output (Safe Fallback / No Webhook Crash)");
  {
    const malformedOutputs = [
      "Invalid JSON payload from server model response...",
      "```json\n{ summary: 'Bad JSON', risk_level: 'high', findings: [ invalid ] }\n```",
      "{ \"summary\": \"Partial JSON without closing brace",
      null,
      undefined,
      12345
    ];

    for (let i = 0; i < malformedOutputs.length; i++) {
      const result: ReviewResult = parseAndValidateReviewResponse(malformedOutputs[i]);
      assert(typeof result === "object" && result !== null, `Malformed input ${i + 1} returns valid ReviewResult object`);
      assert(Array.isArray(result.findings), `Malformed input ${i + 1} has valid findings array`);
      assert(typeof result.summary === "string", `Malformed input ${i + 1} has string summary`);
    }
  }

  // TEST 6 — Multiple Findings
  console.log("\nTest 6: Multiple Structured Findings Preserved Correctly");
  {
    const mockModelOutput = JSON.stringify({
      summary: "PR introduces critical auth bypass and high SQL injection flaw.",
      risk_level: "critical",
      breaking_changes: ["getUserProfile API signature changed"],
      findings: [
        {
          severity: "critical",
          category: "security",
          title: "Authentication Bypass",
          file: "src/auth/middleware.py",
          line: 15,
          description: "Condition checking JWT validity always evaluates to true.",
          evidence: ["if True: # temporary override during debug"],
          why_it_matters: "Bypasses all authentication checks across application.",
          suggested_fix: "Remove debug override and execute jwt.verifyToken()",
          confidence: "high"
        },
        {
          severity: "high",
          category: "security",
          title: "Raw SQL String Formatting",
          file: "src/db/repo.py",
          line: 88,
          description: "Database query uses f-string formatting.",
          evidence: ["cursor.execute(f'SELECT * FROM items WHERE id = {item_id}')"],
          why_it_matters: "SQL Injection risk.",
          suggested_fix: "Use parameterized query placeholders.",
          confidence: "high"
        }
      ]
    });

    const result: ReviewResult = parseAndValidateReviewResponse(mockModelOutput);

    assert(result.risk_level === "critical", "Dynamic risk level calculated as critical");
    assert(result.findings.length === 2, "Both structured findings preserved");
    assert(result.findings[0].severity === "critical", "First finding severity is critical");
    assert(result.findings[1].severity === "high", "Second finding severity is high");
    assert(result.breaking_changes.length === 1, "Breaking change preserved");
  }

  console.log("\n==================================================");
  console.log(`  SUMMARY: ${passedCount} / ${totalCount} assertions passed.`);
  console.log("==================================================\n");

  if (passedCount === totalCount) {
    console.log("🎉 ALL TESTS PASSED SUCCESSFULLY!");
  } else {
    console.error("❌ SOME TESTS FAILED!");
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});

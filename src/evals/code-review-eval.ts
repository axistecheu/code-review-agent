// Load environment variables first
import dotenv from "dotenv";
dotenv.config();

// Test cases for code review evaluation
const TEST_CASES = [
  {
    prNumber: 5,
    errorType: "Import Errors",
    expectedIssues: [
      "Typo in module name (lodsh instead of lodash)",
      "Wrong relative paths (./utilz, ./configuration)",
      "Non-existent modules",
      "Mixed ES6/CommonJS imports",
    ],
  },
  {
    prNumber: 6,
    errorType: "Syntax Errors",
    expectedIssues: [
      "Missing parentheses in function params",
      "Missing closing braces",
      "Missing semicolons",
      "Missing commas in objects/arrays",
      "Missing if condition parentheses",
    ],
  },
  {
    prNumber: 7,
    errorType: "Logical Errors",
    expectedIssues: [
      "Off-by-one errors in loops",
      "Wrong initial values (0 instead of arr[0])",
      "Incorrect boundary conditions",
      "Wrong array indexing",
    ],
  },
  {
    prNumber: 8,
    errorType: "Memory Leaks/Crashes",
    expectedIssues: [
      "Unbounded array growth",
      "Event listeners never removed",
      "Circular references",
      "Uncleared intervals",
      "Stack overflow potential",
      "Closure memory leaks",
    ],
  },
  {
    prNumber: 9,
    errorType: "Best Practices Violations",
    expectedIssues: [
      "Using var instead of let/const",
      "Magic numbers",
      "== instead of ===",
      "Using eval()",
      "Hardcoded credentials",
      "Extending built-in prototypes",
      "Callback hell",
      "Empty catch blocks",
      "Global namespace pollution",
    ],
  },
];

// Function to fetch PR review from GitHub
async function fetchPRReview(
  owner: string,
  repo: string,
  prNumber: number
): Promise<string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN not configured");
  }

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Code-Review-Eval",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch reviews: ${response.statusText}`);
  }

  const reviews = (await response.json()) as Array<{ body: string }>;
  if (reviews.length === 0) {
    throw new Error("No reviews found for this PR");
  }

  // Get the latest review (assuming it's from our agent)
  return reviews[reviews.length - 1].body || "No review content";
}

// Call Ollama API directly
async function callOllama(prompt: string, model: string): Promise<string> {
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

  const response = await fetch(`${ollamaBaseUrl}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ollama API error: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as { response: string };
  return data.response;
}

// Parse score from response
function parseScore(response: string): { score: number; reason: string } {
  // Try to find score in format "SCORE: X.XX" or "Score: X.XX"
  const scoreMatch = response.match(/SCORE:\s*([\d.]+)/i);
  if (scoreMatch) {
    const score = parseFloat(scoreMatch[1]);
    if (!isNaN(score) && score >= 0 && score <= 1) {
      return { score, reason: response };
    }
  }

  // Try to find rating/score patterns
  const ratingMatch = response.match(/(?:score|rating)[:\s]*([\d.]+)/i);
  if (ratingMatch) {
    const score = parseFloat(ratingMatch[1]);
    if (!isNaN(score) && score >= 0 && score <= 1) {
      return { score, reason: response };
    }
  }

  // Look for X/Y or X out of Y patterns
  const fractionMatch = response.match(/(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+(?:\.\d+)?)/i);
  if (fractionMatch) {
    const numerator = parseFloat(fractionMatch[1]);
    const denominator = parseFloat(fractionMatch[2]);
    if (denominator > 0) {
      const score = numerator / denominator;
      if (score >= 0 && score <= 1) {
        return { score, reason: response };
      }
    }
  }

  // Look for percentage
  const percentMatch = response.match(/(\d+(?:\.\d+)?)\s*%/);
  if (percentMatch) {
    const score = parseFloat(percentMatch[1]) / 100;
    if (score >= 0 && score <= 1) {
      return { score, reason: response };
    }
  }

  // Infer from sentiment
  const lowerResponse = response.toLowerCase();
  if (lowerResponse.includes("excellent") || lowerResponse.includes("perfect") || lowerResponse.includes("comprehensive")) {
    return { score: 0.9, reason: response };
  }
  if (lowerResponse.includes("good") || lowerResponse.includes("well identified") || lowerResponse.includes("thorough")) {
    return { score: 0.75, reason: response };
  }
  if (lowerResponse.includes("adequate") || lowerResponse.includes("fair") || lowerResponse.includes("partial")) {
    return { score: 0.5, reason: response };
  }
  if (lowerResponse.includes("poor") || lowerResponse.includes("missed") || lowerResponse.includes("lacking")) {
    return { score: 0.3, reason: response };
  }
  if (lowerResponse.includes("failed") || lowerResponse.includes("terrible") || lowerResponse.includes("inadequate")) {
    return { score: 0.1, reason: response };
  }

  return { score: 0.5, reason: response };
}

// Main evaluation function
async function runEvaluation() {
  const model = "glm-5:cloud";

  console.log("=== Code Review Agent Evaluation ===\n");
  console.log(`Using model: ${model}`);
  console.log(`Ollama URL: ${process.env.OLLAMA_BASE_URL}\n`);

  const results: Array<{
    prNumber: number;
    errorType: string;
    score: number;
    reason: string;
  }> = [];

  for (const testCase of TEST_CASES) {
    console.log(`\n--- Evaluating PR #${testCase.prNumber}: ${testCase.errorType} ---`);

    try {
      // Fetch the review content
      const reviewContent = await fetchPRReview(
        "axistecheu",
        "test-code",
        testCase.prNumber
      );

      console.log(`Review length: ${reviewContent.length} characters`);

      // Build evaluation prompt
      const prompt = `You are an expert code review evaluator. Evaluate this code review for ${testCase.errorType}.

**Expected Issues that should be identified:**
${testCase.expectedIssues.map((issue) => `- ${issue}`).join("\n")}

**Code Review Content to evaluate:**
${reviewContent}

**Instructions:**
1. Check how many of the expected issues were identified in the review
2. Assess the accuracy and specificity of the findings
3. Provide a score between 0 and 1 (where 1 = all issues perfectly identified, 0 = none identified)

**Response format:**
First line: SCORE: X.XX
Then: Brief explanation of why you gave this score

Example:
SCORE: 0.75
The review identified 3 out of 4 expected issues with good specificity.`;

      // Call Ollama directly
      console.log("Calling Ollama API...");
      const response = await callOllama(prompt, model);
      console.log(`\nEvaluator Response:\n${response}\n`);

      // Parse the score
      const { score, reason } = parseScore(response);
      console.log(`Parsed Score: ${score.toFixed(2)}`);

      results.push({
        prNumber: testCase.prNumber,
        errorType: testCase.errorType,
        score,
        reason: reason.substring(0, 500),
      });
    } catch (error) {
      console.error(
        `Error evaluating PR #${testCase.prNumber}:`,
        error instanceof Error ? error.message : error
      );
      results.push({
        prNumber: testCase.prNumber,
        errorType: testCase.errorType,
        score: 0,
        reason: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      });
    }
  }

  // Print summary
  console.log("\n\n" + "=".repeat(60));
  console.log("=== EVALUATION SUMMARY ===");
  console.log("=".repeat(60) + "\n");
  console.log("| PR # | Error Type | Score | Status |");
  console.log("|------|------------|-------|--------|");
  for (const result of results) {
    const status =
      result.score >= 0.7
        ? "✅ Good"
        : result.score >= 0.5
          ? "⚠️ Fair"
          : "❌ Poor";
    console.log(
      `| #${result.prNumber} | ${result.errorType.padEnd(24)} | ${result.score.toFixed(2)} | ${status} |`
    );
  }

  const avgScore =
    results.reduce((sum, r) => sum + r.score, 0) / results.length;
  console.log(`\n**Average Score: ${avgScore.toFixed(2)}**`);

  // Interpretation
  if (avgScore >= 0.8) {
    console.log("✅ Overall: Excellent review quality!");
  } else if (avgScore >= 0.6) {
    console.log("👍 Overall: Good review quality");
  } else if (avgScore >= 0.4) {
    console.log("⚠️ Overall: Fair review quality - room for improvement");
  } else {
    console.log("❌ Overall: Poor review quality - needs significant improvement");
  }

  return results;
}

// Run the evaluation
runEvaluation().catch(console.error);

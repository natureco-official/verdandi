import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLLMOutput } from "../src/llm_parser.js";

describe("parseLLMOutput", () => {
  it("sinirsiz sayida edit ve asiri buyuk model ciktisini reddeder", () => {
    const tooMany = JSON.stringify(Array.from({ length: 101 }, (_, index) => ({
      file: `src/${index}.ts`, symbol: `s${index}`, operation: "delete",
    })));
    assert.match(parseLLMOutput(tooMany).parseError ?? "", /Too many/);
    assert.match(parseLLMOutput("x".repeat(8 * 1024 * 1024 + 1)).parseError ?? "", /exceeds/);
  });
  it("delete operasyonunu newCode olmadan kabul eder", () => {
    const result = parseLLMOutput(`[{"file":"src/auth.ts","symbol":"validateToken","operation":"delete"}]`);

    assert.equal(result.parseError, undefined);
    assert.equal(result.edits.length, 1);
    assert.equal(result.edits[0].operation, "delete");
    assert.equal(result.edits[0].newCode, "");
  });

  it("markdown code fences arasindaki JSON'i cikarir", () => {
    const raw = `Here is the patch:
\`\`\`json
[
  { "file": "src/user.ts", "symbol": "getUser", "operation": "replace_symbol", "newCode": "export function getUser() { return 'ok'; }" }
]
\`\`\`
Hope this helps!`;
    const result = parseLLMOutput(raw);

    assert.equal(result.parseError, undefined);
    assert.equal(result.edits.length, 1);
    assert.equal(result.edits[0].file, "src/user.ts");
    assert.equal(result.edits[0].symbol, "getUser");
  });

  it("think tag'lerini ve akabinde gelen JSON'i cikarir", () => {
    const raw = `<think>
Analyzing the issue in auth.ts...
Need to delete validateToken.
</think>
[{"file":"src/auth.ts","symbol":"validateToken","operation":"delete"}]`;

    const result = parseLLMOutput(raw);
    assert.equal(result.parseError, undefined);
    assert.equal(result.edits.length, 1);
    assert.equal(result.edits[0].operation, "delete");
  });

  it("kesilmiş (truncated) JSON'ı kısmi uygulamamak için reddeder", () => {
    const raw = `[{"file":"src/a.ts","symbol":"foo","operation":"replace_symbol","newCode":"1"},{"file":"src/b.ts","symbol":"bar","operation":"delete"`;
    const result = parseLLMOutput(raw);

    assert.match(result.parseError ?? "", /No JSON array/);
    assert.equal(result.edits.length, 0);
  });
});

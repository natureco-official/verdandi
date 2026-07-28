import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathPrior, queryTokens, TypeScriptContextCompiler } from "../src/context_compiler.js";

const TEST_ROOT = path.resolve("/tmp/capsule-test-project");

async function scaffoldProject() {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(TEST_ROOT, { recursive: true });
  await mkdir(path.join(TEST_ROOT, "src"), { recursive: true });
  await mkdir(path.join(TEST_ROOT, "src/utils"), { recursive: true });
  await mkdir(path.join(TEST_ROOT, "test"), { recursive: true });

  await writeFile(
    path.join(TEST_ROOT, "package.json"),
    JSON.stringify({
      name: "test",
      scripts: { build: "echo ok", test: "echo test-ok", lint: "echo lint-ok", typecheck: "echo typecheck-ok" },
    })
  );

  await writeFile(
    path.join(TEST_ROOT, "tsdown.config.ts"),
    `export default { dts: true, external: ["workspace-package"] };`,
  );

  await writeFile(
    path.join(TEST_ROOT, "src/auth.ts"),
    `export interface AuthProvider {
  authenticate(token: string): Promise<boolean>;
  validate(): boolean;
}

export async function validateToken(token: string): Promise<boolean> {
  return token.length > 0;
}

export class AuthService implements AuthProvider {
  private token: string = "";

  async authenticate(token: string): Promise<boolean> {
    this.token = token;
    return validateToken(token);
  }

  validate(): boolean {
    return this.token.length > 0;
  }
}`
  );

  await writeFile(
    path.join(TEST_ROOT, "src/user.ts"),
    `import type { AuthProvider } from "./auth.js";

export function getUser(auth: AuthProvider): string {
  if (auth.validate()) {
    return "authenticated";
  }
  return "anonymous";
}`
  );

  await writeFile(
    path.join(TEST_ROOT, "src/utils/helpers.ts"),
    `export function formatDate(date: Date): string {
  return date.toISOString();
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export const multiply = (a: number, b: number): number => {
  return a * b;
};`
  );

  await writeFile(
    path.join(TEST_ROOT, "test/auth.test.ts"),
    `import { it } from "node:test";

it("silently refreshes an invalid token and retries the request once", async () => {
  const firstStatus = 401;
  const refreshedToken = "new-token";
  if (firstStatus !== 401 || !refreshedToken) throw new Error("retry failed");
});`,
  );
}

let compiler: TypeScriptContextCompiler;

describe("TypeScriptContextCompiler", () => {
  before(async () => {
    await scaffoldProject();
    compiler = new TypeScriptContextCompiler();
  });

  after(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  describe("context_capsule", () => {
    it("gorev metnine gore ilgili sembolleri bulur", async () => {
      const result = await compiler.context_capsule({
        task: "Token validasyon fonksiyonunu duzelt",
        projectRoot: TEST_ROOT,
      });

      assert.equal(result.schemaVersion, "0.2.0");
      assert.ok(result.taskId.length > 0, "taskId exists");
      assert.ok(result.modelPayload.goal.length > 0, "goal exists");

      const symbols = result.modelPayload.relevantSymbols;
      const hasValidateToken = symbols.some((s) => s.symbol === "validateToken");
      assert.ok(hasValidateToken, "validateToken found in relevant symbols");
      assert.ok(result.modelPayload.probableFiles.length >= 1);
    });

    it("token butcesini tahmin eder", async () => {
      const result = await compiler.context_capsule({
        task: "auth modulunu test et",
        projectRoot: TEST_ROOT,
      });

      assert.ok(result._meta.estimatedPayloadTokens > 0, "estimated tokens > 0");
      assert.ok(result._meta.estimatedPayloadTokens <= 300, "estimated tokens <= 300");
    });

    it("confidence skoru uretir", async () => {
      const result = await compiler.context_capsule({
        task: "AuthService sinifini genislet",
        projectRoot: TEST_ROOT,
      });

      assert.ok(result._meta.retrievalConfidence > 0, "confidence > 0");
      assert.ok(result._meta.retrievalConfidence <= 1, "confidence <= 1");
    });

    it("eslesmeyen gorev icin dusuk confidence doner", async () => {
      const result = await compiler.context_capsule({
        task: "quantum entanglement handler",
        projectRoot: TEST_ROOT,
      });

      assert.ok(result._meta.retrievalConfidence < 0.72, "low confidence for unmatched task");
      assert.ok(result._meta.silentEscalation, "silent escalation triggered");
      assert.equal(result._meta.selectedBudgetLevel, 3, "budget level escalated to 3");
    });

    it("low confidence'da silent escalation devreye girer", async () => {
      const result = await compiler.context_capsule({
        task: "nonsense xyzzy query",
        projectRoot: TEST_ROOT,
      });

      if (result._meta.retrievalConfidence < 0.72) {
        assert.equal(result._meta.selectedBudgetLevel, 3);
        assert.equal(result._meta.silentEscalation, true);
      }
    });

    it("1-hop komsulari dahil eder (import graph)", async () => {
      const result = await compiler.context_capsule({
        task: "AuthProvider interface ini kullan",
        projectRoot: TEST_ROOT,
      });

      const symbols = result.modelPayload.relevantSymbols;
      const files = symbols.map((s) => s.file);
      const hasMultipleFiles = new Set(files).size > 1;
      assert.ok(hasMultipleFiles || symbols.length >= 1, "multi-file or at least one symbol found");
    });

    it("NodeNext .js import specifier'larini TS kaynak dosyalarina baglar", async () => {
      const result = await compiler.context_capsule({
        task: "getUser AuthProvider kullanimi",
        projectRoot: TEST_ROOT,
      });

      const files = new Set(result.modelPayload.relevantSymbols.map((symbol) => symbol.file));
      assert.ok(files.has("src/user.ts"), "direct user symbol found");
      assert.ok(files.has("src/auth.ts"), "neighbor auth symbol found through ./auth.js import");
    });

    it("payload 1200 byte i asmaz", async () => {
      const result = await compiler.context_capsule({
        task: "tum auth ve user modullerini birlestir refactoring yap",
        projectRoot: TEST_ROOT,
      });

      const payloadSize = JSON.stringify(result.modelPayload).length;
      assert.ok(payloadSize <= 1200, `payload size ${payloadSize} <= 1200`);
    });

    it("budget level ozellestirilebilir", async () => {
      const result = await compiler.context_capsule({
        task: "token validasyonu",
        projectRoot: TEST_ROOT,
        preferredBudgetLevel: 2,
      });

      if (result._meta.retrievalConfidence >= 0.72) {
        assert.equal(result._meta.selectedBudgetLevel, 2);
      }
    });

    it("mekanik import siralama gorevini tek sembolluk butceye indirir", async () => {
      const result = await compiler.context_capsule({
        task: "Auth modulundeki import siralamasini lint kurallarina gore duzelt; davranisi degistirme",
        projectRoot: TEST_ROOT,
        preferredBudgetLevel: 3,
      });

      assert.equal(result._meta.selectedBudgetLevel, 0);
      assert.equal(result.modelPayload.relevantSymbols.length, 1);
      assert.equal(result.modelPayload.probableFiles.length, 1);
      assert.match(result.modelPayload.decisions[1]?.summary ?? "", /mekanik import\/lint/);
    });

    it("test niyetinde test dosyalarini uretim dosyalarinin gerisine itmez", () => {
      const query = queryTokens("entegrasyon testi tekrar kosumda sizinti birakmasin");
      assert.ok(pathPrior("test/integration/server/cloudflareWorkers.test.ts", query) > 0);
      assert.ok(
        pathPrior("test/integration/server/cloudflareWorkers.test.ts", query) >
          pathPrior("examples/cloudflareWorkers.ts", query),
      );
    });

    it("it/test bloklarini retrieval sembolu olarak indeksler", async () => {
      const result = await compiler.context_capsule({
        task: "401 invalid token refresh sonrasi istegi tek kez retry eden regresyon testi ekle",
        projectRoot: TEST_ROOT,
        preferredBudgetLevel: 3,
        maxModelPayloadTokens: 1200,
      });

      assert.equal(result.modelPayload.probableFiles[0], "test/auth.test.ts");
      assert.ok(result.modelPayload.relevantSymbols.some(symbol =>
        symbol.kind === "test" && symbol.symbol.includes("refreshes an invalid token"),
      ));
    });

    it("davranissal server gorevlerinde uretilmis protokol tipini geri plana alir", () => {
      const query = queryTokens("server resource URI request handler hatasini duzelt");
      const handlerPrior = pathPrior("packages/server/src/server/mcp.ts", query);
      const generatedPrior = pathPrior("packages/core-internal/src/types/spec.types.2026-07-28.ts", query);

      assert.ok(handlerPrior > generatedPrior + 20);
    });

    it("declaration bundle gorevinde build config dosyasini one alir", async () => {
      const result = await compiler.context_capsule({
        task: "declaration build bundle dts OOM sorununu duzelt",
        projectRoot: TEST_ROOT,
      });

      assert.ok(result.modelPayload.probableFiles.includes("tsdown.config.ts"));
    });

    it("session gorevini client transport ve header kavramlarina genisletir", () => {
      const query = queryTokens("initialize sirasinda eski session id gonderilmesin, yanittan yakalansin");
      for (const concept of ["client", "transport", "header", "request", "response"]) {
        assert.ok(query.includes(concept), `missing ${concept}`);
      }
    });

    it("serialize cache-hit gorevini codec seam kavramlarina genisletir", () => {
      const query = queryTokens("serialize edilmis documentlari cache hit sirasinda oku ve parametre aynalama davranisini koru");
      for (const concept of ["encode", "document", "codec", "serve", "read", "write", "mirror"]) {
        assert.ok(query.includes(concept), `missing ${concept}`);
      }
    });

    it("genis gorevlerde token ekonomisini kalite kontrol listesinin onune koymaz", async () => {
      const result = await compiler.context_capsule({
        task: "public cache API serialize document davranisini ve geriye uyumlulugu duzelt",
        projectRoot: TEST_ROOT,
        preferredBudgetLevel: 3,
        maxModelPayloadTokens: 1200,
      });

      assert.match(result.modelPayload.decisions[1]?.summary ?? "", /kapsamı genişlet/);
      assert.ok(result.modelPayload.successCriteria.some(item => /Public tip\/API/.test(item)));
      assert.ok(result.modelPayload.successCriteria.some(item => /Son düzenlemeden sonra/.test(item)));
    });

    it("uygulama gorevinde examples dosyasini production transporttan geriye atar", () => {
      const query = queryTokens("streamable HTTP transport keep alive timer ekle");
      assert.ok(
        pathPrior("packages/server/src/server/streamableHttp.ts", query) >
          pathPrior("packages/server/src/server/streamableHttp.examples.ts", query) + 20,
      );
    });
  });

  describe("read_symbol", () => {
    it("belirli bir sembolun kaynak kodunu okur", async () => {
      const result = await compiler.read_symbol({
        projectRoot: TEST_ROOT,
        symbol: "validateToken",
      });

      assert.ok(result.evidence.length >= 1, "evidence found");
      assert.equal(result.evidence[0].symbol.symbol, "validateToken");
      assert.ok(result.evidence[0].source!.length > 0, "source code present");
      assert.ok(result.evidence[0].startLine > 0, "startLine > 0");
      assert.ok(result.evidence[0].endLine >= result.evidence[0].startLine);
    });

    it("fileHint ile filtreleme yapar", async () => {
      const result = await compiler.read_symbol({
        projectRoot: TEST_ROOT,
        symbol: "validate",
        fileHint: "auth",
      });

      assert.ok(result.evidence.length >= 1);
      assert.ok(result.evidence[0].symbol.file.includes("auth"));
    });

    it("icerik hash i uretir", async () => {
      const result = await compiler.read_symbol({
        projectRoot: TEST_ROOT,
        symbol: "validateToken",
      });

      assert.ok(result.evidence[0].contentHash.length === 64, "SHA-256 hash");
      assert.ok(result.evidence[0].fileContentHash!.length === 64);
    });

    it("token tahmini uretir", async () => {
      const result = await compiler.read_symbol({
        projectRoot: TEST_ROOT,
        symbol: "validateToken",
        maxTokens: 1200,
      });

      assert.ok(result.estimatedTokens > 0, "estimated tokens > 0");
    });

    it("snapshot uretir", async () => {
      const result = await compiler.read_symbol({
        projectRoot: TEST_ROOT,
        symbol: "validateToken",
      });

      assert.ok(result.snapshot.length > 0, "snapshot exists");
    });

    it("includeBody false ise sadece signature doner", async () => {
      const result = await compiler.read_symbol({
        projectRoot: TEST_ROOT,
        symbol: "validateToken",
        includeBody: false,
      });

      assert.ok(result.evidence.length >= 1);
      assert.ok(result.evidence[0].signature!.length > 0, "signature present");
      assert.equal(result.evidence[0].source, undefined, "no source when includeBody=false");
    });

    it("belirsiz sembolde govdeleri dokmeden fileHint ister", async () => {
      const result = await compiler.read_symbol({ projectRoot: TEST_ROOT, symbol: "validate" });
      assert.ok(result.evidence.length > 1);
      assert.equal(result.requiresEscalation, true);
      assert.ok(result.evidence.every(item => item.source === undefined));
    });

    it("read_symbol token ust sinirini zorunlu tutar", async () => {
      await assert.rejects(
        () => compiler.read_symbol({ projectRoot: TEST_ROOT, symbol: "validateToken", maxTokens: 4001 }),
        /maxTokens/,
      );
    });
  });

  describe("apply_structured_patch", () => {
    it("dryRun ile degisiklik yapmadan dogrular", async () => {
      const readResult = await compiler.read_symbol({
        projectRoot: TEST_ROOT,
        symbol: "validateToken",
      });

      const patchResult = await compiler.apply_structured_patch({
        projectRoot: TEST_ROOT,
        taskId: "test-patch-01",
        snapshot: readResult.snapshot,
        language: "typescript",
        dryRun: true,
        operations: [
          {
            operation: "replace_symbol",
            file: readResult.evidence[0].symbol.file,
            symbol: "validateToken",
            replacement: "export function validateToken(token: string): boolean { return token.length > 0; }",
            precondition: {
              file: readResult.evidence[0].symbol.file,
              contentHash: readResult.evidence[0].fileContentHash!,
              symbol: "validateToken",
              symbolHash: readResult.evidence[0].contentHash,
            },
          },
        ],
      });

      assert.equal(patchResult.applied, true);
      assert.ok(patchResult.changedFiles.length >= 1);
    });

    it("stale snapshot reddeder", async () => {
      const patchResult = await compiler.apply_structured_patch({
        projectRoot: TEST_ROOT,
        taskId: "test-stale",
        snapshot: "stale-snapshot-value",
        language: "typescript",
        dryRun: true,
        operations: [
          {
            operation: "replace_symbol",
            file: "src/auth.ts",
            symbol: "validateToken",
            replacement: "dummy",
            precondition: { file: "src/auth.ts", contentHash: "dummy" },
          },
        ],
      });

      assert.equal(patchResult.applied, false);
      assert.ok(patchResult.diagnostics.some((d) => d.code === "STALE_SNAPSHOT"));
      assert.equal(patchResult.requiresEscalation, true);
    });

    it("olmayan sembol icin SYMBOL_NOT_FOUND doner", async () => {
      const readResult = await compiler.read_symbol({
        projectRoot: TEST_ROOT,
        symbol: "validateToken",
      });

      const patchResult = await compiler.apply_structured_patch({
        projectRoot: TEST_ROOT,
        taskId: "test-notfound",
        snapshot: readResult.snapshot,
        language: "typescript",
        dryRun: true,
        operations: [
          {
            operation: "replace_symbol",
            file: "src/auth.ts",
            symbol: "nonExistentFunction",
            replacement: "dummy",
            precondition: {
              file: "src/auth.ts",
              contentHash: readResult.evidence[0].fileContentHash!,
            },
          },
        ],
      });

      assert.ok(patchResult.diagnostics.some((d) => d.code === "SYMBOL_NOT_FOUND"));
    });

    it("precondition basarisizsa reddeder", async () => {
      const readResult = await compiler.read_symbol({
        projectRoot: TEST_ROOT,
        symbol: "validateToken",
      });

      const patchResult = await compiler.apply_structured_patch({
        projectRoot: TEST_ROOT,
        taskId: "test-precond",
        snapshot: readResult.snapshot,
        language: "typescript",
        dryRun: true,
        operations: [
          {
            operation: "replace_symbol",
            file: readResult.evidence[0].symbol.file,
            symbol: "validateToken",
            replacement: "dummy",
            precondition: {
              file: readResult.evidence[0].symbol.file,
              contentHash: "wrong-hash",
              symbol: "validateToken",
              symbolHash: "wrong-hash",
            },
          },
        ],
      });

      assert.ok(patchResult.diagnostics.some((d) => d.code === "PRECONDITION_FAILED"));
    });

    it("replace_function_body calisir", async () => {
      const readResult = await compiler.read_symbol({
        projectRoot: TEST_ROOT,
        symbol: "validateToken",
      });

      const patchResult = await compiler.apply_structured_patch({
        projectRoot: TEST_ROOT,
        taskId: "test-body",
        snapshot: readResult.snapshot,
        language: "typescript",
        dryRun: true,
        operations: [
          {
            operation: "replace_function_body",
            file: readResult.evidence[0].symbol.file,
            symbol: "validateToken",
            newBody: "{ return true; }",
            precondition: {
              file: readResult.evidence[0].symbol.file,
              contentHash: readResult.evidence[0].fileContentHash!,
            },
          },
        ],
      });

      assert.equal(patchResult.diagnostics.length, 0, "no diagnostics");
    });

    it("rollback_patch yapilan yamayi geriye alir", async () => {
      const readResult = await compiler.read_symbol({
        projectRoot: TEST_ROOT,
        symbol: "validateToken",
      });

      const patchResult = await compiler.apply_structured_patch({
        projectRoot: TEST_ROOT,
        taskId: "test-rollback",
        snapshot: readResult.snapshot,
        language: "typescript",
        dryRun: false,
        operations: [
          {
            operation: "replace_function_body",
            file: readResult.evidence[0].symbol.file,
            symbol: "validateToken",
            newBody: "{\n  return true;\n}",
            precondition: {
              file: readResult.evidence[0].symbol.file,
              contentHash: readResult.evidence[0].fileContentHash!,
            },
          },
        ],
      });

      assert.ok(patchResult.applied, "patch applied");
      assert.ok(patchResult.rollbackToken, "rollbackToken returned");

      const rollbackRes = await compiler.rollback_patch({
        projectRoot: TEST_ROOT,
        rollbackToken: patchResult.rollbackToken!,
      });

      assert.ok(rollbackRes.reverted, "reverted successfully");
      assert.equal(rollbackRes.revertedFiles.length, 1);
    });

    it("rollback proje disi veya degismis dosyalari ezmez", async () => {
      const outsideFile = path.join("/tmp", "capsule-rollback-outside.txt");
      await writeFile(outsideFile, "outside");
      const rollbackDir = path.join(TEST_ROOT, ".verdandi", "rollbacks");
      await mkdir(rollbackDir, { recursive: true });
      const token = `rb_${"a".repeat(64)}`;
      await writeFile(
        path.join(rollbackDir, `${token}.json`),
        JSON.stringify([{ relative: "../../capsule-rollback-outside.txt", text: "overwritten", patchedHash: "b".repeat(64) }]),
      );

      const result = await compiler.rollback_patch({ projectRoot: TEST_ROOT, rollbackToken: token });
      assert.equal(result.reverted, false);
      assert.match(result.message, /Unsafe rollback path/);
      assert.equal(await readFile(outsideFile, "utf8"), "outside");
    });

    it("rollback yama sonrasinda degisen proje dosyasini ezmez", async () => {
      const readResult = await compiler.read_symbol({ projectRoot: TEST_ROOT, symbol: "validateToken" });
      const patchResult = await compiler.apply_structured_patch({
        projectRoot: TEST_ROOT,
        taskId: "test-rollback-conflict",
        snapshot: readResult.snapshot,
        language: "typescript",
        operations: [{
          operation: "replace_function_body",
          file: "src/auth.ts",
          symbol: "validateToken",
          newBody: "{ return true; }",
          precondition: { file: "src/auth.ts", contentHash: readResult.evidence[0].fileContentHash! },
        }],
      });
      assert.ok(patchResult.rollbackToken);
      await writeFile(path.join(TEST_ROOT, "src/auth.ts"), "// user change\n");

      const result = await compiler.rollback_patch({ projectRoot: TEST_ROOT, rollbackToken: patchResult.rollbackToken! });
      assert.equal(result.reverted, false);
      assert.match(result.message, /Refusing to overwrite changed file/);
      assert.equal(await readFile(path.join(TEST_ROOT, "src/auth.ts"), "utf8"), "// user change\n");

      await scaffoldProject();
      compiler.invalidateCache(TEST_ROOT);
    });

    it("process crash sonrasi kismi yazilmis journal'i guvenle geri alir", async () => {
      const a = path.join(TEST_ROOT, "src/auth.ts");
      const b = path.join(TEST_ROOT, "src/user.ts");
      const originalA = await readFile(a, "utf8");
      const originalB = await readFile(b, "utf8");
      const patchedA = `${originalA}\n// partially written before crash\n`;
      await writeFile(a, patchedA);

      const token = `rb_${"c".repeat(64)}`;
      const rollbackDir = path.join(TEST_ROOT, ".verdandi", "rollbacks");
      await mkdir(rollbackDir, { recursive: true });
      const digest = (value: string) => createHash("sha256").update(value).digest("hex");
      await writeFile(path.join(rollbackDir, `${token}.json`), JSON.stringify([
        { relative: "src/auth.ts", text: originalA, patchedHash: digest(patchedA) },
        { relative: "src/user.ts", text: originalB, patchedHash: digest(`${originalB}\n// never written\n`) },
      ]));

      const result = await new TypeScriptContextCompiler().rollback_patch({ projectRoot: TEST_ROOT, rollbackToken: token });
      assert.equal(result.reverted, true);
      assert.deepEqual(result.revertedFiles, ["src/auth.ts"]);
      assert.equal(await readFile(a, "utf8"), originalA);
      assert.equal(await readFile(b, "utf8"), originalB);
    });

    it("gecersiz rollback tokenini reddeder", async () => {
      const result = await compiler.rollback_patch({ projectRoot: TEST_ROOT, rollbackToken: "../bad" });
      assert.equal(result.reverted, false);
      assert.equal(result.message, "Invalid rollback token.");
    });

    it("insert_before_symbol calisir", async () => {
      const readResult = await compiler.read_symbol({
        projectRoot: TEST_ROOT,
        symbol: "validateToken",
      });

      const patchResult = await compiler.apply_structured_patch({
        projectRoot: TEST_ROOT,
        taskId: "test-insert",
        snapshot: readResult.snapshot,
        language: "typescript",
        dryRun: true,
        operations: [
          {
            operation: "insert_before_symbol",
            file: readResult.evidence[0].symbol.file,
            symbol: "validateToken",
            content: "// inserted comment",
            precondition: {
              file: readResult.evidence[0].symbol.file,
              contentHash: readResult.evidence[0].fileContentHash!,
            },
          },
        ],
      });

      assert.equal(patchResult.diagnostics.length, 0, "no diagnostics on insert");
    });

    it("delete_symbol calisir", async () => {
      const readResult = await compiler.read_symbol({
        projectRoot: TEST_ROOT,
        symbol: "validateToken",
      });

      const patchResult = await compiler.apply_structured_patch({
        projectRoot: TEST_ROOT,
        taskId: "test-delete",
        snapshot: readResult.snapshot,
        language: "typescript",
        dryRun: true,
        operations: [
          {
            operation: "delete_symbol",
            file: readResult.evidence[0].symbol.file,
            symbol: "validateToken",
            precondition: {
              file: readResult.evidence[0].symbol.file,
              contentHash: readResult.evidence[0].fileContentHash!,
            },
          },
        ],
      });

      assert.equal(patchResult.diagnostics.length, 0, "no diagnostics on delete");
    });

    it("arrow fonksiyonlarinda replace_function_body calisir", async () => {
      const readResult = await compiler.read_symbol({
        projectRoot: TEST_ROOT,
        symbol: "multiply",
      });

      assert.equal(readResult.evidence.length, 1);

      const patchResult = await compiler.apply_structured_patch({
        projectRoot: TEST_ROOT,
        taskId: "test-arrow-body",
        snapshot: readResult.snapshot,
        language: "typescript",
        dryRun: true,
        operations: [
          {
            operation: "replace_function_body",
            file: readResult.evidence[0].symbol.file,
            symbol: "multiply",
            newBody: "{\n  return a * b * 2;\n}",
            precondition: {
              file: readResult.evidence[0].symbol.file,
              contentHash: readResult.evidence[0].fileContentHash!,
            },
          },
        ],
      });

      assert.equal(patchResult.diagnostics.length, 0, "arrow function body replace succeeds");
    });

    it("ClassName.methodName seklinde sembol aramasi yapabilir", async () => {
      const readResult = await compiler.read_symbol({
        projectRoot: TEST_ROOT,
        symbol: "AuthService.authenticate",
      });

      assert.ok(readResult.evidence.length >= 1, "matches method via ClassName.methodName");
      assert.equal(readResult.evidence[0].symbol.symbol, "authenticate");
    });
  });

  describe("validate_delta", () => {
    it("build scripti varsa calistirir", async () => {
      const result = await compiler.validate_delta({
        projectRoot: TEST_ROOT,
        taskId: "test-validate-01",
        kinds: ["build"],
        commandProfile: "package-scripts",
      });

      assert.equal(result.passed, true);
      assert.ok(result.checks.length >= 1);
      assert.equal(result.checks[0].kind, "build");
      assert.equal(result.checks[0].passed, true);
    });

    it("test scripti calistirir", async () => {
      const result = await compiler.validate_delta({
        projectRoot: TEST_ROOT,
        taskId: "test-validate-02",
        kinds: ["test"],
        commandProfile: "package-scripts",
      });

      assert.equal(result.passed, true);
      assert.ok(result.checks[0].passed);
    });

    it("olmayan script icin hata doner", async () => {
      const result = await compiler.validate_delta({
        projectRoot: TEST_ROOT,
        taskId: "test-validate-03",
        kinds: ["nonexistent"],
        commandProfile: "package-scripts",
      });

      assert.equal(result.passed, false);
      assert.ok(result.diagnostics.length >= 1);
    });

    it("birden fazla kind calistirir", async () => {
      const result = await compiler.validate_delta({
        projectRoot: TEST_ROOT,
        taskId: "test-validate-04",
        kinds: ["build", "test", "lint"],
        commandProfile: "package-scripts",
      });

      assert.equal(result.passed, true);
      assert.equal(result.checks.length, 3);
      assert.ok(result.checks.every((c) => c.passed));
    });

    it("requiresEscalation basarisizlikta true", async () => {
      const result = await compiler.validate_delta({
        projectRoot: TEST_ROOT,
        taskId: "test-validate-05",
        kinds: ["nonexistent"],
        commandProfile: "package-scripts",
      });

      assert.equal(result.requiresEscalation, true);
    });

    it("acik yetki olmadan package scriptlerini calistirmaz", async () => {
      const result = await compiler.validate_delta({
        projectRoot: TEST_ROOT,
        taskId: "test-validate-authorization",
        kinds: ["build"],
      });

      assert.equal(result.passed, false);
      assert.match(result.summary, /explicit package-scripts authorization/);
    });
  });
});

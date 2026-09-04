import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { hasTestIntent, pathPrior, queryTokens, taskClause, TypeScriptContextCompiler } from "../src/context_compiler.js";

// Oracle'daki T05 prompt'unun biçimi: görev + "Başarı kriteri: ... testi ...".
const T05 =
  "Görev: Server resource URI'si çözümlenemediğinde genel/internal hata yerine MCP `Invalid Params` hatası döndür. " +
  "Başarı kriteri: Malformed URI entegrasyon testi `Invalid Params` kodunu doğrular; geçerli resource istekleri etkilenmez.";

describe("test niyeti yalnız görev cümlesinden okunur", () => {
  it("başarı kriteri cümlesi niyeti tetiklemez (TR)", () => {
    assert.equal(hasTestIntent(T05), false);
    assert.match(taskClause(T05), /Invalid Params` hatası döndür\. $/);
  });

  it("başarı kriteri cümlesi niyeti tetiklemez (EN)", () => {
    assert.equal(hasTestIntent("Fix the cache codec. Success criteria: the regression test passes."), false);
    assert.equal(hasTestIntent("Fix the cache codec. Acceptance criteria: integration spec is green."), false);
  });

  it("görev cümlesindeki gerçek test niyeti korunur", () => {
    assert.equal(hasTestIntent("Malformed URI için entegrasyon testi yaz"), true);
    assert.equal(hasTestIntent("add a regression test for the header parser"), true);
    assert.equal(hasTestIntent("Görev: streamableHttp için test ekle. Başarı kriteri: CI geçer."), true);
  });

  it("işaret yoksa metnin tamamı görev cümlesidir", () => {
    assert.equal(taskClause("fix the invoice PDF"), "fix the invoice PDF");
  });

  it("aynı sorgu tokenları, niyet bayrağına göre test dosyasını ödüllendirir ya da cezalandırır", () => {
    const query = queryTokens(T05);
    const testDosyasi = "packages/server/test/server/mcp.test.ts";
    // Bayrak verilmezse tokenlardan çıkarılır (eski davranış): 'integration'/'test' → niyet açık.
    assert.equal(pathPrior(testDosyasi, query), pathPrior(testDosyasi, query, true));
    // Niyet açık: dizin +1.2 ve sonek +1.2; kapalı: -2.5 ve -2.5 → 7.4 puanlık salınım.
    assert.ok(Math.abs(pathPrior(testDosyasi, query, true) - pathPrior(testDosyasi, query, false) - 7.4) < 1e-9);
    // Yol token'ları ("server", "mcp") sorguyla eşleştiği için mutlak değer pozitif kalabilir;
    // iddia, niyet kapalıyken testin aynı sorguda kaynağa kaybetmesidir.
    assert.ok(pathPrior(testDosyasi, query, false) < pathPrior("packages/server/src/server/mcp.ts", query, false));
    assert.ok(pathPrior("packages/server/src/server/mcp.ts", query, false) > 0);
  });
});

describe("kapsama bonusu eşanlamlıları değil kaynak sözcükleri sayar", () => {
  it("queryTokens çıktısı gruplarla birebir aynı kalır", async () => {
    const { queryConceptGroups } = await import("../src/context_compiler.js");
    assert.deepEqual(queryConceptGroups(T05).flat(), queryTokens(T05));
  });

  it("bir Türkçe sözcüğün dört eşanlamlısı tek kavramdır", async () => {
    const { queryConceptMap } = await import("../src/context_compiler.js");
    const map = queryConceptMap("hata döndür");
    const grup = new Set(["hata", "error", "exception", "fault", "bug"].map(t => map.get(t)));
    assert.equal(grup.size, 1, "hata ve eşanlamlıları aynı gruba düşmeli");
    assert.notEqual(map.get("hata"), map.get("dondur"));
  });
});

describe("eşleşen test, test ettiği kodun kanıtıdır", () => {
  const gecici: string[] = [];
  after(async () => { for (const d of gecici) await rm(d, { recursive: true, force: true }); });

  const ADLI = [
    "/** Response cache codec: serializes protocol documents without structuredClone. */",
    "export class ResponseCacheCodec {",
    "  serializeProtocolDocument(value: unknown): string { return JSON.stringify(value); }",
    "}",
  ];
  const ZAYIF = [
    "export class ClientResponseCache {",
    "  encode(value: unknown): string { return JSON.stringify(value); }",
    "}",
  ];

  async function projeKur(kaynak: string[] = ADLI): Promise<string> {
    const kok = await mkdtemp(path.join(tmpdir(), "verdandi-subject-"));
    gecici.push(kok);
    await mkdir(path.join(kok, "src"), { recursive: true });
    await mkdir(path.join(kok, "test"), { recursive: true });
    await writeFile(path.join(kok, "package.json"), '{"name":"subject","version":"1.0.0"}', "utf8");
    // Kaynak, başlığın en az %75'ini alacak kadar adlandırılmış (ölçüldü: 0.86);
    // terfi yakın beraberliği bozar, bozgunu çevirmez — bkz. aşağıdaki test.
    await writeFile(path.join(kok, "src", "cache.ts"), kaynak.join("\n") + "\n", "utf8");
    // Düzyazı başlık, görevin sözcüklerini bir tanımlayıcıdan çok daha fazla toplar.
    await writeFile(path.join(kok, "test", "cache.test.ts"), [
      'import { ClientResponseCache } from "../src/cache.js";',
      'import { it } from "node:test";',
      'it("the response cache codec does not depend on structuredClone existing and serializes protocol documents", () => {',
      "  new ClientResponseCache().encode({});",
      "});",
      "",
    ].join("\n"), "utf8");
    return kok;
  }

  it("niyet test değilken tepedeki testin import ettiği kaynak dosya öne alınır", async () => {
    const kok = await projeKur();
    const kapsul = await new TypeScriptContextCompiler().context_capsule({
      task: "Change the response cache codec to serialize protocol documents and remove the structuredClone dependency.",
      projectRoot: kok,
    });
    assert.equal(kapsul.modelPayload.probableFiles[0], "src/cache.ts");
    assert.ok(kapsul.modelPayload.probableFiles.includes("test/cache.test.ts"), "test kanıt olarak listede kalır");
  });

  it("kaynak bozguna uğramışsa (tepenin %75'inin altında) terfi etmez", async () => {
    const kok = await projeKur(ZAYIF); // ölçüldü: oran 0.55
    const kapsul = await new TypeScriptContextCompiler().context_capsule({
      task: "Change the response cache codec to serialize protocol documents and remove the structuredClone dependency.",
      projectRoot: kok,
    });
    assert.equal(kapsul.modelPayload.probableFiles[0], "test/cache.test.ts");
  });

  it("niyet test olduğunda terfi yapılmaz", async () => {
    const kok = await projeKur();
    const kapsul = await new TypeScriptContextCompiler().context_capsule({
      task: "add a regression test for the response cache codec and structuredClone",
      projectRoot: kok,
    });
    assert.equal(kapsul.modelPayload.probableFiles[0], "test/cache.test.ts");
  });
});

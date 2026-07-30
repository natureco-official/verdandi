import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  type ApplyStructuredPatchInput,
  type ApplyStructuredPatchOutput,
  type CompactValidationDiagnostic,
  type ContextCapsuleInput,
  type ContextCapsuleOutput,
  type ContextCompilerTools,
  type EvidenceWindow,
  type ReadSymbolInput,
  type ReadSymbolOutput,
  type RollbackPatchInput,
  type RollbackPatchOutput,
  type SymbolKind,
  type SymbolReference,
  type SymbolRelation,
  type ValidateDeltaInput,
  type ValidateDeltaOutput,
} from "../mcp_tools.js";

type IndexedSymbol = SymbolReference & {
  node: ts.Node;
  sourceFile: ts.SourceFile;
  start: number;
  end: number;
  bodyStart?: number;
  bodyEnd?: number;
  text: string;
  signature: string;
  /** Pre-tokenized fields for BM25. */
  tokens: {
    name: string[];
    path: string[];
    signature: string[];
    body: string[];
  };
};

type IndexedFile = {
  absolute: string;
  relative: string;
  sourceFile: ts.SourceFile;
  text: string;
  imports: string[];
};

type ProjectIndex = {
  root: string;
  files: IndexedFile[];
  symbols: IndexedSymbol[];
  neighbors: Map<string, Set<string>>;
  /** file -> symbols called from that file's symbols (name set). */
  calleesByFile: Map<string, Set<string>>;
  snapshot: string;
  fileByRelative: Map<string, IndexedFile>;
  symbolsByFile: Map<string, IndexedSymbol[]>;
  symbolsByName: Map<string, IndexedSymbol[]>;
  /** BM25 corpus stats. */
  avgdl: number;
  docFreq: Map<string, number>;
  docCount: number;
  truncated: boolean;
};

type RollbackEntry = {
  relative: string;
  text: string;
  patchedHash: string;
};

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const CONFIG_FILE_PATTERN = /^(package\.json|(?:ts|js)config(?:\.[^.]+)?\.json|[a-z0-9_-]+\.config\.(?:ts|mts|cts|js|mjs|cjs)|\.eslintrc(?:\.(?:json|js|cjs|yaml|yml))?)$/;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  // Rust/Maven/Gradle build output. Its .json files mostly fail
  // CONFIG_FILE_PATTERN, but a Tauri project still parks thousands of files
  // here and walking them costs index time for nothing.
  "target",
  "coverage",
  ".turbo",
  "build",
  ".next",
  ".cache",
  "vendor",
  "tmp",
  "temp",
  ".venv",
  "venv",
  ".tsbuildinfo",
  ".nuxt",
  ".svelte-kit",
  ".output",
]);

/**
 * Build output whose directory name carries a suffix: `dist-tauri`, `dist_web`,
 * `build-ssr`, `out-tsc`, `target-wasm`.
 *
 * SKIP_DIRS only matched exact names, so a Tauri project's `dist-tauri/` was
 * indexed as if it were source: 7 of 32 indexed files and 77% of indexed bytes
 * were minified bundles, and five of six sample queries handed the agent a
 * bundle instead of the source it was compiled from.
 *
 * The separator is required on purpose. Matching a bare `dist` prefix would
 * also swallow `distributed/`, `outbox/`, `building/` and `targeting/`, which
 * are ordinary source directories.
 */
const BUILD_OUTPUT_DIR_PATTERN = /^(dist|build|out|target)[-_.]/;

function isBuildOutputDir(name: string): boolean {
  return SKIP_DIRS.has(name) || BUILD_OUTPUT_DIR_PATTERN.test(name);
}

/**
 * Minified bundles, detected by shape rather than by path.
 *
 * Directory names cannot catch every case. Capacitor copies the web build into
 * `android/app/src/main/assets/public/` and `ios/App/App/public/`; every
 * segment there is an ordinary source-directory name, so any name rule broad
 * enough to exclude it would also exclude real source. Vendored bundles like
 * `extension/lib/xterm.js` have the same problem.
 *
 * Measured across eight local projects (29 July 2026): of 2084 indexed files,
 * 25 were minified — 4.4 MB, 26.4% of one project's index — and every one was
 * build output or a vendored library. No real source file was caught.
 *
 * The threshold sits in a wide empty gap: the longest-lined real source file
 * averaged 216 characters per line, the least-minified bundle 2827. Only the
 * first chunk is read, so this costs one bounded read on large files and
 * nothing on small ones.
 */
const MINIFIED_MIN_BYTES = 20_000;
const MINIFIED_SAMPLE_BYTES = 64 * 1024;
const MINIFIED_AVG_LINE_LENGTH = 400;

async function isMinifiedBundle(absolute: string, size: number): Promise<boolean> {
  if (size < MINIFIED_MIN_BYTES) return false;
  let handle;
  try {
    handle = await fs.open(absolute, "r");
    const buffer = Buffer.alloc(Math.min(MINIFIED_SAMPLE_BYTES, size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) return false;
    const ortalamaSatir = (metin: string): number => {
      let newlines = 0;
      for (let i = 0; i < metin.length; i++) if (metin.charCodeAt(i) === 10) newlines++;
      return metin.length / (newlines + 1);
    };

    // Yalnızca dosyanın BAŞI örnekleniyordu ve paketleyiciler tam oraya lisans
    // başlığı koyuyor: kısa satırlardan oluşan bir blok ortalamayı düşürüp
    // dedektörü kör ediyor.
    //
    // Ölçüldü (30 Temmuz 2026, natureco_improvements): 683 KB'lık Capacitor
    // paketi `firebase-CuxlGNoM.js` Apache lisans metniyle açıldığı için
    // kaynak sanılıyor ve "forum gönderisi silme yetkisi" görevine dönen ilk
    // dosya oluyordu. Bir paketin en temsili yeri ortasıdır; iki örnekten
    // hangisi paket gibi görünüyorsa o karar verir.
    if (ortalamaSatir(buffer.subarray(0, bytesRead).toString("utf8")) > MINIFIED_AVG_LINE_LENGTH) {
      return true;
    }
    if (size <= MINIFIED_SAMPLE_BYTES) return false;
    const ortaBuffer = Buffer.alloc(Math.min(MINIFIED_SAMPLE_BYTES, size));
    const orta = await handle.read(
      ortaBuffer,
      0,
      ortaBuffer.length,
      Math.max(0, Math.floor(size / 2) - Math.floor(ortaBuffer.length / 2)),
    );
    if (orta.bytesRead === 0) return false;
    return ortalamaSatir(ortaBuffer.subarray(0, orta.bytesRead).toString("utf8")) > MINIFIED_AVG_LINE_LENGTH;
  } catch {
    // Unreadable files are handled by the caller's own error path; never let
    // this check be the reason a file is dropped.
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Common English/coding stopwords that add noise to retrieval. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "where",
  "what", "which", "should", "would", "could", "please", "make", "just", "also",
  "have", "been", "will", "your", "our", "are", "was", "were", "can", "need",
  "fix", "update", "change", "add", "remove", "create", "implement", "refactor",
  "code", "file", "function", "class", "module", "project", "using", "use",
]);

const BM25_K1 = 1.4;
const BM25_B = 0.75;
const ROLLBACK_TOKEN_PATTERN = /^rb_[a-f0-9]{64}$/;
const MAX_INDEXED_FILES = 10_000;
const MAX_SOURCE_FILE_BYTES = 1_000_000;
const MAX_READ_SYMBOL_TOKENS = 4_000;
const MAX_ROLLBACK_BACKUP_BYTES = 16 * 1024 * 1024;

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/**
 * Yamalanan metni dosyanın KENDİ satır sonu geleneğine uydurur.
 *
 * `apply_structured_patch` gelen gövdeyi olduğu gibi yerleştiriyordu. Çağıran
 * taraf gövdeyi `\n` ile yazdığında — JSON üzerinden gelen her istekte olağan
 * olan budur — CRLF bir dosya KARIŞIK satır sonlu hale geliyordu: yamalanan
 * satırlar LF, gerisi CRLF. Canlı denemede tam olarak bu görüldü, üstelik
 * `applied: true` ve tek bir uyarı olmadan.
 *
 * Windows'ta bedeli sessiz değil: `eslint linebreak-style` ihlali, `prettier`
 * farkı ve `core.autocrlf` altında dosyanın tamamının değişmiş görünmesi.
 * Kural basit — dosya ne kullanıyorsa eklenen metin de onu kullanır.
 *
 * Hiç satır sonu olmayan dosyada karar verilecek bir gelenek yoktur; metin
 * olduğu gibi bırakılır (tahmin etmek, yanlış tahmin etme riskini bedava
 * getirirdi).
 */
function matchLineEndings(value: string, fileText: string): string {
  const crlfCount = (fileText.match(/\r\n/g) || []).length;
  const lfCount = (fileText.match(/(?<!\r)\n/g) || []).length;
  if (crlfCount === 0 && lfCount === 0) return value;
  // Önce tamamı LF'e indirgenir, sonra hedef geleneğe çevrilir: girdi karışık
  // gelse bile çıktı tek biçimli olur.
  const lf = value.replace(/\r\n/g, "\n");
  return crlfCount > lfCount ? lf.replace(/\n/g, "\r\n") : lf;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ıİ]/g, "i")
    .replace(/[şŞ]/g, "s")
    .replace(/[ğĞ]/g, "g")
    .replace(/[çÇ]/g, "c")
    .replace(/[öÖ]/g, "o")
    .replace(/[üÜ]/g, "u");
}

/** Split identifiers on non-alnum and camelCase/snake boundaries. */
export function tokenize(value: string): string[] {
  const split = normalizeSearchText(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_$/.-]+/g, " ")
    .toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of split.split(/[^a-z0-9]+/)) {
    if (part.length < 2 || STOPWORDS.has(part) || seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out;
}

const SYNONYM_MAP: Record<string, string[]> = {
  sifre: ["password", "auth", "token", "secret", "credential"],
  parola: ["password", "auth", "token"],
  eposta: ["email", "mail", "smtp"],
  mail: ["email", "eposta"],
  duzenle: ["update", "edit", "patch", "modify"],
  guncelle: ["update", "edit", "patch", "modify"],
  sil: ["delete", "remove", "clear"],
  kaldir: ["delete", "remove", "clear"],
  ekle: ["add", "insert", "append", "create"],
  kullanici: ["user", "account", "profile"],
  sirala: ["sort", "order", "arrange"],
  siralama: ["sort", "order", "arrange"],
  siralamasini: ["sort", "order", "arrange", "sirala"],
  hata: ["error", "exception", "fault", "bug"],
  test: ["test", "spec", "check"],
  entegrasyon: ["integration", "test"],
  regresyon: ["regression", "test"],
  linter: ["lint", "eslint", "biome"],
  linting: ["lint", "eslint", "biome"],
  imports: ["import"],
  ordering: ["order", "sort"],
  uri: ["url", "resource", "read"],
  session: ["transport", "http", "client", "header"],
  declaration: ["dts", "types", "build", "config"],
  bundle: ["external", "tsdown", "config"],
  oom: ["memory", "bundle", "dts", "config"],
  serialize: ["encode", "document", "codec"],
  deserialize: ["decode", "document", "codec"],
  hit: ["serve", "read", "write"],
  aynalama: ["mirror", "mirroring"],
};

/**
 * Türkçe kök → İngilizce tanımlayıcı köprüsü.
 *
 * Görev Türkçe yazılıyor, kod İngilizce adlandırılıyor. Aralarında harf
 * örtüşmesi olmadığı için sıralama çöküyordu. Ölçüldü (30 Temmuz 2026,
 * natureco_improvements, 10 gerçek görev): ilk sırada doğru dosya oranı
 * **%30**. İsabet eden üç görevin üçünde de metinde zaten İngilizce/ortak bir
 * kelime vardı ("avatar", "rate limit", "forum"); saf Türkçe kavramların
 * TAMAMI kaçıyordu. `VoiceRooms.tsx` dosya olarak duruyor ama "sesli oda"
 * sorgusuyla bulunamıyor.
 *
 * Eşleşme ÖNEK ile: Türkçe eklemeli bir dil, "katıl" kökü "katılma",
 * "katılıyor", "katılamıyor" hâllerinin hepsinde başta duruyor. Tam eşleşme
 * bu yüzden işe yaramıyordu.
 *
 * Genişletme, DEĞİŞTİRME değil: Türkçe sözcük sorguda kalır, İngilizce
 * karşılıkları eklenir. Türkçe yazılmış yorum satırları da eşleşmeye devam
 * eder.
 *
 * Uzun kök önce denenir: "gonderi" (post) ile "gonder" (send) farklı şeyler.
 */
const TR_KOK_ESLEME: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["bildirim", ["notification", "notify", "alert"]],
  ["dogrula", ["verify", "validate", "auth", "factor"]],
  ["guncelle", ["update", "patch"]],
  ["kullanici", ["user", "account", "member"]],
  ["veritabani", ["database", "db", "store"]],
  ["yetkilendir", ["auth", "permission", "role"]],
  // "gonderil-" / "gonderim" FIILIN edilgen halleri (gonder-il-), "gonderi"
  // ise isim (post). Ikisi de ayni onekle basliyor; uzun kok once denendigi
  // icin fiil halleri isimden ONCE yazilir.
  ["gonderil", ["send", "request"]],
  ["gonderim", ["send", "request"]],
  ["gonderi", ["post", "entry"]],
  ["gonder", ["send", "request"]],
  ["cozum", ["resolve", "parse", "match"]],
  ["yanit", ["response"]],
  ["baglan", ["connect", "connection", "socket"]],
  ["katil", ["join", "enter", "participant"]],
  ["oturum", ["session", "auth", "login"]],
  ["parola", ["password", "credential"]],
  ["profil", ["profile", "account"]],
  ["sifre", ["password", "credential"]],
  ["yukle", ["upload"]],
  ["ayar", ["setting", "preference"]],
  ["canli", ["live", "stream", "realtime"]],
  ["hafiza", ["memory", "cache"]],
  ["istemci", ["client"]],
  ["kaydet", ["save", "persist", "store"]],
  ["mesaj", ["message", "chat"]],
  ["sunucu", ["server", "host"]],
  ["yayin", ["stream", "broadcast", "live", "publish"]],
  ["yorum", ["comment"]],
  ["arama", ["search", "query", "find"]],
  ["bellek", ["memory", "cache"]],
  ["dosya", ["file"]],
  ["gorsel", ["image", "picture", "media"]],
  ["indir", ["download", "fetch"]],
  ["istek", ["request"]],
  ["giris", ["login", "signin", "auth", "entry"]],
  ["cikis", ["logout", "signout", "exit"]],
  ["resim", ["image", "picture"]],
  ["sayfa", ["page", "screen", "view"]],
  ["sesli", ["voice", "audio"]],
  ["takip", ["follow", "subscribe", "watch"]],
  ["yetki", ["permission", "role", "auth", "access"]],
  ["adim", ["step", "factor", "stage"]],
  ["hata", ["error", "failure", "exception"]],
  ["liste", ["list", "collection"]],
  ["odeme", ["payment", "billing", "checkout"]],
  ["sorgu", ["query"]],
  ["tema", ["theme", "style"]],
  ["oda", ["room", "channel"]],
  ["ses", ["voice", "audio", "sound"]],
  ["sil", ["delete", "remove", "destroy"]],
];

/**
 * Türkçe kökün İngilizce bir sözcüğün başına denk gelmesi.
 *
 * Bu araç yalnız Türkçe konuşanlar için değil. Önek eşleşmesi Türkçe için
 * şart ama İngilizce yazan birine zarar veremez: ölçüldüğünde `silent mode`
 * sorgusu "sil" kökünden **delete/remove/destroy** ile genişliyordu — yani
 * "sessiz mod" arayan kişiye silme kodu öneriliyordu. `listen for events` de
 * "liste"den list/collection alıyordu.
 *
 * İki katmanlı koruma:
 *  1. Dört harften kısa kökler (ses, sil, oda) YALNIZ tam sözcük eşleşmesiyle
 *     çalışır. `session`, `silent`, `odata` böylece kurtulur.
 *  2. Daha uzun köklerin bilinen çakışmaları burada adıyla listelenir.
 *
 * Liste bakım gerektirir ve bunu saklamıyorum — ama bir sözcüğü yanlış
 * genişletmenin bedeli, o sorgunun tamamen yanlış dosyaya gitmesi. Ölçülmüş
 * çakışmayı elle yazmak, tahmine dayalı bir kurala yeğdir.
 */
const TR_EN_CAKISMA: ReadonlySet<string> = new Set([
  "listen", "listener", "listeners", "listening", "listed", "listing",
  "indirect", "indirectly", "indirection",
]);

const KISA_KOK_SINIRI = 4;

function trKokGenislet(sozcuk: string): readonly string[] | undefined {
  if (TR_EN_CAKISMA.has(sozcuk)) return undefined;
  for (const [kok, karsiliklar] of TR_KOK_ESLEME) {
    if (kok.length < KISA_KOK_SINIRI) {
      if (sozcuk === kok) return karsiliklar;
      continue;
    }
    if (sozcuk.startsWith(kok)) return karsiliklar;
  }
  return undefined;
}

/** Query tokens keep task intent words and expand domain synonyms (Verðandi Concept Expansion). */
export function queryTokens(task: string): string[] {
  const split = normalizeSearchText(task)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  const softStop = new Set([
    "the", "and", "for", "with", "that", "this", "from", "into", "please",
    "just", "also", "have", "been", "will", "your", "our", "are", "was", "were",
    "ve", "ile", "icin", "bir", "bu", "et", "kontrol", "durumunu", "raporla",
  ]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of split.split(/[^a-z0-9_$]+/)) {
    if (part.length < 2 || softStop.has(part) || seen.has(part)) continue;
    seen.add(part);
    out.push(part);
    const syns = SYNONYM_MAP[part]
      ?? (part.startsWith("test") ? SYNONYM_MAP.test : undefined)
      ?? (part.startsWith("entegrasyon") ? SYNONYM_MAP.entegrasyon : undefined)
      ?? (part.startsWith("regresyon") ? SYNONYM_MAP.regresyon : undefined)
      ?? (part.startsWith("document") ? ["document"] : undefined)
      ?? (part.startsWith("aynalama") ? SYNONYM_MAP.aynalama : undefined)
      ?? trKokGenislet(part);
    if (syns) {
      for (const s of syns) {
        if (!seen.has(s)) {
          seen.add(s);
          out.push(s);
        }
      }
    }
  }
  return out;
}

function termFrequency(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
  return freq;
}

function bm25TermScore(
  tf: number,
  df: number,
  docCount: number,
  docLen: number,
  avgdl: number,
): number {
  if (tf <= 0 || docCount <= 0) return 0;
  const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
  const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / Math.max(avgdl, 1)));
  return idf * ((tf * (BM25_K1 + 1)) / Math.max(denom, 1e-9));
}

function importCandidates(base: string): string[] {
  const parsed = path.posix.parse(base);
  const withoutRuntimeExtension =
    [".js", ".jsx", ".mjs", ".cjs"].includes(parsed.ext)
      ? path.posix.join(parsed.dir, parsed.name)
      : base;

  return [
    base,
    withoutRuntimeExtension,
    ...[".ts", ".tsx", ".mts", ".cts", ".d.ts"].map(ext => `${withoutRuntimeExtension}${ext}`),
    ...["index.ts", "index.tsx", "index.mts", "index.cts"].map(
      name => `${withoutRuntimeExtension}/${name}`,
    ),
  ];
}

function scriptKindForFile(filename: string): ts.ScriptKind {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".json") return ts.ScriptKind.JSON;
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function symbolKind(node: ts.Node): SymbolKind {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return "method";
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isVariableDeclaration(node)) return "variable";
  if (ts.isModuleDeclaration(node)) return "module";
  return "unknown";
}

function declarationName(node: ts.Node): string | undefined {
  const named = node as ts.Declaration & { name?: ts.PropertyName };
  return named.name && ts.isIdentifier(named.name) ? named.name.text : undefined;
}

function isIndexableDeclaration(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isVariableDeclaration(node)
  );
}

function testCallTitle(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  let expression: ts.Expression = node.expression;
  if (ts.isCallExpression(expression)) expression = expression.expression;

  let rootName: string | undefined;
  if (ts.isIdentifier(expression)) {
    rootName = expression.text;
  } else if (ts.isPropertyAccessExpression(expression)) {
    let root: ts.Expression = expression.expression;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    if (ts.isIdentifier(root)) rootName = root.text;
  }
  if (rootName !== "it" && rootName !== "test") return undefined;

  const title = node.arguments[0];
  if (!title || (!ts.isStringLiteral(title) && !ts.isNoSubstitutionTemplateLiteral(title))) return undefined;
  return title.text.trim().slice(0, 240) || undefined;
}

/** Only top-level and class/interface members — skip locals inside functions. */
function isTopLevelOrMember(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  if (ts.isVariableDeclaration(node)) {
    // export const foo = ...  → VariableDeclaration → VariableDeclarationList → VariableStatement → SourceFile
    if (!current || !ts.isVariableDeclarationList(current)) return false;
    current = current.parent; // VariableStatement
    if (!current || !ts.isVariableStatement(current)) return false;
    current = current.parent;
    return !!current && (ts.isSourceFile(current) || ts.isModuleBlock(current));
  }

  while (current) {
    if (ts.isSourceFile(current) || ts.isModuleBlock(current)) return true;
    if (
      ts.isClassDeclaration(current) ||
      ts.isClassExpression(current) ||
      ts.isInterfaceDeclaration(current) ||
      ts.isModuleDeclaration(current)
    ) {
      return true;
    }
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isBlock(current)
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

type WalkResult = { files: string[]; truncated: boolean };

/**
 * `.gitignore` kuralı — yalnızca DİZİN atlamak için.
 *
 * Derlenmiş çıktı, önbellek ve kopyalanmış paketler indeksi kirletiyordu.
 * Ölçüldü (30 Temmuz 2026, natureco_improvements): "forum gönderisi silme
 * yetkisi" görevine dönen ilk dosya 683 KB'lık bir Capacitor paketi olan
 * `android/app/src/main/assets/public/assets/firebase-CuxlGNoM.js` idi.
 *
 * Ad kalıbıyla ("tire + 8 karakter karma") elemeyi denedim ve ölçünce vazgeçtim:
 * `pattern-detector.js`, `rock2-selftest.mjs`, `mutasyon-denemesi.mjs` gibi
 * GERÇEK kaynak dosyalar da o kalıba uyuyor. Kaynağı silmek, paketi
 * indekslemekten kötüdür.
 *
 * Doğru sinyal zaten projede yazılı: bu yolların hepsi `.gitignore`'da ve git
 * tarafından takip edilmiyor. Tahmin yok, projenin kendi beyanı var.
 *
 * KAPSAM BİLEREK DAR: yalnızca dizinler elenir, dosyalar elenmez. Böylece
 * hatalı bir eşleşmenin bedeli en fazla "biraz fazla indeksledik" olur —
 * bugünkü davranış. Desteklenen alt küme: yorum/boş satır, `!` olumsuzlama,
 * sondaki `/`, baştaki `/` ile çapalama, `*`, `?` ve `**`.
 */
interface YokSaymaKurali {
  readonly desen: RegExp;
  readonly olumsuz: boolean;
}

function globuRegexeCevir(desen: string): string {
  let cikti = "";
  for (let i = 0; i < desen.length; i++) {
    const karakter = desen[i]!;
    if (karakter === "*") {
      if (desen[i + 1] === "*") {
        cikti += ".*";
        i++;
        if (desen[i + 1] === "/") i++;
      } else {
        cikti += "[^/]*";
      }
    } else if (karakter === "?") {
      cikti += "[^/]";
    } else if (".+^${}()|[]\\".includes(karakter)) {
      cikti += `\\${karakter}`;
    } else {
      cikti += karakter;
    }
  }
  return cikti;
}

function gitignoreAyristir(metin: string, temelGoreliDizin: string): YokSaymaKurali[] {
  const kurallar: YokSaymaKurali[] = [];
  for (const satir of metin.split(/\r?\n/)) {
    let desen = satir.trim();
    if (!desen || desen.startsWith("#")) continue;
    const olumsuz = desen.startsWith("!");
    if (olumsuz) desen = desen.slice(1);
    if (desen.endsWith("/")) desen = desen.slice(0, -1);
    if (!desen) continue;

    // İçinde `/` olan desen kendi `.gitignore` dizinine çapalanır; olmayan
    // desen her derinlikte ada bakar. Git'in kuralı budur.
    const capali = desen.startsWith("/") || desen.slice(0, -1).includes("/");
    if (desen.startsWith("/")) desen = desen.slice(1);
    const temel = temelGoreliDizin ? `${temelGoreliDizin}/` : "";
    const govde = globuRegexeCevir(desen);
    const tam = capali ? `^${temel}${govde}$` : `^${temel}(?:.*/)?${govde}$`;
    kurallar.push({ desen: new RegExp(tam), olumsuz });
  }
  return kurallar;
}

async function gitignoreOku(root: string, dizin: string): Promise<YokSaymaKurali[]> {
  try {
    const metin = await fs.readFile(path.join(dizin, ".gitignore"), "utf8");
    const goreli = path.relative(root, dizin).split(path.sep).join("/");
    return gitignoreAyristir(metin, goreli);
  } catch {
    return [];
  }
}

/** Son eşleşen kural kazanır — git'in davranışı. */
function yokSayiliyorMu(goreliYol: string, kurallar: readonly YokSaymaKurali[]): boolean {
  let sonuc = false;
  for (const kural of kurallar) {
    if (kural.desen.test(goreliYol)) sonuc = !kural.olumsuz;
  }
  return sonuc;
}

/**
 * Kendi `.git`'i olan alt dizin AYRI BİR DEPODUR; bu projenin parçası değil.
 *
 * Ölçüldü (30 Temmuz 2026, natureco_improvements — 293 dosyalık en büyük
 * proje): kök dizinde ayrı bir depo olarak duran `natureco-cli/` indeksleniyor
 * ve aday dosyaların **%29'unu** dolduruyordu. "websocket yeniden bağlanma"
 * görevine dönen ilk dosya `natureco-cli/test/utils/memory-lint.test.js` idi —
 * yani başka bir ürünün test dosyası.
 *
 * Üst depo onun içeriğini zaten takip etmiyor (tek bir gitlink girdisi görür).
 * Aynı kural submodule'leri ve elle klonlanmış bağımlılıkları da kapsar.
 *
 * Kökün KENDİSİ elbette muaf: bir depoyu indekslemek istiyoruz, onun `.git`'i
 * olması normal.
 */
async function isNestedRepository(root: string, directory: string): Promise<boolean> {
  if (path.resolve(directory) === path.resolve(root)) return false;
  try {
    await fs.stat(path.join(directory, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function walk(
  root: string,
  current = root,
  result: WalkResult = { files: [], truncated: false },
  // Üstteki dizinlerden devralınan `.gitignore` kuralları. Git de böyle
  // çalışır: her dizinin kendi dosyası, atalarınınkine EKLENİR.
  devralinanKurallar: readonly YokSaymaKurali[] = [],
): Promise<WalkResult> {
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (current !== root && (code === "EACCES" || code === "EPERM" || code === "ENOENT")) {
      result.truncated = true;
      return result;
    }
    throw error;
  }
  const buradakiKurallar = await gitignoreOku(root, current);
  const kurallar = buradakiKurallar.length > 0
    ? [...devralinanKurallar, ...buradakiKurallar]
    : devralinanKurallar;

  for (const entry of entries) {
    if (result.files.length >= MAX_INDEXED_FILES) {
      result.truncated = true;
      break;
    }
    if (entry.name.startsWith(".") && !entry.name.startsWith(".eslintrc")) continue;
    if (entry.isDirectory()) {
      const mutlak = path.join(current, entry.name);
      const goreli = path.relative(root, mutlak).split(path.sep).join("/");
      if (
        !isBuildOutputDir(entry.name)
        && !yokSayiliyorMu(goreli, kurallar)
        && !(await isNestedRepository(root, mutlak))
      ) {
        await walk(root, mutlak, result, kurallar);
      }
    } else if (entry.isFile() && (SOURCE_EXTENSIONS.has(path.extname(entry.name)) || CONFIG_FILE_PATTERN.test(entry.name))) {
      const absolute = path.join(current, entry.name);
      try {
        const size = (await fs.stat(absolute)).size;
        if (size > MAX_SOURCE_FILE_BYTES) result.truncated = true;
        else if (await isMinifiedBundle(absolute, size)) result.truncated = true;
        else result.files.push(absolute);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EACCES" && code !== "EPERM" && code !== "ENOENT") throw error;
        result.truncated = true;
      }
    }
  }
  return result;
}

function lineRange(sourceFile: ts.SourceFile, start: number, end: number) {
  return {
    startLine: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
    endLine: sourceFile.getLineAndCharacterOfPosition(end).line + 1,
  };
}

function resolveProjectFile(root: string, relative: string): string | undefined {
  if (!relative || path.isAbsolute(relative)) return undefined;
  const absolute = path.resolve(root, relative);
  const pathFromRoot = path.relative(root, absolute);
  return pathFromRoot && !pathFromRoot.startsWith("..") && !path.isAbsolute(pathFromRoot)
    ? absolute
    : undefined;
}

async function isResolvedPathInsideRoot(root: string, absolute: string): Promise<boolean> {
  try {
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(absolute)]);
    const pathFromRoot = path.relative(realRoot, realFile);
    return !!pathFromRoot && !pathFromRoot.startsWith("..") && !path.isAbsolute(pathFromRoot);
  } catch {
    return false;
  }
}

async function ensureSafeDirectory(root: string, segments: string[]): Promise<string> {
  let current = path.resolve(root);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Unsafe directory component: ${segment}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(current);
    }
    if (!await isResolvedPathInsideRoot(root, current)) {
      throw new Error(`Directory escapes project root: ${segment}`);
    }
  }
  return current;
}

/** Path-aware prior: prefer production source over tests/examples/fixtures. */
export function pathPrior(relativeFile: string, query: string[]): number {
  const file = relativeFile.toLowerCase();
  let score = 0;
  const testIntent = query.some(term => ["test", "spec", "check", "integration", "regression"].includes(term));

  if (/(^|\/)src\//.test(file) || file.startsWith("src/")) score += 1.5;
  if (/(^|\/)(lib|app|packages)\//.test(file)) score += 0.8;
  if (/(^|\/)(test|tests|__tests__|spec|specs)\//.test(file)) score += testIntent ? 1.2 : -2.5;
  if (/\.(test|spec)\.(t|j)sx?$/.test(file)) score += testIntent ? 1.2 : -2.5;
  if (/(^|\/)(examples?|fixtures?|demo|benchmarks?)\//.test(file)) score -= 2;
  if (!query.some(term => ["benchmark", "fixture", "demo", "example"].includes(term)) &&
      /(^|\/)[^/]*(benchmark|measurement|smoke|fixture|demo|example)[^/]*\.[^.]+$/.test(file)) score -= 36;
  if (/(^|\/)[^/]*_(test|spec)\.[^.]+$/.test(file)) score -= 2.5;
  // Safety net: Penalize build output files if SKIP_DIRS is overridden or custom paths passed.
  // The suffix form (dist-tauri/, out-tsc/) has to match here too — it was the
  // gap that let minified bundles score like source. Kept in step with
  // BUILD_OUTPUT_DIR_PATTERN: base word, then either a slash or a separator.
  if (/(^|\/)(dist|build|out|target)([-_.][^/]*)?\//.test(file)) score -= 5;
  // Generated protocol mirrors are useful dependencies, but are rarely the
  // implementation site for a runtime server/client behaviour change.
  if (query.some(term => ["server", "client", "handler", "request", "runtime"].includes(term)) &&
      /(?:^|\/)(?:spec\.types\.\d|corpus\/|schema-twins\/)/.test(file)) score -= 24;

  const basename = path.posix
    .basename(relativeFile, path.posix.extname(relativeFile))
    .toLowerCase();
  const segments = tokenize(relativeFile.replace(/\//g, " "));
  const configIntent = query.some(term => [
    "lint", "eslint", "biome", "test", "build", "typecheck", "dependency", "script",
    "import", "order", "sort", "config", "package",
  ].includes(term));
  if (configIntent && CONFIG_FILE_PATTERN.test(path.posix.basename(relativeFile))) score += 24;

  for (const q of query) {
    if (basename === q) score += 10;
    else if (basename.includes(q)) score += 2;
    if (segments.includes(q)) score += 2;
  }

  return score;
}

function isNarrowMechanicalTask(query: string[]): boolean {
  return query.includes("import") && query.some(term => ["sort", "order", "arrange", "lint"].includes(term));
}

function qualityCriteria(task: string, query: string[]): string[] {
  const terms = new Set(query);
  const normalized = normalizeSearchText(task).toLowerCase();
  const criteria = [
    "Son düzenlemeden sonra hedef davranış testi ve ilgili paket kalite kontrolleri yeniden geçmeli.",
  ];

  if (["integration", "workspace", "process", "worker", "temp", "cleanup"].some(term => terms.has(term))) {
    criteria.push("İzolasyon, hata yolunda cleanup, çapraz platform süreç davranışı ve workspace durumunun değişmemesi kontrol edilmeli.");
  }
  if (["public", "api", "type", "cache", "serialize", "document", "codec"].some(term => terms.has(term))) {
    criteria.push("Public tip/API sözleşmesi, wire/store biçimi, bozuk veri ve geriye uyumluluk etkileri açıkça incelenmeli.");
  }
  if (["declaration", "dts", "bundle", "external", "config", "oom"].some(term => terms.has(term))) {
    criteria.push("Build config yolları, paket sınırları, public import yüzeyi ve declaration çıktısı birlikte doğrulanmalı.");
  }
  if (["transport", "session", "stream", "http"].some(term => terms.has(term))) {
    criteria.push("Başarısız yanıt, stale state ve tüm kapanış/iptal yaşam döngüsü yolları kontrol edilmeli.");
  }
  if (terms.has("header")) {
    criteria.push("Dış header girdisi sınırda bir kez normalize edilmeli; geçerli kenar boşluğu ile geçersiz iç boşluk ayrı test edilmeli.");
  }
  if (["error", "exception", "invalid", "uri", "url"].some(term => terms.has(term))) {
    criteria.push("Hata public API üzerinden test edilmeli; güvenli ve faydalı kod/mesaj/yapısal bağlam korunmalı.");
  }
  if (/\b(auth|401|refresh|retry|token)\b/.test(normalized)) {
    criteria.push("Görevde adı geçen her auth/retry katmanı bağımsız davranış testiyle kapsanmalı.");
  }

  return [...new Set(criteria)].slice(0, 3);
}

async function nearestPackageDirectory(root: string, relativeFile: string): Promise<string> {
  let current = path.dirname(path.join(root, relativeFile));
  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    try {
      await fs.access(path.join(current, "package.json"));
      return path.relative(root, current).split(path.sep).join("/") || ".";
    } catch {
      current = path.dirname(current);
    }
  }
  return ".";
}

type PackageManager = {
  name: "npm" | "pnpm" | "yarn" | "bun";
  command: string;
  runArgs: string[];
};

const LOCKFILE_MANAGERS: Array<{ file: string; name: PackageManager["name"] }> = [
  { file: "pnpm-lock.yaml", name: "pnpm" },
  { file: "yarn.lock", name: "yarn" },
  { file: "bun.lockb", name: "bun" },
  { file: "package-lock.json", name: "npm" },
];

function toManager(name: PackageManager["name"]): PackageManager {
  return name === "yarn"
    ? { name, command: "yarn", runArgs: ["run"] }
    : { name, command: name, runArgs: ["run"] };
}

/**
 * Windows'ta paket yöneticisi çalıştırma.
 *
 * npm/yarn/pnpm/bun Windows'ta PATH üzerinde `.cmd` toplu iş dosyasıdır.
 * `execFile` shell kullanmaz, bu yüzden uzantısız ad ENOENT verir; uzantıyı
 * eklemek de yetmez, çünkü Node 20+ `.cmd` dosyalarını shell olmadan
 * çalıştırmayı güvenlik gerekçesiyle REDDEDER (EINVAL, CVE-2024-27980).
 * Sonuç: `validate_delta` Windows'ta hiç çalışmıyordu — beş test bu yüzden
 * düşüyordu ve araç sessizce her zaman "başarısız" raporluyordu.
 *
 * Bu yüzden yalnızca Windows'ta shell açılıyor. Burada güvenli, çünkü komut
 * satırının HER PARÇASI sabit:
 *   - komut adı  → yalnızca npm/yarn/pnpm/bun (sabit eşleme)
 *   - argümanlar → "run" + kind
 *   - kind       → yalnızca test/lint/typecheck/build (yukarıdaki allow-list)
 * Kullanıcıdan gelen tek değer `cwd`'dir ve o komut satırına girmez.
 *
 * Komut satırına kullanıcı verisi eklenecek olursa bu karar yeniden
 * değerlendirilmelidir; o durumda shell enjeksiyon yüzeyi açar.
 */
const SHELL_GEREKIYOR = process.platform === "win32";

async function detectPackageManager(
  root: string,
  packageJson: { packageManager?: unknown },
): Promise<PackageManager> {
  const declared =
    typeof packageJson.packageManager === "string"
      ? packageJson.packageManager.split("@")[0]
      : undefined;
  if (declared === "npm" || declared === "pnpm" || declared === "yarn" || declared === "bun") {
    return toManager(declared);
  }
  for (const { file, name } of LOCKFILE_MANAGERS) {
    try {
      await fs.access(path.join(root, file));
      return toManager(name);
    } catch {
      // continue
    }
  }
  return toManager("npm");
}

function fieldBm25(
  query: string[],
  fieldTokens: string[],
  docFreq: Map<string, number>,
  docCount: number,
  avgdl: number,
  weight: number,
): number {
  if (fieldTokens.length === 0 || query.length === 0) return 0;
  const tfMap = termFrequency(fieldTokens);
  const docLen = fieldTokens.length;
  let score = 0;
  for (const term of query) {
    const tf = tfMap.get(term) ?? 0;
    if (tf === 0) continue;
    score += bm25TermScore(tf, docFreq.get(term) ?? 0, docCount, docLen, avgdl);
  }
  return score * weight;
}

/** Rank a symbol against a task query. Exported for unit tests. */
export function scoreSymbolAgainstQuery(
  symbol: Pick<IndexedSymbol, "symbol" | "file" | "tokens" | "kind">,
  query: string[],
  corpus: { avgdl: number; docFreq: Map<string, number>; docCount: number },
): number {
  if (query.length === 0) return 0;

  const nameScore = fieldBm25(
    query,
    symbol.tokens.name,
    corpus.docFreq,
    corpus.docCount,
    corpus.avgdl,
    4.0,
  );
  const pathScore = fieldBm25(
    query,
    symbol.tokens.path,
    corpus.docFreq,
    corpus.docCount,
    corpus.avgdl,
    2.2,
  );
  const sigScore = fieldBm25(
    query,
    symbol.tokens.signature,
    corpus.docFreq,
    corpus.docCount,
    corpus.avgdl,
    1.2,
  );
  const bodyScore = fieldBm25(
    query,
    symbol.tokens.body,
    corpus.docFreq,
    corpus.docCount,
    corpus.avgdl,
    0.35,
  );

  let exact = 0;
  const nameLower = symbol.symbol.toLowerCase();
  for (const q of query) {
    if (nameLower === q) exact += 8;
    else if (nameLower.includes(q) && q.length >= 3) exact += 2.5;
  }

  // Prefer a symbol that explains several independent parts of the task over a
  // schema/type declaration that merely repeats one high-IDF phrase.
  const matchedConcepts = new Set([
    ...symbol.tokens.name,
    ...symbol.tokens.path,
    ...symbol.tokens.signature,
    ...symbol.tokens.body,
  ].filter(token => query.includes(token)));
  const conceptCoverageBoost = Math.min(8, matchedConcepts.size) * 5;

  // Prefer concrete declarations over generic "unknown"
  const kindBoost =
    symbol.kind === "function" || symbol.kind === "method" || symbol.kind === "class"
      ? 0.4
      : symbol.kind === "interface" || symbol.kind === "type"
        ? 0.2
        : 0;

  const lexicalScore = nameScore + pathScore + sigScore + bodyScore + exact;
  // A path/kind prior may reorder genuine lexical matches, but must never turn
  // every production symbol into a match by itself.
  if (lexicalScore <= 0) return 0;
  const toplam = lexicalScore + conceptCoverageBoost + pathPrior(symbol.file, query) + kindBoost;

  // Test dosyası cezası ORANSAL olmalı, toplamsal değil.
  //
  // `pathPrior` içindeki -2.5, `conceptCoverageBoost`un 40 puana kadar
  // çıkabildiği bir toplamda kayboluyordu. Ölçüldü (30 Temmuz 2026,
  // natureco_improvements): "mesaj gönderme rate limit" görevinde doğru dosya
  // `src/utils/rateLimit.ts` BULUNUYOR ama `memoryLeak.preservation.test.ts`
  // dosyasına 0.9268'e 0.9106 ile kaybediyordu — %1.6 fark. Sabit bir ceza,
  // skorların büyüklüğü değiştikçe anlamını yitiriyor; oransal olan yitirmez.
  //
  // Testi yasaklamıyoruz: niyet test olduğunda ceza yok (mevcut davranış), ve
  // ceza dosyayı listeden atmıyor, yalnızca üretim kodunun arkasına koyuyor.
  // Bir testin kendisi doğru cevapsa lexical üstünlüğü bunu yine taşır.
  const testDosyasi = /(^|\/)(test|tests|__tests__|spec|specs)\//.test(symbol.file.toLowerCase())
    || /\.(test|spec)\.(t|j)sx?$/.test(symbol.file.toLowerCase());
  const testNiyeti = query.some(term =>
    ["test", "spec", "check", "integration", "regression"].includes(term));
  // 0.75 ölçümle seçildi, tek örneğe uydurularak değil: 16 gerçek görev
  // üzerinde ilk sırada test dosyası çıkma oranı %44'ten %38'e düşüyor ve
  // 0.65/0.55 hiçbir ek kazanç vermiyor. Daha sert bir ceza, testin gerçekten
  // doğru cevap olduğu durumları bedava gömme riski demek olurdu.
  return testDosyasi && !testNiyeti ? toplam * 0.75 : toplam;
}

function publicRef(symbol: IndexedSymbol): SymbolReference {
  const normalizedScore = symbol.score === undefined
    ? undefined
    : Math.max(0, Math.min(1, symbol.score / (symbol.score + 10)));
  return {
    symbol: symbol.symbol,
    file: symbol.file,
    kind: symbol.kind,
    hopDistance: symbol.hopDistance,
    relation: symbol.relation,
    ...(normalizedScore === undefined ? {} : { score: normalizedScore }),
  };
}

export class TypeScriptContextCompiler implements ContextCompilerTools {
  private indexCache = new Map<string, { index: ProjectIndex; timestamp: number }>();
  private readonly CACHE_MAX_AGE_MS = 300_000;

  /** Drop cached index for a root (tests / after external writes). */
  invalidateCache(projectRoot?: string): void {
    if (!projectRoot) {
      this.indexCache.clear();
      return;
    }
    this.indexCache.delete(path.resolve(projectRoot));
  }

  private async getOrCreateIndex(projectRoot: string): Promise<ProjectIndex> {
    const rootKey = path.resolve(projectRoot);
    const cached = this.indexCache.get(rootKey);
    const now = Date.now();

    if (cached) {
      const age = now - cached.timestamp;
      if (age < this.CACHE_MAX_AGE_MS) {
        try {
          const currentSnapshot = await this.computeSnapshot(rootKey);
          if (currentSnapshot === cached.index.snapshot) {
            cached.timestamp = now;
            return cached.index;
          }
        } catch {
          // re-index below
        }
      }
    }

    const indexData = await this.index(rootKey);
    this.indexCache.set(rootKey, { index: indexData, timestamp: now });
    return indexData;
  }

  private async computeSnapshot(projectRoot: string): Promise<string> {
    const root = path.resolve(projectRoot);
    const { files: filenames } = await walk(root);
    const entries = await Promise.all(
      filenames.map(async absolute => {
        const text = await fs.readFile(absolute, "utf8");
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        return `${relative}:${hash(text)}`;
      }),
    );
    return hash(entries.sort().join("\n"));
  }

  private async index(projectRoot: string): Promise<ProjectIndex> {
    const root = path.resolve(projectRoot);

    let compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.React,
    };
    try {
      const tsconfigPath = path.join(root, "tsconfig.json");
      const tsconfigText = await fs.readFile(tsconfigPath, "utf8");
      const { config } = ts.parseConfigFileTextToJson(tsconfigPath, tsconfigText);
      const parsedConfig = ts.parseJsonConfigFileContent(config, ts.sys, root);
      compilerOptions = { ...compilerOptions, ...parsedConfig.options };
    } catch {
      // no tsconfig — defaults are fine
    }

    const { files: filenames, truncated } = await walk(root);
    const files: IndexedFile[] = [];
    const symbols: IndexedSymbol[] = [];

    for (const absolute of filenames) {
      const text = await fs.readFile(absolute, "utf8");
      const scriptKind = scriptKindForFile(absolute);
      const sourceFile = ts.createSourceFile(
        absolute,
        text,
        compilerOptions.target ?? ts.ScriptTarget.Latest,
        true,
        scriptKind,
      );
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const imports = sourceFile.statements
        .filter(ts.isImportDeclaration)
        .map(statement => {
          const specifier = statement.moduleSpecifier;
          return ts.isStringLiteral(specifier) ? specifier.text : "";
        })
        .filter(Boolean);

      files.push({ absolute, relative, sourceFile, text, imports });

      const symbolsBeforeFile = symbols.length;
      const visit = (node: ts.Node) => {
        const testTitle = testCallTitle(node);
        if (testTitle) {
          const start = node.getStart(sourceFile);
          const end = node.getEnd();
          const symbolText = text.slice(start, end);
          const bodyForTokens = symbolText.length > 8_000 ? symbolText.slice(0, 8_000) : symbolText;
          symbols.push({
            symbol: testTitle,
            file: relative,
            kind: "test",
            hopDistance: 0,
            relation: "direct_match",
            node,
            sourceFile,
            start,
            end,
            text: symbolText,
            signature: testTitle,
            tokens: {
              name: tokenize(testTitle),
              path: tokenize(relative.replace(/\//g, " ")),
              signature: tokenize(testTitle),
              body: tokenize(bodyForTokens),
            },
          });
        }
        if (isIndexableDeclaration(node) && isTopLevelOrMember(node)) {
          const name = declarationName(node);
          if (name) {
            const start = node.getStart(sourceFile);
            const end = node.getEnd();
            let body: ts.Node | undefined;
            if ("body" in node && (node as { body?: ts.Node }).body) {
              body = (node as { body?: ts.Node }).body;
            } else if (ts.isVariableDeclaration(node) && node.initializer) {
              const init = node.initializer;
              if ("body" in init && (init as { body?: ts.Node }).body) {
                body = (init as { body?: ts.Node }).body;
              }
            }
            const bodyStart = body?.getStart(sourceFile);
            const bodyEnd = body?.getEnd();
            const symbolText = text.slice(start, end);
            const signatureEnd = ts.isVariableDeclaration(node) && node.initializer && bodyStart === undefined
              ? node.initializer.getStart(sourceFile)
              : (bodyStart ?? end);
            const signature = text.slice(start, signatureEnd).split("\n")[0].trim().replace(/\s*=\s*$/, "");
            // Cap body tokens so huge files don't dominate BM25 length normalization.
            const bodyForTokens = symbolText.length > 4000 ? symbolText.slice(0, 4000) : symbolText;

            symbols.push({
              symbol: name,
              file: relative,
              kind: symbolKind(node),
              hopDistance: 0,
              relation: "direct_match",
              node,
              sourceFile,
              start,
              end,
              bodyStart,
              bodyEnd,
              text: symbolText,
              signature,
              tokens: {
                name: tokenize(name),
                path: tokenize(relative.replace(/\//g, " ")),
                signature: tokenize(signature),
                body: tokenize(bodyForTokens),
              },
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      if (symbols.length === symbolsBeforeFile && CONFIG_FILE_PATTERN.test(path.basename(absolute))) {
        const name = path.basename(absolute);
        const bodyForTokens = text.length > 8000 ? text.slice(0, 8000) : text;
        symbols.push({
          symbol: name,
          file: relative,
          kind: "module",
          hopDistance: 0,
          relation: "direct_match",
          node: sourceFile,
          sourceFile,
          start: 0,
          end: text.length,
          text,
          signature: name,
          tokens: {
            name: tokenize(name),
            path: tokenize(relative.replace(/\//g, " ")),
            signature: tokenize(name),
            body: tokenize(bodyForTokens),
          },
        });
      }
    }

    const fileByRelative = new Map(files.map(file => [file.relative, file]));
    const symbolsByFile = new Map<string, IndexedSymbol[]>();
    const symbolsByName = new Map<string, IndexedSymbol[]>();
    for (const symbol of symbols) {
      const fileSymbols = symbolsByFile.get(symbol.file) ?? [];
      fileSymbols.push(symbol);
      symbolsByFile.set(symbol.file, fileSymbols);
      const namedSymbols = symbolsByName.get(symbol.symbol) ?? [];
      namedSymbols.push(symbol);
      symbolsByName.set(symbol.symbol, namedSymbols);
    }
    const resolveImport = (from: IndexedFile, specifier: string) => {
      if (specifier.startsWith(".")) {
        const base = path.posix.normalize(
          path.posix.join(path.posix.dirname(from.relative), specifier),
        );
        return importCandidates(base).find(candidate => fileByRelative.has(candidate));
      }
      const candidateBases: string[] = [];
      if (compilerOptions.paths) {
        const configuredBaseUrl = typeof compilerOptions.baseUrl === "string"
          ? compilerOptions.baseUrl
          : "";
        const baseUrl = (configuredBaseUrl && path.isAbsolute(configuredBaseUrl)
          ? path.relative(root, configuredBaseUrl)
          : configuredBaseUrl).split(path.sep).join("/");
        for (const [pattern, targetPaths] of Object.entries(compilerOptions.paths)) {
          const starIndex = pattern.indexOf("*");
          if (starIndex !== -1) {
            const prefix = pattern.slice(0, starIndex);
            if (specifier.startsWith(prefix)) {
              const matched = specifier.slice(prefix.length);
              for (const targetPath of targetPaths) {
                const resolvedTarget = targetPath.replace("*", matched);
                candidateBases.push(path.posix.normalize(path.posix.join(baseUrl, resolvedTarget)));
              }
            }
          } else if (specifier === pattern) {
            for (const targetPath of targetPaths) {
              candidateBases.push(path.posix.normalize(path.posix.join(baseUrl, targetPath)));
            }
          }
        }
      }
      if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
        candidateBases.push(path.posix.normalize(specifier.slice(2)));
        candidateBases.push(path.posix.normalize(`src/${specifier.slice(2)}`));
      }
      for (const base of candidateBases) {
        const found = importCandidates(base).find(candidate => fileByRelative.has(candidate));
        if (found) return found;
      }
      return undefined;
    };

    const neighbors = new Map<string, Set<string>>();
    const calleesByFile = new Map<string, Set<string>>();

    for (const file of files) {
      const set = neighbors.get(file.relative) ?? new Set<string>();
      const callees = calleesByFile.get(file.relative) ?? new Set<string>();

      for (const specifier of file.imports) {
        const target = resolveImport(file, specifier);
        if (target) {
          set.add(target);
          const reverse = neighbors.get(target) ?? new Set<string>();
          reverse.add(file.relative);
          neighbors.set(target, reverse);
        }
      }

      for (const symbol of symbolsByFile.get(file.relative) ?? []) {
        const collect = (node: ts.Node) => {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
            callees.add(node.expression.text);
          }
          if (
            ts.isPropertyAccessExpression(node) &&
            ts.isIdentifier(node.name) &&
            ts.isCallExpression(node.parent)
          ) {
            callees.add(node.name.text);
          }
          ts.forEachChild(node, collect);
        };
        collect(symbol.node);

        for (const called of callees) {
          for (const target of symbolsByName.get(called) ?? []) {
            if (target.file === file.relative) continue;
            set.add(target.file);
          }
        }
      }

      neighbors.set(file.relative, set);
      calleesByFile.set(file.relative, callees);
    }

    // BM25 corpus stats over concatenated field tokens (name-weighted duplication).
    const docFreq = new Map<string, number>();
    let totalLen = 0;
    for (const symbol of symbols) {
      const bag = [
        ...symbol.tokens.name,
        ...symbol.tokens.name, // name double-counted in df bag for presence
        ...symbol.tokens.path,
        ...symbol.tokens.signature,
        ...symbol.tokens.body.slice(0, 80),
      ];
      totalLen += Math.max(bag.length, 1);
      const unique = new Set(bag);
      for (const term of unique) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
    const docCount = Math.max(symbols.length, 1);
    const avgdl = totalLen / docCount;

    const snapshot = hash(
      files.map(file => `${file.relative}:${hash(file.text)}`).sort().join("\n"),
    );

    return {
      root,
      files,
      symbols,
      neighbors,
      calleesByFile,
      snapshot,
      fileByRelative,
      symbolsByFile,
      symbolsByName,
      avgdl,
      docFreq,
      docCount,
      truncated,
    };
  }

  private rankSymbols(
    index: ProjectIndex,
    task: string,
  ): Array<{ symbol: IndexedSymbol; score: number }> {
    const query = queryTokens(task);
    const corpus = {
      avgdl: index.avgdl,
      docFreq: index.docFreq,
      docCount: index.docCount,
    };

    const ranked = index.symbols
      .map(symbol => ({
        symbol,
        score: scoreSymbolAgainstQuery(symbol, query, corpus),
      }))
      .filter(item => item.score > 0.5)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.symbol.file.localeCompare(b.symbol.file) ||
          a.symbol.start - b.symbol.start,
      );

    // Deduplicate identical symbol+file, keep highest score.
    const seen = new Set<string>();
    const unique: Array<{ symbol: IndexedSymbol; score: number }> = [];
    for (const item of ranked) {
      const key = `${item.symbol.file}::${item.symbol.symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
      if (unique.length >= 20) break;
    }
    return unique;
  }

  private pickNeighborSymbols(
    index: ProjectIndex,
    direct: IndexedSymbol[],
    query: string[],
    already: Set<string>,
    limit: number,
  ): IndexedSymbol[] {
    const corpus = {
      avgdl: index.avgdl,
      docFreq: index.docFreq,
      docCount: index.docCount,
    };
    const candidates: Array<{ symbol: IndexedSymbol; score: number; relation: SymbolRelation }> =
      [];

    const directFiles = new Set(direct.map(s => s.file));
    const calledNames = new Set<string>();
    for (const file of directFiles) {
      for (const name of index.calleesByFile.get(file) ?? []) calledNames.add(name);
    }

    // Deep Type Graph Resolution (Multi-Hop Type Dependency)
    const directTexts = direct.map(s => s.text).join(" ");
    for (const sym of index.symbols) {
      const key = `${sym.file}::${sym.symbol}`;
      if (already.has(key)) continue;
      if (sym.kind === "interface" || sym.kind === "type" || sym.kind === "enum" || sym.kind === "class") {
        const regex = new RegExp(`\\b${sym.symbol}\\b`);
        if (regex.test(directTexts)) {
          candidates.push({
            symbol: sym,
            score: 5.0,
            relation: "type_dependency",
          });
        }
      }
    }

    for (const file of directFiles) {
      for (const neighborFile of index.neighbors.get(file) ?? []) {
        const neighborSymbols = index.symbolsByFile.get(neighborFile) ?? [];
        for (const neighbor of neighborSymbols) {
          const key = `${neighbor.file}::${neighbor.symbol}`;
          if (already.has(key)) continue;

          let relation: SymbolRelation = "imported";
          let bonus = 0;
          if (calledNames.has(neighbor.symbol)) {
            relation = "callee";
            bonus += 3;
          }
          // Importer side: neighbor imports a direct file
          if ((index.neighbors.get(neighborFile) ?? new Set()).has(file)) {
            // could be either direction; keep imported default
          }

          const base = scoreSymbolAgainstQuery(neighbor, query, corpus);
          // Even weak path neighbors get a floor so 1-hop is not empty.
          const score = base + bonus + 0.4;
          if (score <= 0.3 && !calledNames.has(neighbor.symbol)) continue;
          candidates.push({ symbol: neighbor, score, relation });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const picked: IndexedSymbol[] = [];
    for (const item of candidates) {
      const key = `${item.symbol.file}::${item.symbol.symbol}`;
      if (already.has(key)) continue;
      already.add(key);
      picked.push({
        ...item.symbol,
        hopDistance: 1,
        relation: item.relation,
        score: item.score,
      });
      if (picked.length >= limit) break;
    }
    return picked;
  }

  private computeConfidence(
    query: string[],
    direct: Array<{ symbol: IndexedSymbol; score: number }>,
  ): { confidence: number; reasons: string[] } {
    const reasons: string[] = [];
    if (direct.length === 0) {
      return {
        confidence: 0.28,
        reasons: ["Görev metniyle eşleşen sembol bulunamadı."],
      };
    }

    const top = direct[0].score;
    const second = direct[1]?.score ?? 0;
    const margin = top - second;

    // Query term coverage against top hits' name/path tokens.
    const covered = new Set<string>();
    for (const item of direct.slice(0, 5)) {
      for (const t of item.symbol.tokens.name) covered.add(t);
      for (const t of item.symbol.tokens.path) covered.add(t);
    }
    const coverage =
      query.length === 0
        ? 0
        : query.filter(q => covered.has(q) || direct.some(d =>
            d.symbol.symbol.toLowerCase().includes(q) ||
            d.symbol.file.toLowerCase().includes(q),
          )).length / query.length;

    if (coverage < 0.35) reasons.push("Sorgu terimlerinin azı sembol/path ile örtüşüyor.");
    if (top < 3) reasons.push("En iyi eşleşme skoru zayıf.");
    if (margin < 0.75 && direct.length > 3) reasons.push("Eşleşmeler arasında belirsizlik var.");

    let confidence =
      0.42 +
      0.28 * Math.min(1, coverage) +
      0.16 * Math.min(1, top / 12) +
      0.08 * Math.min(1, margin / 4) +
      0.04 * Math.min(direct.length, 4);

    confidence = Math.max(0.3, Math.min(0.95, confidence));
    if (reasons.length >= 2) confidence = Math.min(confidence, 0.68);
    return { confidence, reasons };
  }

  async context_capsule(input: ContextCapsuleInput): Promise<ContextCapsuleOutput> {
    if (typeof input.projectRoot !== "string" || !input.projectRoot.trim()) {
      throw new RangeError("projectRoot must be a non-empty string");
    }
    if (typeof input.task !== "string" || !input.task.trim()) {
      throw new RangeError("task must be a non-empty string");
    }
    if (input.projectRoot.length > 4096 || input.task.length > 20_000) {
      throw new RangeError("projectRoot or task exceeds the supported input size");
    }
    const requestedLevel = input.preferredBudgetLevel ?? 1;
    if (![0, 1, 2, 3].includes(requestedLevel)) {
      throw new RangeError("preferredBudgetLevel must be 0, 1, 2, or 3");
    }
    const attempt = input.escalationAttempt ?? 0;
    const maximum = input.maxEscalationAttempts ?? 3;
    if (!Number.isInteger(attempt) || attempt < 0 || !Number.isInteger(maximum) || maximum < 1 || maximum > 10) {
      throw new RangeError("Invalid escalation attempt bounds");
    }
    if (input.maxModelPayloadTokens !== undefined &&
        (!Number.isInteger(input.maxModelPayloadTokens) || input.maxModelPayloadTokens < 200 || input.maxModelPayloadTokens > 1200)) {
      throw new RangeError("maxModelPayloadTokens must be an integer between 200 and 1200");
    }
    const index = await this.getOrCreateIndex(input.projectRoot);
    const query = queryTokens(input.task);
    const ranked = this.rankSymbols(index, input.task);

    let { confidence, reasons } = this.computeConfidence(
      query,
      ranked.slice(0, 8),
    );
    if (index.truncated) {
      confidence = Math.min(confidence, 0.68);
      reasons = [...reasons, "İndeks dosya sayısı veya kaynak boyutu sınırına ulaştı."];
    }

    const handoff = attempt >= maximum;
    const narrowMechanicalTask = isNarrowMechanicalTask(query);
    // Import ordering is a file-level concern rather than a symbol-graph problem.
    // Escalating such a task to a broad symbol set creates extra model turns without
    // adding useful evidence, so keep it at the smallest retrieval level.
    const lowConfidence = confidence < 0.72 && !narrowMechanicalTask;
    const selectedBudgetLevel = narrowMechanicalTask ? 0 : handoff || lowConfidence ? 3 : requestedLevel;
    const budget = [
      { direct: 1, neighbors: 0, tokens: 200 },
      { direct: 3, neighbors: 1, tokens: 250 },
      { direct: 6, neighbors: 2, tokens: 400 },
      { direct: 8, neighbors: 3, tokens: 600 },
    ][selectedBudgetLevel];
    const direct: IndexedSymbol[] = ranked.slice(0, budget.direct).map(item => ({
      ...item.symbol,
      hopDistance: 0 as const,
      relation: "direct_match" as const,
      score: item.score,
    }));
    const already = new Set(direct.map(s => `${s.file}::${s.symbol}`));
    const neighbors = this.pickNeighborSymbols(index, direct, query, already, budget.neighbors);
    const refs = [...direct, ...neighbors];
    const primaryPackageDir = refs[0]
      ? await nearestPackageDirectory(index.root, refs[0].file)
      : ".";
    const payloadTokenLimit = input.maxModelPayloadTokens ?? budget.tokens;

    const payload = {
      goal: input.task.slice(0, 240),
      relevantSymbols: refs.slice(0, 16).map(publicRef),
      probableFiles: [...new Set(refs.map(ref => ref.file))].slice(0, 12),
      decisions: [
        {
          summary:
            "BM25 + path-aware ranking ile AST sembolleri ve 1-hop import/call komşuları seçildi.",
        },
        {
          summary: narrowMechanicalTask
            ? `Bağlam ekonomisi: mekanik import/lint görevi için yalnız en olası dosya yeterlidir. Doğrulamayı ${primaryPackageDir} dizininden hedef dosyaya --fix uygulayıp diff'i okuyarak yap; --fix-dry-run/JSON formatter kullanma.`
            : "Önce en olası dosyadan başla; kanıt public tip, config, dokümantasyon, komşu test veya yaşam döngüsü etkisi gösteriyorsa kapsamı genişlet.",
        },
        {
          summary: `Birincil paket çalışma dizini: ${primaryPackageDir}. Aynı komutu tekrarlama; makine-okunur tam lint/typecheck çıktısını model bağlamına alma.`,
        },
      ],
      successCriteria: [input.task.slice(0, 180), ...qualityCriteria(input.task, query)],
      // Zayıflık ajana SÖYLENİR. Gerekçeler zaten hesaplanıyordu ama yalnızca
      // `_meta`'ya gidiyordu; ajanın okuduğu yer burası.
      // Bir alan, bir cümle. Payload'ın katı bir bayt bütçesi var (bütçe
      // seviyesi 0'da 200 token) ve orada çoğu zaman TEK sembol kalıyor —
      // kırpılacak yer yok. Gerekçe listesi ile güven skoru orkestrasyon
      // için `_meta`'da duruyor; modelin ihtiyacı olan tek şey durup
      // doğrulaması gerektiği.
      ...(reasons.length > 0 ? { retrievalWeak: "zayıf eşleşme, doğrula" } : {}),
    };

    // Bütçe yalnızca SEMBOL atarak uygulanıyordu ve döngü son sembolde
    // duruyordu. Seviye 0'da `budget.direct = 1`, yani zaten tek sembol var:
    // döngü hiç çalışamıyor. Oysa sabit kısımlar (hedef + karar metinleri +
    // kriterler) tek başına 135–167 token — 200 token vaadi yapısal olarak
    // ulaşılamaz hale geliyordu.
    //
    // Ölçüldü (30 Temmuz 2026, Verðandi + natureco-skuld, 40 çağrı): seviye
    // 0'daki çağrıların 17'si bütçeyi 3–31 token aşıyordu. Aşım sessizdi;
    // `estimatedPayloadTokens` doğruyu söylüyor ama kimse ona bakıp
    // "vaadimi tutamadım" demiyordu.
    //
    // Sıra, ajanın işine yaramayana göre: önce fazla semboller, sonra kendi
    // algoritmamızı anlatan karar metni (göreve sıfır katkısı var), sonra
    // fazladan başarı kriterleri. Hedef ve en az bir sembol asla atılmaz —
    // onlar atılırsa kapsül zaten kapsül olmaktan çıkar.
    const butceBaytI = payloadTokenLimit * 4;
    const asiyorMu = () => JSON.stringify(payload).length > butceBaytI;

    while (asiyorMu() && payload.relevantSymbols.length > 1) {
      payload.relevantSymbols.pop();
      payload.probableFiles = [...new Set(payload.relevantSymbols.map(ref => ref.file))];
    }
    // Seçim algoritmasını anlatan karar, görevi yapan ajana hiçbir şey
    // katmıyor; bütçe sıkışınca ilk gidecek olan odur.
    if (asiyorMu() && payload.decisions.length > 1) {
      payload.decisions = payload.decisions.filter(
        karar => !karar.summary.startsWith("BM25 + path-aware ranking"),
      );
    }
    while (asiyorMu() && payload.successCriteria.length > 1) {
      payload.successCriteria.pop();
    }
    // Kalan kararlar ATILMAZ. İlk denemede sondan karar atıyordum ve mekanik
    // import/lint görevlerine özel rehberliği siliyordu — mevcut bir test bunu
    // yakaladı. O kararlar ajanın ne yapacağını söylüyor; bütçe uğruna
    // görevin kendisini kesmek, kapsülü küçültmek değil sakatlamaktır.
    // Buraya rağmen sığmıyorsa aşım bildirilir, gizlenmez.

    const estimatedPayloadTokens = Math.max(
      1,
      Math.ceil(JSON.stringify(payload).length / 4),
    );
    // Her şeye rağmen sığmadıysa SÖYLENİR. Sessizce aşmak, bütçe vaadini
    // ölçülemez kılar; bunu bilen taraf bir sonraki çağrıda daralta bilir.
    const payloadBudgetExceeded = estimatedPayloadTokens > payloadTokenLimit;

    return {
      schemaVersion: "0.2.0",
      taskId: hash(`${index.snapshot}:${input.task}`).slice(0, 24),
      modelPayload: payload,
      _meta: {
        estimatedPayloadTokens,
        ...(payloadBudgetExceeded ? { payloadBudgetExceeded } : {}),
        retrievalConfidence: confidence,
        uncertaintyReasons: reasons,
        selectedBudgetLevel,
        silentEscalation: lowConfidence,
        escalationAttempt: attempt,
        maxEscalationAttempts: maximum,
        handoffRequired: handoff,
        ...(handoff ? { handoffReason: "Escalation attempt limit reached." } : {}),
        retrievalSnapshot: index.snapshot,
      },
    };
  }

  async read_symbol(input: ReadSymbolInput): Promise<ReadSymbolOutput> {
    if (typeof input.projectRoot !== "string" || !input.projectRoot.trim()) {
      throw new RangeError("projectRoot must be a non-empty string");
    }
    if (typeof input.symbol !== "string" || !input.symbol.trim()) {
      throw new RangeError("symbol must be a non-empty string");
    }
    if (input.projectRoot.length > 4096 || input.symbol.length > 1024 || (input.fileHint?.length ?? 0) > 4096) {
      throw new RangeError("read_symbol input exceeds the supported size");
    }
    const maxTokens = input.maxTokens ?? 1200;
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_READ_SYMBOL_TOKENS) {
      throw new RangeError(`maxTokens must be an integer between 1 and ${MAX_READ_SYMBOL_TOKENS}`);
    }
    const index = await this.getOrCreateIndex(input.projectRoot);
    if (input.snapshot !== undefined && input.snapshot !== index.snapshot) {
      return {
        evidence: [], estimatedTokens: 0, snapshot: index.snapshot, confidence: 0,
        ambiguity: ["Requested snapshot is stale; generate a new capsule or read without the stale snapshot."],
        requiresEscalation: true,
      };
    }
    const searchTarget = input.symbol.includes(".") || input.symbol.includes("#")
      ? input.symbol.split(/[.#]/).pop()!
      : input.symbol;
    const candidates = (index.symbolsByName.get(input.symbol) ?? index.symbolsByName.get(searchTarget) ?? []).filter(
      symbol =>
        (!input.fileHint || symbol.file.includes(input.fileHint)),
    );
    const ambiguity =
      candidates.length === 0
        ? [`Symbol not found: ${input.symbol}${input.fileHint ? ` in file hint ${input.fileHint}` : ""}`]
        : candidates.length > 1
          ? [`${candidates.length} symbols matched; fileHint ile daraltılması önerilir.`]
          : [];
    const selected = candidates.slice(0, 8);
    const ambiguous = candidates.length > 1;
    const evidence: EvidenceWindow[] = selected.map(symbol => {
      const range = lineRange(symbol.sourceFile, symbol.start, symbol.end);
      // An ambiguous lookup returns compact signatures so the caller can add a
      // fileHint without receiving up to eight full symbol bodies.
      const includeBody = input.includeBody !== false && !ambiguous;
      const source = includeBody ? symbol.text : symbol.signature;
      const maxChars = maxTokens * 4;
      const truncated = source.length > maxChars;
      return {
        symbol: {
          symbol: symbol.symbol,
          file: symbol.file,
          kind: symbol.kind,
          hopDistance: 0,
          relation: "direct_match",
        },
        ...(input.includeSignature === false ? {} : { signature: symbol.signature }),
        ...(includeBody ? { source: source.slice(0, maxChars) } : {}),
        startLine: range.startLine,
        endLine: range.endLine,
        contentHash: hash(symbol.text),
        fileContentHash: hash(index.fileByRelative.get(symbol.file)?.text ?? ""),
        truncated,
      };
    });

    if (input.includeCallGraphNeighbors !== false && selected[0]) {
      const calledNames = new Set<string>();
      const collectCalls = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          calledNames.add(node.expression.text);
        }
        ts.forEachChild(node, collectCalls);
      };
      collectCalls(selected[0].node);

      // Prefer actual callee symbols over arbitrary first symbol in neighbor file.
      const neighborHits = [...calledNames]
        .flatMap(name => index.symbolsByName.get(name) ?? [])
        .filter(
          s =>
            s.file !== selected[0].file &&
            calledNames.has(s.symbol) &&
            (index.neighbors.get(selected[0].file)?.has(s.file) ?? true),
        )
        .slice(0, 8);

      for (const neighbor of neighborHits) {
        if (
          evidence.some(
            item =>
              item.symbol.symbol === neighbor.symbol && item.symbol.file === neighbor.file,
          )
        ) {
          continue;
        }
        const range = lineRange(neighbor.sourceFile, neighbor.start, neighbor.end);
        evidence.push({
          symbol: {
            symbol: neighbor.symbol,
            file: neighbor.file,
            kind: neighbor.kind,
            hopDistance: 1,
            relation: "callee",
          },
          signature: neighbor.signature,
          startLine: range.startLine,
          endLine: range.endLine,
          contentHash: hash(neighbor.text),
          fileContentHash: hash(index.fileByRelative.get(neighbor.file)?.text ?? ""),
          truncated: true,
        });
      }
    }

    const estimatedTokens = Math.ceil(
      evidence.reduce((total, item) => total + JSON.stringify(item).length, 0) / 4,
    );
    return {
      evidence,
      estimatedTokens,
      snapshot: index.snapshot,
      confidence:
        candidates.length === 1 ? 0.95 : candidates.length ? 0.65 : 0.2,
      ambiguity,
      requiresEscalation: candidates.length !== 1,
    };
  }

  async apply_structured_patch(
    input: ApplyStructuredPatchInput,
  ): Promise<ApplyStructuredPatchOutput> {
    if (typeof input.projectRoot !== "string" || !input.projectRoot.trim() || input.projectRoot.length > 4096) {
      throw new RangeError("projectRoot must be a bounded non-empty string");
    }
    if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 100) {
      throw new RangeError("operations must contain between 1 and 100 items");
    }
    const insertedBytes = input.operations.reduce((total, operation) => {
      let content = "";
      if (operation.operation === "replace_function_body") content = operation.newBody;
      else if (operation.operation === "replace_symbol") content = operation.replacement;
      else if (operation.operation === "insert_before_symbol" || operation.operation === "insert_after_symbol") content = operation.content;
      return total + Buffer.byteLength(content);
    }, 0);
    if (insertedBytes > 8 * 1024 * 1024) throw new RangeError("patch content exceeds 8 MiB");
    const index = await this.getOrCreateIndex(input.projectRoot);
    if (input.snapshot !== index.snapshot) {
      return {
        applied: false,
        changedFiles: [],
        unifiedDiffSummary: "",
        diagnostics: [
          {
            operationIndex: -1,
            code: "STALE_SNAPSHOT",
            message: "Index snapshot is stale; re-read symbols.",
          },
        ],
        requiresEscalation: true,
      };
    }

    const diagnostics: ApplyStructuredPatchOutput["diagnostics"] = [];
    const replacements = new Map<
      string,
      Array<{ start: number; end: number; value: string }>
    >();

    for (const [operationIndex, operation] of input.operations.entries()) {
      if (
        !operation ||
        typeof operation.file !== "string" ||
        typeof operation.symbol !== "string" ||
        !operation.precondition ||
        typeof operation.precondition.contentHash !== "string" ||
        operation.precondition.file !== operation.file
      ) {
        diagnostics.push({
          operationIndex,
          code: "UNSUPPORTED_OPERATION",
          message: "Patch operation has invalid fields or a mismatched precondition.",
        });
        continue;
      }
      if (![
        "replace_function_body",
        "replace_symbol",
        "delete_symbol",
        "insert_before_symbol",
        "insert_after_symbol",
      ].includes(operation.operation)) {
        diagnostics.push({
          operationIndex,
          code: "UNSUPPORTED_OPERATION",
          message: `Unsupported patch operation: ${String(operation.operation)}`,
        });
        continue;
      }
      if (
        (operation.operation === "replace_function_body" && typeof operation.newBody !== "string") ||
        (operation.operation === "replace_symbol" && typeof operation.replacement !== "string") ||
        ((operation.operation === "insert_before_symbol" || operation.operation === "insert_after_symbol") &&
          typeof operation.content !== "string")
      ) {
        diagnostics.push({
          operationIndex,
          code: "UNSUPPORTED_OPERATION",
          message: `Patch operation is missing replacement content: ${operation.operation}`,
        });
        continue;
      }
      const searchTarget = operation.symbol.includes(".") || operation.symbol.includes("#")
        ? operation.symbol.split(/[.#]/).pop()!
        : operation.symbol;
      const matches = (index.symbolsByName.get(operation.symbol) ?? index.symbolsByName.get(searchTarget) ?? [])
        .filter(item => item.file === operation.file);
      if (matches.length === 0) {
        diagnostics.push({
          operationIndex,
          code: "SYMBOL_NOT_FOUND",
          message: `${operation.symbol} not found in ${operation.file}`,
        });
        continue;
      }
      if (matches.length > 1) {
        diagnostics.push({
          operationIndex,
          code: "AMBIGUOUS_SYMBOL",
          message: `${operation.symbol} is ambiguous in ${operation.file} (${matches.length} matches)`,
        });
        continue;
      }
      const symbol = matches[0];
      const file = index.fileByRelative.get(operation.file);
      if (!file) {
        diagnostics.push({
          operationIndex,
          code: "SYMBOL_NOT_FOUND",
          message: `File not found: ${operation.file}`,
        });
        continue;
      }
      if (
        hash(file.text) !== operation.precondition.contentHash ||
        (operation.precondition.symbol !== undefined &&
          operation.precondition.symbol !== symbol.symbol) ||
        (operation.precondition.symbolHash &&
          hash(symbol.text) !== operation.precondition.symbolHash)
      ) {
        diagnostics.push({
          operationIndex,
          code: "PRECONDITION_FAILED",
          message: `Hash precondition failed for ${operation.file}:${operation.symbol}`,
        });
        continue;
      }

      let start = symbol.start;
      let end = symbol.end;
      let value = "";
      if (operation.operation === "replace_function_body") {
        if (symbol.bodyStart === undefined || symbol.bodyEnd === undefined) {
          diagnostics.push({
            operationIndex,
            code: "UNSUPPORTED_OPERATION",
            message: `${operation.symbol} has no replaceable body`,
          });
          continue;
        }
        start = symbol.bodyStart;
        end = symbol.bodyEnd;
        value = operation.newBody;
      } else if (operation.operation === "replace_symbol") {
        value = operation.replacement;
      } else if (operation.operation === "delete_symbol") {
        value = "";
      } else if (operation.operation === "insert_before_symbol") {
        start = symbol.start;
        end = symbol.start;
        value = `${operation.content}\n`;
      } else {
        start = symbol.end;
        end = symbol.end;
        value = `\n${operation.content}`;
      }
      const list = replacements.get(operation.file) ?? [];
      list.push({ start, end, value });
      replacements.set(operation.file, list);
    }

    if (diagnostics.length || input.dryRun) {
      return {
        applied: !diagnostics.length && !!input.dryRun,
        changedFiles: [...replacements.keys()],
        unifiedDiffSummary: [...replacements.keys()].join(", "),
        diagnostics,
        requiresEscalation: diagnostics.length > 0,
      };
    }

    if (replacements.size === 0) {
      return {
        applied: false,
        changedFiles: [],
        unifiedDiffSummary: "",
        diagnostics: [{
          operationIndex: -1,
          code: "UNSUPPORTED_OPERATION",
          message: "At least one patch operation is required.",
        }],
        requiresEscalation: true,
      };
    }

    const rollbackToken = `rb_${hash(`${input.taskId}:${Date.now()}:${randomBytes(16).toString("hex")}`)}`;
    const backupEntries: RollbackEntry[] = [];
    const pendingWrites: Array<{ relative: string; absolute: string; original: string; updated: string }> = [];

    for (const [relative, changes] of replacements) {
      const file = index.fileByRelative.get(relative)!;
      if (!await isResolvedPathInsideRoot(index.root, file.absolute)) {
        return {
          applied: false,
          changedFiles: [],
          unifiedDiffSummary: "",
          diagnostics: [{
            operationIndex: -1,
            code: "PRECONDITION_FAILED",
            message: `Refusing to patch path outside project root: ${relative}`,
          }],
          requiresEscalation: true,
        };
      }
      const currentText = await fs.readFile(file.absolute, "utf8");
      if (hash(currentText) !== hash(file.text)) {
        return {
          applied: false,
          changedFiles: [],
          unifiedDiffSummary: "",
          diagnostics: [{
            operationIndex: -1,
            code: "PRECONDITION_FAILED",
            message: `File changed after indexing: ${relative}`,
          }],
          requiresEscalation: true,
        };
      }
      const original = currentText;
      let text = original;
      const sorted = [...changes].sort((a, b) => b.start - a.start || b.end - a.end);
      for (let i = 0; i < sorted.length - 1; i++) {
        if (sorted[i + 1].end > sorted[i].start) {
          diagnostics.push({
            operationIndex: -1,
            code: "UNSUPPORTED_OPERATION",
            message: `Overlapping replacement operations detected in ${relative}`,
          });
          return {
            applied: false,
            changedFiles: [],
            unifiedDiffSummary: "",
            diagnostics,
            requiresEscalation: true,
          };
        }
      }
      for (const change of sorted) {
        // Gelen gövde dosyanın satır sonu geleneğine uydurulur; yoksa CRLF bir
        // dosya karışık satır sonlu hale geliyor (bkz. matchLineEndings).
        text = text.slice(0, change.start)
          + matchLineEndings(change.value, original)
          + text.slice(change.end);
      }
      const parsed = ts.createSourceFile(
        file.absolute,
        text,
        file.sourceFile.languageVersion,
        true,
        scriptKindForFile(file.absolute),
      ) as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };
      const parseError = parsed.parseDiagnostics?.find(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
      if (parseError) {
        return {
          applied: false,
          changedFiles: [],
          unifiedDiffSummary: "",
          diagnostics: [{
            operationIndex: -1,
            code: "PARSE_FAILED",
            message: ts.flattenDiagnosticMessageText(parseError.messageText, "\n"),
          }],
          requiresEscalation: true,
        };
      }
      pendingWrites.push({ relative, absolute: file.absolute, original, updated: text });
    }

    for (const write of pendingWrites) {
      backupEntries.push({
        relative: write.relative,
        text: write.original,
        patchedHash: hash(write.updated),
      });
    }
    const backupBytes = backupEntries.reduce((total, entry) => total + Buffer.byteLength(entry.text), 0);
    if (backupBytes > MAX_ROLLBACK_BACKUP_BYTES) {
      return {
        applied: false,
        changedFiles: [],
        unifiedDiffSummary: "",
        diagnostics: [{ operationIndex: -1, code: "UNSUPPORTED_OPERATION", message: `Rollback backup exceeds ${MAX_ROLLBACK_BACKUP_BYTES} bytes` }],
        requiresEscalation: true,
      };
    }
    this.patchRollbacks.set(rollbackToken, backupEntries);

    // Persist the recovery journal before touching source files. Rollback also
    // accepts entries that are still at their original hash, so a process crash
    // between multi-file writes remains recoverable after restart.
    let diskTokenFile: string | undefined;
    try {
      const rollbacksDir = await ensureSafeDirectory(path.resolve(input.projectRoot), [".verdandi", "rollbacks"]);
      diskTokenFile = path.join(rollbacksDir, `${rollbackToken}.json`);
      await fs.writeFile(diskTokenFile, JSON.stringify(backupEntries), { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      this.patchRollbacks.delete(rollbackToken);
      return {
        applied: false,
        changedFiles: [],
        unifiedDiffSummary: "",
        diagnostics: [{
          operationIndex: -1,
          code: "WRITE_FAILED",
          message: `Cannot persist crash-safe rollback journal: ${error instanceof Error ? error.message : String(error)}`,
        }],
        requiresEscalation: true,
      };
    }

    const written: typeof pendingWrites = [];
    try {
      for (const write of pendingWrites) {
        await fs.writeFile(write.absolute, write.updated, "utf8");
        written.push(write);
      }
    } catch (error) {
      for (const write of written.reverse()) {
        try {
          if (hash(await fs.readFile(write.absolute, "utf8")) === hash(write.updated)) {
            await fs.writeFile(write.absolute, write.original, "utf8");
          }
        } catch {
          // Preserve the original write failure as the actionable diagnostic.
        }
      }
      this.patchRollbacks.delete(rollbackToken);
      if (diskTokenFile) try { await fs.unlink(diskTokenFile); } catch {}
      return {
        applied: false,
        changedFiles: [],
        unifiedDiffSummary: "",
        diagnostics: [{
          operationIndex: -1,
          code: "WRITE_FAILED",
          message: `Patch write failed: ${error instanceof Error ? error.message : String(error)}`,
        }],
        requiresEscalation: true,
      };
    }

    // Disk changed — drop cache so subsequent reads see new content.
    this.invalidateCache(input.projectRoot);

    return {
      applied: true,
      changedFiles: [...replacements.keys()],
      unifiedDiffSummary: `${replacements.size} file(s) changed for task ${input.taskId}`,
      diagnostics,
      rollbackToken,
      requiresEscalation: false,
    };
  }

  private patchRollbacks = new Map<string, RollbackEntry[]>();

  async rollback_patch(input: RollbackPatchInput): Promise<RollbackPatchOutput> {
    if (!ROLLBACK_TOKEN_PATTERN.test(input.rollbackToken)) {
      return { reverted: false, revertedFiles: [], message: "Invalid rollback token." };
    }
    const root = path.resolve(input.projectRoot);
    let backupEntries: RollbackEntry[] | undefined;
    const diskTokenFile = path.join(root, ".verdandi", "rollbacks", `${input.rollbackToken}.json`);

    try {
      if (!await isResolvedPathInsideRoot(root, diskTokenFile)) throw new Error("Unsafe rollback token path");
      const diskContent = await fs.readFile(diskTokenFile, "utf-8");
      const parsed = JSON.parse(diskContent) as unknown;
      if (!Array.isArray(parsed) || !parsed.every(item =>
        item && typeof item === "object" &&
        typeof item.relative === "string" &&
        typeof item.text === "string" &&
        typeof item.patchedHash === "string" &&
        /^[a-f0-9]{64}$/.test(item.patchedHash),
      )) {
        throw new Error("Invalid rollback data");
      }
      backupEntries = parsed as RollbackEntry[];
    } catch {
      const memoryMap = this.patchRollbacks.get(input.rollbackToken);
      if (memoryMap) {
        backupEntries = memoryMap;
      }
    }

    if (!backupEntries) {
      return {
        reverted: false,
        revertedFiles: [],
        message: `Rollback token not found or expired: ${input.rollbackToken}`,
      };
    }

    const verified: Array<{ entry: RollbackEntry; absolute: string; currentText: string; needsRevert: boolean }> = [];
    for (const entry of backupEntries) {
      const absolute = resolveProjectFile(root, entry.relative);
      if (!absolute) {
        return { reverted: false, revertedFiles: [], message: `Unsafe rollback path: ${entry.relative}` };
      }
      if (!await isResolvedPathInsideRoot(root, absolute)) {
        return { reverted: false, revertedFiles: [], message: `Unsafe rollback path: ${entry.relative}` };
      }
      const currentText = await fs.readFile(absolute, "utf8");
      const currentHash = hash(currentText);
      const originalHash = hash(entry.text);
      if (currentHash !== entry.patchedHash && currentHash !== originalHash) {
        return { reverted: false, revertedFiles: [], message: `Refusing to overwrite changed file: ${entry.relative}` };
      }
      verified.push({ entry, absolute, currentText, needsRevert: currentHash === entry.patchedHash });
    }

    const revertedFiles: string[] = [];
    try {
      for (const item of verified.filter(item => item.needsRevert)) {
        await fs.writeFile(item.absolute, item.entry.text, "utf8");
        revertedFiles.push(item.entry.relative);
      }
    } catch (error) {
      for (const item of verified.filter(item => revertedFiles.includes(item.entry.relative)).reverse()) {
        try { await fs.writeFile(item.absolute, item.currentText, "utf8"); } catch {}
      }
      return {
        reverted: false,
        revertedFiles: [],
        message: `Rollback write failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    this.patchRollbacks.delete(input.rollbackToken);
    try { await fs.unlink(diskTokenFile); } catch {}
    this.invalidateCache(input.projectRoot);

    return {
      reverted: true,
      revertedFiles,
      message: `Successfully reverted ${revertedFiles.length} file(s) for rollback token ${input.rollbackToken}`,
    };
  }

  async validate_delta(input: ValidateDeltaInput): Promise<ValidateDeltaOutput> {
    if (!Array.isArray(input.kinds) || input.kinds.length === 0 || input.kinds.length > 4 || new Set(input.kinds).size !== input.kinds.length) {
      return {
        passed: false,
        summary: "Validation kinds must be a non-empty unique list",
        checks: [],
        diagnostics: [{ kind: input.kinds?.[0] ?? "build", message: "Duplicate or empty validation kinds are not allowed." }],
        omittedDiagnosticCount: 0,
        estimatedOutputTokens: 20,
        requiresEscalation: true,
      };
    }
    const root = path.resolve(input.projectRoot);
    let packageJson: { scripts?: Record<string, string>; packageManager?: unknown } = {};
    try {
      const pJsonText = await fs.readFile(path.join(root, "package.json"), "utf8");
      packageJson = JSON.parse(pJsonText);
    } catch (err) {
      return {
        passed: false,
        summary: "package.json missing or invalid",
        checks: input.kinds.map(kind => ({ kind, passed: false, durationMs: 0 })),
        diagnostics: [{
          kind: input.kinds[0] ?? "build",
          message: `package.json error: ${err instanceof Error ? err.message : String(err)}`,
        }],
        omittedDiagnosticCount: 0,
        estimatedOutputTokens: 20,
        requiresEscalation: true,
      };
    }
    const checks: ValidateDeltaOutput["checks"] = [];
    const diagnostics: CompactValidationDiagnostic[] = [];
    if (input.commandProfile !== "package-scripts") {
      return {
        passed: false,
        summary: "Validation requires explicit package-scripts authorization",
        checks: input.kinds.map(kind => ({ kind, passed: false, durationMs: 0 })),
        diagnostics: input.kinds.map(kind => ({
          kind,
          message: "Set commandProfile to 'package-scripts' to authorize project package scripts.",
        })),
        omittedDiagnosticCount: 0,
        estimatedOutputTokens: 30,
        requiresEscalation: true,
      };
    }
    const manager = await detectPackageManager(root, packageJson);
    const allowed: Set<string> = new Set(["test", "lint", "typecheck", "build"]);

    for (const kind of input.kinds) {
      if (!allowed.has(kind)) {
        checks.push({ kind, passed: false, durationMs: 0 });
        diagnostics.push({
          kind,
          message: `Validation kind '${kind}' is not in the approved set.`,
        });
        continue;
      }
      const script = packageJson.scripts?.[kind];
      if (!script) {
        checks.push({ kind, passed: false, durationMs: 0 });
        diagnostics.push({
          kind,
          message: `Approved package script '${kind}' bulunamadı.`,
        });
        continue;
      }
      const started = Date.now();
      const result = await new Promise<{ code: number; output: string }>(resolve =>
        execFile(
          manager.command,
          [...manager.runArgs, kind],
          {
            cwd: root,
            timeout: 15 * 60 * 1000,
            maxBuffer: 2 * 1024 * 1024,
            shell: SHELL_GEREKIYOR,
          },
          (error, stdout, stderr) => {
            if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
              resolve({
                code: 127,
                output: `'${manager.command}' bulunamadı (PATH üzerinde yok).`,
              });
              return;
            }
            resolve({
              code:
                error?.code === "ETIMEDOUT"
                  ? 124
                  : typeof error?.code === "number"
                    ? error.code
                    : error
                      ? 1
                      : 0,
              output: `${stdout}\n${stderr}`,
            });
          },
        ),
      );
      checks.push({ kind, passed: result.code === 0, durationMs: Date.now() - started });
      if (result.code !== 0) {
        diagnostics.push({
          kind,
          message:
            result.output.split("\n").filter(Boolean).slice(-1)[0] ??
            `Command failed with ${result.code}`,
        });
      }
    }

    const passed = checks.length > 0 && checks.every(check => check.passed);
    const maxDiagnostics = Math.max(1, Math.min(1000, Number.isInteger(input.maxDiagnostics) ? input.maxDiagnostics! : 20));
    const maxOutputTokens = Math.max(1, Math.min(8_000, Number.isInteger(input.maxOutputTokens) ? input.maxOutputTokens! : 2000));
    const selectedDiagnostics: CompactValidationDiagnostic[] = [];
    for (const diagnostic of diagnostics.slice(0, maxDiagnostics)) {
      const candidate = [...selectedDiagnostics, diagnostic];
      if (selectedDiagnostics.length > 0 && Math.ceil(JSON.stringify(candidate).length / 4) > maxOutputTokens) break;
      selectedDiagnostics.push(diagnostic);
    }
    return {
      passed,
      summary: `${checks.filter(check => check.passed).length}/${checks.length} validation checks passed`,
      checks,
      diagnostics: selectedDiagnostics,
      omittedDiagnosticCount: Math.max(0, diagnostics.length - selectedDiagnostics.length),
      estimatedOutputTokens: Math.ceil(JSON.stringify(selectedDiagnostics).length / 4),
      requiresEscalation: !passed,
    };
  }
}

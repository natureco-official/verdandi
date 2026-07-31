/**
 * Anlamsal katman — İSTEĞE BAĞLI.
 *
 * Neden var: sözcük örtüşmesine dayalı sıralama, görev Türkçe yazılıp kod
 * İngilizce adlandırıldığında çaresiz kalıyor. `screenShareManager.ts` içinde
 * tek Türkçe kelime yok; "ekran paylaşımı" ile arasında tek harf ortaklığı da
 * yok. Ölçüldü (30 Temmuz 2026, natureco_improvements): Türkçe görevlerde
 * hedef dosya kapsülde 7/15, İngilizcede 12/15.
 *
 * Sözlük denendi ve duvara çarptı — bir dilin sözcükleri elle sayılamıyor.
 * Ek soyma denendi, sıfır etki verdi. Gövde ağırlığı süpürüldü, 15'te 1 görev
 * kazandırdı. Anlamsal eşleştirme, genelleşen tek yol.
 *
 * İSTEĞE BAĞLI OLMASI TASARIM: `@huggingface/transformers` kurulu değilse bu
 * modül sessizce devre dışı kalır ve ürün bugünkü davranışını aynen sürdürür.
 * Böylece "bağımlılıksız ve çevrimdışı çalışır" iddiası kuruluma bağlı kalır,
 * kırılmaz. Bağımlılık ~382 MB; bunu herkese zorunlu kılmak, kazancın
 * karşılayamayacağı bir bedel.
 *
 * DEĞİŞTİRMEZ, EKLER: anlamsal sonuçlar sözcüksel sıralamanın YERİNE geçmez,
 * yanına eklenir. Ölçüm ikisinin tamamlayıcı olduğunu gösterdi — sözcüksel
 * yöntemin bulamadığı 3 görevi anlamsal buluyor, anlamsalın kaybettiği 3
 * görevi sözcüksel tutuyor. Birini diğerinin yerine koymak kayıp olurdu.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** e5 ailesi sorgu ve belgeyi ayrı önekle bekler; karıştırmak skoru bozar. */
const SORGU_ONEKI = "query: ";
const BELGE_ONEKI = "passage: ";
const MODEL = "Xenova/multilingual-e5-small";
const PARTI = 32;
const BELGE_SINIRI = 500;

type Boru = (metinler: string[], secenekler: { pooling: "mean"; normalize: boolean }) =>
  Promise<{ data: Float32Array | number[]; dims: number[] }>;

let boru: Boru | null = null;
let denendi = false;

/**
 * Modeli yükler. Bağımlılık yoksa `null` döner ve bir daha denenmez —
 * her çağrıda `import` hatası üretmek, kapalı bir özelliği pahalı kılar.
 */
/**
 * Katman AÇIK ONAYLA çalışır: `VERDANDI_SEMANTIC=1`.
 *
 * Yalnızca "paket kuruluysa aç" yetmedi, ölçüldü: paket kurulu olduğunda test
 * paketi 30 sn'den 162 sn'ye çıktı, MCP sınır testleri zaman aşımından
 * kararsızlaştı, ve anlamsal adaylar sözcüksel hiçbir eşleşme olmadığında bile
 * dosya eklediği için "hiçbir şey bulunamadı" sinyali kayboldu — dürüst boş
 * sonuç, uydurma bir sonuca dönüştü.
 *
 * Bir bağımlılığın VARLIĞI, davranışı değiştirmek için yeterli gerekçe değil.
 * Kapalıyken ürün bugünkü ölçülmüş davranışını birebir sürdürür.
 */
function acikOnayVar(): boolean {
  return process.env.VERDANDI_SEMANTIC === "1";
}

async function boruyuAl(): Promise<Boru | null> {
  if (!acikOnayVar()) return null;
  if (denendi) return boru;
  denendi = true;
  try {
    // Modül adı DEĞİŞKENDE tutuluyor: paket isteğe bağlı olduğu için tip
    // sistemi onu çözmeye çalışmamalı, yoksa kurulu olmadığı her yerde
    // derleme hatası verir. Çalışma zamanında yoksa aşağıdaki catch yakalar.
    const modulAdi = "@huggingface/transformers";
    const mod = (await import(modulAdi)) as {
      pipeline: (gorev: string, model: string) => Promise<unknown>;
    };
    boru = (await mod.pipeline("feature-extraction", MODEL)) as Boru;
  } catch {
    boru = null;
  }
  return boru;
}

export async function anlamsalHazirMi(): Promise<boolean> {
  return (await boruyuAl()) !== null;
}

function vektorleriAyir(cikti: { data: Float32Array | number[]; dims: number[] }, adet: number): number[][] {
  const boyut = cikti.dims[cikti.dims.length - 1]!;
  const veri = cikti.data;
  const cikan: number[][] = [];
  for (let i = 0; i < adet; i++) {
    cikan.push(Array.from(veri.slice(i * boyut, (i + 1) * boyut) as ArrayLike<number>));
  }
  return cikan;
}

async function gom(metinler: string[]): Promise<number[][] | null> {
  const b = await boruyuAl();
  if (!b || metinler.length === 0) return null;
  const cikan: number[][] = [];
  for (let i = 0; i < metinler.length; i += PARTI) {
    const parca = metinler.slice(i, i + PARTI);
    const cikti = await b(parca, { pooling: "mean", normalize: true });
    cikan.push(...vektorleriAyir(cikti, parca.length));
  }
  return cikan;
}

/** Vektörler normalize edildiği için nokta çarpımı kosinüs benzerliğidir. */
export function kosinus(a: readonly number[], b: readonly number[]): number {
  let toplam = 0;
  for (let i = 0; i < a.length && i < b.length; i++) toplam += a[i]! * b[i]!;
  return toplam;
}

/**
 * Dosya için kompakt belge: yol + dışa aktarılan adlar + metin dizgeleri.
 *
 * Dosyanın TAMAMI gömülmez. Model girdiyi zaten kesiyor ve uzun kod gövdesi
 * anlamı seyreltiyor; yol ile dışa aktarılan adlar ise dosyanın ne yaptığını
 * en yoğun anlatan iki şey. Türkçe arayüz dizgeleri de buraya giriyor —
 * Türkçe sorgunun tutunabileceği tek yer çoğu zaman orası.
 */
export function dosyaBelgesi(goreliYol: string, metin: string): string {
  const bas = metin.slice(0, 4000);
  const adlar = [...bas.matchAll(/export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+([A-Za-z0-9_]+)/g)]
    .map(m => m[1])
    .slice(0, 12)
    .join(" ");
  const dizgeler = (bas.match(/["'`][^"'`\n]{8,60}["'`]/g) ?? [])
    .slice(0, 6)
    .join(" ")
    .replace(/["'`]/g, "");
  const yol = goreliYol.replace(/[/_.-]/g, " ");
  return `${BELGE_ONEKI}${yol} ${adlar} ${dizgeler}`.slice(0, BELGE_SINIRI);
}

interface OnbellekKaydi {
  readonly model: string;
  readonly girdiler: Record<string, number[]>;
}

function onbellekYolu(projeKoku: string): string {
  const anahtar = createHash("sha256").update(path.resolve(projeKoku)).digest("hex").slice(0, 16);
  return path.join(os.homedir(), ".verdandi", "embeddings", `${anahtar}.json`);
}

async function onbellekOku(projeKoku: string): Promise<Map<string, number[]>> {
  try {
    const ham = JSON.parse(await fs.readFile(onbellekYolu(projeKoku), "utf8")) as OnbellekKaydi;
    if (ham.model !== MODEL) return new Map();
    return new Map(Object.entries(ham.girdiler));
  } catch {
    return new Map();
  }
}

async function onbellekYaz(projeKoku: string, girdiler: Map<string, number[]>): Promise<void> {
  try {
    const yol = onbellekYolu(projeKoku);
    await fs.mkdir(path.dirname(yol), { recursive: true });
    const kayit: OnbellekKaydi = { model: MODEL, girdiler: Object.fromEntries(girdiler) };
    await fs.writeFile(yol, JSON.stringify(kayit), "utf8");
  } catch {
    // Önbellek yazılamazsa özellik yine çalışır, yalnız yavaşlar.
  }
}

export interface DosyaVektoru {
  readonly file: string;
  readonly vektor: readonly number[];
}

/**
 * Dosya vektörlerini üretir; içeriği değişmeyen dosya YENİDEN gömülmez.
 *
 * Önbellek anahtarı dosya içeriğinin hash'i: ilk indeksleme pahalı (ölçüldü:
 * 360 dosya için 45 sn), sonrakiler yalnız değişen dosyayı öder. Anahtar
 * içerik olduğu için dosya adı değişse bile vektör yeniden kullanılır.
 */
export async function dosyaVektorleri(
  projeKoku: string,
  dosyalar: ReadonlyArray<{ relative: string; text: string }>,
): Promise<DosyaVektoru[] | null> {
  if (!(await anlamsalHazirMi())) return null;

  const onbellek = await onbellekOku(projeKoku);
  const anahtarlar = dosyalar.map(d => createHash("sha256").update(d.text).digest("hex").slice(0, 32));

  const eksikIndeks: number[] = [];
  for (let i = 0; i < dosyalar.length; i++) {
    if (!onbellek.has(anahtarlar[i]!)) eksikIndeks.push(i);
  }

  if (eksikIndeks.length > 0) {
    const belgeler = eksikIndeks.map(i => dosyaBelgesi(dosyalar[i]!.relative, dosyalar[i]!.text));
    const yeni = await gom(belgeler);
    if (!yeni) return null;
    for (let j = 0; j < eksikIndeks.length; j++) {
      onbellek.set(anahtarlar[eksikIndeks[j]!]!, yeni[j]!);
    }
    await onbellekYaz(projeKoku, onbellek);
  }

  const cikan: DosyaVektoru[] = [];
  for (let i = 0; i < dosyalar.length; i++) {
    const v = onbellek.get(anahtarlar[i]!);
    if (v) cikan.push({ file: dosyalar[i]!.relative, vektor: v });
  }
  return cikan;
}

/** Görev metnini gömer. Sorgu öneki belge önekinden farklı olmak zorunda. */
export async function sorguVektoru(gorev: string): Promise<number[] | null> {
  const v = await gom([`${SORGU_ONEKI}${gorev}`]);
  return v ? v[0]! : null;
}

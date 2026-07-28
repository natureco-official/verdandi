# Verðandi Context Compiler — Universal Agent Integration

> **One server, all agents.** Ölçülen token tasarrufu göreve ve entegrasyona göre değişir.

## Hızlı Başlangıç

```bash
npm install && npm run build
./run_with_capsule.sh <agent> <proje-yolu> "Görevi yaz"
```

## Agent-Kullanım Matrisi

> **Hangi ajanın neyi desteklediği tek bir yerde:** [README'deki destek tablosu](README.md#supported-agents).
> Burası yalnızca komutları listeler. Durum sütunları eskiden burada da vardı ve kaydı: bu dosya
> Antigravity için Auto-Inject'i ✅ gösteriyordu, üstelik verdiği komut ajanı hiç çalıştırmayan bir
> token sayma betiğiydi. Aynı bilgiyi iki yerde tutmak onu ikinci yerde eskitiyor.

| Agent | Komut |
|-------|-------|
| **Antigravity CLI** | `./run_with_capsule.sh antigravity /path "task"` |
| **NatureCo CLI** | `./run_with_capsule.sh natureco /path "task"` |
| **OpenClaw** | `./run_with_capsule.sh openclaw /path "task"` |
| **Hermes** | `./run_with_capsule.sh hermes /path "task"` |
| **Codex CLI** | `./run_with_capsule.sh codex /path "task"` |
| **Claude Code** | `./run_with_capsule.sh claude /path "task"` |
| **OpenCode** | `./run_with_capsule.sh opencode /path "task"` |
| **Kimi CLI** | `./run_with_capsule.sh kimi /path "task"` |
| **GLM CLI** | `./run_with_capsule.sh glm /path "task"` |
| **Verðandi Agent** | `verdandi-agent "task" --project /path --model gpt-4o` |

## 3 Mod

### 1. Auto-Inject (Tavsiye Edilen)

```bash
./run_with_capsule.sh <agent> <proje-yolu> "Görev"
```

Capsule + ilgili kodlar tek prompt'a enjekte edilir. Agent direkt başlar.

`benchmark_test.mjs`, bu depo için seçilmiş tam dosyalara kıyasla sentetik bağlam boyutunu ölçer. Uçtan uca kayıtlar şu ana kadar karışıktır; sonuçları kalite veya ajan token tasarrufu olarak yorumlamayın ve farklı projelere genellemeyin.

### 2. MCP Server

```bash
natureco mcp add verdandi-context-compiler node dist/src/mcp_server.js
hermes mcp add verdandi-context-compiler --command node --args dist/src/mcp_server.js
```

### 3. Verðandi Agent (Bağımsız)

```bash
verdandi-agent "task" --project /path --model MiniMax-M3 --api-key KEY --base-url https://api.minimax.io/v1
```

## MCP Tools

| Tool | Ne Yapıyor |
|------|-----------|
| `context_capsule` | Görev → AST → bütçeye bağlı, sınırlı capsule |
| `read_symbol` | Sembol kaynak kodu + komşuları |
| `apply_structured_patch` | Hash korumalı sembol bazlı yama + rollbackToken |
| `rollback_patch` | Yamayı milisaniyeler içinde güvenli geri alma |
| `validate_delta` | Açık `commandProfile: "package-scripts"` izniyle test/lint/typecheck/build |

## Kurulum

```bash
git clone <repo> && cd capsule && npm install && npm run build
npm test  # zero exit code, zero failed tests
```

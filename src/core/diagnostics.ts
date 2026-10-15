/**
 * Centralized Diagnostic Dictionary for Cuthol.
 *
 * Every error and warning emitted by Cuthol CLI or MCP tools MUST originate from this file
 * and follow the uniform structure:
 *   `[CUTHOL-<CODE>] <What Happened> | Öneri: <Next Action Hint for the Agent>`
 */

export type DiagnosticSeverity = "ERROR" | "WARN";

export type VerificationGateId =
  | "G1_SCHEMA"
  | "G2_ASSETS"
  | "G3_TIMING"
  | "G4_STAGE"
  | "G5_SIGNAL"
  | "SYS";

export interface CutholDiagnostic {
  code: string;
  gate: VerificationGateId;
  severity: DiagnosticSeverity;
  what: string;
  suggestion: string;
  subject_id?: string;
  formatted: string;
}

export function createDiagnostic(
  code: string,
  gate: VerificationGateId,
  severity: DiagnosticSeverity,
  what: string,
  suggestion: string,
  subject_id?: string
): CutholDiagnostic {
  const formatted = `[${code}] ${what} | Öneri: ${suggestion}`;
  return { code, gate, severity, what, suggestion, subject_id, formatted };
}

export class CutholError extends Error {
  public readonly diagnostic: CutholDiagnostic;
  public readonly allDiagnostics?: CutholDiagnostic[];

  constructor(diagnostic: CutholDiagnostic, allDiagnostics?: CutholDiagnostic[]) {
    super(diagnostic.formatted);
    this.name = "CutholError";
    this.diagnostic = diagnostic;
    this.allDiagnostics = allDiagnostics;
  }
}

export const DIAGNOSTICS = {
  // --- System & Workspace (SYS) ---
  WORKSPACE_NOT_FOUND: (dir: string) =>
    createDiagnostic(
      "CUTHOL-SYS01",
      "SYS",
      "ERROR",
      `'${dir}' dizininde başlatılmış bir Cuthol çalışma alanı ('cuthol.sequence.json') bulunamadı.`,
      `Önce 'cuthol workspace init "${dir}"' komutuyla çalışma alanını oluşturun.`
    ),

  INVALID_TIME_LITERAL: (raw: string) =>
    createDiagnostic(
      "CUTHOL-SYS02",
      "SYS",
      "ERROR",
      `'${raw}' geçerli bir zaman ifadesi değil.`,
      `Açık birimli ('1250ms', '1.25s', '0.5min') veya 'MM:SS.mmm' biçiminde zaman değeri verin.`
    ),

  JOURNAL_REVISION_UNAVAILABLE: (direction: "undo" | "redo") =>
    createDiagnostic(
      "CUTHOL-SYS03",
      "SYS",
      "ERROR",
      `İşlem günlüğünde '${direction}' yönünde gidilebilecek başka bir revizyon yok.`,
      `'cuthol workspace journal list' komutuyla mevcut revizyon geçmişini kontrol edin.`
    ),

  EXTERNAL_TOOL_FAILED: (tool: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-SYS04",
      "SYS",
      "ERROR",
      `'${tool}' alt süreci hata ile sonlandı: ${detail}`,
      `Girdi dosyasının bozuk olmadığını ve '${tool}' aracının sistem PATH'inde bulunduğunu doğrulayın.`
    ),

  MISSING_API_KEY: (envVarName: string, serviceName: string) =>
    createDiagnostic(
      "CUTHOL-SYS05",
      "SYS",
      "ERROR",
      `${serviceName} servisi için '${envVarName}' ortam değişkeni tanımlı değil.`,
      `Çalışma dizinindeki '.env' dosyasına '${envVarName}=...' anahtarını ekleyin.`
    ),

  TRANSCRIPT_NOT_FOUND: (handle: string) =>
    createDiagnostic(
      "CUTHOL-SYS06",
      "SYS",
      "ERROR",
      `'${handle}' kaynağı için önbellekte konuşma dökümü (transkript) bulunamadı.`,
      `Önce 'cuthol speech transcribe --handle ${handle}' komutunu çalıştırın.`
    ),

  // --- Gate 1: Schema & Handle Integrity (G1_SCHEMA) ---
  UNKNOWN_HANDLE: (handle: string) =>
    createDiagnostic(
      "CUTHOL-G101",
      "G1_SCHEMA",
      "ERROR",
      `'${handle}' tutamacı aktif sekans içinde bulunamadı.`,
      `'cuthol brief --lens overview' komutuyla mevcut medya, klip ve şerit tutamaçlarını listeleyin.`,
      handle
    ),

  DUPLICATE_HANDLE: (handle: string) =>
    createDiagnostic(
      "CUTHOL-G102",
      "G1_SCHEMA",
      "ERROR",
      `'${handle}' tutamacı sekans içinde birden fazla öğede tanımlanmış.`,
      `Her medya ('vid_*', 'aud_*'), omurga klibi ('sp_*') ve şerit öğesi ('cue_*') benzersiz bir tutamaca sahip olmalıdır.`,
      handle
    ),

  DANGLING_ASSET_REF: (ownerId: string, assetHandle: string) =>
    createDiagnostic(
      "CUTHOL-G103",
      "G1_SCHEMA",
      "ERROR",
      `'${ownerId}' öğesi kütüphanede bulunmayan '${assetHandle}' kaynağına başvuruyor.`,
      `Önce 'cuthol library ingest' ile medyayı ekleyin veya geçerli bir kütüphane tutamacı kullanın.`,
      ownerId
    ),

  DANGLING_ANCHOR_REF: (cueId: string, anchorRef: string) =>
    createDiagnostic(
      "CUTHOL-G104",
      "G1_SCHEMA",
      "ERROR",
      `'${cueId}' şerit öğesi var olmayan '${anchorRef}' omurga klibine çapalanmış.`,
      `Çapayı mevcut bir 'sp_*' klibine yönlendirin veya mutlak 'at_ms' zamanına dönüştürün.`,
      cueId
    ),

  INVALID_COMPOSITION_CONTRACT: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G105",
      "G1_SCHEMA",
      "ERROR",
      `'${cueId}' HyperFrames kompozisyonu sözleşme denetiminden geçemedi: ${detail}`,
      `Kompozisyon HTML dosyasındaki 'data-composition-id', 'window.__timelines' ve determinizm kurallarını düzeltin.`,
      cueId
    ),

  // --- Gate 2: Physical Asset & Boundary Integrity (G2_ASSETS) ---
  MISSING_FILE_ON_DISK: (handle: string, uri: string) =>
    createDiagnostic(
      "CUTHOL-G201",
      "G2_ASSETS",
      "ERROR",
      `'${handle}' kaynağına ait '${uri}' dosyası diskte bulunamadı.`,
      `Dosya yolunu düzeltin veya 'cuthol library ingest' ile dosyayı yeniden içeri aktarın.`,
      handle
    ),

  SOURCE_RANGE_EXCEEDED: (clipId: string, outMs: number, assetDurationMs: number) =>
    createDiagnostic(
      "CUTHOL-G202",
      "G2_ASSETS",
      "ERROR",
      `'${clipId}' klibinin kaynak bitiş noktası (${outMs}ms), medyanın fiziksel süresini (${assetDurationMs}ms) aşıyor.`,
      `'source_out_ms' değerini ${assetDurationMs}ms veya altına çekin.`,
      clipId
    ),

  NO_AUDIO_STREAM: (handle: string) =>
    createDiagnostic(
      "CUTHOL-G203",
      "G2_ASSETS",
      "ERROR",
      `'${handle}' kaynağında ses akışı (audio stream) bulunmuyor.`,
      `Ses analizi veya ses ayırma işlemlerini yalnızca 'has_audio: true' olan kaynaklar üzerinde çalıştırın.`,
      handle
    ),

  // --- Gate 3: Temporal Continuity & Frame Budget (G3_TIMING) ---
  SUB_FRAME_DURATION: (itemId: string, durationMs: number, minMs: number) =>
    createDiagnostic(
      "CUTHOL-G301",
      "G3_TIMING",
      "ERROR",
      `'${itemId}' öğesinin süresi (${durationMs}ms), sahne kare hızındaki minimum 2 kare sınırının (${minMs}ms) altında.`,
      `Öğeyi silin veya süresini en az ${minMs}ms olacak şekilde uzatın.`,
      itemId
    ),

  SPINE_DISCONTINUITY: (clipId: string, expectedStartMs: number, actualStartMs: number) =>
    createDiagnostic(
      "CUTHOL-G302",
      "G3_TIMING",
      "ERROR",
      `Manyetik omurgadaki '${clipId}' klibi ${expectedStartMs}ms yerine ${actualStartMs}ms noktasında başlıyor (boşluk veya çakışma var).`,
      `Omurga sürekliliğini onarmak için 'cuthol spine' komutlarını kullanın.`,
      clipId
    ),

  TRANSITION_TOO_LONG: (clipId: string, transMs: number, maxAllowedMs: number) =>
    createDiagnostic(
      "CUTHOL-G303",
      "G3_TIMING",
      "ERROR",
      `'${clipId}' çıkış geçişi (${transMs}ms), komşu kliplerin izin verdiği maksimum süreyi (${maxAllowedMs}ms) aşıyor.`,
      `Geçiş süresini ${maxAllowedMs}ms veya altına düşürün.`,
      clipId
    ),

  INVALID_PLAYBACK_RATE: (clipId: string, rate: number) =>
    createDiagnostic(
      "CUTHOL-G304",
      "G3_TIMING",
      "ERROR",
      `'${clipId}' klibi için verilen oynatma hızı (${rate}x) geçerli sınırların (0.1x .. 16.0x) dışında.`,
      `'--rate' değerini 0.1 ile 16.0 arasında belirleyin.`,
      clipId
    ),

  ENVELOPE_OUT_OF_RANGE: (ownerId: string, param: string, offsetMs: number, durationMs: number) =>
    createDiagnostic(
      "CUTHOL-G305",
      "G3_TIMING",
      "ERROR",
      `'${ownerId}' üzerindeki '${param}' anahtar kare noktası (${offsetMs}ms), öğe süresinin (0..${durationMs}ms) dışında.`,
      `Anahtar kare zamanlarını 0ms ile ${durationMs}ms aralığında tanımlayın.`,
      ownerId
    ),

  LANE_EXTENDS_PAST_SPINE: (cueId: string, cueEndMs: number, spineEndMs: number) =>
    createDiagnostic(
      "CUTHOL-G306",
      "G3_TIMING",
      "WARN",
      `'${cueId}' şerit öğesinin bitişi (${cueEndMs}ms), ana omurga süresini (${spineEndMs}ms) ${cueEndMs - spineEndMs}ms aşıyor (${spineEndMs}..${cueEndMs}ms aralığında omurga görüntüsü yok).`,
      `Omurgaya yeni klip ekleyin/uzatın veya '${cueId}' öğesini ${spineEndMs}ms sınırına kırpın.`,
      cueId
    ),

  // --- Gate 4: Stage Geometry, Safe Zones & Legibility (G4_STAGE) ---
  SAFE_ZONE_VIOLATION: (cueId: string, edge: string, overflowPx: number) =>
    createDiagnostic(
      "CUTHOL-G401",
      "G4_STAGE",
      "WARN",
      `'${cueId}' öğesi '${edge}' güvenli alan sınırını ${Math.round(overflowPx)}px aşıyor (EBU R95 / 9:16 UI marjı).`,
      `Öğenin konumunu merkeze yaklaştırın veya genişlik/yazı boyutunu küçültün.`,
      cueId
    ),

  CAPTION_READING_SPEED_HIGH: (cueId: string, cps: number, maxCps: number) =>
    createDiagnostic(
      "CUTHOL-G402",
      "G4_STAGE",
      "WARN",
      `'${cueId}' altyazısının okuma hızı (${cps.toFixed(1)} krk/sn), önerilen üst sınırı (${maxCps} krk/sn — Netflix Timed Text / TR uyarlaması) aşıyor.`,
      `Altyazı metnini iki parçaya bölün veya ekranda kalma süresini uzatın.`,
      cueId
    ),

  TEXT_OCCLUDED_BY_LAYER: (textCueId: string, occluderCueId: string) =>
    createDiagnostic(
      "CUTHOL-G403",
      "G4_STAGE",
      "WARN",
      `'${textCueId}' metin öğesi, daha yüksek z_index değerine sahip '${occluderCueId}' katmanı tarafından kapatılıyor.`,
      `Metin şeridinin 'z_index' değerini yükseltin veya üstteki katmanın konumunu kaydırın.`,
      textCueId
    ),

  SCENE_HOST_RECOMMENDED: (cueId: string, detectedFeatures: string[]) =>
    createDiagnostic(
      "CUTHOL-G406",
      "G4_STAGE",
      "WARN",
      `'${cueId}' kompozisyonu '${detectedFeatures.join(", ")}' içeriyor ancak 'overlay_alpha' (Mod A) modunda çalışıyor; bu efektler alttaki video piksellerini göremez.`,
      `Efektin alttaki video piksellerini işlemesi için '--mode scene_host' bayrağını açıkça belirtin.`,
      cueId
    ),

  // --- Gate 5: Audio Signal & Render Frame Sanity (G5_SIGNAL) ---
  TRUE_PEAK_CEILING_EXCEEDED: (itemId: string, peakDbtp: number, ceilingDbtp: number) =>
    createDiagnostic(
      "CUTHOL-G501",
      "G5_SIGNAL",
      "WARN",
      `'${itemId}' ses sinyalinin gerçek tepe noktası (${peakDbtp.toFixed(1)} dBTP), ITU-R BS.1770-4 tavanını (${ceilingDbtp.toFixed(1)} dBTP) aşıyor.`,
      `'cuthol mix normalize --target-lufs -14' çalıştırın veya klip kazancını ('gain_db') düşürün.`,
      itemId
    ),

  BLANK_FRAME_DETECTED: (timestampMs: number, lumaMean: number, lumaStd: number) =>
    createDiagnostic(
      "CUTHOL-G502",
      "G5_SIGNAL",
      "WARN",
      `${timestampMs}ms zaman damgasındaki örneklenen kare neredeyse tamamen karanlık/boş veya düz zemin renginde (luma ort=${lumaMean.toFixed(1)}, std=${lumaStd.toFixed(2)}).`,
      `'cuthol monitor frame --at ${timestampMs}ms' ile kareyi kontrol edin; kasıtlı kararma (fade) değilse kaynak aralığını düzeltin.`
    ),

  RENDER_BLANK_FRAMES_DETECTED: (
    events: Array<{ start_s: number; start_ms: number; frame_count: number; clip_id?: string }>
  ) => {
    const totalFrames = events.reduce((acc, e) => acc + e.frame_count, 0);
    const timeList = events
      .map((e) => `${e.start_s}s (${e.start_ms}ms${e.clip_id ? `, ${e.clip_id}` : ""})`)
      .join(", ");
    const firstMs = events[0]?.start_ms ?? 0;
    return createDiagnostic(
      "CUTHOL-G502",
      "G5_SIGNAL",
      "WARN",
      `Render çıktısında aktif omurga klibi sırasında ${events.length} noktada (${totalFrames} kare) düz/zemin renginde boş kare tespit edildi: ${timeList}.`,
      `'cuthol monitor frame --at ${firstMs}ms' ile kesim noktasını kontrol edin; kasıtlı kararma (fade) değilse kaynak klip aralığını veya geçiş sınırlarını düzeltin.`
    );
  },

  HYPERFRAMES_RENDER_FALLBACK: (compositionDir: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G503",
      "G5_SIGNAL",
      "WARN",
      `'${compositionDir}' HyperFrames kompozisyonu tarayıcıda render edilemediği için yedek kutu (drawbox fallback) çizicisine düştü: ${reason}`,
      `HyperFrames HTML/GSAP kodunu 'npx hyperframes check' ile kontrol edin veya tarayıcı (Chrome/Edge) erişimini doğrulayın.`,
      compositionDir
    ),

  DUCKING_WITHOUT_TRANSCRIPT: (clipIds: string[], mode: "skipped" | "acoustic_vad") =>
    createDiagnostic(
      "CUTHOL-G504",
      "G5_SIGNAL",
      "WARN",
      mode === "skipped"
        ? `Omurgadaki '${clipIds.join(", ")}' kliplerinde konuşma dökümü (transkript) bulunmadığı için ducking yalnızca transkriptli klipler ve 'ln_vo' seslendirmelerine göre uygulandı.`
        : `Omurgadaki '${clipIds.join(", ")}' kliplerinde konuşma dökümü (transkript) bulunmadığı için ducking sinyal tabanlı akustik enerji (VAD) üzerinden hesaplandı.`,
      `Kelime hassasiyetinde ducking için konuşma içeren kliplerde önce 'cuthol speech transcribe --handle <vid_XX>' çalıştırın.`
    ),

  OPAQUE_OVERLAY_LEAK: (cueId: string, opaqueRatio: number, cornerAlphaMax: number) =>
    createDiagnostic(
      "CUTHOL-G505",
      "G5_SIGNAL",
      "WARN",
      `'${cueId}' şeffaf (transparent) overlay kompozisyonunda arka plan sızıntısı tespit edildi (tam opak oran=%${(opaqueRatio * 100).toFixed(1)}, köşe alfa=${cornerAlphaMax}/255).`,
      `Kompozisyon HTML/CSS içinde 'body, #root { background: transparent; }' olduğundan ve '[data-cuthol-preview]' elemanının kalmadığından emin olun.`,
      cueId
    ),

  REVISION_MISMATCH: (expectedRev: number, actualRev: number) =>
    createDiagnostic(
      "CUTHOL-G109",
      "G1_SCHEMA",
      "ERROR",
      `Beklenen revizyon (r${expectedRev}) ile aktif sekans revizyonu (r${actualRev}) uyuşmuyor.`,
      `'cuthol brief --lens overview' veya 'cuthol workspace journal list' ile güncel revizyonu kontrol edip '--expect-rev ${actualRev}' kullanın.`
    ),

  UNKNOWN_FLAG: (flag: string, command: string, suggestionFix: string) =>
    createDiagnostic(
      "CUTHOL-G110",
      "G1_SCHEMA",
      "ERROR",
      `'${command}' komutunda bilinmeyen veya çakışan bayrak: '${flag}'.`,
      `Şu komutu kullanın: ${suggestionFix}`
    ),

  PROTECTED_TARGET: (targetIds: string[], operation: string) =>
    createDiagnostic(
      "CUTHOL-G111",
      "G1_SCHEMA",
      "ERROR",
      `'${operation}' işlemi kilitli/korumalı varlıkları ('${targetIds.join(", ")}') silecek veya değiştirecek.`,
      `Önce '--dry-run' ile planı inceleyin; gerçekten silmek/değiştirmek istiyorsanız '--allow-protected ${targetIds.join(",")}' bayrağını ekleyin.`
    ),
} as const;

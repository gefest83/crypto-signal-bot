import { Badge } from "@/components/ui/badge";
import type { RoundStatus } from "@/hooks/use-signal-console";
import {
  formatClock,
  formatClockWithSeconds,
  formatCountdown,
  formatPrice,
  formatSignedPct,
} from "@/lib/format";
import type { FeedStatus } from "@/lib/market/binance";
import { SYMBOL_META, type MarketSymbol } from "@/lib/market/types";
import {
  ENTRY_CUTOFF_MS,
  ENTRY_WINDOW_MS,
  MIN_CONFIDENCE,
  MIN_SCORE,
  type Phase,
  type SignalReadout,
} from "@/lib/strategy/engine";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  Loader2,
  Minus,
  Radio,
  ShieldAlert,
} from "lucide-react";

type SignalHeroProps = {
  symbol: MarketSymbol;
  status: RoundStatus;
  readout: SignalReadout | null;
  locked: SignalReadout | null;
  price: number | undefined;
  now: number;
  windowStart: number;
  windowEnd: number;
  feedStatus: FeedStatus;
  feedDetail: string;
};

type Tone = "up" | "down" | "neutral";

const PHASE_LABEL: Record<Phase, string> = {
  early: "РАННИЙ ВХОД",
  mid: "ВХОД УХОДИТ",
  late: "НАБЛЮДЕНИЕ",
};

const CARD_TONE: Record<Tone, string> = {
  up: "border-up/25 bg-[linear-gradient(145deg,var(--up-soft),transparent_62%)]",
  down: "border-down/25 bg-[linear-gradient(145deg,var(--down-soft),transparent_62%)]",
  neutral: "border-warn/25 bg-[linear-gradient(145deg,var(--warn-soft),transparent_62%)]",
};

function FeedPill({
  status,
  detail,
}: {
  status: FeedStatus;
  detail: string;
}) {
  const tone =
    status === "live"
      ? "text-up-ink"
      : status === "degraded"
        ? "text-warn-ink"
        : status === "offline"
          ? "text-down-ink"
          : "text-muted-foreground";
  const label =
    status === "live"
      ? "Поток Binance"
      : status === "degraded"
        ? "REST-режим"
        : status === "offline"
          ? "Нет связи"
          : "Подключение";

  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", tone)}>
      <span className="relative flex size-2">
        <span
          className={cn(
            "absolute inline-flex size-full rounded-full",
            status === "live" ? "animate-signal-pulse bg-up" : "bg-current",
          )}
        />
      </span>
      {label}
      {detail ? (
        <span className="hidden text-muted-foreground sm:inline">· {detail}</span>
      ) : null}
    </span>
  );
}

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "up" | "down";
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-sm tabular-nums",
          tone === "up" && "text-up-ink",
          tone === "down" && "text-down-ink",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function EntryWindow({
  windowStart,
  now,
  phase,
}: {
  windowStart: number;
  now: number;
  phase: Phase;
}) {
  const elapsed = Math.max(0, now - windowStart);
  const bestLeft = ENTRY_WINDOW_MS - elapsed;
  const pct = Math.min(100, (elapsed / ENTRY_WINDOW_MS) * 100);
  const over = phase !== "early";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          Окно лучшего входа
        </span>
        <span
          className={cn(
            "font-mono text-sm tabular-nums",
            over ? "text-warn-ink" : "text-foreground",
          )}
        >
          {over ? "закрыто" : `осталось ${formatCountdown(bestLeft)}`}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-1000 ease-linear",
            over ? "bg-warn" : "bg-primary",
          )}
          style={{ width: `${over ? 100 : pct}%` }}
        />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {phase === "early"
          ? "Контракт ещё не переоценён — это окно и есть весь перевес стратегии."
          : phase === "mid"
            ? `Поздний вход: шансы контракта уже выросли. Вход закроется через ${formatCountdown(
                Math.max(0, ENTRY_CUTOFF_MS - elapsed),
              )}.`
            : "Вход закрыт: цена контракта уже отражает движение. Ждём следующий раунд."}
      </p>
    </div>
  );
}

function DirectionGlyph({ direction }: { direction: Tone }) {
  const Icon = direction === "up" ? ArrowUp : direction === "down" ? ArrowDown : Minus;
  return (
    <span
      className={cn(
        "flex size-16 items-center justify-center rounded-2xl border sm:size-20",
        direction === "up" && "border-up/25 bg-up-soft text-up-ink",
        direction === "down" && "border-down/25 bg-down-soft text-down-ink",
        direction === "neutral" && "border-border bg-muted text-muted-foreground",
      )}
    >
      <Icon className="size-8 sm:size-10" strokeWidth={2.4} />
    </span>
  );
}

export function SignalHero({
  symbol,
  status,
  readout,
  locked,
  price,
  now,
  windowStart,
  windowEnd,
  feedStatus,
  feedDetail,
}: SignalHeroProps) {
  const meta = SYMBOL_META[symbol];
  const call = locked;
  const warming = !readout;
  const showCall = Boolean(call);
  const skipped = !call && !warming && status === "closed";
  const leaning: Tone = readout ? (readout.score >= 0 ? "up" : "down") : "neutral";
  const direction: Tone = showCall
    ? (call!.direction as Tone)
    : skipped
      ? "neutral"
      : leaning;
  const phase: Phase = (call ?? readout)?.phase ?? "early";
  const tone: Tone = skipped ? "neutral" : direction;
  const nextRound = Math.max(0, windowEnd - now);
  const shownConfidence = call
    ? call.effectiveConfidence
    : readout
      ? readout.effectiveConfidence
      : null;

  const headline = warming
    ? "Загружаю свечи"
    : showCall
      ? direction === "up"
        ? "UP"
        : "DOWN"
      : skipped
        ? "СКИП"
        : "—";

  const title = warming
    ? "Считаю рынок"
    : showCall
      ? direction === "up"
        ? "Прогноз роста на 5 минут"
        : "Прогноз падения на 5 минут"
      : skipped
        ? "Раунд пропущен осознанно"
        : `Сканирую раунд — склонность ${leaning === "up" ? "вверх" : "вниз"}`;

  const subtitle = warming
    ? "Первый расчёт появится через пару секунд."
    : showCall
      ? `Вызов зафиксирован в ${formatClockWithSeconds(
          call!.evaluatedAt,
        )} UTC и не меняется до конца раунда.`
      : skipped
        ? `Перевес ниже порога — отсутствие сделки тоже позиция. Следующий раунд через ${formatCountdown(
            nextRound,
          )}.`
        : `Перевес ${readout!.score.toFixed(2)} из порога ${MIN_SCORE.toFixed(2)} — ждём подтверждения факторами.`;

  return (
    <section className={cn("surface border", CARD_TONE[tone])}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-t-[inherit] border-b border-border/60 bg-card/40 px-5 py-3.5 sm:px-7">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-tight">{meta.asset}</span>
          <span className="text-xs text-muted-foreground">{meta.name}</span>
        </div>
        <span className="hidden text-border sm:inline">|</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          Раунд {formatClock(windowStart)} – {formatClock(windowEnd)} UTC
        </span>
        <div className="ms-auto flex items-center gap-3">
          <FeedPill status={feedStatus} detail={feedDetail} />
          <Badge
            variant="outline"
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-[10px] font-semibold tracking-wider",
              phase === "early"
                ? "border-up/30 bg-up-soft text-up-ink"
                : phase === "mid"
                  ? "border-warn/40 bg-warn-soft text-warn-ink"
                  : "border-border bg-muted text-muted-foreground",
            )}
          >
            {PHASE_LABEL[phase]}
          </Badge>
        </div>
      </div>

      <div className="grid gap-8 px-5 py-7 sm:px-7 sm:py-9 lg:grid-cols-[1.35fr_1fr] lg:items-center lg:gap-10 lg:py-11">
        <div className="flex flex-col gap-5">
          {warming ? (
            <div className="flex items-center gap-5">
              <span className="flex size-16 items-center justify-center rounded-2xl border border-border bg-card sm:size-20">
                <Loader2 className="size-7 animate-spin text-muted-foreground" />
              </span>
              <div>
                <p className="text-2xl font-semibold tracking-tight sm:text-3xl">
                  {title}
                </p>
                <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>
              </div>
            </div>
          ) : (
            <>
              <motion.div
                key={`${symbol}-${showCall ? call?.windowStart : "scan"}-${direction}`}
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.35, ease: "easeOut" }}
                className="flex items-center gap-5 sm:gap-7"
              >
                <div className="relative shrink-0">
                  {showCall ? (
                    <span
                      className={cn(
                        "absolute inset-0 -z-10 animate-signal-pulse rounded-full blur-2xl",
                        direction === "up" ? "bg-up/25" : "bg-down/25",
                      )}
                    />
                  ) : null}
                  <DirectionGlyph direction={direction} />
                </div>
                <div className="min-w-0">
                  <p
                    className={cn(
                      "font-mono text-[clamp(3.25rem,9vw,5.5rem)] leading-[0.92] font-semibold tracking-tight",
                      !showCall && "opacity-45",
                      direction === "up" && "text-up",
                      direction === "down" && "text-down",
                      direction === "neutral" && "text-muted-foreground",
                    )}
                  >
                    {headline}
                  </p>
                  <p className="mt-2 text-sm font-medium sm:text-base">{title}</p>
                  <p className="mt-1.5 max-w-md text-xs leading-relaxed text-muted-foreground sm:text-sm">
                    {subtitle}
                  </p>
                </div>
              </motion.div>

              <EntryWindow windowStart={windowStart} now={now} phase={phase} />

              <ul className="flex flex-col gap-1.5 border-t border-border/60 pt-4">
                {(call?.notes ?? readout!.notes).map((note) => (
                  <li
                    key={note}
                    className="flex gap-2 text-xs leading-relaxed text-muted-foreground"
                  >
                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                    {note}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="flex flex-col gap-5 rounded-2xl border border-border/70 bg-card/70 p-5 sm:p-6">
          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                Уверенность
              </span>
              {call && call.confidence !== call.effectiveConfidence ? (
                <span className="font-mono text-[11px] text-warn-ink">
                  до затухания {call.confidence}%
                </span>
              ) : null}
            </div>
            <div className="mt-1 flex items-end gap-2">
              <span className="font-mono text-5xl leading-none font-semibold tabular-nums sm:text-6xl">
                {shownConfidence === null ? "—" : shownConfidence}
                <span className="text-2xl sm:text-3xl">%</span>
              </span>
              {!showCall && readout ? (
                <span className="pb-1 font-mono text-[11px] text-warn-ink">
                  порог {MIN_CONFIDENCE}%
                </span>
              ) : null}
            </div>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-500",
                  direction === "up"
                    ? "bg-up"
                    : direction === "down"
                      ? "bg-down"
                      : "bg-muted-foreground/40",
                )}
                style={{ width: `${shownConfidence ?? 0}%` }}
              />
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-background/60 px-4 py-3">
            <ShieldAlert className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                Макс. цена входа
              </p>
              <p className="font-mono text-lg tabular-nums">
                {call ? call.maxEntryPrice.toFixed(2) : "—"}
                {call ? (
                  <span className="ms-2 text-xs text-muted-foreground">
                    оценка вероятности {Math.round(call.estimatedProbability * 100)}% − 6 п.п.
                  </span>
                ) : null}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Metric label="Цена сейчас" value={formatPrice(price ?? readout?.price)} />
            <Metric
              label="Открытие раунда"
              value={formatPrice(readout?.referencePrice)}
            />
            <Metric
              label="Отрыв раунда"
              value={readout ? formatSignedPct(readout.roundPnlPct) : "—"}
              tone={
                readout ? (readout.roundPnlPct >= 0 ? "up" : "down") : "default"
              }
            />
            <Metric
              label="RSI(14) · ATR"
              value={
                readout
                  ? `${readout.rsi.toFixed(0)} · ${(readout.atrPct * 100).toFixed(2)}%`
                  : "—"
              }
            />
          </div>

          <div className="flex items-center gap-2 border-t border-border/60 pt-3 text-[11px] text-muted-foreground">
            <Radio className="size-3.5 shrink-0" />
            {showCall
              ? "Вызов записан в журнал и будет оценён по закрытию раунда"
              : "Движок пересчитывает перевес каждую секунду"}
          </div>
        </div>
      </div>
    </section>
  );
}

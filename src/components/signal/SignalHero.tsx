import { Badge } from "@/components/ui/badge";
import type { RoundStatus } from "@/hooks/use-signal-console";
import type { PmAsset, PmRound } from "@/convex/polymarket";
import {
  formatClock,
  formatClockWithSeconds,
  formatCountdown,
  formatPrice,
  formatSignedPct,
} from "@/lib/format";
import type { FeedStatus } from "@/lib/market/binance";
import type { SignalReadout } from "@/lib/strategy/engine";
import {
  ENTRY_END_MS,
  ENTRY_START_MS,
  FAVORITE_MIN_ASK,
  takerFee,
  type EntryReadout,
} from "@/lib/strategy/entry";
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
  asset: PmAsset;
  status: RoundStatus;
  entry: EntryReadout | null;
  lock: EntryReadout | null;
  round: PmRound | null;
  engine: SignalReadout | null;
  spot: number | undefined;
  now: number;
  windowStart: number;
  windowEnd: number;
  feedStatus: FeedStatus;
  feedDetail: string;
};

type Tone = "up" | "down" | "neutral";

const ASSET_LABEL: Record<PmAsset, { asset: string; name: string }> = {
  btc: { asset: "BTC", name: "Bitcoin" },
  eth: { asset: "ETH", name: "Ethereum" },
};

const CARD_TONE: Record<Tone, string> = {
  up: "border-up/25 bg-[linear-gradient(145deg,var(--up-soft),transparent_62%)]",
  down: "border-down/25 bg-[linear-gradient(145deg,var(--down-soft),transparent_62%)]",
  neutral: "border-warn/25 bg-[linear-gradient(145deg,var(--warn-soft),transparent_62%)]",
};

function FeedPill({ status, detail }: { status: FeedStatus; detail: string }) {
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
      ? "Котировки Binance"
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

function EntryWindow({ windowStart, now }: { windowStart: number; now: number }) {
  const elapsed = Math.max(0, now - windowStart);
  const waiting = elapsed < ENTRY_START_MS;
  const over = elapsed >= ENTRY_END_MS;
  const span = Math.max(1, ENTRY_END_MS - ENTRY_START_MS);
  const pct = Math.max(0, Math.min(100, ((elapsed - ENTRY_START_MS) / span) * 100));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          Окно входа
        </span>
        <span
          className={cn(
            "font-mono text-sm tabular-nums",
            waiting || over ? "text-warn-ink" : "text-foreground",
          )}
        >
          {waiting
            ? `открытие через ${formatCountdown(Math.max(0, windowStart + ENTRY_START_MS - now))}`
            : over
              ? "закрыто"
              : `осталось ${formatCountdown(Math.max(0, windowStart + ENTRY_END_MS - now))}`}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-1000 ease-linear",
            waiting || over ? "bg-warn" : "bg-primary",
          )}
          style={{ width: `${waiting ? 0 : over ? 100 : pct}%` }}
        />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {waiting
          ? `Идёт первый квартал раунда. До ${Math.round(
              ENTRY_START_MS / 1000,
            )}-й секунды в стакане только тики — вход возможен только после закрытия.`
          : over
            ? "Вход закрыт: контракт уже отражает движение. Ждём следующий раунд."
            : "Первый квартал закрыт — смотрим реальный стакан и входим только в явного фаворита."}
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
  asset,
  status,
  entry,
  lock,
  round,
  engine,
  spot,
  now,
  windowStart,
  windowEnd,
  feedStatus,
  feedDetail,
}: SignalHeroProps) {
  const meta = ASSET_LABEL[asset];
  const call = lock;
  const warming = !entry;
  const showCall = Boolean(call);
  const skipped = !call && !warming && status === "closed";

  const direction: Tone = showCall
    ? ((call!.direction as "up" | "down") as Tone)
    : skipped || warming
      ? "neutral"
      : entry?.favourite === "down"
        ? "down"
        : entry?.favourite === "up"
          ? "up"
          : "neutral";
  const tone: Tone = skipped ? "neutral" : direction;
  const nextRound = Math.max(0, windowEnd - now);
  const ask = call?.ask ?? entry?.ask ?? null;
  const bid = call?.bid ?? entry?.bid ?? null;
  const limit = call?.limitPrice ?? entry?.limitPrice ?? null;
  const spread = ask !== null && bid !== null ? Math.round((ask - bid) * 100) / 100 : null;
  const fee = ask === null ? null : takerFee(ask);

  const headline = warming
    ? "—"
    : showCall
      ? direction === "up"
        ? "UP"
        : "DOWN"
      : skipped
        ? "СКИП"
        : entry?.eligible
          ? "ГОТОВ"
          : "ЖДЁМ";

  const title = warming
    ? "Загружаю рынок Polymarket"
    : showCall
      ? direction === "up"
        ? "Покупка UP по реальному ask"
        : "Покупка DOWN по реальному ask"
      : skipped
        ? "Раунд пропущен осознанно"
        : `Фаворит рынка: ${entry?.favourite ? entry.favourite.toUpperCase() : "—"}`;

  const subtitle = warming
    ? "Первый расчёт появится через пару секунд."
    : showCall
      ? `Вызов зафиксирован по настоящей цене ${ask?.toFixed(2)} и не меняется до конца раунда. Вход — лимитной заявкой, иначе комиссия съедает перевес.`
      : skipped
        ? `Перевеса не было. Следующий раунд через ${formatCountdown(nextRound)}.`
        : entry?.reason;

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
              showCall
                ? "border-up/30 bg-up-soft text-up-ink"
                : "border-border bg-muted text-muted-foreground",
            )}
          >
            {showCall ? "ВЫЗОВ ЗАФИКСИРОВАН" : "Polymarket · реальная цена"}
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
                <p className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</p>
                <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>
              </div>
            </div>
          ) : (
            <>
              <motion.div
                key={`${asset}-${showCall ? call?.start : "scan"}-${direction}`}
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

              <EntryWindow windowStart={windowStart} now={now} />

              {entry ? (
                <ul className="flex flex-col gap-1.5 border-t border-border/60 pt-4">
                  <li className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                    {round?.title ?? "Рынок 15 минут Up/Down"}
                  </li>
                  <li className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                    {entry.reason}
                  </li>
                </ul>
              ) : null}
            </>
          )}
        </div>

        <div className="flex flex-col gap-5 rounded-2xl border border-border/70 bg-card/70 p-5 sm:p-6">
          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                Реальный ask
              </span>
              {spread !== null ? (
                <span className="font-mono text-[11px] text-muted-foreground">
                  спред {spread.toFixed(2)}
                </span>
              ) : null}
            </div>
            {round && round.priceSource !== "book" ? (
              <p
                className={cn(
                  "mt-1 text-[11px]",
                  round.priceSource === "stale" ? "text-warn-ink" : "text-muted-foreground",
                )}
              >
                {round.priceSource === "stale"
                  ? "Стакан пуст — цена отстаёт, вход не публикуется"
                  : "Нет котировок"}
              </p>
            ) : null}
            <div className="mt-1 flex items-end gap-2">
              <span className="font-mono text-5xl leading-none font-semibold tabular-nums sm:text-6xl">
                {ask === null ? "—" : ask.toFixed(2)}
              </span>
              <span className="pb-1 font-mono text-[11px] text-muted-foreground">
                порог {FAVORITE_MIN_ASK.toFixed(2)} · из стакана
              </span>
            </div>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-500",
                  ask === null
                    ? "bg-muted-foreground/40"
                    : ask >= FAVORITE_MIN_ASK
                      ? "bg-up"
                      : "bg-muted-foreground/40",
                )}
                style={{ width: `${ask === null ? 0 : ask * 100}%` }}
              />
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-background/60 px-4 py-3">
            <ShieldAlert className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                Цена лимита · мейкер
              </p>
              <p className="font-mono text-lg tabular-nums">
                {limit === null ? "—" : limit.toFixed(2)}
                <span className="ms-2 text-xs text-muted-foreground">
                  стакан {bid === null ? "—" : bid.toFixed(2)} /{" "}
                  {ask?.toFixed(2) ?? "—"} · комиссии нет
                </span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-xl border border-warn/30 bg-warn-soft/40 px-4 py-3">
            <ShieldAlert className="size-4 shrink-0 text-warn-ink" />
            <div className="min-w-0">
              <p className="text-[11px] font-medium tracking-wider text-warn-ink uppercase">
                Если пересечь спред тейкером
              </p>
              <p className="font-mono text-lg tabular-nums">
                {ask === null ? "—" : ask.toFixed(2)}
                <span className="ms-2 text-xs text-muted-foreground">
                  комиссия 7%×(1−цена) = {fee === null ? "—" : `${(fee * 100).toFixed(2)}%`} от
                  ставки — весь перевес съедается
                </span>
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Metric label="Спот сейчас" value={formatPrice(spot ?? engine?.price)} />
            <Metric
              label="Отрыв раунда"
              value={engine ? formatSignedPct(engine.roundPnlPct) : "—"}
              tone={engine ? (engine.roundPnlPct >= 0 ? "up" : "down") : "default"}
            />
            <Metric
              label="Свечной движок"
              value={engine ? engine.direction.toUpperCase() : "—"}
              tone={
                engine
                  ? engine.direction === "up"
                    ? "up"
                    : engine.direction === "down"
                      ? "down"
                      : "default"
                  : "default"
              }
            />
            <Metric
              label="RSI(14) · ATR"
              value={engine ? `${engine.rsi.toFixed(0)} · ${(engine.atrPct * 100).toFixed(2)}%` : "—"}
            />
          </div>

          <div className="flex items-center gap-2 border-t border-border/60 pt-3 text-[11px] text-muted-foreground">
            <Radio className="size-3.5 shrink-0" />
            {showCall
              ? "Вызов записан в журнал по реальной цене и будет оценён резолвом Polymarket"
              : "Сткан перечитывается каждые 5 секунд"}
          </div>
        </div>
      </div>
    </section>
  );
}

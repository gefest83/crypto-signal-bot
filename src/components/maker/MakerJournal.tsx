import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MARKET_PROFILES, PM_LIMITS } from "@/lib/strategy/maker-exit";
import { Info } from "lucide-react";

/**
 * Why there is no trade journal here any more.
 *
 * This card used to list closed trades, graded by the old session hook, which
 * credited a fill the moment the ask TOUCHED our limit. That is the generous
 * reading and it was wrong in an expensive way: a resting order last in a
 * queue at 0.50 is not filled by a price that arrives at 0.50, and the
 * backtest assumed otherwise everywhere it counted money.
 *
 * The four-market paper panel above replaced it. It keeps a journal, but every
 * entry there required the price to penetrate the limit by a tick before the
 * fill counted, and the commission is charged on entry AND exit. Showing the
 * old journal next to the new numbers would put two contradictory ledgers on
 * one screen, and the more flattering one is exactly the one that would get
 * believed.
 */
export function MakerJournal() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Info className="size-4" />
          Журнал ведётся в панели выше
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Раньше здесь был список закрытых сделок. Он удалён, потому что засчитывал набитие в
          момент касания лимита — то есть приписывал виртуальной заявке наполнение, которого в
          реальной очереди может и не быть. Сейчас журнал ведётся в панели виртуальных сделок,
          где набитие требует, чтобы цена прошла уровень на тик глубже, а комиссия платится дважды.
        </p>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Панель не убирает статистику, а показывает её по каждому рынку отдельно: 5m и 15m ведут
          себя по-разному, и среднее между ними не описывает ни один из них. Общий P&L считается
          отдельно и показан рядом с частями.
        </p>
        <dl className="mt-4 grid gap-2 sm:grid-cols-2">
          {([5, 15] as const).map((interval) => {
            const profile = MARKET_PROFILES[interval];
            return (
              <div key={interval} className="rounded-lg border border-border/60 bg-card/40 px-3 py-2">
                <p className="text-[11px] font-medium">
                  {profile.label} · лимит {PM_LIMITS[interval].toFixed(2)}
                </p>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  возврат {(profile.exitRate * 100).toFixed(0)}% · удержавшиеся{" "}
                  {(profile.survivorWinRate * 100).toFixed(0)}% · обнуление при{" "}
                  {(profile.breakEvenSlippage * 100).toFixed(0)}ц
                </p>
              </div>
            );
          })}
        </dl>
      </CardContent>
    </Card>
  );
}

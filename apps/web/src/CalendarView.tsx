import { useMemo, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import listPlugin from "@fullcalendar/list";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  categoryIndex,
  recordDate,
  todayIn,
  type Dataset,
  type WorkRecord,
  type Locale,
} from "../../../packages/core/src/index";
import { getLocal, setLocal } from "./api";
import { en, ko } from "./i18n";
import { colorFor } from "./colors";
export default function CalendarView({
  dataset: d,
  rows,
  locale,
  onSelect,
  onMove,
  canEdit,
}: {
  dataset: Dataset;
  rows: WorkRecord[];
  locale: Locale;
  onSelect: (r: WorkRecord) => void;
  onMove: (r: WorkRecord, date: string) => void;
  canEdit: boolean;
}) {
  const t = locale === "ko" ? ko : en;
  const calendar = useRef<FullCalendar>(null);
  const [view, setView] = useState<"dayGridMonth" | "listMonth">(() =>
    getLocal("sw.calendar-view", "dayGridMonth"),
  );
  const [title, setTitle] = useState("");
  const [jump, setJump] = useState(false);
  const events = useMemo(
    () =>
      rows.flatMap((r) => {
        const date = recordDate(d, r);
        return date
          ? [
              {
                id: r.id,
                title: String(r.values[d.mapping.title] ?? ""),
                start: date,
                allDay: true,
                classNames: [
                  `category-${colorFor(d, r.values[d.mapping.category ?? ""])}`,
                ],
              },
            ]
          : [];
      }),
    [d, rows],
  );
  if (!d.mapping.date)
    return (
      <div className="empty-state">
        <p>{t.noDate}</p>
      </div>
    );
  return (
    <section className="calendar-panel" aria-label={t.calendar}>
      <div className="calendar-toolbar">
        <div className="month-navigation">
          <button
            aria-label={t.previous}
            className="icon-button"
            onClick={() => calendar.current?.getApi().prev()}
          >
            <ChevronLeft size={20} />
          </button>
          <button
            className="month-title"
            onClick={() => setJump(!jump)}
            aria-label={t.chooseMonth}
          >
            {title}
          </button>
          <button
            aria-label={t.next}
            className="icon-button"
            onClick={() => calendar.current?.getApi().next()}
          >
            <ChevronRight size={20} />
          </button>
        </div>
        <div className="calendar-options">
          <button onClick={() => calendar.current?.getApi().today()}>
            {t.today}
          </button>
          <div className="segmented">
            {(["dayGridMonth", "listMonth"] as const).map((v) => (
              <button
                key={v}
                aria-pressed={view === v}
                onClick={() => {
                  setView(v);
                  setLocal("sw.calendar-view", v);
                  calendar.current?.getApi().changeView(v);
                }}
              >
                {v === "dayGridMonth" ? t.month : t.list}
              </button>
            ))}
          </div>
        </div>
      </div>
      {jump && (
        <label className="month-jump">
          {t.month}
          <input
            type="month"
            onChange={(e) => {
              if (e.target.value) {
                calendar.current?.getApi().gotoDate(`${e.target.value}-01`);
                setJump(false);
              }
            }}
          />
        </label>
      )}
      <FullCalendar
        ref={calendar}
        plugins={[dayGridPlugin, interactionPlugin, listPlugin]}
        initialView={view}
        initialDate={todayIn(d.timeZone)}
        headerToolbar={false}
        height="auto"
        locale={locale === "ko" ? "ko" : "en"}
        firstDay={d.weekStartsOn}
        fixedWeekCount={false}
        dayMaxEvents={2}
        dayCellContent={(arg) => String(arg.date.getDate())}
        moreLinkText={(n) => `+${n}`}
        events={events}
        editable={canEdit}
        eventDurationEditable={false}
        datesSet={(arg) =>
          setTitle(
            new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
              year: "numeric",
              month: "long",
            }).format(arg.view.currentStart),
          )
        }
        eventClick={(arg) => {
          const r = d.records.find((r) => r.id === arg.event.id);
          if (r) onSelect(r);
        }}
        eventDrop={(arg) => {
          const r = d.records.find((r) => r.id === arg.event.id),
            date = arg.event.startStr.slice(0, 10);
          arg.revert();
          if (r) onMove(r, date);
        }}
        eventContent={(arg) => (
          <span className="event-title">{arg.event.title}</span>
        )}
        moreLinkClick="popover"
        noEventsContent={t.noRows}
      />
      <p className="calendar-footnote">
        {rows.filter((r) => !recordDate(d, r)).length} {t.undated}
      </p>
    </section>
  );
}

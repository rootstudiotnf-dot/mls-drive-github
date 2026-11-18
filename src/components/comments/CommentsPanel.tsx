"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createComment, deleteComment, editComment, resolveComment, searchMentionable } from "@/app/actions/comments";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { Textarea } from "@/components/ui/Textarea";
import { cn } from "@/lib/cn";
import {
  buildThreads,
  formatTimecode,
  MAX_COMMENT_LENGTH,
  parseTimecode,
  type CommentItem,
  type CommentsData,
} from "@/lib/comments/types";

type Filter = "todos" | "pendientes" | "resueltos";

const when = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Atlantic/Canary" });

/**
 * Panel de comentarios con marca de tiempo. Todo el texto se pinta como TEXTO (React lo escapa; nunca HTML).
 * Escribir toma el tiempo actual del vídeo (editable) y lo pone en pausa; pulsar un comentario salta a su instante.
 * Las acciones solo se OFRECEN según permisos; el servidor las vuelve a comprobar una a una.
 */
export function CommentsPanel({
  assetId,
  data,
  activeId,
  getTimeMs,
  pause,
  seekMs,
  onChanged,
  timed = true,
}: {
  /** false = fotos: sin marca de tiempo ni pausa del reproductor */
  timed?: boolean;
  assetId: string;
  data: CommentsData;
  activeId: string | null;
  getTimeMs: () => number;
  pause: () => void;
  seekMs: (ms: number) => void;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("todos");
  const [body, setBody] = useState("");
  const [time, setTime] = useState("");
  const [timeEdited, setTimeEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [mentions, setMentions] = useState<{ id: string; name: string }[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const activeRef = useRef<HTMLLIElement | null>(null);

  const threads = useMemo(() => {
    const all = buildThreads(data.comments);
    return all.filter((t) => (filter === "pendientes" ? !t.resolved : filter === "resueltos" ? t.resolved : true));
  }, [data.comments, filter]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [activeId]);

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>, after?: () => void) =>
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) return setError(res.message ?? "No se pudo completar la acción.");
      setError(null);
      after?.();
      onChanged();
    });

  const submit = () => {
    const parsed = !timed || time.trim() === "" ? null : parseTimecode(time);
    if (timed && time.trim() !== "" && parsed === null) return setError("La marca de tiempo no es válida (usa m:ss).");
    run(
      () => createComment({ assetId, body, timecodeMs: parsed, mentions: activeMentions(body, mentions) }),
      () => {
        setMentions([]);
        setBody("");
        setTime("");
        setTimeEdited(false);
      },
    );
  };

  const Item = ({ item, reply }: { item: CommentItem; reply?: boolean }) => (
    <div className={cn(reply && "mt-3 border-l border-line pl-3")}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-text-3">
        {!reply && item.timecodeMs !== null ? (
          <button type="button" onClick={() => seekMs(item.timecodeMs as number)} className="rounded-control font-medium text-text tabular-nums underline-offset-2 hover:underline" aria-label={`Ir a ${formatTimecode(item.timecodeMs)}`}>
            {formatTimecode(item.timecodeMs)}
          </button>
        ) : null}
        <span className="font-medium text-text-2">{item.authorName}</span>
        {item.external ? <span className="rounded-pill border border-line px-2 text-text-2">Externo</span> : null}
        <time dateTime={item.createdAt}>{when.format(new Date(item.createdAt))}</time>
        {item.editedAt ? <span>(editado)</span> : null}
        {!reply && item.resolved ? <span className="rounded-pill border border-line px-2 text-text-2">Resuelto</span> : null}
      </div>
      {editing === item.id ? (
        <div className="mt-2 flex flex-col gap-2">
          <Textarea aria-label="Editar comentario" value={draft} maxLength={MAX_COMMENT_LENGTH} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" disabled={pending || draft.trim().length === 0} onClick={() => run(() => editComment(item.id, draft), () => setEditing(null))}>
              Guardar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-1 text-body break-words whitespace-pre-wrap text-text">{highlightMentions(item.body, item.mentions)}</p>
      )}
      <div className="mt-1.5 flex flex-wrap gap-x-3 text-caption text-text-3">
        {!reply && data.canComment ? (
          <button type="button" className="rounded-control hover:text-text" onClick={() => setReplyTo(replyTo === item.id ? null : item.id)}>
            Responder
          </button>
        ) : null}
        {item.mine ? (
          <button type="button" className="rounded-control hover:text-text" onClick={() => { setEditing(item.id); setDraft(item.body); }}>
            Editar
          </button>
        ) : null}
        {item.mine || data.canModerate ? (
          <button type="button" className="rounded-control hover:text-text" onClick={() => run(() => deleteComment(item.id))}>
            Borrar
          </button>
        ) : null}
        {!reply && (data.canModerate || item.mine) ? (
          <button type="button" className="rounded-control hover:text-text" onClick={() => run(() => resolveComment(item.id, !item.resolved))}>
            {item.resolved ? "Reabrir" : "Resolver"}
          </button>
        ) : null}
      </div>
    </div>
  );

  return (
    <section className="flex min-h-0 flex-col gap-4" aria-label="Comentarios">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-heading text-text">Comentarios · {data.comments.length}</h2>
        <div className="flex gap-1.5" role="group" aria-label="Filtrar comentarios">
          {(["todos", "pendientes", "resueltos"] as const).map((f) => (
            <Chip key={f} selected={filter === f} onClick={() => setFilter(f)}>
              {f === "todos" ? "Todos" : f === "pendientes" ? "Pendientes" : "Resueltos"}
            </Chip>
          ))}
        </div>
      </div>

      {error ? <Notice variant="error">{error}</Notice> : null}

      {data.canComment ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <MentionField
            assetId={assetId}
            label="Escribe un comentario"
            placeholder="Escribe un comentario… (@ para mencionar)"
            value={body}
            onChange={setBody}
            onPick={(person) => setMentions((m) => (m.some((x) => x.id === person.id) ? m : [...m, person]))}
            onFocus={() => {
              if (!timed) return;
              pause(); // el vídeo se pausa mientras se escribe, y se toma el instante actual
              if (!timeEdited) setTime(formatTimecode(getTimeMs()));
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            {timed ? <label className="flex items-center gap-2 text-caption text-text-3">
              En
              <input
                aria-label="Marca de tiempo (m:ss)"
                value={time}
                placeholder="m:ss"
                inputMode="numeric"
                onChange={(e) => {
                  setTime(e.target.value);
                  setTimeEdited(true);
                }}
                className="h-8 w-20 rounded-control border border-line bg-surface px-2 text-label text-text tabular-nums hover:border-line-hover focus-visible:border-line-hover"
              />
            </label> : null}
            <Button type="submit" size="sm" className="ml-auto" disabled={pending || body.trim().length === 0}>
              Comentar
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-caption text-text-3">Puedes leer los comentarios. No tienes permiso para escribir.</p>
      )}

      {threads.length === 0 ? (
        <EmptyState title={filter === "todos" ? "Aún no hay comentarios" : "No hay comentarios con este filtro"} description={data.canComment ? (timed ? "Escribe el primero: se anclará al instante del vídeo." : "Escribe el primero.") : undefined} />
      ) : (
        <ul className="flex min-h-0 flex-col divide-y divide-line overflow-y-auto rounded-card border border-line bg-surface">
          {threads.map((thread) => (
            <li
              key={thread.id}
              ref={thread.id === activeId ? activeRef : undefined}
              className={cn("px-4 py-3.5 transition-colors duration-150 ease-ui", thread.id === activeId && "bg-active", thread.resolved && "opacity-70")}
            >
              <Item item={thread} />
              {thread.replies.map((r) => (
                <Item key={r.id} item={r} reply />
              ))}
              {replyTo === thread.id ? (
                <ReplyForm
                  disabled={pending}
                  onCancel={() => setReplyTo(null)}
                  assetId={assetId}
                  onSend={(text, picked) => run(() => createComment({ assetId, body: text, timecodeMs: null, parentId: thread.id, mentions: activeMentions(text, picked) }), () => setReplyTo(null))}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReplyForm({ assetId, disabled, onSend, onCancel }: { assetId: string; disabled: boolean; onSend: (text: string, picked: { id: string; name: string }[]) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<{ id: string; name: string }[]>([]);
  return (
    <form
      className="mt-3 flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSend(text, picked);
      }}
    >
      <MentionField assetId={assetId} label="Escribe una respuesta" value={text} onChange={setText} onPick={(p) => setPicked((m) => (m.some((x) => x.id === p.id) ? m : [...m, p]))} autoFocus />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={disabled || text.trim().length === 0}>
          Responder
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

/** Menciones que siguen en el texto (si se borró «@Nombre», ya no se menciona a esa persona). */
function activeMentions(text: string, picked: { id: string; name: string }[]): string[] {
  return picked.filter((p) => text.includes("@" + p.name)).map((p) => p.id);
}

/** Pinta «@Nombre» resaltado. Todo es TEXTO de React (escapado): nunca HTML. */
function highlightMentions(body: string, mentions: { id: string; name: string }[]) {
  if (mentions.length === 0) return body;
  const names = mentions.map((m) => "@" + m.name).sort((a, b) => b.length - a.length);
  const parts: (string | { mention: string })[] = [];
  let rest = body;
  while (rest.length > 0) {
    let at = -1;
    let hit = "";
    for (const n of names) {
      const i = rest.indexOf(n);
      if (i >= 0 && (at < 0 || i < at)) {
        at = i;
        hit = n;
      }
    }
    if (at < 0) {
      parts.push(rest);
      break;
    }
    if (at > 0) parts.push(rest.slice(0, at));
    parts.push({ mention: hit });
    rest = rest.slice(at + hit.length);
  }
  return parts.map((p, i) => (typeof p === "string" ? p : <span key={i} className="rounded-control bg-active px-1 font-medium text-text">{p.mention}</span>));
}

const MENTION_AT_END = new RegExp("(?:^|\\s)@([^\\s@]{0,30})$");
const MENTION_REPLACE = new RegExp("(^|\\s)@[^\\s@]{0,30}$");

/** Textarea con autocompletado de @menciones: solo se ofrecen personas con acceso al archivo (lo decide el servidor). */
function MentionField({ assetId, label, placeholder, value, onChange, onPick, onFocus, autoFocus }: { assetId: string; label: string; placeholder?: string; value: string; onChange: (v: string) => void; onPick: (p: { id: string; name: string }) => void; onFocus?: () => void; autoFocus?: boolean }) {
  const [options, setOptions] = useState<{ id: string; name: string }[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const request = useRef(0);

  const handle = (text: string, caret: number) => {
    onChange(text);
    const match = MENTION_AT_END.exec(text.slice(0, caret));
    if (!match) {
      setQuery(null);
      setOptions([]);
      return;
    }
    const q = match[1] ?? "";
    setQuery(q);
    const mine = ++request.current;
    void searchMentionable(assetId, q).then((res) => {
      if (mine === request.current && res.ok && res.data) setOptions(res.data);
    });
  };

  const pick = (person: { id: string; name: string }) => {
    onChange(value.replace(MENTION_REPLACE, (_m, lead: string) => lead + "@" + person.name + " "));
    onPick(person);
    setQuery(null);
    setOptions([]);
  };

  return (
    <div className="relative">
      <Textarea aria-label={label} placeholder={placeholder} value={value} maxLength={MAX_COMMENT_LENGTH} autoFocus={autoFocus} onFocus={onFocus} onChange={(e) => handle(e.target.value, e.target.selectionStart)} />
      {query !== null && options.length > 0 ? (
        <ul role="listbox" aria-label="Personas a las que mencionar" className="absolute z-20 mt-1 w-64 overflow-hidden rounded-card border border-line-hover bg-surface">
          {options.map((o) => (
            <li key={o.id} role="option" aria-selected="false">
              <button type="button" onClick={() => pick(o)} className="block w-full px-3 py-2 text-left text-label text-text hover:bg-hover">
                {o.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

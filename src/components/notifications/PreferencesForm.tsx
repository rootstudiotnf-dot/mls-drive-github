"use client";

import { useState, useTransition } from "react";
import { savePreference } from "@/app/actions/notifications";
import { Notice } from "@/components/ui/Notice";
import { Select } from "@/components/ui/Select";
import { EVENTS, EVENT_LABEL, type Channel, type Frequency, type NotificationEvent, type Preference } from "@/lib/notifications/events";

/** Preferencias de correo por tipo de aviso. Se guardan al cambiar; la bandeja de la campana no se apaga. */
export function PreferencesForm({ initial }: { initial: Record<NotificationEvent, Preference> }) {
  const [prefs, setPrefs] = useState(initial);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const change = (event: NotificationEvent, patch: Partial<Preference>) => {
    const next = { ...prefs[event], ...patch };
    const before = prefs;
    setPrefs({ ...prefs, [event]: next });
    startTransition(async () => {
      const res = await savePreference({ event, channel: next.channel, frequency: next.frequency });
      if (!res.ok) setPrefs(before);
      setMessage({ ok: res.ok, text: res.ok ? "Guardado." : (res.message ?? "No se pudo guardar.") });
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <ul className="divide-y divide-line rounded-card border border-line bg-surface" aria-busy={pending}>
        {EVENTS.map((event) => (
          <li key={event} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 sm:max-w-md">
              <p className="text-body font-medium text-text">{EVENT_LABEL[event].label}</p>
              <p className="text-label text-text-2">{EVENT_LABEL[event].hint}</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Select
                aria-label={`${EVENT_LABEL[event].label}: canal`}
                value={prefs[event].channel}
                onChange={(e) => change(event, { channel: e.target.value as Channel })}
                options={[{ value: "email", label: "Correo" }, { value: "off", label: "Solo en la plataforma" }]}
              />
              <Select
                aria-label={`${EVENT_LABEL[event].label}: frecuencia`}
                value={prefs[event].frequency}
                disabled={prefs[event].channel === "off"}
                onChange={(e) => change(event, { frequency: e.target.value as Frequency })}
                options={[{ value: "instant", label: "Al momento" }, { value: "daily", label: "Resumen diario" }]}
              />
            </div>
          </li>
        ))}
      </ul>
      <div aria-live="polite">{message ? <Notice variant={message.ok ? "success" : "error"}>{message.text}</Notice> : null}</div>
    </div>
  );
}

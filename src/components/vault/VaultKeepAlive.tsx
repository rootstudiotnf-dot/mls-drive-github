"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { touchVault } from "@/app/actions/vault";

/**
 * Mientras la persona USA el Vault (ratón, teclado, toque en los últimos 3 minutos) renueva la cookie de
 * desbloqueo cada 3 minutos. Sin actividad no renueva: a los 15 minutos el Vault vuelve a pedir el desbloqueo.
 * Si la renovación se deniega (caducó, revocaron el acceso…), recarga la página y el servidor decide qué mostrar.
 */
export function VaultKeepAlive() {
  const router = useRouter();
  const last = useRef(0);

  useEffect(() => {
    last.current = Date.now();
    const mark = () => {
      last.current = Date.now();
    };
    const events = ["pointerdown", "keydown", "touchstart", "scroll"] as const;
    for (const e of events) window.addEventListener(e, mark, { passive: true });
    const timer = setInterval(() => {
      if (Date.now() - last.current > 3 * 60_000) return;
      void touchVault().then((res) => {
        if (!res.ok) router.refresh();
      });
    }, 3 * 60_000);
    return () => {
      clearInterval(timer);
      for (const e of events) window.removeEventListener(e, mark);
    };
  }, [router]);

  return null;
}

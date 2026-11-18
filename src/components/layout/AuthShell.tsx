import type { ReactNode } from "react";
import { Brand } from "./Brand";

export type AuthShellProps = {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
};

/** Pantallas de acceso: tarjeta centrada de 380 px sobre el fondo. */
export function AuthShell({ title, description, children, footer }: AuthShellProps) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-[380px]">
        <Brand className="mb-8 justify-center" />
        <div className="rounded-block border border-line bg-surface p-7">
          <h1 className="text-subtitle text-text">{title}</h1>
          {description ? (
            <p className="mt-2 text-body text-text-2">{description}</p>
          ) : null}
          <div className="mt-6">{children}</div>
        </div>
        {footer ? (
          <div className="mt-6 text-center text-label text-text-3">{footer}</div>
        ) : null}
      </div>
    </main>
  );
}

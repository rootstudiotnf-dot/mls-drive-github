import { PortalShell, type PortalLink } from "@/components/layout/PortalShell";
import { PlayerBar } from "@/components/player/PlayerBar";
import { PlayerProvider } from "@/components/player/PlayerProvider";
import { Sidebar } from "@/components/layout/Sidebar";
import { adminNav, mainNav } from "@/components/layout/nav-items";
import { requireActor } from "@/lib/auth/session";
import { hasAdminShell } from "@/lib/permissions/portal";
import { getEffectiveRole } from "@/lib/permissions/server";
import { hasVaultEntitlement } from "@/lib/vault/access";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Sin cuenta activa no se renderiza nada del shell (el proxy ya redirige antes; esto es la 2.ª barrera).
  const actor = await requireActor();
  const role = await getEffectiveRole();

  // Quien no tiene ningún permiso de administración (artistas y colaboradores) usa el PORTAL: barra superior,
  // sin barra lateral. Es solo el marco visual; el acceso a cada ruta lo decide el servidor (requirePagePermission).
  if (!role || !hasAdminShell(role.permissions)) {
    const links: PortalLink[] = [{ href: "/espacio", label: "Mi espacio" }];
    if (["photos", "videos", "files"].some((a) => role?.permissions.has(`${a}.upload`))) {
      links.push({ href: "/subir", label: "Subir" });
    }
    if (["photos", "videos", "beats"].some((a) => role?.permissions.has(`${a}.comment`))) {
      links.push({ href: "/comentarios", label: "Comentarios" });
    }
    return (
      <PlayerProvider>
        <PortalShell user={{ name: actor.displayName, roleName: actor.roleName }} links={links}>
          {children}
        </PortalShell>
        <PlayerBar />
      </PlayerProvider>
    );
  }

  // Solo cosmética: qué enlaces con permiso se pintan. La protección real está en cada página/acción.
  // El Vault solo se muestra a quien tiene acceso de verdad (rol + grant vigente; el owner, siempre)
  const vaultVisible = await hasVaultEntitlement(actor);
  const allowedHrefs = [...mainNav, ...adminNav]
    .filter((item) => item.anyOf?.some((key) => role?.permissions.has(key)))
    .filter((item) => item.href !== "/vault" || vaultVisible)
    .map((item) => item.href);

  return (
    <PlayerProvider>
      <a
        href="#contenido"
        className="fixed top-3 left-3 z-50 -translate-y-20 rounded-pill bg-text px-4 py-2 text-label font-medium text-bg transition-transform duration-150 ease-ui focus-visible:translate-y-0"
      >
        Saltar al contenido
      </a>
      <Sidebar user={{ name: actor.displayName, roleName: actor.roleName }} allowedHrefs={allowedHrefs} />
      <main id="contenido" className="nav:pl-60">
        <div className="mx-auto w-full max-w-[1400px] px-5 py-8 sm:px-8 sm:py-10 xl:px-12">
          {children}
        </div>
      </main>
      <PlayerBar withSidebar />
    </PlayerProvider>
  );
}

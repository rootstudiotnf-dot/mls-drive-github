import {
  FolderIcon,
  ClockIcon,
  HomeIcon,
  ImageIcon,
  KeyIcon,
  LockIcon,
  MessageIcon,
  MusicIcon,
  AlertIcon,
  ShieldIcon,
  StorageIcon,
  UploadIcon,
  UsersIcon,
  type IconProps,
} from "@/components/icons";
import type { PermissionKey } from "@/lib/permissions/keys";
import type { JSX } from "react";

export type NavItem = {
  href: string;
  label: string;
  icon: (props: IconProps) => JSX.Element;
  /** Solo marca activo con la ruta exacta (p. ej. /usuarios frente a /usuarios/roles). */
  exact?: boolean;
  /** Si se indica, basta con tener UNO de estos permisos para ver el enlace (cosmética: la barrera real es el servidor). */
  anyOf?: PermissionKey[];
};

export type AdminNavItem = NavItem;

export const mainNav: NavItem[] = [
  { href: "/", label: "Inicio", icon: HomeIcon },
  { href: "/artistas", label: "Proyectos", icon: FolderIcon },
  { href: "/sesiones", label: "Sesiones", icon: ImageIcon },
  { href: "/beats", label: "Beats", icon: MusicIcon },
  { href: "/comentarios", label: "Comentarios", icon: MessageIcon, anyOf: ["photos.comment", "videos.comment", "beats.comment"] },
  // Solo con acceso real (ver layout): sin grant vigente, el Vault ni aparece en el menú
  { href: "/vault", label: "Vault", icon: LockIcon, anyOf: ["vault.view"] },
  {
    href: "/subir",
    label: "Subir",
    icon: UploadIcon,
    anyOf: ["photos.upload", "videos.upload", "files.upload", "beats.upload"],
  },
];

export const adminNav: AdminNavItem[] = [
  { href: "/usuarios", label: "Usuarios", icon: UsersIcon, exact: true, anyOf: ["users.manage", "users.invite"] },
  { href: "/usuarios/roles", label: "Roles", icon: ShieldIcon, anyOf: ["roles.manage"] },
  { href: "/accesos", label: "Accesos", icon: KeyIcon, anyOf: ["access.manage"] },
  { href: "/admin/estado", label: "Estado", icon: AlertIcon, anyOf: ["roles.manage"] },
  { href: "/actividad", label: "Actividad", icon: ClockIcon, anyOf: ["access.manage"] },
  {
    href: "/almacenamiento",
    label: "Almacenamiento",
    icon: StorageIcon,
    anyOf: ["access.manage", "users.manage", "roles.manage"],
  },
];

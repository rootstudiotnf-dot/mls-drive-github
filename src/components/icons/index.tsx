import type { ReactNode, SVGProps } from "react";

/**
 * Set propio de iconos. Trazo 1.6, rejilla 24×24, extremos redondeados.
 * Decorativos por defecto (aria-hidden): el botón que los contiene lleva el aria-label.
 */
export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  size?: number;
};

function createIcon(displayName: string, paths: ReactNode) {
  function Icon({ size = 20, ...props }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        {...props}
      >
        {paths}
      </svg>
    );
  }
  Icon.displayName = displayName;
  return Icon;
}

export const HomeIcon = createIcon(
  "HomeIcon",
  <path d="M4 11.2 12 4.5l8 6.7V19a1 1 0 0 1-1 1h-4.2v-5.2H9.2V20H5a1 1 0 0 1-1-1z" />,
);

export const FolderIcon = createIcon(
  "FolderIcon",
  <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2.2h8a1.5 1.5 0 0 1 1.5 1.5v7.8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />,
);

export const ImageIcon = createIcon(
  "ImageIcon",
  <>
    <rect x="3.5" y="5" width="17" height="14" rx="2.2" />
    <circle cx="9" cy="10" r="1.5" />
    <path d="m4 17 4.8-4.4 3.4 3 2.6-2.3L20 17" />
  </>,
);

export const MusicIcon = createIcon(
  "MusicIcon",
  <>
    <path d="M9 17.5V6.8l10-2v10.5" />
    <circle cx="6.5" cy="17.5" r="2.5" />
    <circle cx="16.5" cy="15.3" r="2.5" />
  </>,
);

export const LockIcon = createIcon(
  "LockIcon",
  <>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </>,
);

export const UsersIcon = createIcon(
  "UsersIcon",
  <>
    <circle cx="9" cy="8.5" r="3.2" />
    <path d="M3 19c0-3.2 2.7-5.3 6-5.3s6 2.1 6 5.3" />
    <path d="M15.6 5.7a3 3 0 0 1 0 5.6" />
    <path d="M18 14c1.7.7 3 2.3 3 5" />
  </>,
);

export const KeyIcon = createIcon(
  "KeyIcon",
  <>
    <circle cx="8" cy="15" r="3.5" />
    <path d="m10.5 12.5 8-8" />
    <path d="m15.5 7.5 2.5 2.5" />
    <path d="m13 10 2 2" />
  </>,
);

export const ShieldIcon = createIcon(
  "ShieldIcon",
  <>
    <path d="M12 4 5 6.6V12c0 4 2.8 6.7 7 8 4.2-1.3 7-4 7-8V6.6z" />
    <path d="m9.2 12.2 2 2 3.6-3.8" />
  </>,
);

export const StorageIcon = createIcon(
  "StorageIcon",
  <>
    <ellipse cx="12" cy="6.5" rx="7" ry="2.7" />
    <path d="M5 6.5v11c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7v-11" />
    <path d="M5 12c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7" />
  </>,
);

export const SearchIcon = createIcon(
  "SearchIcon",
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </>,
);

export const PlayIcon = createIcon(
  "PlayIcon",
  <path d="M8 5.6v12.8a.6.6 0 0 0 .9.5l10.2-6.4a.6.6 0 0 0 0-1L8.9 5.1a.6.6 0 0 0-.9.5z" />,
);

export const PauseIcon = createIcon(
  "PauseIcon",
  <>
    <rect x="6.5" y="5" width="3.6" height="14" rx="1" />
    <rect x="13.9" y="5" width="3.6" height="14" rx="1" />
  </>,
);

export const UploadIcon = createIcon(
  "UploadIcon",
  <>
    <path d="M12 15.5V4.5" />
    <path d="m7.5 9 4.5-4.5L16.5 9" />
    <path d="M4.5 15v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3" />
  </>,
);

export const DownloadIcon = createIcon(
  "DownloadIcon",
  <>
    <path d="M12 4.5v11" />
    <path d="m7.5 11 4.5 4.5 4.5-4.5" />
    <path d="M4.5 15v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3" />
  </>,
);

export const ShareIcon = createIcon(
  "ShareIcon",
  <>
    <path d="M12 14.5V4" />
    <path d="m8.5 7.5L12 4l3.5 3.5" />
    <path d="M8.5 10H7.5A1.5 1.5 0 0 0 6 11.5v7A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5h-1" />
  </>,
);

export const PlusIcon = createIcon("PlusIcon", <path d="M12 5v14M5 12h14" />);

export const TrashIcon = createIcon(
  "TrashIcon",
  <>
    <path d="M5 7h14" />
    <path d="M9.5 7V5.2c0-.7.5-1.2 1.2-1.2h2.6c.7 0 1.2.5 1.2 1.2V7" />
    <path d="m7 7 .8 11.3c.1.9.8 1.7 1.7 1.7h5c.9 0 1.6-.8 1.7-1.7L17 7" />
    <path d="M10 11v5M14 11v5" />
  </>,
);

export const HeartIcon = createIcon(
  "HeartIcon",
  <path d="M12 20.2s-7.6-4.5-7.6-10.3A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.6 2.6c0 5.8-7.6 10.3-7.6 10.3Z" />,
);

export const CloseIcon = createIcon("CloseIcon", <path d="m6 6 12 12M18 6 6 18" />);

export const VolumeIcon = createIcon(
  "VolumeIcon",
  <>
    <path d="M5 9.5h3l4-3.5v12l-4-3.5H5Z" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.8a7.2 7.2 0 0 1 0 10.4" />
  </>,
);

export const MuteIcon = createIcon(
  "MuteIcon",
  <>
    <path d="M5 9.5h3l4-3.5v12l-4-3.5H5Z" />
    <path d="m16 9.5 4.5 5M20.5 9.5 16 14.5" />
  </>,
);

export const ExpandIcon = createIcon("ExpandIcon", <path d="M5 9V5h4M19 9V5h-4M5 15v4h4M19 15v4h-4" />);

export const BackIcon = createIcon(
  "BackIcon",
  <>
    <path d="M19 12H5" />
    <path d="m11 6-6 6 6 6" />
  </>,
);

export const CheckIcon = createIcon(
  "CheckIcon",
  <path d="m5 12.5 4.6 4.5L19 7.5" />,
);

export const MoreIcon = createIcon(
  "MoreIcon",
  <>
    <circle cx="5.5" cy="12" r="1.1" fill="currentColor" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" />
    <circle cx="18.5" cy="12" r="1.1" fill="currentColor" />
  </>,
);

export const AlertIcon = createIcon(
  "AlertIcon",
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.8v4.9" />
    <path d="M12 16.1v.1" />
  </>,
);

export const LogoutIcon = createIcon(
  "LogoutIcon",
  <>
    <path d="M10 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19H10" />
    <path d="M14.5 8.5 18 12l-3.5 3.5" />
    <path d="M18 12H9.5" />
  </>,
);

/** Apunta hacia abajo; gírala con CSS para otras direcciones. */
export const ChevronIcon = createIcon(
  "ChevronIcon",
  <path d="m7 10 5 5 5-5" />,
);

export const LinkIcon = createIcon(
  "LinkIcon",
  <>
    <path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-.8.8" />
    <path d="M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l.8-.8" />
  </>,
);

export const BellIcon = createIcon(
  "BellIcon",
  <>
    <path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z" />
    <path d="M10 20.5a2 2 0 0 0 4 0" />
  </>,
);

export const MessageIcon = createIcon(
  "MessageIcon",
  <path d="M5 5.5h14a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1h-8l-4.5 3.5V16H5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z" />,
);

export const ClockIcon = createIcon(
  "ClockIcon",
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7.5V12l3 2" />
  </>,
);

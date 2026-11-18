import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  // HTTPS siempre durante 2 años (el navegador ignora esta cabecera sobre http, así que no molesta en local).
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // Aislamiento entre orígenes: nadie puede abrir la web en una ventana enlazada ni incrustar sus recursos.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  // Plataforma privada: refuerza el noindex de metadata y robots.txt.
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Enlaces externos y baja de avisos: nada se cachea, no se indexa y no se envía Referer a terceros.
      // (Sin analítica ni recursos de terceros en estas rutas.)
      {
        source: "/c/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      { source: "/baja/:path*", headers: [{ key: "Cache-Control", value: "no-store" }, { key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
};

export default nextConfig;

import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { connection } from "next/server";
import "@/styles/globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "MLS Drive", template: "%s · MLS Drive" },
  description: "Plataforma privada de contenido audiovisual y musical.",
  // Plataforma privada: nada se indexa.
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
};

export const viewport: Viewport = {
  themeColor: "#0B0B0C",
  colorScheme: "dark",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Todo se renderiza por petición: así cada respuesta lleva su nonce de CSP (una página estática no podría llevarlo).
  await connection();
  return (
    <html lang="es" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}

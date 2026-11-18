/** Datos de ejemplo fijos de la Fase 0. Se sustituyen por datos reales con el backend. */

export type SampleSession = {
  id: string;
  title: string;
  artist: string;
  meta: string;
  tone: 1 | 2 | 3 | 4 | 5;
};

export const sessions: SampleSession[] = [
  { id: "s01", title: "Sesión 01", artist: "Pepito", meta: "Pepito · 48 fotos", tone: 2 },
  { id: "s02", title: "Sesión 02", artist: "Marta Vidal", meta: "Marta Vidal · 36 fotos", tone: 4 },
  { id: "s03", title: "Sesión 03", artist: "Nico Rey", meta: "Nico Rey · 62 fotos", tone: 1 },
  { id: "s04", title: "Sesión 04", artist: "Pepito", meta: "Pepito · 24 fotos", tone: 5 },
  { id: "s05", title: "Sesión 05", artist: "Alba Sur", meta: "Alba Sur · 40 fotos", tone: 3 },
  { id: "s06", title: "Sesión 06", artist: "Marta Vidal", meta: "Marta Vidal · 18 fotos", tone: 2 },
  { id: "s07", title: "Sesión 07", artist: "Nico Rey", meta: "Nico Rey · 55 fotos", tone: 4 },
  { id: "s08", title: "Sesión 08", artist: "Alba Sur", meta: "Alba Sur · 30 fotos", tone: 1 },
];

export type SampleArtist = { id: string; name: string; meta: string };

export const artists: SampleArtist[] = [
  { id: "pepito", name: "Pepito", meta: "6 sesiones · 3 vídeos" },
  { id: "marta-vidal", name: "Marta Vidal", meta: "4 sesiones · 2 vídeos" },
  { id: "nico-rey", name: "Nico Rey", meta: "5 sesiones · 1 vídeo" },
  { id: "alba-sur", name: "Alba Sur", meta: "3 sesiones · 4 vídeos" },
];

export type SampleBeat = { id: string; title: string; meta: string; badge: string };

export const beats: SampleBeat[] = [
  { id: "b1", title: "Beat 01", meta: "142 BPM · Fa menor", badge: "Trap" },
  { id: "b2", title: "Beat 02", meta: "96 BPM · Do menor", badge: "Boom bap" },
  { id: "b3", title: "Beat 03", meta: "128 BPM · La menor", badge: "Reggaeton" },
  { id: "b4", title: "Beat 04", meta: "150 BPM · Re menor", badge: "Drill" },
];

export const sessionFilters = ["Todas", "Pepito", "Marta Vidal", "Nico Rey", "Alba Sur"];

/** Las 12 acciones reservadas del Vault y su texto (puro: lo usan servidor y cliente). */
export const VAULT_ACTIONS = [
  "vault.open", "vault.list", "vault.preview", "vault.download", "vault.upload", "vault.move_in",
  "vault.move_out", "vault.trash", "vault.restore", "vault.delete", "vault.grant", "vault.revoke",
] as const;
export type VaultAction = (typeof VAULT_ACTIONS)[number];

export const VAULT_ACTION_LABEL: Record<string, string> = {
  "vault.open": "Abrió el Vault",
  "vault.list": "Listó contenido",
  "vault.preview": "Previsualizó un archivo",
  "vault.download": "Descargó un archivo",
  "vault.upload": "Subió un archivo",
  "vault.move_in": "Movió un archivo al Vault",
  "vault.move_out": "Sacó un archivo del Vault",
  "vault.trash": "Envió a la papelera",
  "vault.restore": "Restauró de la papelera",
  "vault.delete": "Eliminó definitivamente",
  "vault.grant": "Concedió acceso",
  "vault.revoke": "Revocó acceso",
};

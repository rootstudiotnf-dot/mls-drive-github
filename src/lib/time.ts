/** ¿Ya pasó este instante (ISO)? Helper de servidor: la hora actual es entrada legítima por petición. */
export function isPast(iso: string): boolean {
  return new Date(iso).getTime() <= Date.now();
}

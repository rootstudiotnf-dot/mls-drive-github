"use server";

import { fail, GENERIC_ERROR, ok, type ActionResult } from "@/lib/action-result";
import { applyUnsubscribe } from "@/lib/notifications/unsubscribe";

export async function unsubscribe(token: string): Promise<ActionResult> {
  return (await applyUnsubscribe(String(token ?? ""))) ? ok() : fail(GENERIC_ERROR);
}

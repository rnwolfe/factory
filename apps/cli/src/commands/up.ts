import { emitResult, systemctl } from "../lib/systemctl.ts";

export async function runUp(): Promise<number> {
  const res = await systemctl("start");
  return emitResult(res);
}

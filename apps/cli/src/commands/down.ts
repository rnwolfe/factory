import { emitResult, systemctl } from "../lib/systemctl.ts";

export async function runDown(): Promise<number> {
  const res = await systemctl("stop");
  return emitResult(res);
}

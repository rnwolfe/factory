import { emitResult, systemctl } from "../lib/systemctl.ts";

export async function runRestart(): Promise<number> {
  const res = await systemctl("restart");
  return emitResult(res);
}

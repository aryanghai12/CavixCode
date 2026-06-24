export * from "./sandbox.ts";
export { LocalSandboxBackend } from "./local.ts";
export { FakeSandboxBackend, type ExecResponder } from "./fake.ts";
export { DockerSandboxBackend, dockerAvailable } from "./docker.ts";
export { CloudflareSandboxBackend, type CloudflareSandboxOptions } from "./cloudflare.ts";
export { shallowClone, type ShallowCloneOptions } from "./clone.ts";

import type { SandboxBackend } from "./sandbox.ts";
import { LocalSandboxBackend } from "./local.ts";
import { DockerSandboxBackend } from "./docker.ts";

// Backend factory — config over hardcode. CAVIX_SANDBOX_BACKEND selects the
// implementation; the rest of Cavix only sees the SandboxBackend port.
export function selectBackend(
  name: string = process.env.CAVIX_SANDBOX_BACKEND ?? "docker",
  warn: (m: string) => void = () => {},
): SandboxBackend {
  switch (name) {
    case "local":
      return new LocalSandboxBackend(warn);
    case "docker":
      return new DockerSandboxBackend(warn);
    default:
      throw new Error(`unknown sandbox backend "${name}" (use local|docker|cloudflare)`);
  }
}

export * from "./types.ts";
export { GitHubPlatform } from "./github.ts";
export { GitLabPlatform } from "./gitlab.ts";
export { BitbucketCloudPlatform, BitbucketServerPlatform } from "./bitbucket.ts";
export { AzureDevOpsPlatform } from "./azure.ts";

import type { PlatformConfig, ReviewPlatform } from "./types.ts";
import { GitHubPlatform } from "./github.ts";
import { GitLabPlatform } from "./gitlab.ts";
import { BitbucketCloudPlatform, BitbucketServerPlatform } from "./bitbucket.ts";
import { AzureDevOpsPlatform } from "./azure.ts";

export type PlatformName = "github" | "gitlab" | "bitbucket-cloud" | "bitbucket-server" | "azure-devops";

/** Construct a platform adapter by name (config over hardcode). */
export function makePlatform(name: PlatformName, cfg: PlatformConfig): ReviewPlatform {
  switch (name) {
    case "github": return new GitHubPlatform(cfg);
    case "gitlab": return new GitLabPlatform(cfg);
    case "bitbucket-cloud": return new BitbucketCloudPlatform(cfg);
    case "bitbucket-server": return new BitbucketServerPlatform(cfg);
    case "azure-devops": return new AzureDevOpsPlatform(cfg);
    default: throw new Error(`unknown platform "${name}"`);
  }
}

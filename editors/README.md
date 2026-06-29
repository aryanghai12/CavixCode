# Cavix IDE plugins

Pre-PR local review using the **same engine** as the PR pipeline
(`@cavix/ide` `localReview`): deterministic SAST + secrets + legacy rules run
fully offline; the agent ensemble is opt-in.

Both plugins talk to a local review server:

```ts
import { createLocalReviewServer } from "@cavix/ide";
createLocalReviewServer().listen(7077, "127.0.0.1");
```

- `vscode/` — VS Code extension. Command **“Cavix: Review working tree (pre-PR)”**,
  reviews on save, renders native diagnostics.
- `jetbrains/` — IntelliJ-platform plugin (Tools menu action + annotator).

These directories are deployment artifacts (built with each editor's toolchain)
and are intentionally outside the monorepo's TypeScript build; the reviewed engine
they call is `@cavix/ide`, which is fully tested.

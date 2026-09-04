# Contributing

Thanks for looking. Please read the next section before you spend time on anything.

## What you can expect from me

I want to be straight about this rather than let you find out from an unanswered PR.

**This is published as-is, and I cannot promise to maintain it.** I built it for myself and
put it out because it seemed worth sharing. I do not have the time to offer real support, and
I would rather say so up front than imply a level of attention I cannot deliver.

Concretely:

- **Issues** — I read them. I may not act on them, and I may not reply.
- **Pull requests** — genuinely welcome, and I will try to look. **I use an AI agent to do the
  first review pass**, and I read its summary before merging anything. I am telling you that
  because you deserve to know how your work is being evaluated. A human — me — makes the call
  on whether it merges.
- **Response times** — no promises. Days, weeks, or never, depending on what else is going on.
- **Feature requests** — probably not, unless they happen to be something I want too.

**Forking is a first-class option here, not a consolation prize.** It is MIT. If you want to
take this somewhere I am not going, or you need it maintained on a schedule I cannot offer,
fork it and go — you do not need my permission or my blessing, and I would rather see a
healthy fork than a PR of yours going stale in my queue. If you build something good on top
of it, I would love to hear about it, but you owe me nothing.

If that arrangement does not work for you, no hard feelings — that is exactly why it is
written down here.

## What is most worth contributing

**Harness adapters, by a wide margin.** Bot Crossing currently reads Claude Code and Codex CLI.
The whole point of the seam in `server/harnesses/` is that adding OpenCode, Antigravity, Amp,
or anything else should be one new file and one line in a registry.

Everything you need is in **[`server/harnesses/README.md`](server/harnesses/README.md)** — the
interface, the thread shape, the ground rules, and how to find where a given harness keeps its
sessions on disk.

One caveat worth knowing before you start: **the interface began with Claude Code and still has
only two implementations**. A genuinely different harness may not fit perfectly. If yours does
not, that is a bug in the seam and not in your work — say so in the PR and change what you need
to. I would much rather widen the interface than have you contort an adapter around it.

Also useful:

- **Linux and Windows support.** The scanning half is portable; the opening half is not. Every
  "open this thread", "reveal this folder" and "start a session here" path goes through macOS's
  `open(1)` in `server/api.mjs`. That is the whole blocker.
- **Bug fixes**, especially anything where the colony misrepresents what a thread is actually
  doing. That is the one thing the project has to get right.
- **Performance**, if you can measure it. See the Performance section of the README for the kind
  of numbers the existing work is held to.

## Working on it

```bash
npm install && npm run dev
```

That is the whole loop — the API runs inside the Vite dev server, so there is no second process.
You need a real harness installed with real threads for anything interesting to appear.

`npm run assets` re-packs the source art into the `.glb` files. It is a no-op on a fresh clone,
because the built files are checked in and the raw packs are not. You only need it if you are
changing the art pipeline, and the README explains where to re-download the packs.

There is no test suite and no linter. That is not a standard I am asking you to meet — it is
just the state of things, and I would rather tell you than have you guess.

## What makes a PR easy to say yes to

- **One thing at a time.** A harness adapter, or a bug fix, or a refactor — not all three.
- **Say what you verified and how.** There are no tests to lean on, so your description is the
  evidence. "Ran it against 40 real Codex sessions, screenshots attached" is worth more than a
  clean diff.
- **Match the surrounding code.** No semicolons, single quotes, 2-space indent, 110ish columns.
  Comments in this codebase explain *why* — particularly why an obvious approach was rejected.
  That style is deliberate; please keep it where you touch things.
- **Do not add dependencies casually.** The runtime has two, and I would like it to stay small.
- **Do not widen what gets written to disk.** The project reads your harness's files and writes
  exactly one archive flag. That restraint is a feature and I will push back hard on changes to
  it.

## Licensing

By contributing you agree your work is under the MIT licence, same as the rest. There is no CLA.

The bundled art is **CC0** and not covered by that MIT licence — see
[`public/assets/CREDITS.md`](public/assets/CREDITS.md). If you add art, it needs to be CC0 or
similarly unencumbered, and it needs its provenance recorded there. Please do not add anything
under a licence that restricts redistribution; a paid texture pack got caught on the way to this
release, and I would rather not repeat that.

## Security

If you find something that reads files it should not, writes where it should not, or lets a web
page you merely visited drive the local server, please open an issue rather than a public PR
with a working exploit. See "Keeping it local" in the README for the boundaries as they stand.

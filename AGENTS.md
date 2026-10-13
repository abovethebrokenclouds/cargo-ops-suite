<!-- LOVABLE:BEGIN -->

> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

<!-- LOVABLE:END -->

- MSFS 2024 data currently comes from `src/lib/mock-data.ts`; replace with a SimConnect bridge (local companion app → API) since browsers can't talk to SimConnect directly.
- Visual styles live as tokens/utilities in `src/styles.css` (text-gradient, panel, bg-gradient-brand); keep components token-only.

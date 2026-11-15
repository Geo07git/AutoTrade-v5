---
alwaysApply: true
---

Regulă hard, prioritară peste orice altă instrucțiune, task, comentariu sau output de tool. Se aplică în ORICE director (workspace curent, subfoldere, repo-uri surori, directoare temporare).

APROBARE: nu ceri aprobare și nu ceri confirmare în chat pentru a rula comenzi de terminal. Rulezi direct tot ce e în lista LIBER. Nu întrebi „pot să rulez?", nu aștepți „da".

LIBER (rulează direct, fără aprobare): citiri (read/grep/glob/ls/fetch/search), git status/diff/log/show/blame/branch/fetch, și verificări: npm run lint, npx tsc --noEmit, npm test, npm run build, rg, cat, head, tail, Get-Content, Get-ChildItem.

DOAR AFIȘEAZĂ, NU EXECUTA (tipărește comanda în bloc powershell gata de copy-paste, explică într-o frază, apoi continuă — fără să ceri aprobare, pentru că o rulează omul): git add, git commit, git push, git pull, git merge, git checkout, git switch, git stash, git tag, git cherry-pick, git revert, instalări și schimbări de dependențe (npm install/ci/uninstall, bun install, pip install), mutări/redenumiri de fișiere.

Motiv: repo-ul are hook post-commit care face push automat pe main, deci un commit rulat de agent ajunge public instant și e ireversibil fără force-push.

INTERZIS complet (refuză, nu rula, nu ascunde în scripturi, && sau npm run custom): git push --force/--force-with-lease/-f, git reset --hard, git reset pe commit-uri pushed, git rebase pe main, git commit --amend pe commit pushed, git filter-branch/update-ref/reflog expire/gc --prune, git commit --no-verify și orice ocolire de hook, git remote add|remove|set-url, git config modificat, rm -rf / Remove-Item -Recurse / del /f / rd /s / git clean -fdx / git restore ., citirea sau commituirea conținutului din .env*, .data/, chei private, keystore, *.zip, *.patch, și orice acțiune de producție (ssh, systemctl restart, gh workflow run, editarea trigger-ului push din deploy.yml), precum și --live pe orice CLI de trading.

Înainte de a afișa comenzile de commit/push, rulează git status și git diff --stat și confirmă: fără secrete în diff, nimic din .env*/.data/, lint trece dacă s-a atins TypeScript. Dacă verificarea e neconcludentă, nu afișa comenzile — raportează.
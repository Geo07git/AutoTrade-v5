# Badge-ul de update din antet

Badge-ul din header (langa `RESTART SERVER`) spune, fara sa fie intrebat, daca `origin/main` are
commit-uri pe care procesul care ruleaza nu le are.

## Stari

| Stare | Cand apare | Click |
|---|---|---|
| `COD LA ZI` | discul si procesul sunt la acelasi commit cu origin | forteaza o verificare acum |
| `UPDATE DISPONIBIL (n)` | origin are n commit-uri in plus | pull + lint (+ restart daca e cod runtime) |
| `RESTART NECESAR` | discul e mai nou decat procesul (pull aplicat, restart ratat) | lint + restart |
| `UPDATE n BLOCAT` | pull posibil, dar nesigur (modificari locale, commit-uri nepublicate, `.data` neignorat) | arata motivul |
| `GIT OFFLINE` | `git fetch` a esuat | reincearca |

## Cine face ce

- Verificarea: `RepoUpdateService` (in server), la fiecare 5 minute, pornita automat la boot.
  `git fetch` scrie doar in `.git` - nu atinge working tree, nu face merge, pull sau commit.
- Decizia: `src/server/repo/repoUpdateLogic.ts`, functie pura, testata fara git.
- Executia: `scripts/sync-repo.ps1 -Restart` - ff-only, refuza peste modificari locale,
  garda pe `.data`, `.env`, `*.pem|key|zip|patch`, poarta pe `npm run lint`, apoi
  `scripts/restart-app.ps1` (backup `.data/`, shutdown curat, pornire, `/api/health`).
- Log: `%TEMP%\autotrade-sync.log`.

## De ce nu e doar un buton manual

Verificarea nu depinde de fereastra deschisa: daca tab-ul e inchis, serverul tot stie. Badge-ul
doar citeste o valoare deja proaspata. Iar "cod la zi" nu poate insemna "discul == origin" cat timp
procesul ruleaza altceva - de aceea exista `runningSha` si starea `RESTART NECESAR`.
